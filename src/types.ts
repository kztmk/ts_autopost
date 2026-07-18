/** 投稿先プラットフォーム種別（CONTEXT.md「Platform」） */
export type Platform = "threads" | "bluesky";

/** Post のライフサイクル状態（CONTEXT.md「Post」） */
export type PostStatus = "queued" | "processing" | "posted" | "failed";

/**
 * PlatformAccount（CONTEXT.md）。
 * PropertiesService に accountId 単位で保存される認証情報一式。
 * 実際の保存・取得は Phase 2（Bluesky）/ Phase 3（Threads）で実装する。
 */
export interface PlatformAccountBase {
  accountId: string;
  platform: Platform;
  /** 表示用ラベル（任意） */
  displayName?: string;
}

/** Threads アカウント（BYO Meta アプリ。ADR 0003） */
export interface ThreadsAccount extends PlatformAccountBase {
  platform: "threads";
  appId: string;
  appSecret: string;
  userId?: string;
  accessToken?: string;
  tokenSavedAt?: string;
}

/** Bluesky アカウント（アプリパスワード方式） */
export interface BlueskyAccount extends PlatformAccountBase {
  platform: "bluesky";
  handle: string;
  appPassword: string;
  did?: string;
  accessJwt?: string;
  refreshJwt?: string;
}

export type PlatformAccount = ThreadsAccount | BlueskyAccount;

/**
 * Posts シートの 1 行（= 単一の PlatformAccount 宛の 1 Post）。ADR 0002。
 * 列順は constants.ts HEADERS.POST_HEADERS に対応する。
 */
export interface PostRow {
  id: string;
  createdAt: string;
  platform: Platform;
  accountId: string;
  contents: string;
  /** 画像 URL の JSON 配列文字列（Phase 5 予約） */
  mediaUrls: string;
  postSchedule: string;
  /** 一括作成グループ（クロスポスト） */
  crossPostGroupId: string;
  /** 親 Post の内部 id（スレッド連投。Phase 6 予約） */
  inReplyTo: string;
  status: PostStatus;
  /** 公開後のプラットフォーム投稿 ID */
  postId: string;
  errorMessage: string;
}

/** フロント/Proxy から受け取る Post 作成入力（id・status 等はサーバ採番） */
export interface PostInput {
  platform: Platform;
  accountId: string;
  contents: string;
  mediaUrls?: string[];
  postSchedule: string;
  crossPostGroupId?: string;
  inReplyTo?: string;
}

/** Errors シートの 1 行（Post に限らない汎用エラーログ） */
export interface ErrorLogEntry {
  timestamp?: string;
  context?: string;
  message: string;
  stack?: string;
  detail?: string;
}
