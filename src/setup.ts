// セットアップ / 更新のガイド（手動デプロイ方式）。
//
// Apps Script API は使わない（有効化トグル・GCP プロジェクト・追加スコープが不要で、
// 全ユーザーで確実に動くため）。デプロイ自体はユーザーが Apps Script エディタの
// 「デプロイ」ボタンで行い、この画面は手順とコピー用の値を提示する。
//
// - deploySetup():      シート初期化 → 本人確認コード生成 → デプロイ手順＋コードのダイアログ。
// - updateFromRelease(): 最新 code.js の貼り替え＆再デプロイ手順のダイアログ（コード取得はアプリ側）。

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

function escapeHtml(v: string): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- メニューから呼ばれるエントリポイント ----

/**
 * セットアップ。シート初期化 → 本人確認コード生成 → デプロイ手順＋コードのダイアログ表示。
 */
export function deploySetup(): void {
  const s = SETUP_STRINGS[getUiLang()];
  const ui = SpreadsheetApp.getUi();
  try {
    ensureSheetsInitialized();
    const code = generateSetupCode();
    showSetupDialog(code, s);
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

/** 番号付きリストの HTML を作る。 */
function stepsToOl(steps: string[]): string {
  return `<ol style="margin:0 0 12px; padding-left:20px; font-size:13px; line-height:1.9;">${steps
    .map((x) => `<li>${x}</li>`)
    .join("")}</ol>`;
}

/** セットアップ手順（デプロイ手順＋本人確認コード）のダイアログ。 */
function showSetupDialog(code: string, s: SetupStrings): void {
  const html = HtmlService.createHtmlOutput(
    `
    <div style="font-family: Arial, sans-serif; padding: 16px; color: #202124;">
      <h2 style="font-size: 18px; margin: 0 0 8px;">${s.setupTitle}</h2>
      <p style="font-size: 13px; line-height: 1.7; margin: 0 0 12px;">${s.setupIntro}</p>
      ${stepsToOl(s.deploySteps)}

      <label style="font-size: 12px; font-weight: bold;">${s.codeLabel}</label>
      <div style="display:flex; gap:8px; margin: 4px 0 8px;">
        <input id="code" type="text" readonly value="${escapeHtml(code)}"
          style="flex:1; padding:8px; font-size:16px; font-family:monospace;" />
        <button onclick="copyCode()" style="padding:8px 12px; border:0; border-radius:4px; background:#1a73e8; color:#fff; cursor:pointer;">${s.copyLabel}</button>
      </div>
      <p style="font-size:12px; color:#188038; margin:0;" id="status"></p>
      <p style="font-size:12px; color:#5f6368; margin:8px 0 0;">${s.codeExpiryNote}</p>

      <script>
        function copyCode(){
          const el = document.getElementById('code');
          el.select();
          document.execCommand('copy');
          document.getElementById('status').textContent = ${JSON.stringify(s.copiedLabel)};
        }
      </script>
    </div>
    `
  )
    .setWidth(560)
    .setHeight(420);
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
    .setWidth(560)
    .setHeight(320);
  SpreadsheetApp.getUi().showModalDialog(html, s.updateTitle);
}

interface SetupStrings {
  setupTitle: string;
  setupIntro: string;
  deploySteps: string[];
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
    setupTitle: "セットアップ（デプロイ手順）",
    setupIntro:
      "次の手順で Web アプリをデプロイし、表示された「ウェブアプリ URL」と下の本人確認コードを、アプリのプロフィール → API 設定に入力してください。",
    deploySteps: [
      "画面右上の「デプロイ」→「新しいデプロイ」をクリック。",
      "「種類の選択（歯車）」→「ウェブアプリ」を選択。",
      "「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」になっていることを確認（既定で入っています）。",
      "「デプロイ」をクリックし、表示された「ウェブアプリ URL」（.../exec）をコピー。",
      "アプリの API 設定の「Google Sheets URL」欄にその URL を、「GAS 本人確認コード」欄に下のコードを貼り付けて保存。",
    ],
    codeLabel: "本人確認コード",
    copyLabel: "コピー",
    copiedLabel: "コピーしました",
    codeExpiryNote: "本人確認コードの有効期限は10分です。期限切れの場合はこのメニューを再実行してください。",
    updateTitle: "更新手順",
    updateIntro:
      "バックエンドを最新版に更新します。ウェブアプリ URL は変わらないため、アプリ側の再設定は不要です。",
    updateSteps: [
      "アプリの「プロフィール → API 設定」にある「GASスクリプト（code.js）を手動でダウンロード」から最新コードを取得。",
      "このスクリプトエディタで既存のコードを全て消し、ダウンロードした code.js を貼り付けて保存。",
      "「デプロイ」→「デプロイを管理」→ 対象デプロイの編集（鉛筆アイコン）→ バージョンを「新バージョン」にして「デプロイ」。",
      "以上で完了です（ウェブアプリ URL は変わりません）。",
    ],
    errorTitle: "エラーが発生しました",
    errorBody: "処理中にエラーが発生しました。時間をおいて再度お試しください。",
  },
  en: {
    setupTitle: "Setup (deployment steps)",
    setupIntro:
      "Deploy the web app with the steps below, then enter the shown \"Web app URL\" and the verification code below into the app's Profile → API settings.",
    deploySteps: [
      "Click \"Deploy\" → \"New deployment\" at the top right.",
      "Click \"Select type\" (gear) → choose \"Web app\".",
      "Confirm \"Execute as: Me\" and \"Who has access: Anyone\" (these are set by default).",
      "Click \"Deploy\" and copy the shown \"Web app URL\" (.../exec).",
      "Paste that URL into the \"Google Sheets URL\" field and this code into the \"GAS verification code\" field in the app's API settings, then save.",
    ],
    codeLabel: "Verification code",
    copyLabel: "Copy",
    copiedLabel: "Copied",
    codeExpiryNote:
      "The verification code is valid for 10 minutes. If it expires, run this menu again.",
    updateTitle: "Update steps",
    updateIntro:
      "Update the backend to the latest version. The web app URL does not change, so no reconfiguration is needed on the app side.",
    updateSteps: [
      "Get the latest code from \"Download the GAS script (code.js) manually\" in the app's Profile → API settings.",
      "In this script editor, delete all existing code, paste the downloaded code.js, and save.",
      "Click \"Deploy\" → \"Manage deployments\" → edit the deployment (pencil icon) → set Version to \"New version\" → \"Deploy\".",
      "Done (the web app URL does not change).",
    ],
    errorTitle: "An error occurred",
    errorBody: "An error occurred. Please wait a moment and try again.",
  },
};
