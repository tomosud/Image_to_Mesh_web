# TASK A: backfill.js の定数倍最適化（結果ビット単位不変）

## 背景（このファイルだけで完結）

このリポジトリはブラウザ内で単一画像から depth 推論しメッシュ化する静的 Web アプリ。
`js/backfill.js` は「前景の裏に隠れた領域を埋める第2レイヤー」を CPU の JS で生成しており、
パラメータ変更のたびに実行される。アルゴリズムは変えず、定数倍の高速化だけを行う。

対象リポジトリ: `C:\work\script\Image_to_Mesh_web`

## 絶対条件

1. **出力を1ビットも変えない。** 浮動小数の演算順序・比較順序・sort の比較関数の結果順を
   変えない。アルゴリズム・しきい値・反復回数の変更は禁止。
2. 変更してよいファイルは `js/backfill.js` と、`index.html` のキャッシュバスター
   （`backfill.js?v=YYYYMMDD-N` の版数を今日の日付で +1）のみ。他は一切触らない。
3. git commit / push はしない（ユーザーが行う）。ブラウザでの確認もしない。
4. ファイルは UTF-8。日本語コメントを文字化けさせない。既存コメントは削除しない
   （ロジック解説がすべてコメントに入っているため）。
5. 新しい md は作らない（完了報告はチャットで返す）。

## 変更内容

`js/backfill.js` の `generate()` 内。ホットループは synth 領域（最大数百万画素）×近傍で回る。

### A-1. 近傍イテレーションの展開

`for (const [dx, dy] of OFFS)` / `for (const [dx, dy] of OFFS8)` は反復ごとに
イテレータと分割代入を生成する。全ホットループ（1b 穴BFS / 1c collar / 1d ラベリング /
1f 支持点収集 / 2 メインBFS / 2a preclaim / 2b farPriority / 2c close / 節3 Gauss-Seidel
40反復 / 節5 à-trous 5スケール×3パス）で、`dx`/`dy` を個別の定数配列
（`const DX=[1,-1,0,0]` 等）にした通常 for ループへ置き換える。
訪問順序（k=0..3 / 0..7 の順）は現状の OFFS / OFFS8 の並びと同一に保つこと。

### A-2. disparity の前計算

`1 / depth[i]` が 1c / 1d / 1e / 1f / 2(isForeground) / curtainCap 等で繰り返し計算される。
`depth` は `generate()` 内で不変（読み取り専用）なので、冒頭で
`invDisp = new Float32Array(N)` に `1 / depth[i]` を一度だけ計算して全箇所で参照する。
除算1回の結果を再利用するだけなのでビット単位で同値。
（注意: `curtainCap` の `(1 / depth[i]) / (1 + jumpTol)` のような複合式は、
`invDisp[i] / (1 + jumpTol)` に置き換える。式の分解順は変えない）

### A-3. 一時配列の再利用・typed array 化

- 1e の `da/ra/ga/ba` と `median()` 内の `arr.slice().sort()`: 種ごとに毎回 slice+sort している。
  再利用可能な Float32Array バッファ + 長さ変数に変え、sort は typed array の
  `subarray(0, len).sort()`（数値昇順、比較関数なし）で行う。中央値の添字規則
  `t[t.length >> 1]` は変えない。
- `frontier` / `candList` / `nextFrontier` / `synthList` / `preclaimOrder` / `closeList` /
  `seedList` などの整数 push 配列: `Int32Array` + カウンタに置き換えられるものは置き換える。
  処理順（push された順に処理）は維持する。
- `fitAffine` 内の `ds.slice().sort()` はラベル単位で回数が少ないので変更不要（任意）。

### A-4. やらないこと

- 2d ブリッジ統合・fitAffine のロジック変更、Web Worker 化、WGSL 化はしない。
- ループの融合や打ち切り条件の追加など「結果が変わり得る」変更はしない。
- 迷ったら「変えない」を選ぶ。

## 検証（必須）

Node で新旧実装の同値テストを行う。手順:

1. 作業前に `js/backfill.js` を一時フォルダ（リポジトリ外、例: OS の temp）へコピーする。
2. リポジトリ外に検証スクリプト（Node, .mjs）を作る:
   - `js/worldpos.js` と 新旧 `backfill.js` をテキストとして読み、
     `new Function` などで評価して `WorldPos` / `Backfill` を得る
     （両ファイルはブラウザグローバルへ代入する IIFE。DOM 非依存で console のみ使用）。
   - 合成入力を作る: 例 W=96,H=64。シード付き擬似乱数（mulberry32 等）で
     「複数の深度台地 + 段差 + 無効画素の帯（holeMask）」を持つ depth / validMask /
     holeMask を生成。intrinsics は `{fx:1,fy:1,cx:0.5,cy:0.5}`。
     color は `{width:192,height:128,data:Uint8ClampedArray(乱数)}`。
   - opts は既定値と、`{marginPx:64, holePreclaimPx:3, farPriorityPx:12}` など数パターン。
   - 新旧の戻り値 `worldPos` / `colorTex.data` / `validMask` を **byte 単位で比較**
     （Float32Array は Uint8Array ビューで比較。NaN のビットパターンも一致すること）。
3. 乱数シードを変えて最低 5 ケース、全一致を確認する。
4. `node --check js/backfill.js` で構文確認。
5. 検証スクリプトと一時コピーは終了時に削除する（リポジトリに残さない）。

## 完了報告フォーマット

- 変更した関数/節の一覧と、それぞれの変更種別（A-1/A-2/A-3）
- 同値テスト結果（ケース数、全一致か）と、可能なら Node 上での新旧実行時間
- 変更しなかったもの（A-4 に該当して見送った箇所があれば理由）
