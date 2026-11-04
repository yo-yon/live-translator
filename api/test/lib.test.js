const test = require("node:test");
const assert = require("node:assert/strict");
const {
  scrub, normalizeFeedback, normalizeTranscript, buildTranslateBody, normalizeEndpoint, requireUser,
} = require("../src/lib");

const principal = (roles) => ({
  headers: { get: (k) => (k === "x-ms-client-principal" ? Buffer.from(JSON.stringify({ userRoles: roles })).toString("base64") : null) },
});

test("scrub: メール・URL・電話番号を伏せる", () => {
  const s = scrub("連絡は taro@example.com か https://example.com/a?b=1 、電話 +1 (702) 555-0123 まで。2026年10月30日");
  assert.equal(s, "連絡は [メール] か [URL] 、電話 [番号] まで。2026年10月30日");
});

test("scrub: 短い数字（年・割合・件数）は残す", () => {
  assert.equal(scrub("2025年に 45% 増えて 1,000,000 件"), "2025年に 45% 増えて 1,000,000 件");
});

test("normalizeFeedback: 字幕の👎", () => {
  const f = normalizeFeedback({ kind: "content", category: "asr", original: "Indian skills", translated: "インドのスキル", correct: "agent skills", comment: "" });
  assert.equal(f.kind, "content");
  assert.equal(f.correct, "agent skills");
  assert.equal(f.status, "open");
  assert.ok(f.at);
});

test("normalizeFeedback: ご意見はコメント必須、不明な種類は拒否", () => {
  assert.equal(normalizeFeedback({ kind: "app", category: "bug", comment: "  " }), null);
  assert.ok(normalizeFeedback({ kind: "app", category: "bug", comment: "止まる" }));
  assert.equal(normalizeFeedback({ kind: "content", category: "nope" }), null);
  assert.equal(normalizeFeedback({ kind: "x", category: "asr" }), null);
  assert.equal(normalizeFeedback(null), null);
});

test("normalizeFeedback: コメント内の個人情報を伏せ、長さを制限", () => {
  const f = normalizeFeedback({ kind: "app", category: "other", comment: "a@b.co " + "x".repeat(2000) });
  assert.ok(f.comment.startsWith("[メール] "));
  assert.ok(f.comment.length <= 1000);
});

test("normalizeTranscript: 行を整形し、空行と不正な ID を除く", () => {
  const t = normalizeTranscript({ sessionId: "abc/../1", part: 2, lines: [{ t: "10:00:01", src: "Hi", ja: "こんにちは" }, { src: "", ja: "" }] });
  assert.equal(t.sessionId, "abc1");
  assert.equal(t.part, 2);
  assert.equal(t.lines.length, 1);
  assert.equal(normalizeTranscript({ sessionId: "a", lines: [] }), null);
  assert.equal(normalizeTranscript({ sessionId: "", lines: [{ src: "x" }] }), null);
});

test("normalizeTranscript: 1回300行まで", () => {
  const lines = Array.from({ length: 400 }, (_, i) => ({ src: `s${i}`, ja: `j${i}` }));
  assert.equal(normalizeTranscript({ sessionId: "s", lines }).lines.length, 300);
});

test("buildTranslateBody: モデルはサーバーの値を使い、余計な項目は捨てる", () => {
  const b = buildTranslateBody({
    model: "gpt-4o", temperature: 2, messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
    max_completion_tokens: 99999, reasoning_effort: "high",
  }, "gpt-5.4-mini");
  assert.deepEqual(b, { model: "gpt-5.4-mini", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], max_completion_tokens: 2000, reasoning_effort: "none" });
});

test("buildTranslateBody: 不正な役割・大きすぎる入力は拒否", () => {
  assert.equal(buildTranslateBody({ messages: [{ role: "assistant", content: "x" }] }, "d"), null);
  assert.equal(buildTranslateBody({ messages: [{ role: "user", content: "x".repeat(20001) }] }, "d"), null);
  assert.equal(buildTranslateBody({ messages: [] }, "d"), null);
  assert.equal(buildTranslateBody(null, "d"), null);
});

test("normalizeEndpoint: リソース名だけ・/openai/v1 付きのどちらも受け付ける", () => {
  assert.equal(normalizeEndpoint("proj-x"), "https://proj-x.openai.azure.com");
  assert.equal(normalizeEndpoint("https://proj-x.openai.azure.com/openai/v1/"), "https://proj-x.openai.azure.com");
  assert.equal(normalizeEndpoint(""), "");
});

test("requireUser: owner と member だけ通す", () => {
  assert.equal(requireUser(principal(["anonymous", "authenticated", "owner"])), null);
  assert.equal(requireUser(principal(["authenticated", "member"])), null);
  assert.equal(requireUser(principal(["authenticated"])).status, 403);
  assert.equal(requireUser({ headers: { get: () => null } }).status, 403);
});

test("scrub：年や件数が続いても数字の並びは消さない", () => {
  assert.equal(scrub("between 2015 2016 and 2,50,000 actions, 1 2 3 4 5"), "between 2015 2016 and 2,50,000 actions, 1 2 3 4 5");
  assert.equal(scrub("call 090-1234-5678 2026"), "call [番号] 2026");
  assert.equal(scrub("id 12345678901"), "id [番号]");
});
