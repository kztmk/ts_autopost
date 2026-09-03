// セットアップ / 更新のガイド（手動デプロイ方式）。
//
// Apps Script API は使わない（全ユーザーで確実に動く）。デプロイは Apps Script エディタの
// 「デプロイ」ボタンでユーザーが行い、この画面は確認チェックリストとコピー用の値を提示する。
//
// 認証ポップアップを1回で済ませるため、運用は「先にデプロイ → シートを再読込 → メニュー実行」。
// onOpen 側でデプロイ済みか判定し、未デプロイのうちはセットアップ項目を出さない（main.ts）。
//
// - deploySetup():      デプロイ確認チェックリスト＋ウェブアプリURL（自動取得）＋本人確認コードを表示。
// - updateFromRelease(): 最新 code.js の貼り替え＆再デプロイ手順を表示。

import { getUiLang } from "./utils";
import { generateSetupCode } from "./security";
import { ensureSheet } from "./sheets";
import { SHEETS, HEADERS } from "./constants";

/** シート（Posts / Posted / Errors）が無ければ作成する（冪等）。 */
function ensureSheetsInitialized(): void {
  const specs: Array<{ name: string; headers: readonly string[] }> = [
    { name: SHEETS.POSTS, headers: HEADERS.POST_HEADERS },
    { name: SHEETS.POSTED, headers: HEADERS.POSTED_HEADERS },
    { name: SHEETS.ERRORS, headers: HEADERS.ERROR_HEADERS },
  ];
  specs.forEach((s) => ensureSheet(s.name, s.headers));
}

const WEB_APP_URL_OVERRIDE_PROP_KEY = "setup_webAppUrlOverride";
// 個人Googleアカウント: https://script.google.com/macros/s/{id}/exec
// Google Workspace（組織ドメイン）: https://script.google.com/a/{domain}/macros/s/{id}/exec
const WEB_APP_URL_PATTERN =
  /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/.+\/exec$/;

/**
 * ScriptApp.getService().getUrl() は、Webアプリのデプロイが複数存在する場合に
 * 実際とは異なる（古い・別の）デプロイのURLを返すことがある（GAS既知の制限）。
 * 信頼できないため表示には一切使わない。ユーザーがデプロイ画面からコピーした
 * 正しいURLを手動保存してもらい、保存済みならそれだけを表示する
 * （未保存なら空欄のまま。自動取得へのフォールバックはしない）。
 */
export function getWebAppUrlOverride(): string {
  return (
    PropertiesService.getScriptProperties().getProperty(WEB_APP_URL_OVERRIDE_PROP_KEY) || ""
  );
}

/** セットアップ画面の「このURLを保存」ボタンから呼ばれる（google.script.run）。 */
export function saveWebAppUrlOverride(rawUrl: string): { saved: boolean; url: string } {
  const url = String(rawUrl || "").trim();
  if (!WEB_APP_URL_PATTERN.test(url)) {
    throw new Error(
      getUiLang() === "en"
        ? "Enter a valid Web App URL (one ending in https://script.google.com/.../exec)."
        : "正しいウェブアプリ URL（https://script.google.com/.../exec で終わるもの）を入力してください。"
    );
  }
  PropertiesService.getScriptProperties().setProperty(WEB_APP_URL_OVERRIDE_PROP_KEY, url);
  return { saved: true, url };
}

/**
 * 保存済みのウェブアプリ /exec URL を返す（未保存なら空文字）。
 * ScriptApp.getService().getUrl() の自動取得は信頼できないため使わない。
 */
export function getDeployedWebAppUrl(): string {
  return getWebAppUrlOverride();
}

function escapeHtml(v: string): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 番号付きリストの HTML を作る。 */
function stepsToOl(steps: string[]): string {
  return `<ol style="margin:0 0 12px; padding-left:20px; font-size:13px; line-height:1.9;">${steps
    .map((x) => `<li>${escapeHtml(x)}</li>`)
    .join("")}</ol>`;
}

// ---- メニューから呼ばれるエントリポイント ----

/**
 * セットアップ。デプロイ確認チェックリスト＋ウェブアプリURL＋本人確認コードを表示。
 * URLは自動取得せず、保存済み（saveWebAppUrlOverride）があればそれだけを表示する。
 * 未保存なら空欄のまま。デプロイ画面の正しいURLを貼り付けて保存してもらう。
 */
export function deploySetup(): void {
  const s = SETUP_STRINGS[getUiLang()];
  const ui = SpreadsheetApp.getUi();
  try {
    ensureSheetsInitialized();
    const url = getWebAppUrlOverride();
    const code = generateSetupCode();
    showSetupDialog(url, Boolean(url), code, s);
  } catch (e: any) {
    ui.alert(s.errorTitle, `${s.errorBody}\n\n${e && e.message ? e.message : e}`, ui.ButtonSet.OK);
  }
}

/** 更新手順（最新 code.js の貼り替え＋再デプロイ）を案内する。 */
export function updateFromRelease(): void {
  const s = SETUP_STRINGS[getUiLang()];
  const ui = SpreadsheetApp.getUi();
  try {
    showUpdateDialog(s);
  } catch (e: any) {
    ui.alert(s.errorTitle, `${s.errorBody}\n\n${e && e.message ? e.message : e}`, ui.ButtonSet.OK);
  }
}

/** セットアップ（デプロイ確認＋URL＋本人確認コード）のダイアログ。 */
function showSetupDialog(
  url: string,
  isOverride: boolean,
  code: string,
  s: SetupStrings
): void {
  const urlValue = url || "";
  const urlNote = isOverride ? s.urlOverrideNote : s.urlManualNote;
  const html = HtmlService.createHtmlOutput(
    `
    <div style="font-family: Arial, sans-serif; padding: 16px; color: #202124;">
      <h2 style="font-size: 18px; margin: 0 0 8px;">${s.setupTitle}</h2>
      <p style="font-size: 13px; line-height: 1.7; margin: 0 0 8px;"><b>${s.setupChecklistLead}</b></p>
      ${stepsToOl(s.deploySteps)}

      <label style="font-size: 12px; font-weight: bold;">${s.webAppUrlLabel}</label>
      <div style="display:flex; gap:8px; margin: 4px 0 4px;">
        <input id="url" type="text" value="${escapeHtml(urlValue)}"
          placeholder="https://script.google.com/macros/s/.../exec"
          style="flex:1; padding:8px; font-size:13px; font-family:monospace;" />
        <button onclick="copyField('url')" style="padding:8px 10px; border:0; border-radius:4px; background:#1a73e8; color:#fff; cursor:pointer;">${s.copyLabel}</button>
      </div>
      <p style="font-size:11px; color:#5f6368; margin:0 0 4px;">${urlNote}</p>
      <p style="font-size:11px; color:#5f6368; margin:0 0 4px;">${s.urlOverrideHint}</p>
      <div style="margin: 0 0 12px;">
        <button onclick="saveUrl()" style="padding:6px 10px; border:1px solid #1a73e8; border-radius:4px; background:#fff; color:#1a73e8; cursor:pointer;">${s.saveUrlLabel}</button>
        <span id="urlSaveStatus" style="margin-left:8px; font-size:12px;"></span>
      </div>

      <label style="font-size: 12px; font-weight: bold;">${s.codeLabel}</label>
      <div style="display:flex; gap:8px; margin: 4px 0 8px;">
        <input id="code" type="text" readonly value="${escapeHtml(code)}"
          style="flex:1; padding:8px; font-size:16px; font-family:monospace;" />
        <button onclick="copyField('code')" style="padding:8px 12px; border:0; border-radius:4px; background:#1a73e8; color:#fff; cursor:pointer;">${s.copyLabel}</button>
      </div>
      <p style="font-size:12px; color:#188038; margin:0;" id="status"></p>
      <p style="font-size:12px; color:#5f6368; margin:8px 0 0;">${s.codeExpiryNote}</p>

      <script>
        function copyField(id){
          const el = document.getElementById(id);
          el.select();
          document.execCommand('copy');
          document.getElementById('status').textContent = ${JSON.stringify(s.copiedLabel)};
        }
        function saveUrl(){
          const el = document.getElementById('url');
          const statusEl = document.getElementById('urlSaveStatus');
          statusEl.style.color = '#5f6368';
          statusEl.textContent = ${JSON.stringify(s.urlSaving)};
          google.script.run
            .withSuccessHandler(function(){
              statusEl.style.color = '#188038';
              statusEl.textContent = ${JSON.stringify(s.urlSaved)};
            })
            .withFailureHandler(function(error){
              statusEl.style.color = '#c5221f';
              statusEl.textContent = (error && error.message) ? error.message : ${JSON.stringify(s.urlSaveFailed)};
            })
            .saveWebAppUrlOverride(el.value);
        }
      </script>
    </div>
    `
  )
    .setWidth(580)
    .setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, s.setupTitle);
}

/** 更新手順のダイアログ。 */
function showUpdateDialog(s: SetupStrings): void {
  const html = HtmlService.createHtmlOutput(
    `
    <div style="font-family: Arial, sans-serif; padding: 16px; color: #202124;">
      <h2 style="font-size: 18px; margin: 0 0 8px;">${s.updateTitle}</h2>
      <p style="font-size: 13px; line-height: 1.7; margin: 0 0 12px;">${s.updateIntro}</p>
      ${stepsToOl(s.updateSteps)}
    </div>
    `
  )
    .setWidth(580)
    .setHeight(340);
  SpreadsheetApp.getUi().showModalDialog(html, s.updateTitle);
}

interface SetupStrings {
  setupTitle: string;
  setupChecklistLead: string;
  deploySteps: string[];
  webAppUrlLabel: string;
  urlManualNote: string;
  urlOverrideNote: string;
  urlOverrideHint: string;
  saveUrlLabel: string;
  urlSaving: string;
  urlSaved: string;
  urlSaveFailed: string;
  codeLabel: string;
  copyLabel: string;
  copiedLabel: string;
  codeExpiryNote: string;
  updateTitle: string;
  updateIntro: string;
  updateSteps: string[];
  errorTitle: string;
  errorBody: string;
}

/** メニュー・ダイアログの表示文言（日英）。 */
const SETUP_STRINGS: Record<"ja" | "en", SetupStrings> = {
  ja: {
    setupTitle: "セットアップ（URL・本人確認コード）",
    setupChecklistLead: "デプロイはお済みですか？（以下の手順）",
    deploySteps: [
      "シートメニューの「拡張機能 → Apps Script」を開く。",
      "スクリプトエディタ右上の「デプロイ → 新しいデプロイ」をクリック。",
      "「種類の選択（歯車）→ ウェブアプリ」を選択。",
      "「デプロイ」→「アクセスを承認」→ Google の確認画面で許可（「すべて選択」→続行）。",
      "表示された「ウェブアプリ URL」（.../exec）をコピー。",
      "シートに戻り、再読み込みしてからこのメニューを実行し、下の欄にコピーしたURLを貼り付けて保存する。",
    ],
    webAppUrlLabel: "ウェブアプリ URL（アプリの「Google Sheets URL」欄）",
    urlManualNote:
      "URLは自動取得しません（デプロイが複数あると誤ったURLになるため）。デプロイ画面に表示された正しいURL（.../exec）を上の欄に貼り付けて「このURLを保存」を押してください。",
    urlOverrideNote: "以前保存したURLを表示しています。",
    urlOverrideHint:
      "※ デプロイをやり直した、または別のデプロイのURLを使いたい場合は、上の欄を正しいURLに書き換えて「このURLを保存」を押してください。",
    saveUrlLabel: "このURLを保存",
    urlSaving: "保存中...",
    urlSaved: "保存しました。次回以降はこのURLが表示されます。",
    urlSaveFailed: "保存に失敗しました。URLの形式を確認してください。",
    codeLabel: "本人確認コード（アプリの「GAS 本人確認コード」欄）",
    copyLabel: "コピー",
    copiedLabel: "コピーしました",
    codeExpiryNote: "本人確認コードの有効期限は10分です。期限切れの場合はこのメニューを再実行してください。",
    updateTitle: "更新手順",
    updateIntro:
      "バックエンドを最新版に更新します。ウェブアプリ URL は変わらないため、アプリ側の再設定は不要です。",
    updateSteps: [
      "アプリの「プロフィール → API 設定」にある「GASスクリプト（code.js）を手動でダウンロード」から最新コードを取得。",
      "シートメニューの「拡張機能 → Apps Script」を開き、既存コードを全て消して貼り付けて保存。",
      "「デプロイ」→「デプロイを管理」→ 対象デプロイの編集（鉛筆）→ バージョンを「新バージョン」にして「デプロイ」。",
      "以上で完了です（ウェブアプリ URL は変わりません）。",
    ],
    errorTitle: "エラーが発生しました",
    errorBody: "処理中にエラーが発生しました。時間をおいて再度お試しください。",
  },
  en: {
    setupTitle: "Set up (URL & verification code)",
    setupChecklistLead: "Have you deployed yet? (steps below)",
    deploySteps: [
      "Open \"Extensions → Apps Script\" from the sheet menu.",
      "Click \"Deploy → New deployment\" at the top right of the script editor.",
      "Click \"Select type\" (gear) → choose \"Web app\".",
      "Click \"Deploy\" → \"Authorize access\" → allow on Google's screen (\"Select all\" → Continue).",
      "Copy the shown \"Web app URL\" (.../exec).",
      "Return to the sheet, reload it, run this menu, then paste the copied URL below and save it.",
    ],
    webAppUrlLabel: "Web app URL (the app's \"Google Sheets URL\" field)",
    urlManualNote:
      "The URL is not auto-detected (it can be wrong when there is more than one deployment). Paste the correct URL (.../exec) shown on the deploy screen above and click \"Save this URL\".",
    urlOverrideNote: "Showing the URL you saved previously.",
    urlOverrideHint:
      "Note: if you redeploy or want to use a different deployment's URL, edit the field above and click \"Save this URL\" again.",
    saveUrlLabel: "Save this URL",
    urlSaving: "Saving...",
    urlSaved: "Saved. This URL will be shown from now on.",
    urlSaveFailed: "Failed to save. Please check the URL format.",
    codeLabel: "Verification code (the app's \"GAS verification code\" field)",
    copyLabel: "Copy",
    copiedLabel: "Copied",
    codeExpiryNote:
      "The verification code is valid for 10 minutes. If it expires, run this menu again.",
    updateTitle: "Update steps",
    updateIntro:
      "Update the backend to the latest version. The web app URL does not change, so no reconfiguration is needed on the app side.",
    updateSteps: [
      "Get the latest code from \"Download the GAS script (code.js) manually\" in the app's Profile → API settings.",
      "Open \"Extensions → Apps Script\" from the sheet menu, delete all existing code, paste, and save.",
      "Click \"Deploy\" → \"Manage deployments\" → edit the deployment (pencil) → set Version to \"New version\" → \"Deploy\".",
      "Done (the web app URL does not change).",
    ],
    errorTitle: "An error occurred",
    errorBody: "An error occurred. Please wait a moment and try again.",
  },
};
