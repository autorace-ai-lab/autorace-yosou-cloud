オートレース3連単予想ラボ — Netlifyクラウド学習版
=====================================================

これは WINTICKET の公開出走表・結果を使い、画面を閉じている間も
15分ごとに情報収集と検証学習を行う Netlify 用プロジェクトです。

主な機能
--------
・本日の開催と出走表を WINTICKET から取得
・試走タイム、偏差、ST、ハンデ、級別、審査点、近況成績を使用
・Plackett-Luce で8車の3連単336通りを列挙（合計確率=100%）
・レース前スナップショットだけを保存し、確定結果と照合
・結果確定後にモデル順位、確率、配当を学習履歴へ保存
・5年以内の過去レースを新しい順に少しずつ追加学習
・20%を固定の検証データとして分離し、検証損失が1%以上改善した
  パラメータだけを採用（過学習対策）
・Netlify Blobs にモデル、レース、PDCA履歴を永続保存

定期実行
--------
netlify.toml の次の設定で15分ごとに動きます。

  [functions."collect-and-train"]
    schedule = "*/15 * * * *"

Netlifyの定期Functionは本番公開後に動きます。
画面の「今すぐ同期」でも同じ処理を手動実行できます。

公開方法
--------
1. このフォルダーをGitHubリポジトリへ登録
2. Netlifyで「Add new project」→「Import an existing project」
3. 対象リポジトリを選択
4. Publish directory は「.」、Functions directory は
   netlify/functions（netlify.tomlから自動認識）
5. Deployを実行

公開後の確認
------------
・画面上部に「クラウド学習 稼働中」と表示される
・「今すぐ同期」を押すと取得数と学習累計が更新される
・NetlifyのFunctions画面に collect-and-train と state が表示される
・collect-and-train に Scheduled の表示がある

データ取り扱いと注意
--------------------
・データ元はWINTICKETの公開ページです。ページ構造変更、障害、アクセス制限時は
  一時的に取得できないことがあります。
・結果ページの埋め込み公開データにある trifectaWinningOddsIds と
  payoffUnitPrice を照合して、3連単の組と配当を取得します。
・結果情報をレース前予想へ混入させません。学習は保存済みのレース前情報と
  確定結果の比較だけで行います。
・精度改善を保証するものではありません。母数が少ない間は基準モデルを維持します。
・予想は統計的参考情報であり、的中を保証しません。
・車券購入は20歳以上、余裕資金の範囲で行ってください。

ファイル
--------
index.html                         予想画面
netlify.toml                       公開・15分間隔の設定
package.json                       Netlify Blobs / HTML解析の依存関係
netlify/functions/collect-and-train.mjs  収集・結果照合・学習
netlify/functions/state.mjs        画面へ最新状態を返すAPI
netlify/functions/lib/model.mjs    確率計算・検証学習
netlify/functions/lib/source.mjs   WINTICKET取得・解析
netlify/functions/lib/store.mjs    Netlify Blobs永続化

