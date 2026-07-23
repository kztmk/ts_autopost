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

/** デプロイ済みならウェブアプリ /exec URL を返す（未デプロイ・取得不可なら空文字）。 */
export function getDeployedWebAppUrl(): string {
  try {
    return ScriptApp.getService().getUrl() || "";
  } catch (e) {
    return "";
  }
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
 * セットアップ。デプロイ確認チェックリスト＋ウェブアプリURL（自動取得）＋本人確認コードを表示。
 * 想定運用: 先にデプロイ済み → この時点でURLが自動取得できる。
 */
export function deploySetup(): void {
  const s = SETUP_STRINGS[getUiLang()];
  const ui = SpreadsheetApp.getUi();
  try {
    ensureSheetsInitialized();
    const url = getDeployedWebAppUrl();
    const code = generateSetupCode();
    showSetupDialog(url, code, s);
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
function showSetupDialog(url: string, code: string, s: SetupStrings): void {
  const urlValue = url || "";
  const urlNote = url ? s.urlAutoNote : s.urlManualNote;
  const html = HtmlService.createHtmlOutput(
    `
    <div style="font-family: Arial, sans-serif; padding: 16px; color: #202124;">
      <h2 style="font-size: 18px; margin: 0 0 8px;">${s.setupTitle}</h2>
      <p style="font-size: 13px; line-height: 1.7; margin: 0 0 8px;"><b>${s.setupChecklistLead}</b></p>
      ${stepsToOl(s.deploySteps)}

      <label style="font-size: 12px; font-weight: bold;">${s.webAppUrlLabel}</label>
      <div style="display:flex; gap:8px; margin: 4px 0 4px;">
        <input id="url" type="text" readonly value="${escapeHtml(urlValue)}"
          placeholder="https://script.google.com/macros/s/.../exec"
          style="flex:1; padding:8px; font-size:13px; font-family:monospace;" />
        <button onclick="copyField('url')" style="padding:8px 10px; border:0; border-radius:4px; background:#1a73e8; color:#fff; cursor:pointer;">${s.copyLabel}</button>
      </div>
      <p style="font-size:11px; color:#5f6368; margin:0 0 12px;">${urlNote}</p>

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
      </script>
    </div>
    `
  )
    .setWidth(580)
    .setHeight(520);
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
  urlAutoNote: string;
  urlManualNote: string;
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
      "シートに戻り、再読み込みしてからこのメニューを実行（下に URL が自動表示されます）。",
    ],
    webAppUrlLabel: "ウェブアプリ URL（アプリの「Google Sheets URL」欄）",
    urlAutoNote: "デプロイ済みのため自動取得しました。上のコピーで貼り付けてください。",
    urlManualNote:
      "自動取得できませんでした。先にデプロイし、シートを再読み込みしてから再実行するか、デプロイ画面の URL を貼り付けてください。",
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
      "Return to the sheet, reload it, then run this menu (the URL appears below automatically).",
    ],
    webAppUrlLabel: "Web app URL (the app's \"Google Sheets URL\" field)",
    urlAutoNote: "Detected automatically because it is already deployed. Copy it above and paste it.",
    urlManualNote:
      "Could not detect it automatically. Deploy first and reload the sheet, then run again, or paste the URL from the deploy screen.",
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
