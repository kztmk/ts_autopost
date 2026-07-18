import { SHEETS, HEADERS } from "./constants";
import { ErrorLogEntry } from "./types";
import { ensureSheet } from "./sheets";

/**
 * Errors シートにエラーを記録する。シートが無ければ作成する。
 */
export function logErrorToSheet(errorInfo: ErrorLogEntry, context: string): void {
  try {
    const { sheet } = ensureSheet(SHEETS.ERRORS, HEADERS.ERROR_HEADERS);

    const row = HEADERS.ERROR_HEADERS.map((header) => {
      if (header === "timestamp") {
        return errorInfo.timestamp || new Date().toISOString();
      }
      if (header === "context") {
        return context || errorInfo.context || "";
      }
      return (errorInfo as any)[header] ?? "";
    });
    sheet.appendRow(row);
  } catch (e: any) {
    Logger.log(`logErrorToSheet failed: ${e.message}`);
  }
}

/**
 * 429（レート制限）を考慮したリトライ付き HTTP リクエスト。
 */
export function fetchWithRetries(
  url: string,
  options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions,
  retries: number = 3
): GoogleAppsScript.URL_Fetch.HTTPResponse {
  let response: GoogleAppsScript.URL_Fetch.HTTPResponse | undefined;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() !== 429) {
        return response;
      }
      if (handleRateLimiting(response)) {
        continue;
      }
      return response;
    } catch (e: any) {
      if (attempt < retries - 1) {
        Logger.log(`fetch attempt ${attempt + 1} failed: ${e}. Retrying...`);
        Utilities.sleep(2000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `Request failed after ${retries} retries. Last response: ${response?.getContentText()}`
  );
}

function handleRateLimiting(
  response: GoogleAppsScript.URL_Fetch.HTTPResponse
): boolean {
  if (response.getResponseCode() !== 429) return false;
  const headers = response.getHeaders() as { [key: string]: string };

  // Bluesky (AT Protocol) は ratelimit-reset（epoch 秒）、
  // 汎用には Retry-After（秒）を返すサーバーもある。どちらも無ければ固定待ち。
  let waitTime = 5000;
  const resetEpoch = parseInt(headers["ratelimit-reset"] as string, 10);
  const retryAfter = parseInt(headers["retry-after"] as string, 10);
  if (!isNaN(resetEpoch)) {
    waitTime = Math.max((resetEpoch - Math.floor(Date.now() / 1000)) * 1000 + 5000, 0);
  } else if (!isNaN(retryAfter)) {
    waitTime = retryAfter * 1000 + 1000;
  }

  Logger.log(`Rate limited. Waiting ${waitTime / 1000}s`);
  Utilities.sleep(Math.min(waitTime, 60000));
  return true;
}

/**
 * 機密文字列をマスクする（先頭 3 文字のみ表示）。
 */
export function maskSensitive(value: string | null | undefined): string {
  if (!value || value.length <= 3) return "***";
  return value.substring(0, 3) + "*".repeat(Math.min(value.length - 3, 12));
}

/** UUID を生成する */
export function newId(): string {
  return Utilities.getUuid();
}

/** JSON を安全にパースする。失敗時は fallback を返す */
export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    return fallback;
  }
}

/**
 * 指定ハンドラ名のトリガーを削除する。
 * @returns 削除した件数
 */
export function deleteTriggersByHandler(handlerName: string): number {
  let count = 0;
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(trigger);
      count++;
    }
  });
  return count;
}
