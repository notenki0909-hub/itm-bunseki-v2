# ITM分析ツール Ver2

ティッカーを入力すると、過去の株価データから「権利行使価格に対してどれくらいの確率でITMになったか」を計算するWebツールの第2版。
米国株のみ対応。データ取得元は [Twelve Data](https://twelvedata.com/)（無料プラン）。

- Ver1（公開中・そのまま維持）: https://itm-bunseki.pages.dev （リポジトリ `notenki0909-hub/itm-bunseki`）
- Ver2（このリポジトリ）: https://itm-bunseki-v2.pages.dev （リポジトリ `notenki0909-hub/itm-bunseki-v2`）

## Ver1との違い

- **リスクリワード分析を廃止**（判定の前提に問題があったため。詳細は `引継ぎ資料.txt` の「3. リスクリワード分析を廃止した理由」）。
- 注文内容カードから「損切額」「見越し最大利益額」を削除（リスクリワード分析専用だったため）。
- 「OTMに戻るまでの平均日数」「OTMに戻らなかった割合」は「分析結果」へ移動。
- 今後、スプレッドオプション講座の運用ルールに沿った機能を順次追加（`引継ぎ資料.txt` の「4. 今後の予定」）。

## 構成

```
site/
  index.html / guide.html / detail.html   画面（分析ページ・使い方・詳細マトリクス）
  css/style.css                            デザイン
  js/calc.js                               計算ロジック（純粋関数）
  js/chart.js, heatmap.js                  グラフ・ヒートマップ生成（純粋関数）
  js/app.js                                画面とロジックをつなぐ処理
  js/marketTime.js                         株価データが古いかの判定
functions/api/history.js                   Twelve Data中継API（Cloudflare Pages Function）
wrangler.toml                              KVバインディング設定
```

## ローカルでの確認

```bash
npx wrangler pages dev site --port 8789 --kv PRICE_CACHE
```

`.dev.vars`（Gitには含めない）に `TWELVEDATA_API_KEY=（Twelve DataのAPIキー）` を設定しておくこと。

## 本番デプロイ（Cloudflare Pages）

1. Cloudflare Pagesで、このリポジトリを連携（プロジェクト名 `itm-bunseki-v2`、ビルドコマンドなし、出力ディレクトリ `site`）
2. KVのバインディングは `wrangler.toml` で管理（Ver1と同じ名前空間 `PRICE_CACHE` を共有。同じ銘柄の取得をVer1・Ver2で共用して無料枠を節約する）
3. Settings → Variables and secrets に `TWELVEDATA_API_KEY` を **Secret** で追加
4. デプロイ後、`/api/history?symbol=AAPL` がJSONを返すことを確認
