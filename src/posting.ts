// 投稿ループ（トリガーハンドラ autoPost）。
// Posts シートを走査し、時刻の来た Post を各 Platform へ投稿して Posted へ移送する。
// Phase 2 では Bluesky のみ実処理する（Threads は Phase 4、スレッド連投は Phase 6）。

import { readPostRows, movePostToPosted, markPostFailed } from "./api/postData";
import { postToBluesky } from "./api/blueskyAuth";
import { POSTING_HANDLER } from "./api/triggers";
import { deleteTriggersByHandler, logErrorToSheet } from "./utils";
import { PostRow } from "./types";

const MAX_POSTS_PER_RUN = 20;

function isDue(postSchedule: string, nowMs: number): boolean {
  if (!postSchedule) return true; // 予約日時なし = 即時
  const d = new Date(postSchedule);
  if (isNaN(d.getTime())) return true; // 不正な日時は投稿を試みる
  return d.getTime() <= nowMs;
}

function isQueued(row: PostRow): boolean {
  const status = String(row.status || ""); // シートのセルは空文字のこともある
  return (status === "queued" || status === "") && !row.postId;
}

/**
 * トリガーから呼ばれる投稿ループ。
 * 対象: status が queued/空・postId 未設定・スレッド子でない（inReplyTo 空）・時刻到来。
 */
export function autoPost(): void {
  const nowMs = Date.now();
  const due = readPostRows().filter(
    (r) => isQueued(r) && !r.inReplyTo && isDue(r.postSchedule, nowMs)
  );

  let processed = 0;
  for (const post of due) {
    if (processed >= MAX_POSTS_PER_RUN) break;

    // Threads は Phase 4 で実装。それまでは queued のまま残す。
    if (post.platform !== "bluesky") continue;

    processed++;
    try {
      const uri = postToBluesky(post.accountId, post.contents);
      movePostToPosted(post, uri);
    } catch (e: any) {
      markPostFailed(post.id, e.message);
      logErrorToSheet(
        { message: e.message, stack: e.stack, detail: `platform=bluesky accountId=${post.accountId} postId=${post.id}` },
        "autoPost/bluesky"
      );
    }
  }

  // 残りの queued（実処理対象）が無ければトリガーを自動削除する。
  // Threads の queued はまだ残るため、bluesky に限って判定する（Phase 4 で見直す）。
  const remainingBluesky = readPostRows().filter(
    (r) => isQueued(r) && r.platform === "bluesky"
  );
  if (remainingBluesky.length === 0) {
    deleteTriggersByHandler(POSTING_HANDLER);
  }
}

/** 【エディタ実行用】投稿ループを 1 回手動実行する（トリガーを待たずに検証したいとき） */
export function runAutoPostOnce(): void {
  autoPost();
  Logger.log("runAutoPostOnce 完了。Posted / Errors シートを確認してください。");
}
