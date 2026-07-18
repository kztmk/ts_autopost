# Threads OAuth は BYO Meta アプリ + GAS コールバックとする

Threads の認可コードフローには Meta アプリへのリダイレクト URI 登録が必須。運営者所有の中央 Meta アプリ + Functions での一元コールバック受けも検討したが、App Review 必須・運営責任・審査リスクを抱えるため不採用。x_Autopost の BYO 思想に合わせ、各ユーザーが自分の Meta アプリを作成して Threads App ID/Secret をフロントから登録し、リダイレクトは本人の GAS `doGet` に新設する無認証例外ルート（`state` で PlatformAccount 紐付け + CSRF 検証）で受ける。各自がテスター登録すれば App Review は不要。

帰結: (1) 認可スコープには最初から `threads_manage_insights` を含める（後から足すと全ユーザー再認可になる）。(2) GAS の再デプロイで URL が変わると Meta 側のリダイレクト URI 登録が壊れるため、デプロイ更新は「既存デプロイの新バージョン」方式を運用ルールとする。
