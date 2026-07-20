// 投稿ループ（トリガーハンドラ autoPost）。
// Posts シートを走査し、時刻の来た Post を各 Platform へ投稿して Posted へ移送する。
// Bluesky / Threads を実処理し、スレッド連投（inReplyTo 連鎖）にも対応する。

import {
  readPostRows,
  movePostToPosted,
  markPostFailed,
  updatePostStatus,
  fetchPostedData,
} from "./api/postData";
import { postToBluesky, getBlueskyReplyRef } from "./api/blueskyAuth";
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

/**
 * Post を該当 Platform へ投稿し、公開後の投稿 ID を返す。
 * parentPostId が渡された場合はスレッド返信として投稿する
 * （Threads: reply_to_id / Bluesky: 親 uri から root/parent 参照を解決）。
 */
function publishPost(post: PostRow, parentPostId?: string): string {
  const mediaUrls = parseMediaUrls(post.mediaUrls);
  if (post.platform === "bluesky") {
    const reply = parentPostId ? getBlueskyReplyRef(post.accountId, parentPostId) : undefined;
    return postToBluesky(post.accountId, post.contents, mediaUrls, reply);
  }
  if (post.platform === "threads") {
    return postToThreads(post.accountId, post.contents, mediaUrls, parentPostId);
  }
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
 * due の Post を「親→子」の順に並べる（トポロジカルソート）。
 * バッチ内に親がいる子は、その親より後に処理されるようにする。
 * 深さ = due 内をたどれる祖先の数。祖先が既に Posted 済み（due 外）なら深さに数えない。
 */
function orderByReplyChain(due: PostRow[]): PostRow[] {
  const byId: { [id: string]: PostRow } = {};
  due.forEach((p) => (byId[p.id] = p));
  const depthCache: { [id: string]: number } = {};
  function depth(p: PostRow, seen: { [id: string]: boolean }): number {
    if (p.id in depthCache) return depthCache[p.id];
    if (!p.inReplyTo || !(p.inReplyTo in byId) || seen[p.id]) {
      depthCache[p.id] = 0;
      return 0;
    }
    seen[p.id] = true; // 循環参照ガード
    const d = 1 + depth(byId[p.inReplyTo], seen);
    depthCache[p.id] = d;
    return d;
  }
  return due.slice().sort((a, b) => depth(a, {}) - depth(b, {}));
}

type ParentResolution =
  | { status: "root" }
  | { status: "ready"; parentPostId: string }
  | { status: "wait" }
  | { status: "broken"; reason: string };

/**
 * トリガーから呼ばれる投稿ループ。
 * 対象: status が queued/空・postId 未設定・対応 Platform・時刻到来（子行も含む）。
 *
 * スレッド連投:
 *  - 親（inReplyTo 先）が投稿済みになってから子を投稿する（親→子のトポロジカル順）。
 *  - 親がまだ未投稿（queued/processing）なら子は見送り、次回トリガーで再開。
 *  - 親が failed / 見つからない場合は連鎖を中断し、子も failed にする。
 *  - 連鎖は Platform ごとに独立（親子は必ず同一 Platform。異なれば中断）。
 *
 * 二重投稿ガード:
 *  - ScriptLock で並行実行を直列化（取れなければ即リターン）。
 *  - 投稿前に status を "processing" にし、Posted 移送失敗時も再投稿しない。
 */
export function autoPost(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log("autoPost: previous run still in progress. Skipping.");
    return;
  }

  try {
    const nowMs = Date.now();
    const allPosts = readPostRows();
    const due = orderByReplyChain(
      allPosts.filter(
        (r) =>
          isQueued(r) &&
          SUPPORTED_PLATFORMS.indexOf(r.platform) !== -1 &&
          isDue(r.postSchedule, nowMs)
      )
    );

    // 親の投稿 ID 解決用。Posted 済みの投稿 ID を事前ロードし、
    // このランで投稿した親も逐次追加する（同一ラン内で子が親を参照できるように）。
    const resolvedPostId: { [internalId: string]: string } = {};
    const resolvedPlatform: { [internalId: string]: Platform } = {};
    fetchPostedData().forEach((r: any) => {
      if (r.id && r.postId) {
        resolvedPostId[r.id] = r.postId;
        resolvedPlatform[r.id] = r.platform;
      }
    });
    // 未投稿・失敗の親判定用に Posts 側の status も引けるようにする
    const postsById: { [id: string]: PostRow } = {};
    allPosts.forEach((p) => (postsById[p.id] = p));

    const resolveParent = (post: PostRow): ParentResolution => {
      if (!post.inReplyTo) return { status: "root" };
      const parentId = post.inReplyTo;
      if (parentId in resolvedPostId) {
        if (resolvedPlatform[parentId] !== post.platform) {
          return {
            status: "broken",
            reason: `親(${parentId})と Platform が異なります（親=${resolvedPlatform[parentId]} 子=${post.platform}）`,
          };
        }
        return { status: "ready", parentPostId: resolvedPostId[parentId] };
      }
      const parentPending = postsById[parentId];
      if (parentPending) {
        if (String(parentPending.status) === "failed") {
          return { status: "broken", reason: `親(${parentId})が failed のため連鎖を中断` };
        }
        return { status: "wait" }; // 親がまだ未投稿 → 次回へ
      }
      return { status: "broken", reason: `親(${parentId})が見つかりません` };
    };

    const quotaTracker = new ThreadsQuotaTracker();
    let processed = 0;
    for (const post of due) {
      if (processed >= MAX_POSTS_PER_RUN) break;

      const parent = resolveParent(post);
      if (parent.status === "wait") continue; // queued のまま次回へ
      if (parent.status === "broken") {
        markPostFailed(post.id, parent.reason);
        if (postsById[post.id]) postsById[post.id].status = "failed"; // 同ラン内の子に連鎖中断を伝播
        logErrorToSheet(
          { message: parent.reason, detail: `platform=${post.platform} postId=${post.id}` },
          "autoPost/thread"
        );
        continue;
      }
      if (quotaTracker.shouldDefer(post)) continue; // queued のまま次回へ

      processed++;
      updatePostStatus(post.id, "processing");
      try {
        const parentPostId = parent.status === "ready" ? parent.parentPostId : undefined;
        const platformPostId = publishPost(post, parentPostId);
        quotaTracker.consume(post);
        // 同一ラン内で後続の子がこの投稿を親として参照できるよう記録
        resolvedPostId[post.id] = platformPostId;
        resolvedPlatform[post.id] = post.platform;
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
        if (postsById[post.id]) postsById[post.id].status = "failed"; // 同ラン内の子に連鎖中断を伝播
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

    // 対応 Platform の queued が無ければトリガーを自動削除。
    // レート制限で見送った Threads 行や、親待ちの子行が queued のまま残る間はトリガーを維持する。
    const remaining = readPostRows().filter(
      (r) => isQueued(r) && SUPPORTED_PLATFORMS.indexOf(r.platform) !== -1
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
