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

/** 投稿単位のエンゲージメントを Platform に応じて取得する */
function getPostEngagement(platform: Platform, accountId: string, postId: string): Engagement {
  if (platform === "threads") return getThreadsPostInsights(accountId, postId);
  if (platform === "bluesky") return getBlueskyPostEngagement(postId);
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * 【トリガーハンドラ】Posted シートを走査し、各投稿のエンゲージメントを最新化する。
 * 失敗した行はスキップして続行し、Errors に記録する。
 * 時間予算を超えたら中断（次回の日次実行で続きが更新される）。
 */
export function updateAllEngagement(): void {
  const startMs = Date.now();
  const rows = readPostedRows();
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (Date.now() - startMs > ENGAGEMENT_TIME_BUDGET_MS) {
      Logger.log(`updateAllEngagement: 時間予算に達したため中断（${updated}件更新）。`);
      break;
    }
    const postId = String(row.postId || "");
    const platform = String(row.platform || "") as Platform;
    if (!postId || (platform !== "threads" && platform !== "bluesky")) {
      continue;
    }
    try {
      const eng = getPostEngagement(platform, row.accountId, postId);
      writePostedEngagement(row.__row, eng);
      updated++;
    } catch (e: any) {
      skipped++;
      logErrorToSheet(
        { message: e.message, stack: e.stack, detail: `platform=${platform} postId=${postId} id=${row.id}` },
        "updateAllEngagement"
      );
    }
    Utilities.sleep(ENGAGEMENT_FETCH_INTERVAL_MS);
  }

  Logger.log(`updateAllEngagement 完了: 更新=${updated} スキップ=${skipped} / 全${rows.length}行。`);
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
