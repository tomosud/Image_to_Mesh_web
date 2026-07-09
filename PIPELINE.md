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
  - `Edge Threshold`: `0.050`
  - `Snap Width`: `8`
- 窓検出（追加）: 各ステップが Edge Threshold 未満でも、半径 `3px` の窓内に「自分より `12%`
  以上手前」と「`12%` 以上奥」の画素が両方あれば marked にする。隣接対では拾えない「数px
  で大きく変化するランプ」（fg/bg 境界のボケ）を検出し、主メッシュで奥へ長く伸びる薄板を防ぐ。
  台地は片側しか差が無いので拾わず、総変化の小さい連続斜面も拾わない
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
  - ただし near/far は2値分類なので、3つ以上の深度が集まる**三重点セル**では中間深度が
    片側に押し込まれてプレート内部に段差が残る。この場合そのプレート側は張らず（実在角の
    深度スパンが `0.10` を超えたら skip）、中間を跨ぐスパイクを防ぐ。欠けた1セルは backfill が埋める
- NaN を含むセルだけ面を張らない
- 分割・カット後、**Small Component Faces 未満の孤立連結成分を除去**する（`removeSmallFaceComponents`、既定 `64`）。
  三重点カットや NaN で切り離された小さい/細いポリ（フリンジのちぎれ等）を消す。除去面は
  透明になり再充填しない。巨大な連結面（本体）は残る

## 10. Backfill = 遮蔽穴の裏打ちレイヤー（js/backfill.js）

- シームの**奥側**エッジを種に、深度を奥へ伸長した第2レイヤー（別メッシュ）を作る
- 覗き込んだとき、手前プレートの裏に背景側の補完面が見えるようにする
- 種は depth 不連続の奥側から取る。手前側の位置・色は意図的に種にしない
- **各奥側エッジをそれぞれ独立に延長する（最奥1枚へ吸着しない）。**
  - 種を背景面ごとにラベル分けする（4近傍で disparity 比が近い種＝同一背景面。前景を
    挟んで分かれた背景は別ラベル）
  - 通常 BFS 前に、全 seed から黒穴（`holeMask`）内だけへ `Backfill Hole Preclaim`（既定 `3px`）
    ぶん自己深度・ラベル・色を先取り拡張する。同じ黒穴画素で競合した場合は、より奥のラベル
    （小さい disparity）が勝つ。foreground 裏へは入らない
  - 多源 BFS で各穴/前景画素を「最も近い奥側エッジ」に割り当て、その背景面の disparity・
    ラベル・色を伝播する。深度の平滑化・色の平滑化はいずれも**同一ラベル内のみ**で行い、
    別背景面（例: 空 vs 建物）が深度で膜になったり色が混ざったりしないようにする
  - BFS 後、近傍 `Backfill Far Priority`（既定 `12px`）以内だけ**奥側優先**で再割り当てする。より奥のラベル（小さい disparity）
    が近くに届く場合は手前寄りラベルの伸長を置き換えるが、距離を限定するので全域が最奥1枚へ
    吸着しない
  - 穴（1b）の種は「最寄り帯（=前景）より jumpTol 以上奥」を全部取る。前景だけ除外する
    ので手前へ突き出さず、複数の背景面がそれぞれ延長される
- **種の深度・色はロバスト化してから延長ターゲットにする（1e）。** エッジ直上の種は前景と
  の混色や EdgeSnap で吸着し切れなかった中間段差（台地より手前に突出した薄い帯）を含む。
  各種の近傍窓で far 側の台地 disparity を推定し、その台地帯（前景・突出画素は大 disparity
  として自動除外）の深度中央値・色中央値に置き換える。これで「手前へ急に伸びる」挙動と、
  高周波エッジ由来の色の縞を抑える。近くに台地が無い孤立背景は元の値を保つ
- **延長ターゲットはラベル毎の disparity 平面フィット（1f。等深度ではない）。** 3D の平面は
  スクリーン座標に対して disparity がアフィン（1/z = a·x + b·y + c）になるため、ラベルごとに
  種（robust 値）+ 種から台地内へ `24px` 広げた有効画素を支持点に (x, y, disparity) を平面
  フィット（ridge + 外れ値1回除去）し、BFS の割り当て値を「各画素のレイとそのラベル平面の
  交点」にする。床・机・壁のような斜めの面が、エッジ深度のまま伸びる板ではなく傾きを保った
  延長になる。評価はラベル内 disparity 範囲の ±50% でクランプして外挿の暴走を防ぎ、薄い
  種帯で拘束できない方向の勾配は ridge により 0（=等深度）へ縮退する
- **共面ラベルのブリッジ統合（2d）。** 前景を挟んで左右に分かれた同一面（例: 前景の両側の壁）
  は別ラベルになり、延長同士が穴の中央でぶつかる disparity 段差 → 視差カットで開くシーム
  （黒い隙間）になる。割り当てが接するラベル対で、互いの平面が相手の重心の disparity を
  相対誤差 `0.15` 未満で予測し合えるなら同一面とみなして統合し、両ラベルの支持点で合同
  フィットした1枚の平面で延長を張り直す（合同残差 `0.08` 超は取り消し）。統合後は深度・色の
  平滑化もラベルを跨いで効くため内部シームが消える
- **カーテンクランプ（節3の出力時）。** 前景の下の生成 disparity は「局所前景のすぐ裏
  （前景 disparity / (1+jumpTol)）」を上限にする。平面延長が前景より手前に出ることを防ぎつつ、
  前景シルエット際では fill が前景の背中へ寄るため、視点を振ったときの開き幅
  （∝ 前景と fill の disparity 差）が小さくなる。BFS 中の判定値（bgDisp）には適用しない
- **BFS の margin 外に残った穴を最寄りリムで閉じる（2c）。** 黒く残った holeMask 画素へ、層から
  「最も手前(=最大 disparity)のリム値」を伝播して埋める。最寄りリムなので奥へ突き出さず、
  視差時の黒穴を減らす。`CLOSE_PASSES`=64 を超える巨大穴の芯は黒のまま
- 生成 depth は同一ラベル内の平滑化中に `Backfill Front Clamp` / `Backfill Far Clamp` で制限する。
  既定では front clamp `1.00x` により割り当てエッジより手前へ出さず、far clamp `4.0x` により
  割り当てエッジ深度の4倍より奥へ飛ばない
- 色は手順5/7で補正済みの表示/backfill 用画像をモデル解像度に縮小した基準色を、割り当て済み
  ラベルに沿って伝播し、間隔を 16,8,4,2,1 と変える à-trous 平滑化で徐々に拡散させて延長方向の
  縞を緩和する（同一ラベル内のみ）
- 主メッシュには一切手を加えない
- backfill メッシュ生成（js/viewer.js）の面カットは**視差(disparity)差**で判定する。面の
  `(1/z_near - 1/z_far)` がしきい値を超えたら切る。目的が「視差で背面が見えることの緩和」で、
  視差量 ∝ disparity 差だから。遠い面同士は深度比が大きくても disparity 差が小さい（視差小）
  ので繋がり奥穴を埋め、手前を含む面は disparity 差が大きい（視差大）ので切れて奥から手前へ
  伸びる smear を除去する。しきい値 = シーン中央値 disparity × `Backfill Parallax Cut`（既定 `0.50`、スケール不変）。
  上げる→切りにくい（黒穴減・smear 増）／下げる→切りやすい（smear 減・黒穴増）
- 視差カット後、Small Component Faces 未満の孤立連結成分を除去する（`removeSmallFaceComponents`、主メッシュと共通、既定 `64`）。
  カットで切り離された細い fill 片（面張りの元）を消す

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
| Initial Depth Resize | 2（内部既定値。UI 非表示） |
| JBU Radius / Sigma Space / Sigma Color / Sigma Depth | 2（内部既定値。UI 非表示） |
| Treat 0 depth as invalid / Invalid Depth Value | 2（内部既定値。UI 非表示） |
| Edge Threshold | 6（`1.000`=Off で 6/7 と 9 の depth seam split を無効化） |
| Snap Width | 6（吸着の伝播上限。超えた分は元 depth のまま） |
| Small Component Faces | 9, 10 |
| Sky / Masked Area | 3, 4, 5 |
| Fill Occlusion / Fill Margin | 10 |
| Backfill Parallax Cut | 10（backfill メッシュの視差カットのみ。backfill 生成は再計算しない） |
| Backfill Front Clamp / Far Clamp / Hole Preclaim / Far Priority | 10（backfill 生成深度・割り当ての調整。backfill のみ再生成） |

固定しきい値 / UI既定値:

- mesh seam split: relative depth jump `0.10`
- Fill Margin UI: original image long edge percentage, default `25%`; converted to processing-grid `marginPx` before `Backfill.generate`
- Backfill Parallax Cut: scene median disparity multiplier, default `0.50`
- Backfill Front Clamp: max generated disparity multiplier, default `1.00`
- Backfill Far Clamp: max generated depth multiplier, default `4.0`
- Backfill Hole Preclaim: black-hole-only far-wins preclaim distance, default `3px`, `0` disables it
- Backfill Far Priority: local far-label override distance, default `12px`, `0` disables it
- backfill 種検出: relative depth jump `0.10`
- backfill 平面フィット: 支持帯 `24px` / 支持点上限 `600` / 評価クランプ帯 ラベル範囲 `±50%`
- backfill ブリッジ統合: 相互予測誤差 `0.15` 未満 / 合同フィット残差 `0.08` 以下
- ColorPatch 帯・側判定: relative depth jump `0.10`
- SkyMaskColorFill 内周幅: `4px`
