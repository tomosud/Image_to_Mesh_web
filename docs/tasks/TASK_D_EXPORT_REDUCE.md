# TASK D: エクスポート時の境界スムース化 + ポリゴンリダクション

## 背景（このファイルだけで完結）

このリポジトリはブラウザ内で単一画像から depth 推論しメッシュ化する静的 Web アプリ
（GitHub Pages ホスト、ビルド工程なし）。メッシュは画像グリッド由来で、深度段差で
意図的に切り離した境界（シルエット）が**ピクセル階段状（ガタガタ）**になっており、
面数も数百万と多い。OBJ / GLB エクスポート時に限り、次の2段を行う機能を追加する:

1. **境界スムース化**: 切り離し境界の階段を滑らかにする（見た目の改良）
2. **リダクション**: meshoptimizer で誤差上限内の安全な簡略化

重要な前提: このメッシュのテクスチャは元画像の画面投影なので、境界頂点を
**スクリーン空間で動かし、UV も同じ量ずらせば**テクスチャはズレない。
これがスムース化を先に行える理由であり、`LockBorder` 付き簡略化の削減率も改善する。

事前調査は同フォルダの `TASK_C_REPORT.md` にある。**先にそれを読むこと**
（meshoptimizer の入手先・API・統合スケッチ・注意点が書いてある）。

対象リポジトリ: `C:\work\script\Image_to_Mesh_web`

## 絶対条件

1. **チェックボックス OFF（既定）のとき、エクスポート結果・ビューア表示とも現状と
   完全に同一であること。** 新機能は export 経路の opt-in 分岐のみ。表示用メッシュ
   生成（createMesh / rebuildBackfillMesh / rebuildFillBMesh）は変更しない。
2. 変更してよいファイル: `js/viewer.js`、`index.html`（UI 追加とキャッシュバスター）、
   `README.md`（third-party ライセンス節の追加のみ）、新規 `js/vendor/meshopt_simplifier.js`。
3. git commit / push はしない。ブラウザでの実機確認もしない（`node --check` のみ）。
4. ファイルは UTF-8。日本語コメントを壊さない。既存コメントは削除しない。
5. UI パラメータは**チェックボックス1つだけ**。数値スライダーは追加しない。
   調整用定数はコード先頭にまとめ、コメントで意味を書く。
6. 新しい md は作らない（完了報告はチャットで返す）。

## 実装内容

### D-1. vendor 配置とライセンス

- `meshoptimizer@1.2.0` の `meshopt_simplifier.js` を `js/vendor/meshopt_simplifier.js` に置く
  （TASK_C_REPORT.md 記載の npm tarball / CDN から取得。サイズ約 55KB、WASM 内包の
  単一 ES module であることを確認）。
- README.md に TASK_C_REPORT.md 節2の文面で Third-party libraries 節を追加。

### D-2. ロード方法

ES module なので、export 時に一度だけ dynamic import する（TASK_C_REPORT.md 案A）:
`await import('./vendor/meshopt_simplifier.js')` → `MeshoptSimplifier.ready` を await。
Promise をキャッシュして2回目以降は再ロードしない。`supported` が false の場合と
ロード失敗時は、**簡略化をスキップして従来のエクスポートを続行**し、alert ではなく
console.warn で通知する。

### D-3. UI

`index.html` の Export 欄に checkbox `id="reducePolygons"`、ラベル「Reduce Polygons」、
既定 OFF を追加。viewer.js 側は export 関数内で
`const el = document.getElementById('reducePolygons'); const reduce = !!(el && el.checked);`
のように null 安全に読む。main.js は変更しない。

### D-4. 処理の挿入位置と順序

現在 `createCompactExportGeometry(sourceGeometry)` は「使用頂点の compact 化 →
**コピーと同時に** alignment 変換（center 減算 + quaternion）→ BufferGeometry 化」を行う。
reduce ON のときは順序を次に変える（OFF のときは既存コードパスをそのまま通すこと）:

1. compact コピー（**alignment 未適用**の生 world 座標のまま position/uv/index を作る）
2. 境界スムース化（D-5。world→スクリーン投影が必要なため alignment 前に行う）
3. meshopt 簡略化（D-6）
4. alignment 変換を position に適用
5. BufferGeometry 化、normal/bounds 再計算

対象は主メッシュ・backfill・FillB の3ジオメトリ共通。ただし**FillB は D-5 をスキップ**
（連続グリッドで切り離し境界が無い）し、D-6 のみ適用する。

### D-5. 境界スムース化

定数（コード冒頭にまとめる）: `SMOOTH_ITERS = 3` / `SMOOTH_LAMBDA = 0.5` /
`SMOOTH_CLAMP_CELLS = 0.75`（累計変位のグリッドセル単位上限）。

1. **スクリーン座標の導出**: world position → 処理グリッドのピクセル座標へ逆投影する。
   `js/worldpos.js`（world 化 = camera-space の X,Y 反転）と `js/backfill.js` 節6
   （camera-space 化: `x_cam = (u01 - cx) / fx * z`）を読み、その**逆写像**を正確に
   実装する。検算: 複製頂点でないグリッド頂点の逆投影結果は、その頂点の uv
   （`(px + 0.5) / W` 規約）と一致するはず。intrinsics は viewer が保持する
   `currentIntrinsics`、グリッド寸法は `currentWorldPosData.width/height`。
2. **境界抽出**: 使用回数1の辺（境界辺）を列挙し、境界頂点ごとに境界隣接頂点を集める。
3. **可動判定**: 境界隣接がちょうど2個の頂点のみ可動。分岐点（3個以上）・端点は固定。
   さらに**画像外周フレーム上の頂点は固定**（逆投影したピクセル座標が
   グリッド外周から 1px 以内のもの。外周を丸めないため）。
4. **平滑化**: スクリーン座標 (sx, sy) に対し `p' = p + λ((prev + next) / 2 − p)` を
   SMOOTH_ITERS 回。z は変更しない。累計変位が SMOOTH_CLAMP_CELLS を超えたら
   その半径にクランプ。
5. **書き戻し**: 新スクリーン座標と元の z から position を再計算（1 の逆写像の逆 =
   backfill 節6 と同じ式 + world 反転）。**uv には同じスクリーン変位を
   `(Δsx / W, −Δsy / H)` として加算**する（複製頂点は uv が自分の位置と異なる規約なので、
   uv を位置から再計算してはならない。必ず「差分の加算」で動かすこと）。

境界辺の抽出は viewer.js 既存の `erodeBoundaryFaces` の辺カウント方式
（`EDGE_KEY_STRIDE` の整数キー）を参考にしてよい。

### D-6. meshopt 簡略化

TASK_C_REPORT.md 節3のスケッチに従う。定数: `REDUCE_TARGET_RATIO = 0.1`（下限目標。
実際の到達点は誤差上限が決める）/ `REDUCE_TARGET_ERROR = 0.01` / `UV_WEIGHT = 1.0`。

- `simplifyWithAttributes(indices, positions, 3, uvs, 2, [UV_WEIGHT, UV_WEIGHT], null,
  targetIndexCount, REDUCE_TARGET_ERROR, ['LockBorder'])`
- `compactMesh` で remap して未使用頂点を落とす（レポートの擬似コードどおり）
- 3ジオメトリそれぞれで `console.log('[Reduce]', name, 面数 before → after, error)` を出す
- 簡略化後の index が Uint16 に収まる場合も Uint32Array のままでよい

### D-7. 非同期化

`exportGLB` を async にする（`exportOBJ` は既に async）。ボタンハンドラは
`index.html` / `main.js` 側の変更なしで動くこと（イベントリスナーに async 関数は可）。
失敗時は catch して従来どおり alert。

### D-8. キャッシュバスター

`index.html` の `viewer.js?v=` を今日の日付で +1 する。

## 検証

- `node --check js/viewer.js`
- OFF パス不変の自己検証: reduce OFF のとき `createCompactExportGeometry` が
  既存と同一の演算順で動くことをコードレビューレベルで確認し、報告に根拠を書く
- D-5 の逆投影の検算（非複製頂点で uv と一致）を Node の単体計算で確認できるなら行う
  （viewer.js から式を抜き出した簡易スクリプトで可。終了時に削除）
- 実機確認（エクスポートして DCC で開く）はユーザーが行う

## 完了報告フォーマット

- D-1〜D-8 の実施状況
- OFF パス不変の根拠
- 逆投影検算の結果
- 定数一覧（調整時にユーザーが触る場所）
- 既知の制限（例: 大メッシュでのフリーズ秒数見込み、LockBorder による削減率の頭打ち）
