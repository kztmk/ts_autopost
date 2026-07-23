// Discord 通知（投稿結果のプッシュ通知）。
// - Webhook URL は機密なので ScriptProperties に保存し、フロントへは値を返さない
//   （保存済みか否かの hasWebhookUrl のみ返す）。
// - autoPost の 1 ラン分の結果をまとめて 1 通の Discord メッセージ（embed）で送る。
// target=notificationSettings / action=upsert|test で操作する。

import { fetchWithRetries } from "../utils";
import { Platform } from "../types";

const NOTIFICATION_PROP_KEYS = {
  discordEnabled: "notification_discord_enabled",
  discordWebhookUrl: "notification_discord_webhookUrl",
} as const;

// Discord Webhook URL の形式（フロントの DISCORD_WEBHOOK_URL_PATTERN と同等）。
const DISCORD_WEBHOOK_URL_PATTERN =
  /^https:\/\/((?:ptb|canary)\.)?(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+(\?[\w=&-]+)?$/;

const APP_NAME = "Autopost";
const COLOR_SUCCESS = 0x2ecc71; // green
const COLOR_FAILURE = 0xe74c3c; // red
const COLOR_MIXED = 0xf1c40f; // yellow
const MAX_EMBED_FIELDS = 25; // Discord embed の fields 上限
const CONTENT_EXCERPT_LEN = 80;

/** autoPost から渡す 1 件分の投稿結果 */
export interface PostNotification {
  platform: Platform | string;
  accountId: string;
  contents: string;
  success: boolean;
  /** 成功時: 公開後のプラットフォーム投稿 ID */
  postId?: string;
  /** 失敗時: エラー内容 */
  error?: string;
}

interface NotificationSettings {
  enabled: boolean;
  webhookUrl: string;
}

function getProps() {
  return PropertiesService.getScriptProperties();
}

/** 保存済みの通知設定を読み出す（内部利用） */
export function getNotificationSettings(): NotificationSettings {
  const props = getProps();
  return {
    enabled: props.getProperty(NOTIFICATION_PROP_KEYS.discordEnabled) === "true",
    webhookUrl: props.getProperty(NOTIFICATION_PROP_KEYS.discordWebhookUrl) || "",
  };
}

function platformLabel(platform: string): string {
  if (platform === "threads") return "Threads";
  if (platform === "bluesky") return "Bluesky";
  return platform || "不明";
}

function excerpt(text: string): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= CONTENT_EXCERPT_LEN) return s;
  return `${s.slice(0, CONTENT_EXCERPT_LEN)}…`;
}

/**
 * 通知設定の保存（upsert）。
 * - enabled: 通知の ON/OFF
 * - webhookUrl: 指定時のみ検証して上書き（未指定なら既存値を維持）
 * 戻り値の hasWebhookUrl でフロントは「保存済みか」を判定する（値そのものは返さない）。
 */
export function upsertNotificationSettings(requestData: {
  enabled?: boolean;
  webhookUrl?: string;
}): { enabled: boolean; hasWebhookUrl: boolean } {
  const props = getProps();

  if (typeof requestData?.enabled === "boolean") {
    props.setProperty(
      NOTIFICATION_PROP_KEYS.discordEnabled,
      requestData.enabled ? "true" : "false"
    );
  }

  const rawWebhookUrl = requestData?.webhookUrl;
  if (typeof rawWebhookUrl === "string" && rawWebhookUrl.trim()) {
    const webhookUrl = rawWebhookUrl.trim();
    if (!DISCORD_WEBHOOK_URL_PATTERN.test(webhookUrl)) {
      throw new Error("Discord Webhook URL の形式が正しくありません。");
    }
    props.setProperty(NOTIFICATION_PROP_KEYS.discordWebhookUrl, webhookUrl);
  }

  const settings = getNotificationSettings();
  return {
    enabled: settings.enabled,
    hasWebhookUrl: Boolean(settings.webhookUrl),
  };
}

/**
 * テスト送信。requestData.webhookUrl があればそれを、無ければ保存済みを使う。
 * どちらも無ければエラー。送信失敗（非 2xx）も throw する。
 */
export function testNotification(requestData: { webhookUrl?: string }): {
  sent: boolean;
} {
  const raw = requestData?.webhookUrl;
  let webhookUrl = "";
  if (typeof raw === "string" && raw.trim()) {
    webhookUrl = raw.trim();
    if (!DISCORD_WEBHOOK_URL_PATTERN.test(webhookUrl)) {
      throw new Error("Discord Webhook URL の形式が正しくありません。");
    }
  } else {
    webhookUrl = getNotificationSettings().webhookUrl;
  }
  if (!webhookUrl) {
    throw new Error("Discord Webhook URL が設定されていません。");
  }

  postToDiscord(webhookUrl, {
    username: APP_NAME,
    embeds: [
      {
        title: "🔔 テスト通知",
        description:
          `${APP_NAME} からのテスト通知です。この内容が Discord に届いていれば、投稿結果の通知は正常に設定されています。`,
        color: COLOR_SUCCESS,
        timestamp: new Date().toISOString(),
      },
    ],
  });

  return { sent: true };
}

/**
 * autoPost の 1 ラン分の投稿結果をまとめて 1 通で通知する。
 * 通知 OFF / Webhook 未設定 / 結果ゼロ件なら何もしない。
 * 通知の失敗が投稿ループ本体を壊さないよう、呼び出し側で try/catch すること。
 */
export function sendPostResultNotifications(results: PostNotification[]): void {
  if (!results || results.length === 0) return;

  const settings = getNotificationSettings();
  if (!settings.enabled || !settings.webhookUrl) return;

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.length - successCount;

  let color = COLOR_MIXED;
  if (failureCount === 0) color = COLOR_SUCCESS;
  else if (successCount === 0) color = COLOR_FAILURE;

  const title =
    failureCount === 0
      ? `✅ 投稿完了（${successCount}件）`
      : successCount === 0
        ? `❌ 投稿失敗（${failureCount}件）`
        : `⚠️ 投稿結果（成功 ${successCount} / 失敗 ${failureCount}）`;

  const fields = results.slice(0, MAX_EMBED_FIELDS).map((r) => {
    const head = `${r.success ? "✅" : "❌"} ${platformLabel(String(r.platform))} @${r.accountId}`;
    const body = r.success
      ? `${excerpt(r.contents)}${r.postId ? `\nID: ${r.postId}` : ""}`
      : `${excerpt(r.contents)}\nエラー: ${excerpt(r.error || "不明なエラー")}`;
    return {
      name: head.slice(0, 256),
      value: (body || "—").slice(0, 1024),
      inline: false,
    };
  });

  const omitted = results.length - fields.length;
  const description =
    omitted > 0 ? `他 ${omitted} 件は省略されました。` : undefined;

  postToDiscord(settings.webhookUrl, {
    username: APP_NAME,
    embeds: [
      {
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/** Discord Webhook へ POST する。非 2xx はエラーにする。 */
function postToDiscord(webhookUrl: string, payload: any): void {
  const response = fetchWithRetries(webhookUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(
      `Discord への送信に失敗しました（HTTP ${code}）: ${response.getContentText()}`
    );
  }
}
