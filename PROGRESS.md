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
- Depth EXR、Initial Depth EXR、World Position EXR、Backfill EXR/PNG、OBJ+Texture ZIP、Scene GLB、2048 PNG 出力
- Scene GLB の色テクスチャは emissive map に接続し、base color は黒、metallic は 1.0
- 連続処理時に ONNX Runtime session へ並列 `run()` が入らないための排他ガード

## 現在の既定値

- Quality (`num_tokens`): `1800`
- High-Res Depth: ON
- High-Res Depth long edge: `2048px`
- Initial Depth Resize: `Bilinear` (internal, UI hidden)
- Edge Threshold: `0.010`
- Snap Width: `8`
- Small Component Faces: `64`
- Sky / Masked Area: Sky Backdrop
- Fill Margin: `25%` of original image long edge
- Backfill Parallax Cut: `0.50x` scene median disparity
- Backfill Front Clamp: `1.00x` assigned edge disparity
- Backfill Far Clamp: `4.0x` assigned edge depth
- Backfill Hole Preclaim: `3px`
- Backfill Far Priority: `12px`
- SkyMaskColorFill inner ring: `4px`

## 途中状態: Backfill 伸長の調整中

2026-07-05 時点で、覗き込み時に backfill が手前側 depth から細く伸びる問題を調整中。

現在入っているテスト処理:

- `Backfill Parallax Cut`: backfill メッシュ面を disparity 差で切る倍率。`Other` に移動済み
- `Backfill Front Clamp` / `Backfill Far Clamp`: 生成 depth の手前/奥クランプ。`Other` に移動済み
- `Backfill Far Priority`: 通常 BFS 後、近傍内のより奥ラベルが手前寄りラベルを上書きできる局所補正
- `Backfill Hole Preclaim`: 通常 BFS 前に、全 seed から `holeMask` 内だけへ数px先取り拡張し、競合時はより奥のラベルを優先する処理
- `viewer.js` では `Small Component Faces` の前に境界 face を1層削るテスト処理 `erodeBoundaryFaces(geometry, 1)` を主メッシュ/backfill メッシュの両方へ入れている

現時点の重要な注意:

- `Hole Preclaim` は `holeMask` 内だけに効く。見えている黒穴が `holeMask` ではなく、メッシュ面カットや backfill 視差カット後の描画上の穴なら効果が分かりにくい
- 通常 BFS 後の `2c` close 処理は、残った `holeMask` 画素へ「最も手前 = 最大 disparity」のリム値を伝播する。ここは奥優先ではないため、残り穴の見え方に影響している可能性がある
- `Backfill Far Priority` は hole 以外の `synth` にも効くため、値を上げると手前伸びは減り得るが、広い領域が奥へ寄りすぎる可能性がある
- `Hole Preclaim` と `Far Priority` はどちらも `0` で無効化できる

次に見るべき点:

- コンソールの `[Backfill]` ログで `holePreclaimFilled` / `holePreclaimOverrides` / `farPriorityOverrides` が増えているか確認する
- もし `holePreclaimFilled` が少ない場合、問題箇所は `holeMask` ではなく描画上の穴の可能性が高い
- その場合は `2c` close の優先規則、または backfill メッシュ面カット後の穴への対策を検討する

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
