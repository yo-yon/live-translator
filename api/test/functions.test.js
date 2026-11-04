// 関数の動きを、Azure Functions・テーブル・外部 API をすべて模擬して確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

/* ---- 模擬：@azure/functions（登録された関数を手元に集める） ---- */
const handlers = {};
/* ---- 模擬：@azure/data-tables（メモリ上のテーブル） ---- */
const rows = new Map();
const fakeTables = {
  TableClient: {
    fromConnectionString: () => ({
      createTable: async () => {},
      upsertEntity: async (e) => { rows.set(`${e.partitionKey}|${e.rowKey}`, e); },
      getEntity: async (pk, rk) => {
        const e = rows.get(`${pk}|${rk}`);
        if (!e) { const err = new Error("nf"); err.statusCode = 404; throw err; }
        return e;
      },
      listEntities: ({ queryOptions }) => {
        const pk = /PartitionKey eq '(.*)'/.exec(queryOptions.filter)[1];
        const list = [...rows.values()].filter((e) => e.partitionKey === pk).sort((a, b) => (a.rowKey < b.rowKey ? -1 : 1));
        return (async function* () { yield* list; })();
      },
    }),
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "@azure/functions") return { app: { http: (name, def) => { handlers[name] = def.handler; } } };
  if (req === "@azure/data-tables") return fakeTables;
  return origLoad.call(this, req, ...rest);
};

process.env.SPEECH_KEY = "SK";
process.env.SPEECH_REGION = "eastus";
process.env.FOUNDRY_ENDPOINT = "proj-x";
process.env.FOUNDRY_API_KEY = "FK";
process.env.FOUNDRY_DEPLOYMENT = "gpt-5.4-mini";
process.env.STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
process.env.FEEDBACK_HUB_URL = "https://hub.example.net/api/collect/";

/* ---- 模擬：外部 API ---- */
const calls = [];
let llmStatus = 200;
global.fetch = async (url, opt = {}) => {
  calls.push({ url, opt });
  if (url.includes("/sts/v1.0/issueToken")) return { ok: true, status: 200, text: async () => "TOKEN" };
  if (url.includes("/openai/v1/chat/completions")) {
    if (llmStatus !== 200) return { ok: false, status: llmStatus, json: async () => ({ error: { message: "Unsupported value: 'reasoning_effort' does not support 'none'" } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "訳" } }], usage: { prompt_tokens: 5, completion_tokens: 2 }, secret: "x" }) };
  }
  if (url.includes("microsofttranslator.com")) return { ok: true, status: 200, json: async () => [{ translations: [{ text: "機械訳" }] }] };
  if (url.includes("/api/collect")) return { ok: true, status: 202, json: async () => ({}) };
  throw new Error("unexpected " + url);
};

require("../src/functions/index.js");

const req = ({ method = "GET", body, roles = ["authenticated", "owner"] } = {}) => ({
  method,
  headers: { get: (k) => (k === "x-ms-client-principal" ? Buffer.from(JSON.stringify({ userRoles: roles })).toString("base64") : null) },
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});
const ctx = { error: () => {}, warn: () => {} };

test("ロールがない人はすべて 403", async () => {
  for (const name of Object.keys(handlers)) {
    const r = await handlers[name](req({ roles: ["authenticated"] }), ctx);
    assert.equal(r.status, 403, name);
  }
});

test("config：サーバー版であることと使える機能を返す（キーは返さない）", async () => {
  const r = await handlers.config(req(), ctx);
  assert.equal(r.jsonBody.mode, "hosted");
  assert.equal(r.jsonBody.speechRegion, "eastus");
  assert.equal(r.jsonBody.llm, true);
  assert.equal(r.jsonBody.share, true);
  assert.ok(!JSON.stringify(r.jsonBody).includes("SK") && !JSON.stringify(r.jsonBody).includes("FK"));
});

test("speech-token：トークンを発行し、5分間は使い回す", async () => {
  calls.length = 0;
  const a = await handlers.speechToken(req(), ctx);
  const b = await handlers.speechToken(req(), ctx);
  assert.equal(a.jsonBody.token, "TOKEN");
  assert.ok(a.jsonBody.expiresAt > Date.now() + 9 * 60 * 1000);
  assert.equal(calls.filter((c) => c.url.includes("issueToken")).length, 1);
  assert.equal(b.jsonBody.token, "TOKEN");
});

test("translate：キーとデプロイ名はサーバー側の値で呼ぶ", async () => {
  calls.length = 0;
  const r = await handlers.translate(req({ method: "POST", body: { model: "evil", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], reasoning_effort: "none" } }), ctx);
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.choices[0].message.content, "訳");
  assert.equal(r.jsonBody.secret, undefined);
  const c = calls[0];
  assert.equal(c.url, "https://proj-x.openai.azure.com/openai/v1/chat/completions");
  assert.equal(c.opt.headers["api-key"], "FK");
  assert.equal(JSON.parse(c.opt.body).model, "gpt-5.4-mini");
});

test("translate：上流のエラーは状態コードと文面をそのまま返す（推論なし→低の切替用）", async () => {
  llmStatus = 400;
  const r = await handlers.translate(req({ method: "POST", body: { messages: [{ role: "user", content: "u" }] } }), ctx);
  llmStatus = 200;
  assert.equal(r.status, 400);
  assert.match(r.jsonBody.error.message, /reasoning/);
});

test("translate：壊れた JSON や不正な内容は 400", async () => {
  assert.equal((await handlers.translate(req({ method: "POST", body: "{bad" }), ctx)).status, 400);
  assert.equal((await handlers.translate(req({ method: "POST", body: { messages: [{ role: "tool", content: "x" }] } }), ctx)).status, 400);
});

test("nmt：Translator の結果をそのまま返す。言語コードを検証", async () => {
  const r = await handlers.nmt(req({ method: "POST", body: { text: "hello", from: "en", to: "ja" } }), ctx);
  assert.equal(r.jsonBody[0].translations[0].text, "機械訳");
  assert.equal((await handlers.nmt(req({ method: "POST", body: { text: "x", from: "en&x=1", to: "ja" } }), ctx)).status, 400);
});

test("feedback：「作者にも送る」を選ばなければ、自分のテーブルに保存するだけ", async () => {
  calls.length = 0;
  const r = await handlers.feedback(req({ method: "POST", body: { kind: "content", category: "asr", original: "Indian skills", correct: "agent skills" } }), ctx);
  assert.equal(r.status, 201);
  assert.equal(r.jsonBody.forwarded, false);
  assert.equal(calls.length, 0);
  const list = await handlers.feedback(req(), ctx);
  assert.equal(list.jsonBody[0].shared, false);
});

test("feedback：選んだものだけ、受付の形式（v1）で送る（個人情報は伏せる）", async () => {
  calls.length = 0;
  const r = await handlers.feedback(req({ method: "POST", body: { kind: "content", category: "asr", original: "Indian skills", translated: "インドのスキル", correct: "agent skills", comment: "me@x.com より", share: true, context: { version: "2026-11-04.2", device: "pc", mode: "llm" } } }), ctx);
  assert.equal(r.jsonBody.forwarded, true);
  const ing = calls.find((c) => c.url === "https://hub.example.net/api/collect");
  const sent = JSON.parse(ing.opt.body);
  assert.equal(ing.opt.headers["x-hub-key"], undefined);
  assert.deepEqual([sent.v, sent.type, sent.app, sent.appVersion], [1, "feedback", "live-translator", "2026-11-04.2"]);
  assert.match(sent.instanceId, /^[0-9a-f-]{36}$/);
  assert.deepEqual([sent.item.kind, sent.item.category, sent.item.targetType], ["content", "聞き取り違い", "caption"]);
  assert.equal(sent.item.comment, "[メール] より");
  assert.deepEqual(sent.item.detail, { variant: "live", engine: "", source: "Indian skills", translated: "インドのスキル", expected: "agent skills" });
  const list = await handlers.feedback(req(), ctx);
  assert.equal(list.jsonBody[0].shared, true);
});

test("feedback：端末 ID は毎回同じ", async () => {
  calls.length = 0;
  await handlers.feedback(req({ method: "POST", body: { kind: "app", category: "feature", comment: "A", share: true } }), ctx);
  await handlers.feedback(req({ method: "POST", body: { kind: "app", category: "feature", comment: "B", share: true } }), ctx);
  const sent = calls.filter((c) => c.url.includes("/api/collect")).map((c) => JSON.parse(c.opt.body));
  assert.deepEqual([sent[0].item.kind, sent[0].item.category, sent[0].item.targetType], ["app", "機能の要望", ""]);
  const ids = sent.map((b) => b.instanceId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("transcript：保存は常に、中央への転送は share が true のときだけ", async () => {
  calls.length = 0;
  const body = { sessionId: "s1", part: 0, lines: [{ t: "10:00:00", src: "Hi", ja: "こんにちは" }] };
  const a = await handlers.transcript(req({ method: "POST", body }), ctx);
  assert.equal(a.status, 201);
  assert.equal(a.jsonBody.forwarded, false);
  assert.equal(calls.filter((c) => c.url.includes("/api/collect")).length, 0);
  const long = Array.from({ length: 250 }, (_, i) => ({ t: "10:00:00", src: "a".repeat(900), ja: `${i}` }));
  const b = await handlers.transcript(req({ method: "POST", body: { ...body, part: 1, lines: long, share: true } }), ctx);
  assert.equal(b.jsonBody.forwarded, true);
  // 受付の上限に合わせて 100 行ずつ・1行 400 字までに分けて送る
  const sent = calls.filter((c) => c.url === "https://hub.example.net/api/collect/transcript").map((c) => JSON.parse(c.opt.body));
  assert.deepEqual(sent.map((s) => s.transcript.lines.length), [100, 100, 50]);
  assert.deepEqual(sent.map((s) => s.transcript.part), [10, 11, 12]);
  assert.equal(sent[0].type, "transcript");
  assert.equal(sent[0].transcript.lines[0].src.length, 400);
  const keys = [...rows.keys()].filter((k) => k.startsWith("transcript-"));
  assert.equal(keys.length, 2);
});

test("中央が未設定なら転送しない（保存は成功）", async () => {
  const url = process.env.FEEDBACK_HUB_URL;
  delete process.env.FEEDBACK_HUB_URL;
  calls.length = 0;
  const r = await handlers.feedback(req({ method: "POST", body: { kind: "app", category: "bug", comment: "x", share: true } }), ctx);
  process.env.FEEDBACK_HUB_URL = url;
  assert.equal(r.status, 201);
  assert.equal(r.jsonBody.forwarded, false);
  assert.equal(calls.length, 0);
});
