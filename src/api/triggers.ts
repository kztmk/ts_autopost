// 投稿トリガー（時間ベース）の管理。ハンドラは posting.ts の autoPost。

import { VERSION } from "../constants";
import { deleteTriggersByHandler } from "../utils";

export const POSTING_HANDLER = "autoPost";
export const ENGAGEMENT_HANDLER = "updateAllEngagement";
const TRIGGER_INTERVAL_PREFIX = "triggerInterval_";
// GAS の everyMinutes が受け付ける値はこの 5 つのみ。
// それ以外を渡すと「既存トリガー削除後に作成で例外 → トリガー消失」になるため事前検証する。
const VALID_INTERVALS = [1, 5, 10, 15, 30];

/** triggerInterval_* プロパティをすべて削除する（トリガー削除・作り直しの際の掃除） */
function cleanupTriggerIntervalProps(): void {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach((key) => {
    if (key.indexOf(TRIGGER_INTERVAL_PREFIX) === 0) {
      props.deleteProperty(key);
    }
  });
}

/**
 * 時間ベースの投稿トリガーを作成する。既存の autoPost トリガーは削除してから作り直す。
 * @param data intervalMinutes（1 / 5 / 10 / 15 / 30 のいずれか）
 */
export function createPostingTrigger(data: any) {
  const intervalMinutes = data?.intervalMinutes;
  if (VALID_INTERVALS.indexOf(intervalMinutes) === -1) {
    throw new Error(
      `Invalid interval: must be one of ${VALID_INTERVALS.join(", ")} (GAS everyMinutes の制約).`
    );
  }

  deleteTriggersByHandler(POSTING_HANDLER);
  cleanupTriggerIntervalProps();

  const trigger = ScriptApp.newTrigger(POSTING_HANDLER)
    .timeBased()
    .everyMinutes(intervalMinutes)
    .create();
  const triggerId = trigger.getUniqueId();
  PropertiesService.getScriptProperties().setProperty(
    TRIGGER_INTERVAL_PREFIX + triggerId,
    String(intervalMinutes)
  );

  return {
    status: "success",
    functionName: POSTING_HANDLER,
    triggerId,
    intervalMinutes,
  };
}

/** すべての autoPost トリガーを削除する（interval プロパティも掃除） */
export function deletePostingTriggers() {
  const deleted = deleteTriggersByHandler(POSTING_HANDLER);
  cleanupTriggerIntervalProps();
  return { status: "success", deleted };
}

/** エンゲージメント日次更新トリガー（updateAllEngagement）が無ければ作成する */
export function ensureEngagementTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(
    (t) => t.getHandlerFunction() === ENGAGEMENT_HANDLER
  );
  if (exists) {
    return { functionName: ENGAGEMENT_HANDLER, created: false, exists: true };
  }
  ScriptApp.newTrigger(ENGAGEMENT_HANDLER).timeBased().everyDays(1).create();
  return { functionName: ENGAGEMENT_HANDLER, created: true, exists: true };
}

/** エンゲージメント日次更新トリガーを削除する */
export function deleteEngagementTrigger() {
  const deleted = deleteTriggersByHandler(ENGAGEMENT_HANDLER);
  return { status: "success", deleted };
}

/** 指定関数名のトリガー有無と間隔を返す */
export function checkTriggerExists(functionName: string) {
  const name = String(functionName || "").trim();
  if (!name) {
    throw new Error("Missing required parameter: functionName.");
  }
  const props = PropertiesService.getScriptProperties();
  let triggerFound = false;
  let triggerId: string | null = null;
  let intervalMinutes: number | null = null;

  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (triggerFound || trigger.getHandlerFunction() !== name) return;
    triggerFound = true;
    triggerId = trigger.getUniqueId();
    const intervalStr = props.getProperty(TRIGGER_INTERVAL_PREFIX + triggerId);
    if (intervalStr) intervalMinutes = parseInt(intervalStr, 10);
  });

  return {
    functionName: name,
    triggerFound,
    triggerId,
    intervalMinutes,
    version: VERSION,
  };
}
