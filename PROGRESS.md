# 実装進行状況 (PROGRESS)

> トークン制限に備え、各ステップ完了ごとに更新する作業ログ。再開時はここを最初に読む。

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
