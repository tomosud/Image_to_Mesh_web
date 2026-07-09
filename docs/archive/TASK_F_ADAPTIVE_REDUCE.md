# TASK F: カメラ距離適応リダクション（奥ほど強く削る）

## 背景（このファイルだけで完結）

このリポジトリはブラウザ内で単一画像から depth 推論しメッシュ化する静的 Web アプリ。
表示メッシュへの遅延ポリゴンリダクションは Web Worker（`js/reduce_worker.js`、
meshoptimizer `simplifyWithAttributes` + 境界スムース化）で動いている。
現状は誤差をワールド空間で測るため、画面上ほとんど動かない遠景も近景と同じ基準で
しか削れない。これを「**ソースカメラから見た画面上の誤差**」基準に変え、
奥に行くほど強く削れるようにする。あわせて全体の削減も一段強める。

対象リポジトリ: `C:\work\script\Image_to_Mesh_web`
現在の実装: `js/reduce_worker.js`（簡略化・スムース化・法線計算）と
`js/viewer.js`（スケジューリング・定数定義・結果差し替え）。

## 絶対条件

1. 変更してよいファイル: `js/reduce_worker.js`、`js/viewer.js`（定数と params 渡しのみ）、
   `index.html`（キャッシュバスターのみ）。
2. **表示・エクスポートに使う頂点の position / uv の値は一切変えない**
   （簡略化は index の選別のみ。歪み座標は誤差判定専用のコピーに使う）。
   境界スムース化・法線計算・差し替え処理は変更しない。
3. `Reduce Polygons` OFF 時の挙動は現状と完全同一。UI の追加はしない。
   調整用の新定数は viewer.js の既存定数ブロックにまとめ、params で worker へ渡す。
4. git commit / push はしない。ブラウザ実機確認はしない（構文チェックのみ）。
5. ファイルは UTF-8。日本語コメントを壊さない。
6. 新しい md は作らない（完了報告はチャットで返す）。

## 実装内容

### F-1. 歪み座標（スクリーン + 視差）での簡略化

worker の簡略化直前に、判定専用の頂点配列 `warped: Float32Array(N*3)` を作る:

```
// 投影はスムース化で使っている world → スクリーンの逆写像ヘルパを流用する
sx = u01 * gridW / L          // L = max(gridW, gridH)。画面XYを等方な 0..1 系に
sy = v01 * gridH / L
d  = (1 / z) / dispRef        // dispRef = そのジオメトリの有効頂点の disparity 中央値
warped[i*3]   = sx
warped[i*3+1] = sy
warped[i*3+2] = DEPTH_AXIS_WEIGHT * d
```

- `simplifyWithAttributes` の `vertex_positions` に **warped を渡し**、uv 属性・
  target/error/flags は従来どおり。**返ってきた index を元の position/uv に適用**する
  （meshopt simplifier は頂点値を書き換えず index を選別するだけなので、これが成立する）。
- `compactMesh` 以降は現状のまま。
- `dispRef` の中央値計算は worker 内で行う（typed array sort で可。有効頂点のみ）。
- これで target_error の意味が「画面上のずれの割合」になる。遠景（disparity 小）は
  ワールドで大きく動いても warped 空間ではほぼ動かないため、自動的に強く削れる。
- 数値安定: z が極端に大きい頂点（FillB バックドロップ等）は d ≈ 0 になり潰れやすく
  なるが、それが意図した挙動。z ≤ 0 / 非 finite は compact 化済みなので考えなくてよい。

### F-2. 削減強度の定数変更

viewer.js の定数ブロックで:

- `REDUCE_TARGET_ERROR`: `0.01` → `0.02`（新メトリクスでは「画面の約2%」の意味になる）
- `REDUCE_TARGET_RATIO`: `0.1` → `0.05`
- 新定数 `DEPTH_AXIS_WEIGHT = 0.5`
  （視差軸の重み。上げる=奥行き方向の形状維持が強くなり削減が弱まる、
    下げる=遠景がさらに潰れる。コメントにこの意味を書く）

### F-3. 遠景の境界ロック解除

現在は `['LockBorder']` で全境界頂点が固定され、遠景の切り離しシームの階段頂点が
面数を食っている。頂点単位ロックに切り替える:

- 新定数 `UNLOCK_FAR_BORDERS = true` / `FAR_BORDER_DISP_RATIO = 1.0`
  （dispRef との比。境界頂点のうち disparity < dispRef * ratio のもの＝中央値より
    奥のものはロックしない）
- スムース化で既に計算している境界頂点判定を流用し、
  `vertex_lock: Uint8Array(N)` を作る:
  近景境界（disparity ≥ dispRef * FAR_BORDER_DISP_RATIO）= 1（ロック）、
  遠景境界 = 0、非境界 = 0。
- `vertex_lock` を渡す場合は `LockBorder` フラグを外す（二重指定しない）。
- `UNLOCK_FAR_BORDERS = false` のときは従来どおり `['LockBorder']` + `vertex_lock: null`
  で呼ぶ（比較用に1定数で戻せること）。
- fillb（スムース化スキップのジオメトリ）は境界情報が無ければ従来どおり
  `LockBorder` でよい（外周フレームを守る）。

### F-4. ログ

`[Reduce]` ログに `dispRef` と `lockedBorderVerts / totalBorderVerts` を追加し、
遠景解除がどの程度効いたか実機で確認できるようにする。

### F-5. キャッシュバスター

`index.html` の `viewer.js?v=` と、viewer.js 内の worker URL（`reduce_worker.js?v=`）を
今日の日付で +1 する。

## 検証

- `node --check` を viewer.js / reduce_worker.js の両方に実行
- 歪み座標が**判定専用**であること（出力 position/uv が元配列由来のままであること）を
  コードレビューレベルで確認し、報告に根拠を書く
- 可能なら Node で小さな合成グリッドを simplifier に通し、
  (a) 出力頂点が入力頂点の部分集合であること、
  (b) DEPTH_AXIS_WEIGHT を変えると遠景側の削減が変わること、を確認する
  （meshopt の import が Node で可能な場合のみ。一時スクリプトは終了時に削除）
- 見た目の評価（近景の維持・遠景の削れ方・シームの割れ）はユーザーが実機で行う

## 完了報告フォーマット

- F-1〜F-5 の実施状況
- 出力座標不変の根拠
- 定数一覧と「もっと削る / 戻す」ときにユーザーが触るべき定数の説明
- 既知のリスク（例: 遠景境界解除による主メッシュ⇔backfill 間の隙間の可能性。
  気になる場合は UNLOCK_FAR_BORDERS=false か FAR_BORDER_DISP_RATIO を下げる）
