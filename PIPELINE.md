# 処理パイプライン解説（PIPELINE.md）

2026-07-05 時点。「画像を読み込んで MoGe-2 推論を行い、depth / world position / mesh /
backfill を作る」までに何が行われているかを、段階ごとに**何を入力し、何を変更し、
何を変更しないか**で整理する。

画像を読み込む/Recompute するたびに、下の 1→10 が毎回この順で実行される。
推論 0 だけは画像・モデル・`num_tokens` が変わったときのみ実行される。

---

## 0. 推論（js/inference.js）

- 入力: 元画像
- MoGe-2 が **point map（各画素の3D位置の素）/ 法線 / mask（空・不確実領域=0）/
  metric scale** を出力する
- 解像度は `num_tokens` と画像アスペクト比から決まるモデル解像度
- ここではまだ入力画像解像度ではない

## 1. MoGe 後処理 = metric depth と camera-space points を作る（js/moge_post.js `process`）

- point map からカメラの focal / shift を復元する
- 各画素の **metric depth** と **カメラ空間の3D点（points）** を作る
- ここで「1画素 = 1つの深度 = 1つの3D点」が確定する
- 3D点は必ずそのピクセルのレイ（視線）上にある。以後の段階で depth を変える場合も、
  点は同じレイ上を前後に動くだけで、画面上の位置はズレない

## 2. DepthUpsampler = depth 高解像度化（js/depth_upsample.js）

- 入力: MoGe 後処理後の metric depth / mask / points / normal / intrinsics と元画像
- 出力解像度: 入力画像のアスペクト比に合わせ、長辺最大 `2048px`
- まず `Initial Depth Resize` で低解像度 depth を high-res depth へ拡大する
  - `Bilinear`: なめらかだが境界も丸まりやすい
  - `Nearest`: 段差を硬く残しやすい
- WebGPU が使える場合、RGB をガイドにした Joint Bilateral Filter を WGSL compute shader で実行する
  - `JBU Radius`: 周辺探索半径
  - `Sigma Space`: 距離による重み
  - `Sigma Color`: RGB差による重み
  - `Sigma Depth`: depth差（メートル）による重み
- WebGPU が使えない場合は UI に fallback を明示し、initial resize の結果を使う
- depth は計算中ずっと float32 メートル単位。表示用正規化や8bit化はしない
- high-res depth から camera-space points を再投影し、以後の処理はこの high-res グリッドで進む
- `Initial Depth (EXR)` は WebGPU filter 前の high-res depth、`Depth (EXR)` は後段処理後の最終 depth

## 3. mask の適用（js/moge_post.js `cleanDepthMask`）

- **エッジの削除はここではしない**（`rtol=1` 固定で呼ぶ。削除は EdgeSnap に置き換え済み）
- やることは「無効 depth（非finite / z≤0）を無効にする」+ UI の Sky / Masked Area に応じて
  「mask=0 の画素（空など）を無効にする」だけ
- 出力: 有効/無効の二値マスク

## 4. Sky Backdrop（js/moge_post.js `fillBackdrop`、Sky モードのみ）

- 手順3で無効になった画素（空など）を、
  **max(有効画素の最大 depth × 2, 100m) の一定Z平面**として同じレイ上に置き直す
- 変更するもの: その画素の depth と points（=幾何のみ）
- 変更しないもの: 色・UV
- これで Sky モードでは全画素が有効になる
- ただし、Sky Backdrop 前の mask は後段の SkyMaskColorFill 用に保持する

## 5. SkyMaskColorFill = 空mask内周の色補正（js/skymask_colorfill.js、Sky モードのみ）

- 入力: Sky Backdrop 前の mask と元画像
- 対象: mask 領域の内周 `4px` だけ
  - mask を `4px` 収縮する
  - `元mask - 収縮後mask` のリングだけを書き換える
- 色は収縮後mask側、つまり空maskの少し内側の色から fill する
- mask 外の非空画素は読まない・書き換えない
- 内周4pxより奥の空色も書き換えない
- 目的: mask境界に混入した建物・黒・手前色を、空側の色で置き換えて Sky Backdrop / Backfill の色種汚染を減らす
- 変更するもの: **表示/backfill 用テクスチャ画像の一部の色だけ**
- 変更しないもの: 元画像、depth、points、mask、UV、メッシュ

## 6. EdgeSnap = 深度の中間値の除去（js/edgesnap.js）

- エッジ検出: 横/縦の隣接画素ペアを比較し、相対 depth 段差が **Edge Threshold** を超える場所
- 既定値:
  - `Edge Threshold`: `0.010`
  - `Snap Width`: `8`
- 検出された両側画素を「marked edge pixels」とし、安定した非marked近傍から depth を伝播する
- 各 marked pixel は、元の depth と対数距離が最も近い near/far 側の台地 depth へ吸着する
  - 例: `2 2 3 4 5 5 → 2 2 2 5 5 5`
- `Snap Width` は「ぼけ幅そのもの」ではなく、安定した台地 depth を marked pixels へ伝播する最大パス数
- 上限を超えて残った marked pixel は元 depth のまま残る（削除しない）
- 変更するもの: depth と points（レイ上の前後移動のみ）
- 変更しないもの: UV・テクスチャ・画素の有効/無効

## 7. ColorPatch = テクスチャの混色帯の塗り直し（js/colorpatch.js）

- 写真のエッジ部分のテクスチャには手前と奥の**混ざった色**（ボケ・アンチエイリアス）が写っている
- これをエッジ帯だけ**元画像解像度で**塗り直す
- 入力画像は、Sky モードでは手順5の SkyMaskColorFill 済み画像、通常は元画像
- 帯の各画素は「自分と同じ depth 側（差10%以内）の帯の外の画素」から色をもらう
  - 手前の帯は手前の色だけ
  - 奥の帯は奥の色だけ
  - 色がシームを越えない
- 同じ側に届かない画素は元の色のまま残す
- 変更するもの: **表示/backfill 用テクスチャ画像のエッジ帯の色だけ**
- 変更しないもの: 元画像、UV、depth、points、メッシュ

## 8. World Position 化（js/worldpos.js）

- camera-space points を X,Y 反転して Y-up の world position へ変換する
- 無効画素（Apply Mask ON などで残る mask 除去）は NaN になる
- Sky モードでは Sky Backdrop により基本的に全画素が有効

## 9. メッシュ生成 + シーム分割（js/viewer.js `createMesh` / `splitDiscontinuousFaces`）

- world position のグリッドに 1画素=1頂点 のメッシュを張る
- geometry は最大 `2048×2048` に制限される
- UV は全頂点「元画像のその画素の位置」のまま
  - EdgeSnap の吸着元へ UV を丸ごと差し替える方式は、モデル解像度粒度のブロック/スジが出たため廃止
  - 色の問題は手順5/7のテクスチャ側補正で扱う
- depth 段差が `0.10`（固定）を超えるセルは面を削除せず near / far の2枚に分割する
  - 手前プレートと奥プレートがそれぞれ相手側へ**1セルずつ延長**し合う
  - 正面からは隙間ゼロ、覗くと切り離されている
  - 延長用の複製頂点だけは「自分のプレート側の角の UV」をコピーする
- NaN を含むセルだけ面を張らない

## 10. Backfill = 遮蔽穴の裏打ちレイヤー（js/backfill.js）

- シームの**奥側**エッジを種に、深度を奥へ伸長した第2レイヤー（別メッシュ）を作る
- 覗き込んだとき、手前プレートの裏に背景側の補完面が見えるようにする
- 種は depth 不連続の奥側から取る。手前側の位置・色は意図的に種にしない
- 色は手順5/7で補正済みの表示/backfill 用画像をモデル解像度に縮小し、種の色をプルプッシュで引き延ばす
- 主メッシュには一切手を加えない

---

## 早見表: どの段階が何を変更するか

| 段階 | depth / points | mask | UV | テクスチャ画素 | 面（メッシュ） |
|---|---|---|---|---|---|
| 2. DepthUpsampler | high-res depthへ拡大・points再投影 | high-resへ拡大 | - | - | - |
| 3. mask 適用 | 無効化のみ | 二値化/適用 | - | - | - |
| 4. Sky Backdrop | 空画素を最奥平面へ | 全画素有効へ | - | - | - |
| 5. SkyMaskColorFill | - | - | - | 空mask内周4pxのみ補正 | - |
| 6. EdgeSnap | marked edge pixelsを台地へ吸着 | - | **変更しない** | **変更しない** | - |
| 7. ColorPatch | **変更しない** | - | **変更しない** | エッジ帯のみ補正 | - |
| 8. WorldPos | 座標系変換 | - | - | - | - |
| 9. シーム分割 | - | - | 複製頂点のみプレート側をコピー | - | 段差セルを2枚に分割 |
| 10. Backfill | 第2レイヤーのみ生成 | 第2レイヤー用 | - | 第2レイヤー用に生成 | 第2レイヤーのみ |

## UI パラメータと対応段階

| UI | 効く段階 |
|---|---|
| Model / Quality (`num_tokens`) | 0 |
| High-Res Depth | 2 |
| Initial Depth Resize | 2 |
| JBU Radius / Sigma Space / Sigma Color / Sigma Depth | 2 |
| Treat 0 depth as invalid / Invalid Depth Value | 2 |
| Edge Threshold | 6（`1.000`=Off で 6/7 と 9 の depth seam split を無効化） |
| Snap Width | 6（吸着の伝播上限。超えた分は元 depth のまま） |
| Sky / Masked Area | 3, 4, 5 |
| Fill Occlusion / Fill Margin | 10 |

固定しきい値（UIと非連動）:

- mesh seam split: relative depth jump `0.10`
- backfill 種検出: relative depth jump `0.10`
- ColorPatch 帯・側判定: relative depth jump `0.10`
- SkyMaskColorFill 内周幅: `4px`
