const { app } = require("@azure/functions");
const {
  requireUser, normalizeFeedback, buildTranslateBody, normalizeEndpoint,
  descKey, insertRow, listPartition, instanceId, centralConfigured, forwardToCentral, bad, fail,
} = require("../lib");

const noStore = { "Cache-Control": "no-store" };
const VERSION = "0.1.0";

/* ---------- 画面が「サーバー版で動いているか」を知るための設定 ---------- */
app.http("config", {
  route: "config",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request) => {
    const denied = requireUser(request);
    if (denied) return denied;
    const llm = !!(process.env.FOUNDRY_ENDPOINT && process.env.FOUNDRY_API_KEY);
    return {
      jsonBody: {
        mode: "hosted",
        apiVersion: VERSION,
        speechRegion: process.env.SPEECH_REGION || "",
        speech: !!(process.env.SPEECH_KEY && process.env.SPEECH_REGION),
        llm,
        deployment: llm ? process.env.FOUNDRY_DEPLOYMENT || "gpt-5.4-mini" : "",
        storage: !!process.env.STORAGE_CONNECTION_STRING,
        share: centralConfigured(), // 中央に送れる設定になっているか
      },
      headers: noStore,
    };
  },
});

/* ---------- Speech の短期トークン（有効10分。発行から5分間は使い回す） ---------- */
let cachedToken = null; // { token, issuedAt }
app.http("speechToken", {
  route: "speech-token",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireUser(request);
    if (denied) return denied;
    const key = process.env.SPEECH_KEY;
    const region = process.env.SPEECH_REGION;
    if (!key || !region) return { status: 500, jsonBody: { error: "SPEECH_KEY / SPEECH_REGION が未設定です" } };
    try {
      if (!cachedToken || Date.now() - cachedToken.issuedAt > 5 * 60 * 1000) {
        const r = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
          method: "POST",
          headers: { "Ocp-Apim-Subscription-Key": key, "Content-Length": "0" },
        });
        if (!r.ok) {
          context.error(`issueToken failed: ${r.status}`);
          return { status: 502, jsonBody: { error: "token_failed", status: r.status } };
        }
        cachedToken = { token: await r.text(), issuedAt: Date.now() };
      }
      return {
        jsonBody: { token: cachedToken.token, region, expiresAt: cachedToken.issuedAt + 10 * 60 * 1000 },
        headers: noStore,
      };
    } catch (e) {
      return fail(context, e);
    }
  },
});

/* ---------- LLM 翻訳（gpt-5.4-mini）。キーはサーバー側だけに置く ---------- */
app.http("translate", {
  route: "translate",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireUser(request);
    if (denied) return denied;
    const endpoint = normalizeEndpoint(process.env.FOUNDRY_ENDPOINT);
    const apiKey = process.env.FOUNDRY_API_KEY;
    if (!endpoint || !apiKey) return { status: 500, jsonBody: { error: { message: "FOUNDRY_ENDPOINT / FOUNDRY_API_KEY が未設定です" } } };
    let body;
    try { body = buildTranslateBody(await request.json(), process.env.FOUNDRY_DEPLOYMENT || "gpt-5.4-mini"); }
    catch { body = null; }
    if (!body) return bad("translate");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`${endpoint}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await r.json().catch(() => ({}));
      // 失敗も含めて、状態コードとエラー文はそのまま返す（画面側の「推論なし→低」への自動切替に使う）
      return { status: r.status, jsonBody: r.ok ? { choices: data.choices, usage: data.usage } : { error: data.error || { message: `HTTP ${r.status}` } }, headers: noStore };
    } catch (e) {
      if (e.name === "AbortError") return { status: 504, jsonBody: { error: { message: "timeout" } } };
      return fail(context, e);
    } finally {
      clearTimeout(timer);
    }
  },
});

/* ---------- 代替の機械翻訳（Translator。Speech のキーがマルチサービスキーのときだけ動く） ---------- */
app.http("nmt", {
  route: "nmt",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireUser(request);
    if (denied) return denied;
    let b;
    try { b = await request.json(); } catch { return bad("nmt"); }
    const lang = (v) => (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(v || "")) ? v : null);
    const text = typeof b?.text === "string" ? b.text.slice(0, 2000) : "";
    if (!text || !lang(b.from) || !lang(b.to)) return bad("nmt");
    try {
      const r = await fetch(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${b.from}&to=${b.to}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": process.env.SPEECH_KEY || "",
          "Ocp-Apim-Subscription-Region": process.env.SPEECH_REGION || "",
        },
        body: JSON.stringify([{ Text: text }]),
      });
      const data = await r.json().catch(() => ([]));
      return { status: r.status, jsonBody: data, headers: noStore };
    } catch (e) {
      return fail(context, e);
    }
  },
});

/* ---------- フィードバック（字幕の👎・ご意見・要望） ---------- */
app.http("feedback", {
  route: "feedback",
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireUser(request);
    if (denied) return denied;
    try {
      if (request.method === "GET") {
        return { jsonBody: await listPartition("feedback", 200), headers: noStore };
      }
      let raw;
      try { raw = await request.json(); } catch { return bad("feedback"); }
      const item = normalizeFeedback(raw);
      if (!item) return bad("feedback");
      // 作者に届けるのは、利用者が1件ごとに「作者にも送る」を選んだものだけ（初期設定は送らない）
      item.shared = raw.share === true && centralConfigured();
      await insertRow("feedback", descKey(), item);
      const forwarded = item.shared ? await forwardToCentral("feedback", item, await instanceId(), context) : false;
      return { status: 201, jsonBody: { forwarded }, headers: noStore };
    } catch (e) {
      return fail(context, e);
    }
  },
});

