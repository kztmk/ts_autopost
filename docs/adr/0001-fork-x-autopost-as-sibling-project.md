# x_Autopost を拡張せず姉妹プロジェクトとしてフォークする

Threads/Bluesky 対応にあたり、既存の x_Autopost（X 用 GAS）にプラットフォームを追加する案もあったが、稼働中の X 運用への影響を避けるため、このリポジトリに独立した GAS プロジェクトを新設し、x_Autopost のアーキテクチャ（TS + esbuild、`target/action` ルーティング、HMAC Proxy 認証、Sheets データモデル、トリガー/アーカイブ機構)を踏襲して X 固有モジュールだけを置き換える。フロントエンド側も同じ理由で既存 Torai（snake-sns）を改修せず、snake-sns をフォークした別アプリ + 新 Firebase プロジェクトとする（Torai の Functions は GAS URL を1ユーザー1件しか持てず、相乗りにはスキーマと Proxy の改修が必要になるため）。Proxy 契約（HMAC 署名・setup code 方式）は無改変で流用し、両系統の互換を保つ。
