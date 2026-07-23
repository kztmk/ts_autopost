// ワンクリック・セットアップ / 自動更新（Apps Script API で自分自身を操作する）。
//
// - deploySetup():      シート初期化 → 自分を Web アプリとして自動デプロイ（/exec 取得）
//                       → 本人確認コード生成 → 結果ダイアログ表示。
// - updateFromRelease(): GitHub Release の最新 code.js を取得 → 自分のコードを差し替え
//                       → 同じデプロイを新バージョンに更新（/exec URL は不変）。
//
// 前提: ユーザーが一度だけ「Apps Script API」を有効化
//   （https://script.google.com/home/usersettings）し、
//   script.projects / script.deployments スコープを承認していること。
// 未有効の場合は 403 を検出し、有効化手順を案内する（ScriptApiDisabledError）。

import { getUiLang, fetchWithRetries } from "./utils";
import { generateSetupCode } from "./security";
import { ensureSheet } from "./sheets";
import { SHEETS, HEADERS, RELEASE_CODE_URL } from "./constants";

const SCRIPT_API_BASE = "https://script.googleapis.com/v1";
const MANIFEST_FILE_NAME = "appsscript";
const CODE_FILE_NAME = "code";

const SETUP_PROP_KEYS = {
  deploymentId: "setup_webAppDeploymentId",
} as const;

/** Apps Script API が未有効（ユーザー設定でオフ）のときに投げる。 */
class ScriptApiDisabledError extends Error {
  constructor() {
    super("Apps Script API is not enabled for this account.");
    this.name = "ScriptApiDisabledError";
  }
}

/** Apps Script API を叩く共通処理。403(API未有効) は専用エラーに変換する。 */
function scriptApiFetch(method: string, apiPath: string, payload?: any): any {
  const res = UrlFetchApp.fetch(`${SCRIPT_API_BASE}/${apiPath}`, {
    method: method as GoogleAppsScript.URL_Fetch.HttpMethod,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    contentType: "application/json",
    muteHttpExceptions: true,
    ...(payload ? { payload: JSON.stringify(payload) } : {}),
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (
    code === 403 &&
    /has not been used|SERVICE_DISABLED|accessNotConfigured|Apps Script API/i.test(text)
  ) {
    throw new ScriptApiDisabledError();
  }
  if (code < 200 || code >= 300) {
    throw new Error(`Apps Script API error (${code}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Deployment レスポンスから Web アプリの /exec URL を取り出す。 */
function extractWebAppUrl(deployment: any): string | null {
  const eps = (deployment && deployment.entryPoints) || [];
  for (const ep of eps) {
    if (ep.entryPointType === "WEB_APP" && ep.webApp && ep.webApp.url) {
      return ep.webApp.url as string;
    }
  }
  return null;
}

/**
 * 自分自身の新バージョンを作成し、Web アプリのデプロイを作成/更新して /exec URL を返す。
 * 既存デプロイ ID を Script Properties に保存し、更新時は同じ URL を維持する。
 */
function ensureWebAppDeployment(): string {
  const scriptId = ScriptApp.getScriptId();
  const props = PropertiesService.getScriptProperties();

  const version = scriptApiFetch("POST", `projects/${scriptId}/versions`, {
    description: `autopost ${new Date().toISOString()}`,
  });
  const versionNumber = version.versionNumber;

  const config = {
    versionNumber,
    manifestFileName: MANIFEST_FILE_NAME,
    description: "Autopost Web App",
  };

  const storedId = props.getProperty(SETUP_PROP_KEYS.deploymentId);
  let deployment: any;
  if (storedId) {
    try {
      deployment = scriptApiFetch("PUT", `projects/${scriptId}/deployments/${storedId}`, {
        deploymentConfig: config,
      });
    } catch (e) {
      // 保存済み ID が消えている等。作り直してIDを更新する。
      deployment = scriptApiFetch("POST", `projects/${scriptId}/deployments`, config);
      props.setProperty(SETUP_PROP_KEYS.deploymentId, deployment.deploymentId);
    }
  } else {
    deployment = scriptApiFetch("POST", `projects/${scriptId}/deployments`, config);
    props.setProperty(SETUP_PROP_KEYS.deploymentId, deployment.deploymentId);
  }

  const url = extractWebAppUrl(deployment);
  if (!url) {
    throw new Error(
      "Web アプリ URL を取得できませんでした。manifest の webapp 設定を確認してください。"
    );
  }
  return url;
}

/** シート（Posts / Posted / Errors）が無ければ作成する（冪等）。 */
function ensureSheetsInitialized(): void {
  const specs: Array<{ name: string; headers: readonly string[] }> = [
    { name: SHEETS.POSTS, headers: HEADERS.POST_HEADERS },
    { name: SHEETS.POSTED, headers: HEADERS.POSTED_HEADERS },
    { name: SHEETS.ERRORS, headers: HEADERS.ERROR_HEADERS },
  ];
  specs.forEach((s) => ensureSheet(s.name, s.headers));
}

// ---- メニューから呼ばれるエントリポイント ----

/**
 * ワンクリック・セットアップ。
 * シート初期化 → 自動デプロイ → 本人確認コード生成 → 結果ダイアログ。
 */
export function deploySetup(): void {
  const s = SETUP_STRINGS[getUiLang()];
  const ui = SpreadsheetApp.getUi();
  try {
    ensureSheetsInitialized();
    const url = ensureWebAppDeployment();
    const code = generateSetupCode();
    showSetupResultDialog(url, code, s);
  } catch (e: any) {
    if (e instanceof ScriptApiDisabledError) {
      ui.alert(s.apiDisabledTitle, s.apiDisabledBody, ui.ButtonSet.OK);
    } else {
      ui.alert(s.errorTitle, `${s.errorBody}\n\n${e && e.message ? e.message : e}`, ui.ButtonSet.OK);
    }
  }
}

/**
 * GitHub Release の最新 code.js を取得して自分のコードを差し替え、
 * 同じデプロイを新バージョンに更新する（/exec URL は不変）。
 * appsscript マニフェストは温存する（スコープ再承認を避けるため）。
 */
export function updateFromRelease(): void {
  const s = SETUP_STRINGS[getUiLang()];
  const ui = SpreadsheetApp.getUi();
  try {
    const res = fetchWithRetries(RELEASE_CODE_URL, {
      method: "get",
      muteHttpExceptions: true,
      followRedirects: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error(`code.js の取得に失敗しました (${res.getResponseCode()})。`);
    }
    const newCode = res.getContentText();

    const scriptId = ScriptApp.getScriptId();
    const content = scriptApiFetch("GET", `projects/${scriptId}/content`);
    const files: any[] = content.files || [];
    const manifest = files.find((f) => f.type === "JSON");
    if (!manifest) {
      throw new Error("マニフェスト(appsscript)が見つかりませんでした。");
    }

    // マニフェストは温存し、サーバーコードは 1 ファイル（code）に統一して差し替える。
    scriptApiFetch("PUT", `projects/${scriptId}/content`, {
      files: [
        { name: manifest.name, type: "JSON", source: manifest.source },
        { name: CODE_FILE_NAME, type: "SERVER_JS", source: newCode },
      ],
    });

    const url = ensureWebAppDeployment(); // 新バージョン作成＋同一デプロイ更新
    ui.alert(s.updatedTitle, s.updatedBody(url), ui.ButtonSet.OK);
  } catch (e: any) {
    if (e instanceof ScriptApiDisabledError) {
      ui.alert(s.apiDisabledTitle, s.apiDisabledBody, ui.ButtonSet.OK);
    } else {
      ui.alert(s.errorTitle, `${s.errorBody}\n\n${e && e.message ? e.message : e}`, ui.ButtonSet.OK);
    }
  }
}

/** セットアップ結果（/exec URL・本人確認コード）をコピーしやすいダイアログで表示する。 */
function showSetupResultDialog(url: string, code: string, s: SetupStrings): void {
  const esc = (v: string) =>
    String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = HtmlService.createHtmlOutput(
    `
    <div style="font-family: Arial, sans-serif; padding: 16px; color: #202124;">
      <h2 style="font-size: 18px; margin: 0 0 8px;">${s.resultTitle}</h2>
      <p style="font-size: 13px; line-height: 1.7; margin: 0 0 12px;">${s.resultBody}</p>

      <label style="font-size: 12px; font-weight: bold;">${s.webAppUrlLabel}</label>
      <div style="display:flex; gap:8px; margin: 4px 0 12px;">
        <input id="url" type="text" readonly value="${esc(url)}"
          style="flex:1; padding:8px; font-size:13px; font-family:monospace;" />
        <button onclick="copy('url')" style="padding:8px 10px; border:0; border-radius:4px; background:#1a73e8; color:#fff; cursor:pointer;">${s.copyLabel}</button>
      </div>

      <label style="font-size: 12px; font-weight: bold;">${s.codeLabel}</label>
      <div style="display:flex; gap:8px; margin: 4px 0 8px;">
        <input id="code" type="text" readonly value="${esc(code)}"
          style="flex:1; padding:8px; font-size:16px; font-family:monospace;" />
        <button onclick="copy('code')" style="padding:8px 10px; border:0; border-radius:4px; background:#1a73e8; color:#fff; cursor:pointer;">${s.copyLabel}</button>
      </div>
      <p style="font-size:12px; color:#188038; margin:0;" id="status"></p>
      <p style="font-size:12px; color:#5f6368; margin:8px 0 0;">${s.codeExpiryNote}</p>

      <script>
        function copy(id){
          const el = document.getElementById(id);
          el.select();
          document.execCommand('copy');
          document.getElementById('status').textContent = ${JSON.stringify(s.copiedLabel)};
        }
      </script>
    </div>
    `
  )
    .setWidth(560)
    .setHeight(320);
  SpreadsheetApp.getUi().showModalDialog(html, s.resultTitle);
}

interface SetupStrings {
  resultTitle: string;
  resultBody: string;
  webAppUrlLabel: string;
  codeLabel: string;
  copyLabel: string;
  copiedLabel: string;
  codeExpiryNote: string;
  updatedTitle: string;
  updatedBody: (url: string) => string;
  apiDisabledTitle: string;
  apiDisabledBody: string;
  errorTitle: string;
  errorBody: string;
}

/** メニュー・ダイアログの表示文言（日英）。 */
const SETUP_STRINGS: Record<"ja" | "en", SetupStrings> = {
  ja: {
    resultTitle: "セットアップ完了",
    resultBody:
      "以下の2つをアプリのプロフィール画面（API設定）に入力してください。<br>Webアプリのデプロイと本人確認コードの発行が完了しました。",
    webAppUrlLabel: "Web アプリ URL（Google Sheets URL 欄）",
    codeLabel: "本人確認コード",
    copyLabel: "コピー",
    copiedLabel: "コピーしました",
    codeExpiryNote: "本人確認コードの有効期限は10分です。",
    updatedTitle: "更新完了",
    updatedBody: (url: string) =>
      `最新版に更新し、同じ Web アプリ URL で再デプロイしました。<br>URL は変わりません:<br>${url}`,
    apiDisabledTitle: "Apps Script API の有効化が必要です",
    apiDisabledBody:
      "自動デプロイには Apps Script API の有効化が必要です。\n\n" +
      "1) https://script.google.com/home/usersettings を開く\n" +
      "2) 「Google Apps Script API」をオンにする\n" +
      "3) 数分待ってから、もう一度このメニューを実行してください。",
    errorTitle: "エラーが発生しました",
    errorBody: "処理中にエラーが発生しました。時間をおいて再度お試しください。",
  },
  en: {
    resultTitle: "Setup complete",
    resultBody:
      "Enter the following two values on the app's profile screen (API settings).<br>Web app deployment and verification code generation are complete.",
    webAppUrlLabel: "Web app URL (Google Sheets URL field)",
    codeLabel: "Verification code",
    copyLabel: "Copy",
    copiedLabel: "Copied",
    codeExpiryNote: "The verification code is valid for 10 minutes.",
    updatedTitle: "Update complete",
    updatedBody: (url: string) =>
      `Updated to the latest version and redeployed with the same web app URL.<br>The URL does not change:<br>${url}`,
    apiDisabledTitle: "You need to enable the Apps Script API",
    apiDisabledBody:
      "Automatic deployment requires the Apps Script API to be enabled.\n\n" +
      "1) Open https://script.google.com/home/usersettings\n" +
      "2) Turn on \"Google Apps Script API\"\n" +
      "3) Wait a few minutes, then run this menu again.",
    errorTitle: "An error occurred",
    errorBody: "An error occurred. Please wait a moment and try again.",
  },
};
