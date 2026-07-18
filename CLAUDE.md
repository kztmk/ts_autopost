# Autopost_Threads

Threads/Bluesky 予約投稿の GAS バックエンド。`CONTEXT.md`（用語集）と `docs/adr/`（設計決定）を先に読むこと。

## 関連リポジトリ

- `~/Documents/Devs/React/playground/x_Autopost` — アーキテクチャ踏襲元の X 用 GAS（TS + esbuild、target/action ルーティング、HMAC Proxy 認証）
- `~/Documents/Devs/React/playground/snake-sns` — フォーク元のフロントエンド + Firebase Functions Proxy（Torai）。Proxy 契約は `docs/gas-proxy-developer-guide.md` 参照

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
