// 投稿ループ（トリガーハンドラ autoPost）。
// Posts シートを走査し、時刻の来た Post を各 Platform へ投稿して Posted へ移送する。
// Bluesky / Threads を実処理する（スレッド連投 inReplyTo は Phase 6）。

import {
  readPostRows,
  movePostToPosted,
  markPostFailed,
  updatePostStatus,
} from "./api/postData";
import { postToBluesky } from "./api/blueskyAuth";
import { postToThreads, getThreadsRemainingQuota } from "./api/threadsAuth";
import { deletePostingTriggers } from "./api/triggers";
import { logErrorToSheet } from "./utils";
import { PostRow, Platform } from "./types";

const MAX_POSTS_PER_RUN = 20;
const LOCK_WAIT_MS = 0; // 取れなければ次のトリガー実行に任せる
// Platform 型の全値と一致するが、シート上の不正値（手編集等）を弾くガードとして明示する。
const SUPPORTED_PLATFORMS: Platform[] = ["bluesky", "threads"];
// Threads クォータの安全マージン。「上限近接時は見送り」（development-plan Phase 4）の実装。
// 残枠がこの値以下になったら投稿せず次回へ持ち越す（チェック後〜publish 間の枯渇レース対策）。
const THREADS_QUOTA_SAFETY_MARGIN = 2;

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
 * mediaUrls 列（JSON 配列文字列）を厳格にパースする。
 * 破損 JSON を [] に黙殺すると「画像付きのはずが画像なしで成功」する
 * サイレント経路になるため、不正なら throw して failed + Errors 記録に乗せる。
 */
function parseMediaUrls(raw: string): string[] {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(`mediaUrls が不正な JSON です: ${s}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`mediaUrls は JSON 配列である必要があります: ${s}`);
  }
  return parsed.map((u) => String(u));
}

/** Post を該当 Platform へ投稿し、公開後の投稿 ID を返す */
function publishPost(post: PostRow): string {
  const mediaUrls = parseMediaUrls(post.mediaUrls);
  if (post.platform === "bluesky") return postToBluesky(post.accountId, post.contents, mediaUrls);
  if (post.platform === "threads") return postToThreads(post.accountId, post.contents, mediaUrls);
  throw new Error(`Unsupported platform: ${post.platform}`);
}

/**
 * Threads クォータのラン内トラッカー。
 * threads_publishing_limit API はアカウントごとに 1 ラン 1 回だけ呼び、
 * 以降はラン内で消費数を差し引いて判定する（行ごとの API 呼び出しを避ける）。
 */
class ThreadsQuotaTracker {
  private remaining: { [accountId: string]: number } = {};

  /** この Post を見送るべきか（残枠がマージン以下）。Threads 以外は常に false */
  shouldDefer(post: PostRow): boolean {
    if (post.platform !== "threads") return false;
    if (!(post.accountId in this.remaining)) {
      this.remaining[post.accountId] = getThreadsRemainingQuota(post.accountId);
    }
    if (this.remaining[post.accountId] <= THREADS_QUOTA_SAFETY_MARGIN) {
      Logger.log(
        `Threads quota near limit for ${post.accountId} (remaining=${this.remaining[post.accountId]}); deferring ${post.id}.`
      );
      return true;
    }
    return false;
  }

  /** 投稿を 1 件消費したことを記録する */
  consume(post: PostRow): void {
    if (post.platform === "threads" && post.accountId in this.remaining) {
      this.remaining[post.accountId]--;
    }
  }
}

/**
 * トリガーから呼ばれる投稿ループ。
 * 対象: status が queued/空・postId 未設定・スレッド子でない（inReplyTo 空）・時刻到来。
 *
 * 二重投稿ガード（x_Autopost の processing キャッシュ方式に相当）:
 *  - ScriptLock で並行実行を直列化（取れなければ即リターンし次回に任せる）
 *  - 投稿前に status を "processing" へ更新。isQueued は processing を対象外とするため、
 *    投稿成功後の Posted 移送が万一失敗しても、次回実行で同じ行を再投稿しない
 *    （processing のまま残った行は Errors シートとあわせて人が確認する）。
 */
export function autoPost(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log("autoPost: previous run still in progress. Skipping.");
    return;
  }

  try {
    const nowMs = Date.now();
    const due = readPostRows().filter(
      (r) =>
        isQueued(r) &&
        !r.inReplyTo &&
        SUPPORTED_PLATFORMS.indexOf(r.platform) !== -1 &&
        isDue(r.postSchedule, nowMs)
    );

    const quotaTracker = new ThreadsQuotaTracker();
    let processed = 0;
    for (const post of due) {
      if (processed >= MAX_POSTS_PER_RUN) break;
      if (quotaTracker.shouldDefer(post)) continue; // queued のまま次回へ

      processed++;
      updatePostStatus(post.id, "processing");
      try {
        const platformPostId = publishPost(post);
        quotaTracker.consume(post);
        try {
          movePostToPosted(post, platformPostId);
        } catch (moveError: any) {
          // 投稿自体は成功している。processing のまま残し、再投稿はしない。
          logErrorToSheet(
            {
              message: `投稿は成功したが Posted への移送に失敗: ${moveError.message}`,
              stack: moveError.stack,
              detail: `platform=${post.platform} accountId=${post.accountId} postId=${post.id} published=${platformPostId}`,
            },
            "autoPost/movePostToPosted"
          );
        }
      } catch (e: any) {
        markPostFailed(post.id, e.message);
        logErrorToSheet(
          {
            message: e.message,
            stack: e.stack,
            detail: `platform=${post.platform} accountId=${post.accountId} postId=${post.id}`,
          },
          `autoPost/${post.platform}`
        );
      }
    }

    // 実処理対象（対応 Platform・スレッド子でない）の queued が無ければトリガーを自動削除。
    // レート制限で見送った Threads 行は queued のまま残るので、その間はトリガーを維持し
    // 次回以降で再試行する（クォータは 24 時間で回復する）。
    const remaining = readPostRows().filter(
      (r) => isQueued(r) && !r.inReplyTo && SUPPORTED_PLATFORMS.indexOf(r.platform) !== -1
    );
    if (remaining.length === 0) {
      deletePostingTriggers();
    }
  } finally {
    lock.releaseLock();
  }
}

/** 【エディタ実行用】投稿ループを 1 回手動実行する（トリガーを待たずに検証したいとき） */
export function runAutoPostOnce(): void {
  autoPost();
  Logger.log("runAutoPostOnce 完了。Posted / Errors シートを確認してください。");
}
