#!/usr/bin/env node
// Proxy 契約の疎通テスト（フロントエンド無しでの検証手段）。
// snake-sns の functions/src/handlers/proxy.ts と同一の署名ロジックを再現し、
// GAS 側 security.ts が「本物の Functions と同じ形のリクエスト」を受理することを確認する。
//
// 使い方（GAS を Web アプリとしてデプロイし、URL を取得した後）:
//   1) 初期化: スプレッドシートのメニューで本人確認コードを生成してから
//        GAS_URL=<webapp url> node tools/proxy-test.mjs init <uid> <setupCode>
//      → proxySecret が表示される
//   2) 状態確認（無認証 GET）:
//        GAS_URL=<url> node tools/proxy-test.mjs status
//   3) 署名付き GET（認証ゲート通過を確認。target は未実装なので 501 が正常）:
//        GAS_URL=<url> node tools/proxy-test.mjs signed-get <uid> <proxySecret> [target]
//   4) 署名付き POST（同上）:
//        GAS_URL=<url> node tools/proxy-test.mjs signed-post <uid> <proxySecret> [target] [action]
//   5) 改竄署名（401 Invalid request signature が正常）:
//        GAS_URL=<url> node tools/proxy-test.mjs bad-sig <uid> <proxySecret>
//   6) 無署名（認証情報を一切付けず保護ルートを叩く。401 が正常）:
//        GAS_URL=<url> node tools/proxy-test.mjs no-auth [target]
//
// 期待結果の読み方:
//   - 認証ゲートを通過すると code:501 (Not implemented) が返る = 署名検証 OK（Phase 1 では正常）
//   - 署名が不正なら code:401 "Invalid request signature." が返る = 拒否が正しく機能

import { createHmac, randomUUID } from "node:crypto";

const AUTH_QUERY_PARAM_KEYS = new Set([
  "uid",
  "firebaseUid",
  "timestamp",
  "signature",
  "requestId",
]);

// ---- proxy.ts と 1 バイトも違えない署名ロジック ----

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stripAuthField(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const sanitized = {};
  Object.keys(body).forEach((key) => {
    if (key !== "_auth") sanitized[key] = body[key];
  });
  return sanitized;
}

function createQuerySignatureBody(params) {
  const body = {};
  const keys = Array.from(new Set(Array.from(params.keys())));
  keys.forEach((key) => {
    if (AUTH_QUERY_PARAM_KEYS.has(key)) return;
    body[key] = params.getAll(key);
  });
  return body;
}

function createRequestSignature(secret, timestamp, uid, action, target, body) {
  const payload = [
    timestamp,
    uid,
    action || "",
    target || "",
    stableStringify(body || {}),
  ].join(".");
  return createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createProxyAuthPayload(secret, uid, action, target, body) {
  const timestamp = String(Date.now());
  const requestId = randomUUID();
  return {
    uid,
    timestamp,
    requestId,
    signature: createRequestSignature(secret, timestamp, uid, action, target, body),
  };
}

// ---- HTTP ----

function requireUrl() {
  const url = process.env.GAS_URL;
  if (!url) {
    console.error("環境変数 GAS_URL に Web アプリの URL を設定してください。");
    process.exit(1);
  }
  return url;
}

async function printResponse(res) {
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  console.log(`HTTP ${res.status}`);
  console.log(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));
  return parsed;
}

async function cmdInit(uid, setupCode) {
  const url = new URL(requireUrl());
  url.searchParams.set("target", "security");
  url.searchParams.set("action", "initialize");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid, setupCode }),
    redirect: "follow",
  });
  const parsed = await printResponse(res);
  if (parsed?.data?.proxySecret) {
    console.log("\n=> proxySecret を控えて以降のテストに使ってください。");
  }
}

async function cmdStatus() {
  const url = new URL(requireUrl());
  url.searchParams.set("target", "security");
  url.searchParams.set("action", "status");
  const res = await fetch(url, { method: "GET", redirect: "follow" });
  await printResponse(res);
}

async function cmdSignedGet(uid, secret, target = "postData") {
  const action = "fetch"; // proxy.ts は action=fetch のときだけ GET で転送する
  const params = new URLSearchParams();
  params.set("action", action);
  params.set("target", target);
  const bodyForSignature = createQuerySignatureBody(params);
  const auth = createProxyAuthPayload(secret, uid, action, target, bodyForSignature);
  params.set("uid", auth.uid);
  params.set("timestamp", auth.timestamp);
  params.set("signature", auth.signature);
  params.set("requestId", auth.requestId);

  const url = new URL(requireUrl());
  params.forEach((v, k) => url.searchParams.append(k, v));
  const res = await fetch(url, { method: "GET", redirect: "follow" });
  await printResponse(res);
}

async function cmdSignedPost(uid, secret, target = "postData", action = "create") {
  const body = {}; // Phase 1 では空ボディで十分（署名検証のみ確認）
  const bodyForSignature = stripAuthField(body);
  const auth = createProxyAuthPayload(secret, uid, action, target, bodyForSignature);

  const url = new URL(requireUrl());
  url.searchParams.set("action", action);
  url.searchParams.set("target", target);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, _auth: auth }),
    redirect: "follow",
  });
  await printResponse(res);
}

async function cmdBadSig(uid, secret) {
  // わざと違う秘密で署名し、拒否されることを確認する
  await cmdSignedGet(uid, secret + "_tampered", "postData");
}

async function cmdNoAuth(target = "postData") {
  // 認証情報を一切付けずに保護ルートを GET する。401 で拒否されるのが正常。
  const url = new URL(requireUrl());
  url.searchParams.set("action", "fetch");
  url.searchParams.set("target", target);
  const res = await fetch(url, { method: "GET", redirect: "follow" });
  await printResponse(res);
}

const [cmd, ...args] = process.argv.slice(2);

const run = {
  init: () => cmdInit(args[0], args[1]),
  status: () => cmdStatus(),
  "signed-get": () => cmdSignedGet(args[0], args[1], args[2]),
  "signed-post": () => cmdSignedPost(args[0], args[1], args[2], args[3]),
  "bad-sig": () => cmdBadSig(args[0], args[1]),
  "no-auth": () => cmdNoAuth(args[0]),
};

if (!cmd || !run[cmd]) {
  console.error(
    "usage: GAS_URL=<url> node tools/proxy-test.mjs <init|status|signed-get|signed-post|bad-sig|no-auth> [...args]"
  );
  process.exit(1);
}

run[cmd]().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
