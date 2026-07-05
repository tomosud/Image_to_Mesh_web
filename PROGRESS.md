# 実装状況

最終更新: 2026-07-05

## 現在の構成

単一画像をブラウザ内で MoGe-2 に入力し、metric depth、world position、メッシュ、backfill を生成する。画像と推論結果は外部へ送信しない。モデルと JavaScript ライブラリの初回取得時のみネットワークを使用する。

処理順と各段階が変更する対象は [PIPELINE.md](PIPELINE.md) を正本とする。ユーザー向けの使い方と UI 仕様は [README.md](README.md) を正本とする。

## 実装済み

- MoGe-2 ViT-S / ViT-B / ViT-L の WebGPU 推論と WASM フォールバック
- `num_tokens`、モデル選択、Scale、Sky / Masked Area、High-Res Depth、EdgeSnap、Backfill の UI
- MoGe point map から focal / shift / intrinsics / metric depth / camera-space points を復元
- 入力画像比率・長辺最大 2048px の depth 高解像度化
- WebGPU RGB-guided Joint Bilateral Filter と、WebGPU 不可時の初期拡大 fallback
- Sky Backdrop による mask 領域の最奥平面化
- SkyMaskColorFill による空 mask 内周4pxの色補正
- EdgeSnap による depth ランプの near/far 台地への吸着
- ColorPatch によるエッジ混色帯の表示/backfill 用テクスチャ補正
- Y-up world position 生成、メッシュ / 点群 / ワイヤーフレーム / Unlit / No Color 表示
- Adjust Horizontal Grid は aligned export 用の地平方向だけを設定し、scene origin / grid 表示位置 / orbit pivot は初期ターゲットに固定する
- Reset View は推定ソースカメラ位置・上方向・初期ターゲットへ戻す。grid 設定後も中心は変えない
- カメラ操作は Maya 風の `Alt+左=orbit` / `Alt+中=pan` / `Alt+右=dolly`。dolly は低速化
- カメラ情報が変わらない後処理パラメータ変更では、現在のビューを維持したままメッシュだけ更新
- depth 段差セルの near/far 2枚プレート分割と各1セル延長
- 奥側エッジ由来の Backfill 第2レイヤー
- Depth EXR、Initial Depth EXR、World Position EXR、Backfill EXR/PNG、OBJ、Scene GLB、2048 PNG 出力
- 連続処理時に ONNX Runtime session へ並列 `run()` が入らないための排他ガード

## 現在の既定値

- Quality (`num_tokens`): `1800`
- High-Res Depth: ON
- High-Res Depth long edge: `2048px`
- Initial Depth Resize: `Bilinear`
- Edge Threshold: `0.010`
- Snap Width: `8`
- Sky / Masked Area: Sky Backdrop
- SkyMaskColorFill inner ring: `4px`

## 要実機確認

- 複数の縦長・横長画像で、初期表示の向き、余白、Reset View を確認する。
- ViT-S / ViT-B / ViT-L の focal / shift 復元結果を比較する。
- WebGPU 使用時と fallback 時の High-Res Depth ステータスと出力差分を確認する。
- `Initial Depth (EXR)` と `Depth (EXR)` を比較し、JBU と後段処理の差を確認する。
- Apply Mask の有無で不要面除去とカメラクリップ範囲を確認する。
- 出力 EXR を Houdini などで読み、チャンネルと座標系を確認する。
- 大容量モデルの初回ダウンロード、Cache API、WebGPU → WASM 切り替えを実ブラウザで確認する。

## 履歴

完了済みの計画・検討ログは root から外し、`docs/archive/` に退避した。

- [初期 DA3 版計画](docs/archive/PLAN_DA3_INITIAL.md)
- [MoGe-2 移行計画](docs/archive/PLAN_MOGE_MIGRATION.md)
- [Backfill / EdgeSnap 履歴](docs/archive/PLAN_INPAINT_HISTORY.md)
- [Edge Color / ColorPatch 履歴](docs/archive/PLAN_EDGE_COLOR_HISTORY.md)
- [Depth Upsampling 履歴](docs/archive/PLAN_DEPTH_UPSAMPLE_HISTORY.md)
