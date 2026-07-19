// 投稿トリガー（時間ベース）の管理。ハンドラは posting.ts の autoPost。

import { VERSION } from "../constants";
import { deleteTriggersByHandler } from "../utils";

export const POSTING_HANDLER = "autoPost";
const TRIGGER_INTERVAL_PREFIX = "triggerInterval_";

/**
 * 時間ベースの投稿トリガーを作成する。既存の autoPost トリガーは削除してから作り直す。
 * @param data intervalMinutes（1 以上の整数）
 */
export function createPostingTrigger(data: any) {
  const intervalMinutes = data?.intervalMinutes;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new Error("Invalid interval: must be an integer >= 1.");
  }

  deleteTriggersByHandler(POSTING_HANDLER);

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

/** すべての autoPost トリガーを削除する */
export function deletePostingTriggers() {
  const deleted = deleteTriggersByHandler(POSTING_HANDLER);
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
