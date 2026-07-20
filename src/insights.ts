// エンゲージメント（インサイト）の取得と日次蓄積。
// 投稿単位の数値を Posted シートに書き込む（Q8 合意: 投稿単位のみ蓄積）。
// アカウント全体はオンデマンド取得のみ（蓄積しない）。

import { readPostedRows, writePostedEngagement } from "./api/postData";
import { getThreadsPostInsights, getThreadsAccountInsights } from "./api/threadsAuth";
import { getBlueskyPostEngagement, getBlueskyAccountInsights } from "./api/blueskyAuth";
import { logErrorToSheet } from "./utils";
import { Engagement, Platform } from "./types";

// レート制限対策: 投稿ごとの待機と、GAS 実行時間制限を睨んだ時間予算
const ENGAGEMENT_FETCH_INTERVAL_MS = 500;
const ENGAGEMENT_TIME_BUDGET_MS = 5 * 60 * 1000;
// 前回どこまで処理したかを記憶するカーソル（ラウンドロビン用）
const ENGAGEMENT_CURSOR_PROP = "engagement_cursor";

/** 投稿単位のエンゲージメントを Platform に応じて取得する */
function getPostEngagement(platform: Platform, accountId: string, postId: string): Engagement {
  if (platform === "threads") return getThreadsPostInsights(accountId, postId);
  if (platform === "bluesky") return getBlueskyPostEngagement(postId);
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * 【トリガーハンドラ】Posted シートを走査し、各投稿のエンゲージメントを最新化する。
 * 失敗した行はスキップして続行し、Errors に記録する。
 *
 * 飢餓対策（カーソル方式のラウンドロビン）:
 * 前回処理した行の次から開始し、一巡する。時間予算で中断しても次回は続きから始まるため、
 * 恒久的に取得失敗する行が毎回先頭に来て他行を飢えさせることがない。
 *
 * 排他: アーカイブ（Posted のコピー→削除）と同じ ScriptLock を取り、更新の取りこぼしを防ぐ。
 * autoPost が実行中（ロック保持中）なら今回はスキップし、次回の実行に委ねる。
 */
export function updateAllEngagement(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log("updateAllEngagement: 他処理がロック中のためスキップ（次回に再開）。");
    return;
  }
  try {
    const startMs = Date.now();
    const props = PropertiesService.getScriptProperties();
    const rows = readPostedRows();
    if (rows.length === 0) {
      Logger.log("updateAllEngagement: 対象なし。");
      return;
    }

    const cursor = props.getProperty(ENGAGEMENT_CURSOR_PROP) || "";
    const cursorIdx = rows.findIndex((r: any) => String(r.id) === cursor);
    const startIdx = cursorIdx >= 0 ? (cursorIdx + 1) % rows.length : 0;

    let updated = 0;
    let skipped = 0;
    let lastId = cursor;

    for (let k = 0; k < rows.length; k++) {
      if (Date.now() - startMs > ENGAGEMENT_TIME_BUDGET_MS) {
        Logger.log(`updateAllEngagement: 時間予算に達したため中断（${updated}件更新）。`);
        break;
      }
      const row: any = rows[(startIdx + k) % rows.length];
      const id = String(row.id || "").trim();
      const postId = String(row.postId || "");
      const platform = String(row.platform || "") as Platform;
      if (!id || !postId || (platform !== "threads" && platform !== "bluesky")) {
        continue; // 処理対象外（カーソルは進めない）
      }
      lastId = id; // 成否に関わらずカーソルを進め、次回は次の行から始める
      try {
        const eng = getPostEngagement(platform, row.accountId, postId);
        // 書き込みは id で行を再検索する（並行アーカイブでのシート差し替えに対して安全）
        if (writePostedEngagement(id, eng)) {
          updated++;
        } else {
          skipped++; // 対象行が見つからない（アーカイブ等）→ 更新扱いにしない
        }
      } catch (e: any) {
        skipped++;
        logErrorToSheet(
          { message: e.message, stack: e.stack, detail: `platform=${platform} postId=${postId} id=${id}` },
          "updateAllEngagement"
        );
      }
      Utilities.sleep(ENGAGEMENT_FETCH_INTERVAL_MS);
    }

    props.setProperty(ENGAGEMENT_CURSOR_PROP, lastId);
    Logger.log(`updateAllEngagement 完了: 更新=${updated} スキップ=${skipped} / 全${rows.length}行。`);
  } finally {
    lock.releaseLock();
  }
}

/** 【エディタ実行用】エンゲージメント更新を 1 回手動実行する */
export function runEngagementUpdateOnce(): void {
  updateAllEngagement();
  Logger.log("runEngagementUpdateOnce 完了。Posted シートの数値列を確認してください。");
}

/** アカウント全体の現在インサイトを取得する（オンデマンド。蓄積しない） */
export function getAccountInsights(data: any): { platform: string; accountId: string; insights: { [key: string]: number } } {
  const platform = String(data?.platform || "") as Platform;
  const accountId = String(data?.accountId || "").trim();
  if (!accountId) throw new Error("Missing required field: accountId.");
  let insights: { [key: string]: number };
  if (platform === "threads") insights = getThreadsAccountInsights(accountId);
  else if (platform === "bluesky") insights = getBlueskyAccountInsights(accountId);
  else throw new Error(`Invalid platform: ${platform}`);
  return { platform, accountId, insights };
}
