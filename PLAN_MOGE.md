# MoGe-2 への移行計画 (PLAN_MOGE)

現行の `DA3METRIC-LARGE.onnx`（FOV仮定によるintrinsics推定 → 湾曲が出る）を、
**MoGe-2 (`Ruicheng/moge-2-vitl-normal-onnx`)** に置き換える計画。
MoGe は affine point map から focal/shift を自動復元するため、平面歪み（湾曲）が大幅に改善する見込み。

- ONNX docs: https://github.com/microsoft/MoGe/blob/main/docs/onnx.md
- Model: https://huggingface.co/Ruicheng/moge-2-vitl-normal-onnx

---

## 1. なぜ変えるか
- DA3METRIC は intrinsics を出さず、当アプリは FOV を仮定 → 焦点距離が実画像と合わず**球状の湾曲**が発生。
- MoGe-2 は **point map から focal と shift を最適化で復元**するので、カメラ内部パラメータ未知でも幾何整合性が高い。

---

## 2. MoGe ONNX の仕様（確定事項）

### 入力
- `image`: `[B, 3, H, W]` float32, **ImageNet 正規化** (mean `[0.485,0.456,0.406]`, std `[0.229,0.224,0.225]`)
- `num_tokens`: int64 スカラ（dynamic 版のみ）。推奨 1200〜2500。既定 1800 程度。
- H, W は ViT パッチ(14)の倍数。`base_h=round(√(num_tokens/aspect))`, `base_w=round(√(num_tokens·aspect))` とし、画像を `(base_h·14, base_w·14)` にリサイズすれば丁度 num_tokens パッチになる。

### 出力（forward のみ。**後処理は含まれない**）
- `points`: `[B, H, W, 3]` — **affine-invariant point map**（カメラ空間ではない。focal/shift 未適用）
- `normal`: `[B, H, W, 3]`（正規化済み法線）
- `mask`: `[B, H, W]`（sigmoid 済みの floating mask, 0〜1）
- `metric_scale`: `[B]`（exp 済みのスカラ。メートル化係数）

> 公式注記: `.infer()` の後処理（focal/shift 復元・再投影・metric 適用・depth/intrinsics 生成）は ONNX 外。**JS へ移植が必要**。

---

## 3. 移植する後処理（PyTorch `infer()` 準拠）

`moge/model/v2.py infer()` と `moge/utils/geometry_numpy.py` を JS 化する。

### 3.1 mask 二値化
```
mask_binary = mask > 0.5
```

### 3.2 focal / shift 復元 (`recover_focal_shift`)
1. `uv = normalized_view_plane_uv(W, H)`:
   - `span_x = aspect/√(1+aspect²)`, `span_y = 1/√(1+aspect²)` (aspect=W/H)
   - `u ∈ [-span_x·(W-1)/W, +…]`, `v ∈ [-span_y·(H-1)/H, +…]` の格子
2. points と uv を **64×64 に縮小**（mask があれば masked-nearest。簡易には mask>0.5 の画素のみ収集）
3. **shift を 1D 最適化**（MoGe `solve_optimal_focal_shift` 相当）:
   - 与えた shift に対し `xy_proj = xy/(z+shift)`、
     `focal = Σ(xy_proj·uv)/Σ(xy_proj²)`（closed form）
   - 残差 `Σ|focal·xy_proj − uv|²` を最小化する shift を求める
   - 実装: 粗グリッド探索 → ゴールデンセクション（or LM風）で微調整
   - 初期値・範囲は legacy 線形解（下記）で当たりを付けてもよい
   - **代替（簡易）**: `point_map_to_depth_legacy` の線形最小二乗で focal,shift を一発計算
     ```
     b = (uv * z).flatten()                 # (H*W*2)
     A = stack([xy, -uv], -1)               # (H*W*2, 2)
     [focal, shift] = inv(AᵀA + 1e-6 I) · Aᵀb
     ```
   → まずは legacy 線形版で実装し、不足なら 1D 最適化版に差し替える。

### 3.3 intrinsics（正規化, cx=cy=0.5）
```
fx = focal/2 · √(1+aspect²)/aspect
fy = focal/2 · √(1+aspect²)
K  = [[fx,0,0.5],[0,fy,0.5],[0,0,1]]   # 画像を [0,1] に正規化した座標系
```

### 3.4 depth と再投影
```
points.z += shift
depth = points.z            (>0 のみ有効)
# force_projection: depth と intrinsics から point map を作り直す
u01,v01 = ((x+0.5)/W, (y+0.5)/H)          # 画素中心の正規化座標
X = (u01 - 0.5)/fx · depth
Y = (v01 - 0.5)/fy · depth
Z = depth
```

### 3.5 metric scale 適用
```
points *= metric_scale
depth  *= metric_scale
```

### 3.6 mask 適用
- `mask_binary` 外を無効化（depth=∞ / points=NaN）。表示・EXR では無効画素を除外 or 0 埋め。

---

## 4. アプリ座標系への接続
- MoGe `points` は **カメラ空間メトリック点群**（X右, Y下, Z前）。
- 既存 viewer/EXR は Houdini 系（Y-up）。現行同様 **X, Y を反転**し、`scale` を掛けて world position とする。
- 出力解像度は MoGe 入力解像度 → **元画像解像度へ補間**して表示/EXR（現行 `upscaleDepth` と同様の処理を points にも適用、または depth を上げてから再投影）。

---

## 5. UI / 機能の変更点
- **不要になる**: FOV スライダー（MoGe が focal を推定）。→ 残すなら「FOV 上書き（任意）」に再定義（MoGe は `fov_x` 既知時の分岐あり）。当面は撤去 or 無効化。
- **追加候補**:
  - `num_tokens`（精度/速度トレードオフ）スライダー（1200〜2500）
  - mask 適用 ON/OFF（背景/空を除外）
  - normal の EXR/PNG ダウンロード（MoGe は法線も出す。任意）
- **維持**: scale、metricスケール（MoGe は metric_scale を出すので focal/300 は不要 → 撤去）、表示モード、各種 DL（元画像 / depth EXR / worldpos EXR / OBJ / PNG）。

---

## 6. 変更するファイル
| ファイル | 変更内容 |
|---|---|
| `js/inference.js` | モデルURL/入出力名を MoGe に変更。前処理(ImageNet+リサイズ+num_tokens)。出力 points/normal/mask/metric_scale を返す |
| `js/moge_post.js` (新規) | focal/shift 復元・intrinsics・再投影・metric・mask の後処理。`points(metric, camera) + depth + intrinsics` を返す |
| `js/worldpos.js` | FOV逆投影を廃止し、MoGe の camera-space points を受け取り Houdini化+scale するだけに簡素化 |
| `js/main.js` | パイプライン差し替え（推論→moge_post→worldpos→viewer）。UI（FOV撤去/num_tokens追加等）配線 |
| `index.html` / `css` | UI 項目の追加・削除 |
| `js/exr.js` | 変更なし（必要なら normal EXR 追加） |
| `README.md` / `PROGRESS.md` | 反映 |

モデルURL（要確認）:
`https://huggingface.co/Ruicheng/moge-2-vitl-normal-onnx/resolve/main/model.onnx`
（実ファイル名は HF の Files タブで確認。`model.onnx` か別名か未確定）

---

## 7. 実装ステップ
1. HF の Files でモデル実ファイル名・入出力名（`image`/`num_tokens` 有無＝dynamic か static か）を確認。
2. `inference.js`: 前処理＋推論を MoGe 用に書換え、4出力を取得。
3. `moge_post.js`: legacy 線形版で focal/shift→intrinsics→depth→再投影→metric→mask を実装。
4. `worldpos.js`: camera points → Houdini化+scale に簡素化。元解像度へ補間。
5. `main.js`/UI: 配線変更、FOV撤去、num_tokens（任意）。
6. 実機確認 → 湾曲改善を検証。必要なら focal/shift を 1D最適化版へ強化。
7. README/PROGRESS 更新。

---

## 8. リスク / オープン課題
1. **モデル実ファイル名・入力構成（num_tokens の有無）**: dynamic 版は int64 の num_tokens 入力が必要。static 版なら 518×518 固定。→ 要 HF 確認。
2. **focal/shift 最適化の精度**: legacy 線形版で十分か。MoGe 実装は非線形最適化。湾曲が残れば 1D 最適化へ。
3. **モデルサイズ**: vitl は大きい（初回DL時間）。必要なら vitb/vits onnx も選択肢。
4. **masked resize の簡略化**: 64×64 縮小を mask 加味でどこまで簡略化するか。
5. **メモリ/速度**: 高解像度の points 再投影・補間コスト。onnxruntime-web (WebGPU) 前提。
6. **EXR 解像度**: points を元解像度へ補間 vs depth を補間して再投影、のどちらで出すか（後者の方がエッジが綺麗）。
