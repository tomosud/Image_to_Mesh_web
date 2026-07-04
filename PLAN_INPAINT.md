# 遮蔽穴インペイント計画 (PLAN_INPAINT)

深度不連続で切断された部分（覗き込むと穴になる領域）を、
**「奥側エッジから位置と画像をスムースに伸長した第2レイヤー（画像 + world position のセット）」** で埋める計画。

- 対象ブランチ: `inpaint_try`
- 現状: `cleanDepthMask`（[moge_post.js](js/moge_post.js)）が深度不連続の両側画素を無効化し、
  `removeInvalidAndDiscontinuousFaces`（[viewer.js](js/viewer.js)）が該当面を除去 → シルエット裏が穴になる。

---

## 1. 要件の整理

| 要件 | 設計への反映 |
|---|---|
| レリーフ状でよい。カメラが上下左右にやや動く程度の覗き込みに耐える | 遮蔽領域全体ではなく、シルエットから**一定マージン分だけ**奥面を延長すれば足りる |
| 大きく視点が変われば破綻してよい | パッチ整合や本格的な novel view synthesis は不要 |
| 穴のエッジの手前/奥を見分け、**奥側エッジから**位置と画像を伸長 | 不連続エッジ画素を depth で near/far に分類し、**far 側のみ**を境界条件にする |
| シンプルで重すぎない技術 | 純 JS（+必要なら WebGL）。追加モデル DL・追加ライブラリなし |
| 表示だけの解決ではなく、**もう一枚の画像 + world position のセット**を生成 | 第2レイヤーを `{ colorTex, worldPos, validMask }` として保持し、EXR/PNG で出力可能に |
| 1階層の奥だけ表現できればよい（多重遮蔽は対象外） | レイヤーは常に 1 枚。near/far 分類も 2 クラスのみ |
| GitHub Pages で配信できる | 静的ファイルのみ。ビルド工程・サーバ処理なし |
| 商用利用可能なライセンス | 自前実装（アルゴリズムは古典手法）なので MIT のまま。外部モデル導入時のみ再確認 |

---

## 2. 技術選定

### 2.1 色（画像）のインペイント候補

| 手法 | 品質 | 重さ | 依存 | ライセンス | 判定 |
|---|---|---|---|---|---|
| **A. プルプッシュ（画像ピラミッド）+ 拡散平滑化** | 中（ボケるが破綻しない） | 極軽（数十ms、純JS） | なし | 自前実装=MIT | ✅ **採用** |
| B. ラプラス拡散のみ（Jacobi/マルチグリッド） | 低〜中（一様にボケる） | 極軽 | なし | MIT | Aの平滑化段として利用 |
| C. OpenCV.js（Telea / Navier-Stokes） | 中 | WASM ~8MB 追加 | opencv.js | Apache-2.0 | ❌ 得られる品質に対して重い |
| D. PatchMatch 系（テクスチャ合成） | 高 | 実装コスト大・実行も重め | なし | MIT可 | ❌ 「やや覗き込む」用途に過剰 |
| E. ニューラル（MI-GAN / LaMa を onnxruntime-web で） | 最高 | モデルDL 数十〜数百MB | 既存の ort-web を流用可 | MI-GAN: MIT / LaMa: Apache-2.0（**weights の学習データ由来の条件は要確認**） | 🔜 Phase 2 の差し替え候補 |

**採用理由**: 覗き込みで見えるのは幅数十px の帯であり、遠景側の色が滑らかに続いてさえいれば
知覚的に成立する。プルプッシュは「近傍の色を構造を保ちつつ引き延ばす」性質があり、
純 JS で完結し、モデル DL もライセンス懸念もない。
品質が不足したら E（MI-GAN。軽量・MIT・ort-web が既にある）へ**同じインターフェースのまま**差し替える。

### 2.2 深度（位置）の伸長候補

| 手法 | 挙動 | 判定 |
|---|---|---|
| **A. far リングの平面フィット（disparity 空間）を初期値に、ラプラス平滑化** | 奥面の傾きを保って自然に延長。テーブル面などが素直に続く | ✅ **採用** |
| B. far エッジ深度の等値複製 | 平坦な棚状になり、斜め面で折れ目が見える | 初期値のフォールバックに使用 |
| C. ラプラス膜のみ（Dirichlet=farリング） | 境界間を張る膜になり、穴の反対側の値に引っ張られる恐れ | Aの平滑化段として、**farリング以外は Neumann（勾配0）** にして使用 |

**要点**:
- 計算は depth ではなく **disparity (1/z)** で行う（遠方の暴れを抑え、補間が透視的に自然になる）。
- 境界条件は **far 側リングのみ Dirichlet**。near 側・画像境界側は **Neumann（勾配0）**。
  これが「奥側エッジから伸長する」の数学的な実装になる。
- 生成 depth は `max(生成値, farエッジ最小depth)` でクランプし、前面レイヤーより手前に出ないことを保証。

### 2.3 レイヤーの表現と描画

- 第2レイヤーは現行と同じ **`H×W` グリッド + world position 変位** 方式（`viewer.js` の `createMesh` と同型）。
  synthesized 画素 + far リング画素にだけ面を張る。
- far リング上の頂点は主レイヤーと**同一座標**を共有 → 継ぎ目にクラックが出ない。
- 生成領域は主レイヤーより幾何的に奥にあるため、深度バッファだけで正しく隠れる
  （スクリーンスペースの誤魔化しではない）。
- world position 化は既存パス（`MogePost` の intrinsics で再投影 → `WorldPos.fromCameraPoints`）を
  そのまま流用できるので、座標系・水平グリッド整列・エクスポートの整合が自動的に取れる。

---

## 3. アルゴリズム詳細

入力（すべて既存。モデル解像度 `W×H`）:
`depth`, `cleanedMask`, `intrinsics {fx,fy}`, 元画像色（`W×H` へバイリニア縮小したもの）

### 3.1 穴領域と near/far エッジの分類
1. `hole = { cleanedMask==0 }`（applyMask による空・背景除去はそのまま。**far リングを持つ穴のみ**対象）。
2. 穴の連結成分ごとに、穴に隣接する有効画素（境界リング）の depth を収集。
3. 成分ごとにしきい値 `t = √(min·max)`（幾何平均。必要なら Otsu に強化）で
   境界画素を **near（<t）/ far（≥t）** に 2 分類。
4. far 画素が一定数未満の成分（画像端の欠けなど）はスキップ。

### 3.2 合成対象領域の決定（マージン付き BFS）
1. far リングを種として BFS。進入可能なのは「hole 画素」または
   「near 側（前景）画素 = depth が伝播中の背景 depth より十分小さい画素」。
2. 距離上限 `M` px（UI スライダー。既定 48、範囲 8〜128）。
   これが「やや覗き込める量」を直接決める。
3. 得られた画素集合が第2レイヤーの synthesized 領域。前景の裏側にも潜り込む点が重要
   （穴そのものだけを埋めると、シルエットぎわで覗いた瞬間に途切れる）。

### 3.3 深度の伸長
1. far リングの disparity に最小二乗平面をフィット（成分ごと）。外れ値は MAD で除外。
   フィット不能（リングが小さい等）なら far リング中央値の定数面。
2. synthesized 領域を平面値で初期化し、
   **Dirichlet=far リング / それ以外 Neumann** のラプラス平滑化を
   ピラミッド（coarse→fine）で数回反復。
3. `disparity → depth` に戻し、前述のクランプを適用。

### 3.4 色の伸長
1. far リング画素の色だけを種にしたプルプッシュ:
   ダウンサンプル時に有効画素のみ平均 → 最粗解像度から有効値を埋め戻し。
2. 仕上げに synthesized 領域内のみ 2〜3 回の拡散平滑化（種は far リング固定）。
3. 出力は RGBA（A=1 が synthesized ∪ far リング）。near 側の色は**一切参照しない**。

### 3.5 第2レイヤーの world position 化
1. 生成 depth を既存 intrinsics で再投影（`moge_post.js` の force_projection と同式）
   → カメラ空間点群。
2. `WorldPos.fromCameraPoints` で Houdini 系へ（主レイヤーと同一変換）。
3. 非対象画素は NaN（既存の invalid 表現に合わせる）。

### 3.6 描画・エクスポート
- Viewer: `setData` に第2レイヤー（任意引数）を追加し、`BackfillMesh` として scene に追加。
  マテリアルは主レイヤーと同じ（テクスチャは 3.4 の RGBA、alphaTest で非対象画素を落とす）。
- ダウンロード追加:
  - `Backfill WorldPos (EXR)` — 水平グリッド整列を主レイヤーと共通で適用
  - `Backfill Texture (PNG)` — RGBA
- GLB: `BackfillMesh` ノードを追加（テクスチャ込み）。OBJ は Phase 1 では対象外（必要なら第2 OBJ）。

---

## 4. 変更ファイル（実装時）

| ファイル | 変更内容 |
|---|---|
| `js/backfill.js` (新規) | 3.1〜3.5 の全ロジック。入出力を純データに保ち、Phase 2 のニューラル差し替えを可能に |
| `js/viewer.js` | 第2レイヤーのメッシュ生成/破棄、GLB への `BackfillMesh` 追加 |
| `js/main.js` | `recompute()` 後に Backfill 実行、UI 配線（ON/OFF・マージン）、DLボタン |
| `js/download.js` | Backfill EXR / PNG 保存 |
| `index.html` / `css/style.css` | 「Fill Occlusion」チェックボックス、「Fill Margin」スライダー、DLボタン 2 個 |
| `README.md` / `PROGRESS.md` | 機能説明の追記 |

推論 (`inference.js`)・後処理 (`moge_post.js`)・worldpos (`worldpos.js`) は**変更不要**。

### インターフェース案

```js
// backfill.js
// 戻り値: {
//   worldPos: Float32Array(H*W*4),  // RGBA=XYZ+1, 非対象は NaN
//   colorTex: { data: Uint8Array RGBA, width, height },
//   validMask: Uint8Array(H*W),
//   width, height, stats: { components, filledPx }
// } | null（対象穴なし）
Backfill.generate({ depth, cleanedMask, intrinsics, colorWH, width, height }, { marginPx })
```

---

## 5. UI / 挙動

- **Fill Occlusion** チェックボックス（既定 ON）: 第2レイヤーの生成と表示。
- **Fill Margin** スライダー（8〜128 px、既定 48）: 覗き込み許容量。change で Backfill のみ再計算
  （推論・主レイヤーは再計算しない。数十ms 想定）。
- Edge Threshold / Apply Mask 変更時（`recompute`）は Backfill も追従再計算。
- Wireframe / Points / No Color は主レイヤーと同じ扱いにする（Points 時は第2レイヤーも点表示）。

---

## 6. 性能見積り

- 対象解像度はモデル解像度（num_tokens 1800 ≒ 700×500 前後、最大でも 2500 tokens ≒ 830×590 前後）。
- BFS + 平面フィット + ピラミッド数段の反復はいずれも O(W·H) × 小定数 → **純 JS で 100ms 以下**の想定。
  遅ければ WebGL シェーダ化やタイル化の余地はあるが、Phase 1 では不要と判断。

---

## 7. ライセンス

- Phase 1 は外部コード・外部モデルの追加なし（プルプッシュ／ラプラス／平面フィットは古典手法の自前実装）
  → リポジトリは **MIT のまま**。商用利用可。
- Phase 2 でニューラルインペイントを導入する場合:
  - **MI-GAN**（Picsart, MIT）が第一候補（軽量・ort-web 流用可）。**公開 ONNX weights のライセンス表記を導入前に必ず確認**。
  - LaMa はコード Apache-2.0 だが、公開 weights の学習データ由来の利用条件を要確認。
  - 導入時は README のライセンス節に追記。

---

## 8. 実装ステップ

1. `backfill.js`: 穴の連結成分抽出 + near/far 分類（3.1）。デバッグ用に分類結果をキャンバス表示できるlog/可視化を仮実装。
2. マージン付き BFS（3.2）→ 深度伸長（3.3）→ 色伸長（3.4）。
3. world position 化（3.5）と viewer の第2レイヤー表示（3.6）。この時点で覗き込み検証。
4. UI 配線（Fill Occlusion / Fill Margin）と再計算フロー。
5. エクスポート（Backfill EXR / PNG、GLB の `BackfillMesh`）。
6. 実機検証: 添付例のような「前景ぬいぐるみ + 背景壁/台」画像で、上下左右 ±10〜15° 程度の
   オービットで穴が見えないこと、正面視で第2レイヤーが一切見えない（沁み出さない）ことを確認。
7. README / PROGRESS 更新。

---

## 9. リスク / オープン課題

1. **near/far 分類の誤り**: 前景と背景の depth 差が小さい穴では 2 クラス分離が不安定。
   → far 画素数と分離度（min/max 比）で信頼度を判定し、低信頼の穴はスキップ（現状維持）に倒す。
2. **色のボケ**: 拡散ベースなので背景にテクスチャが強いと引き延ばしが目立つ。
   → 要件上「やや覗く」までなので許容。不足なら Phase 2（MI-GAN）で色のみ差し替え。
3. **穴の反対側が同一成分に混ざるケース**（前景がリング状で背景を囲む等）:
   far リングが複数方向にあると膜状になるが、Neumann+平面初期化でおおむね自然。破綻時は成分分割を検討。
4. **画像境界に接する穴**: far リングを持たないためスキップ。境界側は現状どおり穴のまま。
5. **法線/ライティング**: 第2レイヤーの normal map は Phase 1 では生成しない（Unlit 前提の表示が既定のため）。
   ライティング有効時は生成 depth から簡易法線を計算する拡張余地あり。
6. **メモリ**: `H×W` グリッドがもう1枚増える。モデル解像度なら数十MB 未満で問題なし。
