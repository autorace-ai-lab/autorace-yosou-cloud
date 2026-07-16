# Deno Deploy公開手順（推奨）

Deno Deploy無料枠で、画面・手動更新API・15分Cron・Deno KVへの学習保存をまとめて動かす構成です。

1. https://console.deno.com へGitHubでログインする。
2. Organizationを作成して `+ New App` を押す。
3. GitHubの `hakutsu810-web/autorace-yosou-cloud` を接続する。
4. Entrypointに `deno/main.mjs` を指定してデプロイする。
5. DatabasesからDeno KVを作成し、このAppへAssignする。

デプロイ後はDenoが `Deno.cron()` を検出し、15分ごとに自動取得・結果検証・PDCAを実行します。画面上の「今日のレースを更新」「確定結果をまとめて取得」も同じApp内のAPIを呼びます。

無料枠を超過すると次の請求期間までアプリが一時停止する可能性があります。Deno DeployのMetricsとCron画面で、CPU時間・メモリ時間・実行結果を確認してください。

予想は統計的参考情報であり、的中を保証しません。車券購入は20歳以上、余裕資金の範囲で利用してください。
