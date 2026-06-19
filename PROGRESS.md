# 実装進行状況 (PROGRESS)

> トークン制限に備え、各ステップ完了ごとに更新する作業ログ。再開時はここを最初に読む。

---

## ★ MoGe-2 移行（最新・確定） — 実装完了

DA3METRIC-LARGE は intrinsics 非出力のため FOV 仮定が必要で、球面状の歪み（湾曲）が出た。
カメラ焦点/シフトを点群から復元できる **MoGe-2** に移行。計画は [PLAN_MOGE.md](PLAN_MOGE.md)。

### モデル
- `Ruicheng/moge-2-vitl-normal-onnx` の `model.onnx`（約1.32GB, FP32, 動的形状 + 可変トークン）
- 入力: `image`[1,3,H,W]（ImageNet正規化）+（任意）`num_tokens` int64 スカラー
- 出力: `points`[1,H,W,3]（アフィン点群）/ `normal`[1,H,W,3] / `mask`[1,H,W]（sigmoid）/ `metric_scale`[1]

### 実装状況（すべて完了）
- [x] inference.js を MoGe 用に書換（4出力、num_tokens対応、入力サイズ算出）
- [x] moge_post.js 新規（recover_focal_shift 最小二乗、正規化intrinsics、逆投影、metric適用、mask二値化）
- [x] worldpos.js を `WorldPos.fromCameraPoints(camPoints,W,H,maskBin,{scale,applyMask})` に簡素化
- [x] main.js パイプライン差替（Inference.run → MogePost.process → WorldPos.fromCameraPoints → Viewer.setData）
- [x] index.html UI 変更：FOV撤去、`num_tokens`スライダ追加、`metricScale`→`applyMask`、`moge_post.js`読込追加
- [x] get_errors で JS/HTML 静的エラーなしを確認

### パイプライン（現行）
1. `Inference.run(imageData, numTokens)` → 生 MoGe 出力（モデル解像度 inW×inH）
2. `MogePost.process(moge, {useMetric:true})` → カメラ空間メトリック点群 + depth + intrinsics + 二値mask
3. `WorldPos.fromCameraPoints(...)` → Houdini WP（out=[-X*scale, -Y*scale, Z*scale, 1]、applyMaskでNaN）
4. `Viewer.setData(...)` → メッシュ表示（色テクスチャは元画像解像度、ビューア側で補間）
- 再計算: num_tokens 変更時のみ再推論、scale/mask変更は後処理のみ（軽量）

### 未検証 / 実機確認が必要
1. **モデルDL**: 約1.32GB。初回DLは時間がかかる（Cache APIで2回目以降は高速）。HF CDN CORS要確認。
2. **後処理の数値妥当性**: focal/shift 復元、reprojection の見た目（歪みが取れているか）。
3. **mask の効き**: 背景/空の除外が意図通りか。
4. **num_tokens の最適値**: 既定1800。精度/速度トレードオフ。
5. EXR 互換性（Houdini等で開けるか）は従来同様要確認。

### 次のアクション
- ローカル（run.bat → http://localhost:8000）で実機テスト → 上記の確認・調整。

---

## （以下は DA3METRIC 時代のログ・参考）

## 全体ステップ
- [x] 0. 計画策定（[PLAN.md](PLAN.md)）
- [x] 1. プロジェクト雛形（index.html / css / .nojekyll）
- [x] 2. three.js ビューア移植（`js/viewer.js`）— `Viewer.setData(worldPos,w,h,colorTex,baseName)` API
- [x] 3. world position 計算（`js/worldpos.js`）— `WorldPos.compute(depth,dW,dH,{fovDeg,scale,useMetricScale})`
- [x] 4. EXR エンコーダ（`js/exr.js`）— `EXR.encodeDepth` / `EXR.encodeWorldPos`（FLOAT無圧縮）
- [ ] 5. onnxruntime-web 推論（`js/inference.js`）— ロード/前処理/推論/後処理
- [ ] 6. ダウンロード機能（`js/download.js`）
- [ ] 7. 全体配線・UI（`js/main.js`, `index.html` 仕上げ）
- [ ] 8. GitHub Actions デプロイ（`.github/workflows/deploy.yml`）+ README

## 確定した設計メモ
- **出力形式: EXR（確定）**。depth=`{name}_depth.exr`(Yチャンネル), WP=`{name}_worldposition.exr`(R=X,G=Y,B=Z)。
- モデル `DA3METRIC-LARGE.onnx`: 入力`[1,3,280,504]`(ImageNet正規化, [0,1])、出力`depth`/`sky`のみ。**intrinsics非出力** → FOV仮定で `fx=fy=0.5*W/tan(FOV/2)`, `cx=W/2, cy=H/2`。
- 後処理: 負値クランプ → `metricDepth = depth*((fx+fy)/2/300)`(任意) → 逆投影 `X=(u-cx)Z/fx,Y=(v-cy)Z/fy` → Houdini化 `X=-X,Y=-Y` → `*scale`。
- WP内部表現: `Float32Array(H*W*4)` RGBA(=XYZ+1)。viewer/EXR共用。元画像解像度で保持。
- three.js は CDN r128。onnxruntime-web は CDN。モデルは HF CDN から実行時 fetch + Cache API。
- viewer の既存ID群（移植先でも踏襲）: `pointsMode`,`disableLighting`,`disableColor`,`pointSizeControl`,`pointSize`,`pointSizeValue`,`resetView`,`toggleWireframe`,`showCaptureFrame`,`exportOBJ`,`exportPNG`,`meshResolution`,`rangeX/Y/Z`,`loadingOverlay`,`loadingText`,`dropZone`,`fileInput`,`controls`,`info`,`meshInfo`,`canvas`,`captureFrame`。

## 現在地
- 全ステップ実装完了。get_errors でJS/HTMLの静的エラーなしを確認済み。
- 作成済ファイル: `index.html`, `css/style.css`, `.nojekyll`, `js/{viewer,worldpos,exr,inference,download,main}.js`, `.github/workflows/deploy.yml`, `README.md`, `PLAN.md`, `PROGRESS.md`。

## 未検証 / 残課題（実機確認が必要）
1. **HF CDN の CORS**: `resolve/main/...onnx` への直接 fetch がブラウザで通るか未確認。NG の場合は Pages 同梱(Git LFS)かプロキシ対応が必要。
2. **モデルサイズ**: LARGE は大きい可能性。初回DLの所要時間。
3. **depth スケール/符号**: モデル出力 depth の単位・符号、focal/300 スケールの妥当性は実画像で要検証。逆投影の見た目が歪む場合は FOV または metricScale を調整。
4. **EXR の互換性**: 自作エンコーダ。Houdini/他ツールで開けるか実ファイルで確認推奨。
5. **sky 出力**: 現状未使用（空ピクセルのキャップ処理は未実装）。必要なら inference.js に追加。
6. ローカル確認は `python -m http.server` 等の静的サーバー経由（file:// では Cache API 等が制限）。

## 次にやること（任意の改善）
- 実機テスト → 上記課題の確認・調整。
- 必要なら sky マスクによる遠景クランプ、EXR の確認用 PNG 出力など。
