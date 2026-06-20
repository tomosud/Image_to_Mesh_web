# 実装状況

最終更新: 2026-06-20

## 現在の構成

単一画像をブラウザ内で MoGe-2 に入力し、深度・ワールドポジション・メッシュを生成する。画像と推論結果は外部へ送信しない。モデルと JavaScript ライブラリの初回取得時のみネットワークを使用する。

処理パイプライン:

1. `js/inference.js`: MoGe-2 ONNX 推論。ViT-S / ViT-B / ViT-L、`num_tokens`、WebGPU → WASM フォールバック、Cache API に対応。
2. `js/moge_post.js`: point map から focal/shift を復元し、正規化 intrinsics、metric depth、camera-space point map、二値 mask を生成。
3. `js/worldpos.js`: camera-space `(X right, Y down, Z forward)` を Y-up の `(-X, -Y, Z)` へ変換し、表示スケールと mask を適用。
4. `js/viewer.js`: three.js でテクスチャ付きメッシュまたは点群を表示。無効画素と大きな深度段差をまたぐ面を除去。
5. `js/download.js` / `js/exr.js`: 元画像、Depth EXR、World Position EXR、OBJ、2048×2048 PNG を出力。

## 実装済み

- [x] JPG / PNG のドロップとファイル選択
- [x] MoGe-2 ViT-S / ViT-B / ViT-L の切り替え
- [x] WebGPU 推論と WASM フォールバック
- [x] モデルのブラウザキャッシュと選択モデルの保存
- [x] `num_tokens`、Scale、Apply Mask の UI
- [x] focal/shift、intrinsics、metric scale の後処理
- [x] Y-up World Position の生成
- [x] メッシュ、点群、ワイヤーフレーム、Unlit、No Color 表示
- [x] mask と深度不連続による不要面の除去
- [x] 推定 intrinsics を使った正面初期カメラと Reset View
- [x] Depth EXR / World Position EXR / OBJ / PNG の出力
- [x] GitHub Pages デプロイ設定

## カメラ仕様

MoGe 後処理が返す正規化 `fx/fy` から水平・垂直画角を計算する。初期表示と Reset View は推定カメラ原点 `(0, 0, 0)` から `+Z` を向く。`worldpos.js` が X/Y を反転しているため、この向きで入力画像と同じ上下左右になる。

ビューアのアスペクト比が入力画像と異なる場合は、水平・垂直の両方が収まるよう垂直 FOV を拡張する。intrinsics が不正、または正の深度範囲が得られない場合は、メッシュ境界を正面から収めるフォールバックを使用する。

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
