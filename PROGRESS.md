# 実装状況

最終更新: 2026-07-05

## 現在の構成

単一画像をブラウザ内で MoGe-2 に入力し、深度・ワールドポジション・メッシュを生成する。画像と推論結果は外部へ送信しない。モデルと JavaScript ライブラリの初回取得時のみネットワークを使用する。

処理パイプライン:

1. `js/inference.js`: MoGe-2 ONNX 推論。ViT-S / ViT-B / ViT-L、`num_tokens`、WebGPU → WASM フォールバック、Cache API に対応。
2. `js/moge_post.js`: point map から focal/shift を復元し、正規化 intrinsics、metric depth、camera-space point map、二値 mask を生成。
2a. `MogePost.fillBackdrop`: Sky Backdrop モード時、mask 除去画素を最奥の一定Z平面へ再投影して埋め戻す。
2b. `js/edgesnap.js`: 深度エッジのランプ画素を両側の台地へ吸着（中間値の除去、画素削除なし）。吸着元 index を UV 差し替えに渡す。Edge Threshold が検出しきい値、Snap Width が伝播上限。
3. `js/worldpos.js`: camera-space `(X right, Y down, Z forward)` を Y-up の `(-X, -Y, Z)` へ変換し、表示スケールと mask を適用。
4. `js/backfill.js`: エッジ切断で生じた穴を、奥側エッジのみから深度（disparity平面フィット+ラプラス平滑化）と色（プルプッシュ+拡散）で伸長し、第2レイヤー（world position + テクスチャ）を生成（PLAN_INPAINT.md）。
5. `js/viewer.js`: three.js でテクスチャ付きメッシュまたは点群を表示。無効画素の面を除去し、深度段差セルは削除せず near/far 2枚のプレートへ分割（頂点複製で各1セル延長、正面ビュー隙間ゼロ）。第2レイヤーは `BackfillMesh` として表示・GLB 出力。
6. `js/download.js` / `js/exr.js`: 元画像、Depth EXR、World Position EXR、Backfill WorldPos EXR / Texture PNG、OBJ、2048×2048 PNG を出力。

## 実装済み

- [x] JPG / PNG のドロップとファイル選択
- [x] MoGe-2 ViT-S / ViT-B / ViT-L の切り替え
- [x] WebGPU 推論と WASM フォールバック
- [x] モデルのブラウザキャッシュと選択モデルの保存
- [x] `num_tokens`、Scale、Sky / Masked Area（3択: Sky Backdrop / Apply Mask OFF / ON）の UI
- [x] Sky Backdrop: mask 除去領域（空など）を `max(有効最大深度×2, 100m)` の一定Z平面（書き割り）として最奥に残す（2026-07-05、既定モード。`MogePost.fillBackdrop`）
- [x] focal/shift、intrinsics、metric scale の後処理
- [x] Y-up World Position の生成
- [x] メッシュ、点群、ワイヤーフレーム、Unlit、No Color 表示
- [x] mask による不要面の除去
- [x] 深度エッジのスナップ + シーム分割（旧: 頂点・面削除方式を 2026-07-05 に置き換え。Edge Threshold=検出しきい値 0.005〜1.000 既定0.045 / Snap Width=伝播上限 1〜32px 既定4。エッジのランプ画素を両側の台地へ吸着し UV も吸着元へ差し替え、段差セルは near/far 2枚のプレートに分割して各1セル延長 → 正面ビューの隙間ゼロ。PLAN_INPAINT.md 2026-07-05 ログ参照）— 実機検証待ち
- [x] 推定 intrinsics を使った正面初期カメラと Reset View
- [x] 3点指定による水平面・回転中心・手前側の設定
- [x] 確定済み水平グリッドへの OBJ 座標変換（中心=原点、法線=+Y）
- [x] 水平グリッドへ変換した World Position EXR
- [x] 変換済みメッシュ・テクスチャ・推定元カメラ・現在カメラを含む Scene GLB
- [x] Depth EXR / World Position EXR / OBJ / PNG の出力
- [x] GitHub Pages デプロイ設定
- [x] 遮蔽穴インペイント（Fill Occlusion / Fill Margin、第2レイヤー表示、Backfill EXR/PNG、GLB `BackfillMesh`）— 実画像で検証済み。確定仕様は PLAN_INPAINT.md「8.5 確定実装スナップショット」参照

## カメラ仕様

MoGe 後処理が返す正規化 `fx/fy` から水平・垂直画角を計算する。初期表示と Reset View は推定カメラ原点 `(0, 0, 0)` から `+Z` を向く。`worldpos.js` が X/Y を反転しているため、この向きで入力画像と同じ上下左右になる。

ビューアのアスペクト比が入力画像と異なる場合は、水平・垂直の両方が収まるよう垂直 FOV を拡張する。intrinsics が不正、または正の深度範囲が得られない場合は、メッシュ境界を正面から収めるフォールバックを使用する。

`Adjust Horizontal Grid` では現在の回転平面を先に表示し、同一平面上の3点から候補グリッドをプレビューする。`Use This Grid` で重心を OrbitControls の中心、平面法線を上方向として確定し、`Cancel` で破棄する。確定・取消後は初期ボタン表示へ戻る。確定後はグリッドを非表示にするが設定は保持し、Reset View でも推定カメラ位置から確定済みの中心を向くビューを再構成する。

## 要実機確認

- 複数の縦長・横長画像で、初期表示の向き、余白、Reset View を確認する。
- ViT-S / ViT-B / ViT-L の focal/shift 復元結果を比較する。
- Apply Mask の有無で不要面除去とカメラクリップ範囲を確認する。
- 出力 EXR を Houdini などで読み、チャンネルと座標系を確認する。
- 大容量モデルの初回ダウンロード、Cache API、WebGPU → WASM 切り替えを実ブラウザで確認する。

## 参考

- 現行の利用方法と仕様: [README.md](README.md)
- MoGe-2 移行時の設計記録: [PLAN_MOGE.md](PLAN_MOGE.md)
- 初期 DA3 版の設計記録: [PLAN.md](PLAN.md)
