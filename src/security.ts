// Proxy 契約（CONTEXT.md「Proxy 契約」/ ADR 0001）。
// snake-sns の Firebase Functions（functions/src/handlers/proxy.ts）と
// 1 バイトも違わない署名規約を実装する。ワイヤー上の契約
//   - 署名対象: timestamp.uid.action.target.stableStringify(bodyWithoutAuth)
//   - HMAC-SHA256 → web-safe base64（+→-, /→_, 末尾 = 除去）
//   - POST は body の _auth、GET はクエリパラメータで認証情報を受け取る
//   - 認証専用パラメータ: uid, firebaseUid, timestamp, signature, requestId
// は変更しないこと（変更すると Functions 側と検証不一致になる）。
// プロパティキー・シート名は内部保存用でありワイヤー契約ではない。

const SECURITY_PROP_KEYS = {
  ownerUid: "security_ownerUid",
  proxySecret: "security_proxySecret",
  initializedAt: "security_initializedAt",
  setupCodeHash: "security_setupCodeHash",
  setupCodeExpiresAt: "security_setupCodeExpiresAt",
} as const;

const SECURITY_STATE_SHEET_NAME = "_autopost_security_state";
const SETUP_CODE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TOLERANCE_MS = 5 * 60 * 1000;
const REPLAY_CACHE_TTL_SECONDS = 5 * 60;
const AUTH_QUERY_PARAM_KEYS = new Set<string>([
  "uid",
  "firebaseUid",
  "timestamp",
  "signature",
  "requestId",
]);

interface ProxyAuthPayload {
  uid?: string;
  timestamp?: string | number;
  signature?: string;
  requestId?: string;
}

interface InitializeRequest {
  uid?: string;
  setupCode?: string;
}

export function generateSetupCode(): string {
  const code = createRandomCode();
  const expiresAt = Date.now() + SETUP_CODE_TTL_MS;
  const properties = PropertiesService.getScriptProperties();
  const setupCodeHash = sha256Base64(code);

  properties.setProperties({
    [SECURITY_PROP_KEYS.setupCodeHash]: setupCodeHash,
    [SECURITY_PROP_KEYS.setupCodeExpiresAt]: String(expiresAt),
  });
  saveSetupCodeStateToSheet(setupCodeHash, expiresAt);

  Logger.log(
    `Setup code generated. It expires at ${new Date(expiresAt).toISOString()}.`
  );
  return code;
}

export function getSecurityStatus() {
  const properties = PropertiesService.getScriptProperties();
  const allProps = properties.getProperties();
  const ownerUid = allProps[SECURITY_PROP_KEYS.ownerUid];
  const initializedAt = allProps[SECURITY_PROP_KEYS.initializedAt];
  const setupState = getSetupCodeState(allProps);
  const setupCodeExpiresAt = setupState.setupCodeExpiresAt;

  return {
    initialized: Boolean(ownerUid),
    ownerUid: ownerUid ? maskValue(ownerUid) : "",
    initializedAt: initializedAt || "",
    setupCodeActive:
      Boolean(setupCodeExpiresAt) && Number(setupCodeExpiresAt) > Date.now(),
  };
}

export function initializeProxyAuth(requestData: InitializeRequest) {
  if (!requestData || typeof requestData !== "object") {
    throw new Error("Invalid initialize request body.");
  }

  const uid = normalizeRequiredString(requestData.uid, "uid");
  const setupCode = normalizeRequiredString(requestData.setupCode, "setupCode");
  const properties = PropertiesService.getScriptProperties();
  const allProps = properties.getProperties();
  const existingOwnerUid = allProps[SECURITY_PROP_KEYS.ownerUid];
  const setupState = getSetupCodeState(allProps);
  const expectedHash = setupState.setupCodeHash;
  const expiresAt = Number(setupState.setupCodeExpiresAt || "0");

  if (setupState.source === "sheet") {
    properties.setProperties({
      [SECURITY_PROP_KEYS.setupCodeHash]: expectedHash,
      [SECURITY_PROP_KEYS.setupCodeExpiresAt]: String(expiresAt),
    });
  }

  if (!expectedHash || !expiresAt) {
    throw new Error(
      "Setup code has not been generated. Generate a new setup code from the Spreadsheet menu, then save it in the app before it expires."
    );
  }

  if (Date.now() > expiresAt) {
    clearSetupCode(properties);
    throw new Error("Setup code has expired. Generate a new setup code.");
  }

  if (sha256Base64(setupCode) !== expectedHash) {
    throw new Error("Invalid setup code.");
  }

  if (existingOwnerUid && existingOwnerUid !== uid) {
    throw new Error("このシートは他の方が登録されており使用できません。");
  }

  const proxySecret = createProxySecret(uid, expectedHash);
  const initializedAt = new Date().toISOString();

  properties.setProperties({
    [SECURITY_PROP_KEYS.ownerUid]: uid,
    [SECURITY_PROP_KEYS.proxySecret]: proxySecret,
    [SECURITY_PROP_KEYS.initializedAt]: initializedAt,
  });
  clearSetupCode(properties);

  return {
    status: "initialized",
    ownerUid: maskValue(uid),
    initializedAt,
    proxySecret,
    signatureAlgorithm: "HMAC_SHA256_BASE64_WEBSAFE",
    signaturePayload: "timestamp.uid.action.target.stableJsonPayloadWithoutAuth",
  };
}

function getSetupCodeState(allProps: { [key: string]: string }) {
  const scriptSetupCodeHash = allProps[SECURITY_PROP_KEYS.setupCodeHash] || "";
  const scriptSetupCodeExpiresAt =
    allProps[SECURITY_PROP_KEYS.setupCodeExpiresAt] || "";

  if (scriptSetupCodeHash && scriptSetupCodeExpiresAt) {
    return {
      setupCodeHash: scriptSetupCodeHash,
      setupCodeExpiresAt: scriptSetupCodeExpiresAt,
      source: "scriptProperties",
    };
  }

  const sheetState = loadSetupCodeStateFromSheet();
  if (sheetState.setupCodeHash && sheetState.setupCodeExpiresAt) {
    return {
      ...sheetState,
      source: "sheet",
    };
  }

  return {
    setupCodeHash: "",
    setupCodeExpiresAt: "",
    source: "none",
  };
}

function saveSetupCodeStateToSheet(setupCodeHash: string, expiresAt: number): void {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) {
      Logger.log("Setup code sheet fallback skipped: active spreadsheet not found.");
      return;
    }

    const sheet = getOrCreateSecurityStateSheet(spreadsheet);
    sheet.getRange(1, 1, 3, 2).setValues([
      ["key", "value"],
      [SECURITY_PROP_KEYS.setupCodeHash, setupCodeHash],
      [SECURITY_PROP_KEYS.setupCodeExpiresAt, String(expiresAt)],
    ]);
  } catch (error: any) {
    Logger.log(`Setup code sheet fallback save failed: ${error.message}`);
  }
}

function loadSetupCodeStateFromSheet(): {
  setupCodeHash: string;
  setupCodeExpiresAt: string;
} {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) {
      Logger.log("Setup code sheet fallback load skipped: active spreadsheet not found.");
      return { setupCodeHash: "", setupCodeExpiresAt: "" };
    }

    const sheet = spreadsheet.getSheetByName(SECURITY_STATE_SHEET_NAME);
    if (!sheet) {
      return { setupCodeHash: "", setupCodeExpiresAt: "" };
    }

    const values = sheet.getDataRange().getValues();
    const state: { [key: string]: string } = {};
    values.slice(1).forEach((row) => {
      const key = String(row[0] || "");
      if (key) {
        state[key] = String(row[1] || "");
      }
    });

    return {
      setupCodeHash: state[SECURITY_PROP_KEYS.setupCodeHash] || "",
      setupCodeExpiresAt: state[SECURITY_PROP_KEYS.setupCodeExpiresAt] || "",
    };
  } catch (error: any) {
    Logger.log(`Setup code sheet fallback load failed: ${error.message}`);
    return { setupCodeHash: "", setupCodeExpiresAt: "" };
  }
}

function clearSetupCodeStateSheet(): void {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet?.getSheetByName(SECURITY_STATE_SHEET_NAME);
    if (sheet) {
      sheet.clear();
      hideSheetIfVisible(sheet);
    }
  } catch (error: any) {
    Logger.log(`Setup code sheet fallback clear failed: ${error.message}`);
  }
}

function getOrCreateSecurityStateSheet(
  spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet
): GoogleAppsScript.Spreadsheet.Sheet {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    lock.waitLock(10000);
    lockAcquired = true;
  } catch (lockError) {
    Logger.log(`Could not acquire lock for security state sheet: ${lockError}`);
    throw lockError;
  }

  try {
    let sheet = spreadsheet.getSheetByName(SECURITY_STATE_SHEET_NAME);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(SECURITY_STATE_SHEET_NAME);
    }
    hideSheetIfVisible(sheet);
    return sheet;
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

function hideSheetIfVisible(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  if (!sheet.isSheetHidden()) {
    const visibleSheets = sheet
      .getParent()
      .getSheets()
      .filter((spreadsheetSheet) => !spreadsheetSheet.isSheetHidden());
    if (visibleSheets.length > 1) {
      sheet.hideSheet();
    }
  }
}

export function assertProxyAuthorized(
  e: any,
  action: string,
  target: string,
  requestData: any,
  method: "GET" | "POST"
): void {
  const properties = PropertiesService.getScriptProperties();
  const allProps = properties.getProperties();
  const ownerUid = allProps[SECURITY_PROP_KEYS.ownerUid];
  const proxySecret = allProps[SECURITY_PROP_KEYS.proxySecret];

  if (!ownerUid || !proxySecret) {
    throw new Error("Proxy authorization is not initialized.");
  }

  const authPayload = getAuthPayload(e, requestData, method);
  const uid = normalizeRequiredString(authPayload.uid, "_auth.uid");
  const signature = normalizeRequiredString(
    authPayload.signature,
    "_auth.signature"
  );
  const timestampRaw = normalizeRequiredString(
    authPayload.timestamp,
    "_auth.timestamp"
  );
  const timestamp = Number(timestampRaw);

  if (uid !== ownerUid) {
    throw new Error("このシートは他の方が登録されており使用できません。");
  }

  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid _auth.timestamp.");
  }

  if (Math.abs(Date.now() - timestamp) > REQUEST_TOLERANCE_MS) {
    throw new Error("Request timestamp is outside the allowed window.");
  }

  const requestId = authPayload.requestId
    ? String(authPayload.requestId).trim()
    : signature;
  assertNotReplay(requestId);

  const bodyForSignature =
    method === "POST" ? stripAuthField(requestData) : getQuerySignatureBody(e);
  const expectedSignature = createRequestSignature(
    proxySecret,
    String(timestamp),
    uid,
    action,
    target,
    bodyForSignature
  );

  if (signature !== expectedSignature) {
    // 診断ログ（Apps Script の「実行数」で確認可能）。
    // secret・完全な署名・body 値は決して出さない（キー名のみ）。
    console.log("Signature mismatch", {
      method,
      action,
      target,
      timestamp: timestampRaw,
      bodyKeys:
        bodyForSignature && typeof bodyForSignature === "object"
          ? Object.keys(bodyForSignature).sort()
          : typeof bodyForSignature,
      receivedSigPrefix: signature.slice(0, 6),
      expectedSigPrefix: expectedSignature.slice(0, 6),
    });
    throw new Error("Invalid request signature.");
  }
}

export function stripAuthField<T>(requestData: T): T {
  if (
    !requestData ||
    typeof requestData !== "object" ||
    Array.isArray(requestData)
  ) {
    return requestData;
  }

  const sanitized: { [key: string]: any } = {};
  Object.keys(requestData as any).forEach((key) => {
    if (key !== "_auth") {
      sanitized[key] = (requestData as any)[key];
    }
  });
  return sanitized as T;
}

function getAuthPayload(
  e: any,
  requestData: any,
  method: "GET" | "POST"
): ProxyAuthPayload {
  if (
    method === "POST" &&
    requestData &&
    typeof requestData === "object" &&
    !Array.isArray(requestData) &&
    requestData._auth
  ) {
    return requestData._auth;
  }

  const parameter =
    e && e.parameter && typeof e.parameter === "object" ? e.parameter : {};

  return {
    uid: parameter.uid || parameter.firebaseUid,
    timestamp: parameter.timestamp,
    signature: parameter.signature,
    requestId: parameter.requestId,
  };
}

function getQuerySignatureBody(e: any): { [key: string]: any } {
  const sanitized: { [key: string]: any } = {};
  const rawParameters =
    e && e.parameters && typeof e.parameters === "object" ? e.parameters : null;

  if (rawParameters) {
    Object.keys(rawParameters).forEach((key) => {
      if (isAuthQueryParam(key)) {
        return;
      }

      const value = rawParameters[key];
      if (Array.isArray(value)) {
        sanitized[key] = value.map((item) => String(item));
        return;
      }

      if (value !== undefined) {
        sanitized[key] = [String(value)];
      }
    });
    return sanitized;
  }

  const parameters =
    e && e.parameter && typeof e.parameter === "object" ? e.parameter : {};
  Object.keys(parameters).forEach((key) => {
    if (!isAuthQueryParam(key)) {
      sanitized[key] = [String(parameters[key])];
    }
  });
  return sanitized;
}

function isAuthQueryParam(key: string): boolean {
  return AUTH_QUERY_PARAM_KEYS.has(key);
}

function createRequestSignature(
  secret: string,
  timestamp: string,
  uid: string,
  action: string,
  target: string,
  body: any
): string {
  const payload = [
    timestamp,
    uid,
    action || "",
    target || "",
    stableStringify(body || {}),
  ].join(".");
  // Charset は UTF_8 を明示する。指定しないと非 ASCII（日本語本文など）を含む
  // payload のバイト列が Functions 側（Node crypto は UTF-8）と食い違い、
  // "Invalid request signature." になる。
  const bytes = Utilities.computeHmacSha256Signature(
    payload,
    secret,
    Utilities.Charset.UTF_8
  );
  // Functions は末尾 "=" パディングを除去した web-safe base64 で署名を作る。
  // こちらも除去して両者を一致させる。
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) {
    return "null";
  }

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

function assertNotReplay(requestId: string): void {
  const normalizedRequestId = normalizeRequiredString(
    requestId,
    "_auth.requestId"
  );
  const cacheKey = `security_request_${sha256Base64(normalizedRequestId)}`;
  const cache = CacheService.getScriptCache();

  if (cache.get(cacheKey)) {
    throw new Error("Duplicate request detected.");
  }

  cache.put(cacheKey, "1", REPLAY_CACHE_TTL_SECONDS);
}

function createRandomCode(): string {
  const raw = Utilities.getUuid().replace(/-/g, "").toUpperCase();
  return `${raw.slice(0, 8)}-${raw.slice(8, 16)}-${raw.slice(16, 24)}`;
}

function createProxySecret(uid: string, setupCodeHash: string): string {
  const seed = [
    Utilities.getUuid(),
    Utilities.getUuid(),
    Utilities.getUuid(),
    uid,
    setupCodeHash,
    String(Date.now()),
    getScriptIdForEntropy(),
  ].join(".");

  return sha256Base64(seed);
}

function getScriptIdForEntropy(): string {
  try {
    return ScriptApp.getScriptId();
  } catch (error) {
    return "script-id-unavailable";
  }
}

function sha256Base64(value: string): string {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value
  );
  return Utilities.base64EncodeWebSafe(bytes);
}

function normalizeRequiredString(value: any, fieldName: string): string {
  if (value === null || value === undefined) {
    throw new Error(`Missing required field: ${fieldName}.`);
  }

  const normalized = String(value).trim();
  if (!normalized) {
    throw new Error(`Missing required field: ${fieldName}.`);
  }
  return normalized;
}

function clearSetupCode(
  properties: GoogleAppsScript.Properties.Properties
): void {
  properties.deleteProperty(SECURITY_PROP_KEYS.setupCodeHash);
  properties.deleteProperty(SECURITY_PROP_KEYS.setupCodeExpiresAt);
  clearSetupCodeStateSheet();
}

function maskValue(value: string): string {
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
