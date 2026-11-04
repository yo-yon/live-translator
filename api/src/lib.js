// 共通処理：本人確認・入力の整形・個人情報の除去・テーブル操作・中央への転送
const crypto = require("node:crypto");

const APP_NAME = "live-translator";
const ALLOWED_ROLES = ["owner", "member"];
const TABLE_NAME = process.env.TABLE_NAME || "livetranslator";

/* ---------- 本人確認 ---------- */

/** SWA が付ける x-ms-client-principal（Base64 の JSON）を読む */
function getPrincipal(request) {
  const raw = request.headers.get("x-ms-client-principal");
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** ルート設定に加えて、API 側でもロールを再確認する（owner または member） */
function requireUser(request) {
  const p = getPrincipal(request);
  const roles = Array.isArray(p?.userRoles) ? p.userRoles : [];
  if (!ALLOWED_ROLES.some((r) => roles.includes(r))) {
    return { status: 403, jsonBody: { error: "forbidden" } };
  }
  return null;
}

/* ---------- 入力の整形 ---------- */

const clip = (s, n) => (s == null ? "" : String(s).slice(0, n));

/**
 * 個人情報らしい文字列を伏せる（メールアドレス・URL・電話番号・長い数字列）。
 * 字幕ログやコメントに混ざることがあるため、保存と転送の前に必ず通す。
 */
function scrub(text) {
  return String(text ?? "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[メール]")
    .replace(/\bhttps?:\/\/[^\s"'<>）)]+/gi, "[URL]")
    .replace(/\bwww\.[^\s"'<>）)]+/gi, "[URL]")
    // 電話番号：区切り（- . 括弧）のある書き方だけ。「2015 2016」のような数字の並びは残す
    .replace(/(?<!\d)(?:\+?\d{1,3}[-.\s]?)?(?:\(\d{2,4}\)[-.\s]?|\d{2,4}[-.])\d{2,4}[-.]\d{3,4}(?!\d)/g, "[番号]")
    .replace(/(?<![\d,.])\d{10,}(?![\d,.])/g, "[番号]");
}

const FB_KINDS = new Set(["content", "app"]);
const FB_CATEGORIES = {
  content: new Set(["asr", "translation", "other"]), // 聞き取り違い / 訳が不自然 / その他
  app: new Set(["feature", "usability", "bug", "other"]), // 機能の要望 / 使い勝手 / 不具合 / その他
};

/** フィードバック1件を検証して保存用の形にそろえる。不正なら null */
function normalizeFeedback(b) {
  if (!b || typeof b !== "object") return null;
  if (!FB_KINDS.has(b.kind) || !FB_CATEGORIES[b.kind].has(b.category)) return null;
  const comment = scrub(clip(b.comment, 1000)).trim();
  if (b.kind === "app" && !comment) return null;
  return {
    kind: b.kind,
    category: b.category,
    original: scrub(clip(b.original, 600)),
    translated: scrub(clip(b.translated, 600)),
    correct: scrub(clip(b.correct, 300)),
    comment,
    engine: clip(b.engine, 20),
    sessionTitle: scrub(clip(b.sessionTitle, 200)),
    context: { version: clip(b.context?.version, 20), device: clip(b.context?.device, 20), mode: clip(b.context?.mode, 20) },
    status: "open",
    at: new Date().toISOString(),
  };
}

/**
 * 翻訳の依頼を検証する。ブラウザから来た値のうち、サーバーで使ってよいものだけを残す。
 * モデル（デプロイ名）はサーバー側の設定を使い、ブラウザの指定は無視する。
 */
function buildTranslateBody(b, deployment) {
  if (!b || !Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 4) return null;
  const messages = [];
  let total = 0;
  for (const m of b.messages) {
    if (!m || !["system", "user"].includes(m.role) || typeof m.content !== "string") return null;
    total += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (total > 20000) return null;
  const effort = ["none", "low", "minimal", "medium"].includes(b.reasoning_effort) ? b.reasoning_effort : "none";
  const max = Math.max(50, Math.min(2000, parseInt(b.max_completion_tokens, 10) || 400));
  return { model: deployment, messages, max_completion_tokens: max, reasoning_effort: effort };
}

/** Foundry のエンドポイントを「https://<名前>.openai.azure.com」の形にそろえる */
function normalizeEndpoint(v) {
  let s = String(v || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}.openai.azure.com`;
  return s.replace(/\/openai(\/v1)?$/i, "");
}

/* ---------- テーブル ---------- */

let tableClient = null;
let tableReady = null;
async function table() {
  if (!tableClient) {
    const cs = process.env.STORAGE_CONNECTION_STRING;
    if (!cs) throw new Error("STORAGE_CONNECTION_STRING が未設定です");
    const { TableClient } = require("@azure/data-tables");
    tableClient = TableClient.fromConnectionString(cs, TABLE_NAME);
    tableReady = tableClient.createTable().catch((e) => {
      if (e.statusCode !== 409) throw e; // 409 = すでに存在
    });
  }
  await tableReady;
  return tableClient;
}

/** 新しい順に並ぶ RowKey（9e15 から現在時刻を引く）＋同時刻の衝突よけ */
const descKey = () => `${String(9e15 - Date.now()).padStart(16, "0")}-${crypto.randomBytes(3).toString("hex")}`;

async function insertRow(pk, rk, obj) {
  const t = await table();
  await t.upsertEntity({ partitionKey: pk, rowKey: rk, data: JSON.stringify(obj) }, "Replace");
}

async function listPartition(pk, limit = 200) {
  const t = await table();
  const out = [];
  const iter = t.listEntities({ queryOptions: { filter: `PartitionKey eq '${pk.replace(/'/g, "''")}'` } });
  for await (const e of iter) {
    try { out.push({ id: e.rowKey, ...JSON.parse(e.data) }); } catch { /* 壊れた行は読み飛ばす */ }
    if (out.length >= limit) break;
  }
  return out;
}

/** この環境のランダムな ID（中央では利用者をこの ID だけで区別する）。初回に作って保存 */
let cachedInstanceId = null;
async function instanceId() {
  if (cachedInstanceId) return cachedInstanceId;
  const t = await table();
  try {
    const e = await t.getEntity("settings", "instance");
    cachedInstanceId = JSON.parse(e.data).instanceId;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
    cachedInstanceId = crypto.randomUUID();
    await t.upsertEntity({ partitionKey: "settings", rowKey: "instance", data: JSON.stringify({ instanceId: cachedInstanceId }) }, "Replace");
  }
  return cachedInstanceId;
}

/* ---------- 中央の受け口への転送 ---------- */

// 送り先は環境変数 FEEDBACK_HUB_URL（作者の受付 feedback-hub の https://<受付>/api/collect）。
// 空なら機能ごと無効。English Trainer と同じ送信形式（v1）で送る
const HUB_URL = () => String(process.env.FEEDBACK_HUB_URL || "").trim().replace(/\/+$/, "");
const centralConfigured = () => /^https:\/\/[^\s]+$/i.test(HUB_URL());

const FB_TEXT = { asr: "聞き取り違い", translation: "訳が不自然", other: "その他", feature: "機能の要望", usability: "使い勝手", bug: "不具合" };

/** 保存したフィードバック1件を、受付の形式（v1）にする */
function hubFeedback(item, iid) {
  const content = item.kind === "content";
  return {
    v: 1, type: "feedback", app: APP_NAME, instanceId: iid, appVersion: item.context?.version || "",
    item: {
      kind: content ? "content" : "app",
      category: FB_TEXT[item.category] || "その他",
      targetType: content ? (item.category === "translation" ? "translation" : "caption") : "",
      // 同じ語への指摘を、別々の人からのものとして集計できるようにする（正しい語があればそれ）
      targetId: content ? clip(String(item.correct || item.original || "").toLowerCase().replace(/\s+/g, " ").trim(), 100) : "",
      targetText: content ? (item.original || item.translated) : "",
      comment: item.comment,
      detail: content
        ? { variant: "live", engine: item.engine, source: item.original, translated: item.translated, expected: item.correct }
        : { variant: "live" },
      context: { tab: item.context?.mode || "", device: item.context?.device || "" },
    },
  };
}

async function postJson(url, body, context) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) context?.warn?.(`feedback hub failed: ${r.status}`);
    return r.ok;
  } catch (e) {
    context?.warn?.(`feedback hub error: ${e.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 作者の受付に送る（サーバー間）。利用者が「作者にも送る」を選んだものだけ呼ぶ。
 * 失敗しても利用者側の保存は成功扱いにする。
 * @returns {Promise<boolean>} 送れたか
 */
async function forwardToCentral(kind, item, iid, context) {
  if (!centralConfigured()) return false;
  if (kind !== "feedback") return false; // 字幕ログ全体は送らない（社外秘や発言内容が混じるため）
  return postJson(HUB_URL(), hubFeedback(item, iid), context);
}

const bad = (msg) => ({ status: 400, jsonBody: { error: msg } });
const fail = (context, e) => {
  context.error(e);
  return { status: 500, jsonBody: { error: "server_error" } };
};

module.exports = {
  APP_NAME, getPrincipal, requireUser, clip, scrub, normalizeFeedback,
  buildTranslateBody, normalizeEndpoint, table, descKey, insertRow, listPartition, instanceId,
  centralConfigured, forwardToCentral, hubFeedback, bad, fail,
};
