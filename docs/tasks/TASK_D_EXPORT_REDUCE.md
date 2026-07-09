# TASK D: 境界スムース化 + ポリゴンリダクション（表示への遅延適用）

改訂 2026-07-09: 当初「エクスポート時のみ・既定 OFF」だった設計を、
「**表示メッシュへ遅延適用・既定 ON**」に変更した。エクスポートは表示中の
ジオメトリをそのまま使う既存構造のため、表示を縮小版に差し替えれば
OBJ / GLB も自動的に縮小版になる。

## 背景（このファイルだけで完結）

このリポジトリはブラウザ内で単一画像から depth 推論しメッシュ化する静的 Web アプリ
（GitHub Pages ホスト、ビルド工程なし）。メッシュは画像グリッド由来で、深度段差で
意図的に切り離した境界（シルエット）が**ピクセル階段状（ガタガタ）**になっており、
面数も数百万と多い。メッシュ表示後に遅延して次の2段を行う機能を追加する:

1. **境界スムース化**: 切り離し境界の階段を滑らかにする（見た目の改良）
2. **リダクション**: meshoptimizer で誤差上限内の安全な簡略化

重要な前提: このメッシュのテクスチャは元画像の画面投影なので、境界頂点を
**スクリーン空間で動かし、UV も同じ量ずらせば**テクスチャはズレない。
これがスムース化を先に行える理由であり、`LockBorder` 付き簡略化の削減率も改善する。

事前調査は同フォルダの `TASK_C_REPORT.md` にある。**先にそれを読むこと**
（meshoptimizer の入手先・API・統合スケッチ・注意点が書いてある）。

対象リポジトリ: `C:\work\script\Image_to_Mesh_web`

## 絶対条件

1. **チェックボックス OFF のとき、表示・エクスポートとも現状と完全に同一であること。**
   メッシュを最初に構築する経路（createMesh / rebuildBackfillMesh / rebuildFillBMesh）の
   計算内容は変更しない。リダクションは構築・表示の**後に**走る後処理とする。
2. 変更してよいファイル: `js/viewer.js`、`index.html`（UI 追加とキャッシュバスター）、
   `README.md`（third-party ライセンス節の追加のみ）、新規 `js/vendor/meshopt_simplifier.js`。
3. git commit / push はしない。ブラウザでの実機確認もしない（`node --check` のみ）。
4. ファイルは UTF-8。日本語コメントを壊さない。既存コメントは削除しない。
5. UI パラメータは**チェックボックス1つだけ**（`Reduce Polygons`、既定 ON）。
   数値スライダーは追加しない。調整用定数はコード内の1箇所にまとめ、コメントで意味を書く。
6. v1 はメインスレッド実行でよい（Web Worker 化は別計画 Phase 1-G で行う。
   ここでは作らない）。
7. 新しい md は作らない（完了報告はチャットで返す）。

## アーキテクチャ

```
createMesh / rebuildBackfillMesh / rebuildFillBMesh（従来どおり、フル解像度で表示）
        │ 表示された後
        ▼
scheduleReduction()  … debounce REDUCE_DEBOUNCE_MS(既定400ms) + 世代トークン
        ▼
runReduction()       … メインスレッド。対象: 主メッシュ / backfill / FillB
   1. compact 化（使用頂点のみの position/uv/index を作る。alignment は適用しない）
   2. 境界スムース化（FillB はスキップ）
   3. meshopt simplifyWithAttributes + compactMesh
   4. 新しい BufferGeometry を作り、表示中メッシュの geometry を差し替え
      （旧 geometry は dispose。material・wireframe 状態は維持。normal 再計算）
        ▼
エクスポート: 既存コードのまま「表示中の geometry」を使う → 自動的に縮小版
```

- **世代トークン**: メッシュが再構築されるたびにカウンタを進め、遅延実行時に
  トークンが古ければ結果を捨てる。スライダー連打中に古い結果で上書きしない。
- **points モード時はリダクションしない**（点描画は index を使わないため無意味。
  points→mesh に切り替えたら通常どおりスケジュールされる）。
- **チェック OFF への切替時**: スケジュールを取り消し、createMesh（フル再構築）で
  元のフル解像度表示に戻す。ON への切替時はスケジュールする。
- **エクスポート時にリダクションが未完/保留中の場合**: 先に実行を完了させてから
  エクスポートする（散発的な「たまたま未縮小のまま出力」を防ぐ）。
- メインスレッド実行なので走る瞬間は UI が固まる（1〜2秒想定）。debounce により
  「操作が止まった後に1回だけ」走ることを保証する。

## 実装内容

### D-1. vendor 配置とライセンス

- `meshoptimizer@1.2.0` の `meshopt_simplifier.js` を `js/vendor/meshopt_simplifier.js` に置く
  （TASK_C_REPORT.md 記載の npm tarball / CDN から取得。サイズ約 55KB、WASM 内包の
  単一 ES module であることを確認）。
- README.md に TASK_C_REPORT.md 節2の文面で Third-party libraries 節を追加。

### D-2. ロード方法

初回のリダクション実行時に一度だけ dynamic import する（TASK_C_REPORT.md 案A）:
`await import('./vendor/meshopt_simplifier.js')` → `MeshoptSimplifier.ready` を await。
Promise をキャッシュして2回目以降は再ロードしない。`supported` が false またはロード
失敗時は console.warn を出し、以後リダクションを無効化してフル表示のまま動かす
（アプリを止めない）。

### D-3. UI

`index.html` の Mesh 系設定欄に checkbox `id="reducePolygons"`、ラベル「Reduce Polygons」、
**既定 ON（checked）** を追加。viewer.js 側で
`const el = document.getElementById('reducePolygons')` を null 安全に読み、
change イベントも viewer.js 内で購読してよい（main.js は変更しない）。

### D-4. compact 化（リダクション入力の準備）

既存 `createCompactExportGeometry` の「使用頂点だけを詰め直す」ロジックとほぼ同じだが、
**alignment 変換を適用しない**版を関数として切り出す（既存関数は変更せず流用できる形なら
流用してよい。ただし既存 export 経路の挙動を変えないこと）。
表示ジオメトリには面除去で参照されなくなった NaN 頂点が残っており、meshopt に
そのまま渡せないため、この compact 化は必須。

### D-5. 境界スムース化

定数: `SMOOTH_ITERS = 3` / `SMOOTH_LAMBDA = 0.5` /
`SMOOTH_CLAMP_CELLS = 0.75`（累計変位のグリッドセル単位上限）。

1. **スクリーン座標の導出**: world position → 正規化スクリーン座標 (u01, v01) へ逆投影。
   `js/worldpos.js`（world 化 = camera-space の X,Y 反転）と `js/backfill.js` 節6
   （camera-space 化: `x_cam = (u01 - cx) / fx * z`）を読み、その**逆写像**を正確に実装する。
   検算: 複製頂点でないグリッド頂点の逆投影結果は、その頂点の uv（`(px + 0.5) / W` 規約、
   v は上下反転）と一致するはず。intrinsics は viewer 保持の `currentIntrinsics`。
   グリッド寸法 W/H は主メッシュ = `meshWidth/meshHeight`（`createMesh` と同じ算出）、
   backfill = layer の width/height。
2. **境界抽出**: 使用回数1の辺（境界辺）を列挙し、境界頂点ごとに境界隣接頂点を集める。
   既存 `erodeBoundaryFaces` の辺カウント方式（`EDGE_KEY_STRIDE` 整数キー）を参考にしてよい。
3. **可動判定**: 境界隣接がちょうど2個の頂点のみ可動。分岐点（3個以上）・端点は固定。
   さらに**画像外周フレーム上の頂点は固定**（u01/v01 がグリッド外周から 1px 相当以内。
   外周を丸めないため）。
4. **平滑化**: スクリーン座標に対し `p' = p + λ((prev + next) / 2 − p)` を SMOOTH_ITERS 回。
   z は変更しない。累計変位が SMOOTH_CLAMP_CELLS（セル単位）を超えたらその半径にクランプ。
5. **書き戻し**: 新スクリーン座標と元の z から position を再計算（backfill 節6 と同じ式 +
   world 反転）。**uv には同じスクリーン変位を差分として加算**する（複製頂点は uv が
   自分の位置と異なる規約なので、uv を位置から再計算してはならない。必ず差分加算）。

FillB は連続グリッドで切り離し境界が無いためスムース化をスキップし、D-6 のみ適用する。

### D-6. meshopt 簡略化

TASK_C_REPORT.md 節3のスケッチに従う。定数: `REDUCE_TARGET_RATIO = 0.1`（下限目標。
実際の到達点は誤差上限が決める）/ `REDUCE_TARGET_ERROR = 0.01` / `UV_WEIGHT = 1.0`。

- `simplifyWithAttributes(indices, positions, 3, uvs, 2, [UV_WEIGHT, UV_WEIGHT], null,
  targetIndexCount, REDUCE_TARGET_ERROR, ['LockBorder'])`
- `compactMesh` で remap して未使用頂点を落とす（レポートの擬似コードどおり）
- 各メッシュで `console.log('[Reduce]', name, 面数 before → after, error, 所要ms)` を出す
- 簡略化後の index は Uint32Array のままでよい

### D-7. 差し替えとスケジューリング

- `scheduleReduction()`: `REDUCE_DEBOUNCE_MS = 400` の debounce。呼び出し箇所は
  createMesh / rebuildBackfillMesh / rebuildFillBMesh の末尾（表示が立った後）。
  世代トークンを比較し、実行時点で最新でなければ何もしない。
- 実行は `setTimeout` ベースでよい（描画1フレームを挟むために
  `requestAnimationFrame` → `setTimeout(0)` の併用も可）。
- 差し替え: `mesh.geometry.dispose()` → 新 geometry を代入。material / wireframe /
  レイヤー名（`BackfillMesh` 等）は維持。normal は `computeVertexNormals()`、
  bounds は標準の compute で再計算（縮小後は NaN 頂点が無いため既存の
  `updateFiniteGeometryBounds` は不要）。
- 差し替え後にカメラ・コントロールは触らない。

### D-8. キャッシュバスター

`index.html` の `viewer.js?v=` を今日の日付で +1 する。

## 検証

- `node --check js/viewer.js`
- OFF パス不変の自己検証: チェック OFF のとき新規コードが一切実行されないことを
  コードレビューレベルで確認し、報告に根拠を書く
- D-5 の逆投影の検算（非複製頂点で uv と一致）を Node の単体計算で確認できるなら行う
  （viewer.js から式を抜き出した簡易スクリプトで可。終了時に削除）
- 実機確認（表示の差し替わり・エクスポートを DCC で確認）はユーザーが行う

## 完了報告フォーマット

- D-1〜D-8 の実施状況
- OFF パス不変の根拠
- 逆投影検算の結果
- 定数一覧（ユーザーが調整時に触る場所）
- 既知の制限（例: 実行瞬間のフリーズ見込み、LockBorder による削減率の頭打ち、
  Worker 化は Phase 1-G 予定であること）
