# コードレビュー / 改善点まとめ（2026-07-06 時点）

Image to Mesh Web の実装全体を通しで見て気づいた「実装上の問題」「改善すべき点」を、
優先度と対応方針つきで整理する。**本ドキュメントは所見のメモであり、この時点では
コード変更は行っていない。** 着手する際はここから該当項目を選ぶ想定。

対象: `js/*.js`（backfill / viewer / main / moge_post / edgesnap / depth_upsample ほか）。

---

## A. アーキテクチャ / 設計

### A-1. ジオメトリの「存在判定」が二重ソースになっている（最重要）
- **問題**: 「どの画素にジオメトリがあるか」を決める処理が2系統に分裂している。
  - main.js 側: `cleanedMask`（`MogePost.cleanDepthMask` + Sky backdrop）→ backfill の
    `validMask` / `holeMask` を [main.js:372 付近](../js/main.js) で生成。
  - viewer.js 側: `splitDiscontinuousFaces` → `erodeBoundaryFaces` → `removeSmallFaceComponents`
    がメッシュ構築時にジオメトリを削る（[viewer.js の createMesh](../js/viewer.js)）。
- backfill は viewer 側の削除を（原則）知らないため、「メッシュには無いが backfill 上は
  有効画素」という不整合が起きる。2026-07-06 の「Small Component 除去画素を fill 対象から外す」
  対応（A案）はこの不整合の一部をパッチしたに過ぎない。
- **残る不整合**: `erodeBoundaryFaces`（境界1層削り）の削除画素は今も backfill に伝わっていない。
  → backfill から見ると有効なので、種になったり穴として扱われなかったりし得る。
- **改善案**: 「有効画素マスク」を単一ソース化する。理想は
  (1) 画素マスクを確定 → (2) それを唯一の入力として主メッシュと backfill の双方を生成、
  という一方向フローにする。少なくとも viewer 側の削除結果（erode / small-component）を
  1つの `removedPixels` に集約して main.js へ返し、backfill が必ずそれを引く形に統一する。

### A-2. 解像度 ≤2048 の暗黙前提が各所に散在
- **問題**: `meshWidth = min(width, 2048)`（viewer）、`maxLongEdge: 2048`（depth_upsample）、
  backfill の「レイヤーはモデル解像度そのまま（≤2048 前提）」コメント、などバラバラに前提を持つ。
  width>2048 だと頂点↔画素の 1:1 対応が崩れ、A案の `removedPixels` マスクも整合しなくなる
  （現状は解像度一致チェックで黙って無効化＝安全側だが、前提自体が明文化されていない）。
- **改善案**: 「モデル解像度 = 描画/背面/マスクの共通解像度（≤2048）」を1箇所の定数/契約として定義し、
  超える場合の扱い（縮小 or 明示エラー）を1箇所で決める。

### A-3. `erodeBoundaryFaces` が「テスト用処理」のまま常設されている
- **問題**: [viewer.js の erodeBoundaryFaces](../js/viewer.js) はコメントに「テスト用処理」と
  ありながら、主メッシュ・backfill メッシュの両方で常時 1 パス実行され、境界 face を無条件に
  1層削っている。ユーザー制御不可で、恒久的にジオメトリを失っている。
- **改善案**: 正式機能に昇格（意図・既定値を明記、必要なら UI 化）するか、不要なら撤去する。
  「テスト」の位置づけを解消する。

### A-4. backfill の調整パラメータが多すぎ、相互作用が非自明
- **問題**: Parallax Cut / Front Clamp / Far Clamp / Hole Preclaim / Far Priority と、
  PROGRESS.md でも「調整中」のテスト系ノブが多数 UI 露出している。さらに `2c` の穴閉じは
  「最も手前（最大 disparity）のリム優先」で、他所の far-priority 思想と逆向き（PROGRESS.md 自身が
  影響の可能性を指摘）。挙動の予測が難しい。
- **改善案**: backfill の伸長ロジックを一度収束させ、ノブを整理・削減する（内部固定にできるものは
  固定し、`Other` の実験ノブは非表示 or 撤去）。相反する優先方針（手前優先 vs 奥優先）を
  1つの一貫した規則に統一する。

---

## B. 正確性 / 堅牢性

### B-1. EXIF オリエンション未対応の可能性
- **問題**: [readImageFile](../js/main.js) は `Image` → canvas.drawImage でそのまま取り込む。
  EXIF 回転を持つスマホ写真は、ブラウザによって未回転で読まれ、以降の深度・メッシュが
  90/180 度ずれる恐れ。
- **改善案**: `createImageBitmap(blob, { imageOrientation: 'from-image' })` を使う等で
  オリエンションを正規化する。

### B-2. WebGPU 非対応時に深度アップサンプルが「ただのリサイズ」に劣化
- **問題**: [depth_upsample.js](../js/depth_upsample.js) は WebGPU compute 前提で、非対応環境では
  RGB ガイド付きアップサンプルをせず initial resize にフォールバックする（status に警告は出る）。
  品質差が大きいのに気づかれにくい。
- **改善案**: フォールバック時の品質差をユーザーに明示（現状の警告文をより目立たせる）、
  または CPU 実装の簡易ガイドフィルタを用意して極端な劣化を避ける。

### B-3. メモリ解放を「ページ全リロード」に依存
- **問題**: `loadAnother` が `window.location.reload()`（[main.js](../js/main.js)）。ONNX/WebGPU と
  大きな TypedArray を確実に解放する手段が全リロードしかない＝メモリ圧が既知の課題である示唆。
  大画像の連続処理で圧迫しやすい。
- **改善案**: セッション/テンソル/ジオメトリの明示 dispose 経路を整備し、リロード無しで
  差し替え可能にする。少なくとも入力サイズ上限 or 警告を設ける。

### B-4. 閾値マジックナンバー 0.10 の重複
- **問題**: `splitDiscontinuousFaces` の `relativeDepthThreshold = 0.10`、backfill の
  `jumpTol = 0.10`、`removeInvalidAndDiscontinuousFaces` 相当が、意図的に同じ 0.10 を使いつつ
  各所にリテラルで散在（backfill 側コメントも「viewer と同じ既定値」と明記）。片方だけ変えると
  容易に不整合。EdgeSnap の `WIN_T=0.12` も近縁。
- **改善案**: 段差判定の基準値を共有定数化し、意味的に連動すべきものは 1 箇所から供給する。

---

## C. パフォーマンス / 応答性

### C-1. 重い処理が全てメインスレッド同期実行
- **問題**: backfill の多源 BFS / à-trous 拡散、EdgeSnap 伝播、MogePost の focal/shift LM、
  WASM フォールバック時の深度処理などが全てメインスレッドで同期実行。2048² では顕著に重く、
  スライダー操作時に UI が固まり得る。
- **改善案**: 純粋計算（backfill / edgesnap / moge_post）を Web Worker へ退避（静的ホストでも可）。
  まずは backfill.generate と EdgeSnap を worker 化するのが効果大。

### C-2. backfill 再計算にデバウンスが無い
- **問題**: fill 系スライダーの `change` ごとに `updateBackfill()` が O(N×passes) の同期再計算を走らせる。
- **改善案**: 再計算をデバウンス/キャンセル可能にする（C-1 の worker 化と併せると自然）。

### C-3. `recoverFocalShift` の LM で残差配列を毎反復アロケート
- **問題**: [moge_post.js](../js/moge_post.js) の LM ループが `evalShift` を反復ごとに複数回呼び、
  その都度 `Float64Array(n*2)` を確保（GC 圧）。サンプルは最大 64×64 に間引かれているので影響は限定的だが、
  無駄なアロケーションが残る。
- **改善案**: 残差バッファを使い回す（軽微・優先度低）。

---

## D. 保守性 / テスト

### D-1. リポジトリにコミット済みの自動テストが無い
- **問題**: CLAUDE.md は「ロジックは Node 合成テストで検証してから結線」を求めるが、テストは
  scratchpad 限りでコミットされない。backfill / moge_post の focal 解 / edgesnap / ジオメトリ
  クリーンアップ（split・erode・removeSmall）といった純粋ロジックに回帰テストが無い。
- **改善案**: `tests/`（Node 実行の合成テスト）を用意し、純粋関数をブラウザ非依存モジュールとして
  切り出してテストを常設化する。

### D-2. viewer.js が 1795 行で責務過多
- **問題**: レンダリング・メッシュ構築・ジオメトリ演算・オービット/グリッド操作・エクスポートが同居。
  特にジオメトリ演算（split / erode / removeSmall / discontinuity cut）は純粋で切り出し可能なのに
  三次元描画コードと混在してテストしにくい。
- **改善案**: 「ジオメトリクリーンアップ」を独立モジュール化（+ D-1 のテスト）。描画・操作・
  エクスポートも段階的に分割。

### D-3. キャッシュバスターの手動管理
- **問題**: [index.html](../index.html) の `?v=YYYYMMDD-N` がファイルごとに別日付・別連番で手動。
  更新漏れ・不整合が起きやすい（実際に日付がバラバラ）。
- **改善案**: 全 JS を 1 つの共通バージョン文字列で参照する等、単一ソース化する
  （静的ホスト維持のまま可能）。

### D-4. 概念の重複実装
- **問題**: `getSmallComponentMinFaces` が main.js（DOM 参照）と viewer.js（options 参照）に併存。
  UV / intrinsics → カメラ点変換の規約も複数箇所で再実装。
- **改善案**: 共有ユーティリティに寄せる（軽微）。

---

## E. 既知の機能上の限界（設計トレードオフ）

### E-1. 連続面に囲まれた「平面内の穴」は永久に塞がらない
- backfill は深度**段差**の奥側にしか種を打たない（[backfill.js の 1a/1b](../js/backfill.js)）ため、
  周囲がひと続きの同深度面で囲まれた穴（例: 葉・岩表面の小さな欠損）は種が無く、`2c` の穴閉じも
  種/synth からしか伝播しないので届かない。2026-07-06 の A案でこれらは明示的に fill 対象外
  （`holeMask=0`）にしたので、なおさら黒く残る。
- **将来対応の方向**: 「リムが単一連続面（段差なし）で囲まれた穴」を、そのリムの深度・色から
  局所的に埋める平面穴埋めパスを追加する（段差を跨がないので smear は出ない）。サイズ上限で暴発防止。
  ※ 2026-07-06 時点でユーザー判断により未対応。

### E-2. 縞（等深度延長由来）は à-trous 拡散で緩和するのみ
- backfill の色延長は種色の平行敷き詰めで高周波エッジに縞が出やすく、à-trous 平滑化で
  溶かしているだけ（[backfill.js の 5](../js/backfill.js)、コメントも「完全な除去は将来 inpainting で」）。
  本質解決は別途 inpainting が要る。

---

## 優先度まとめ

| 優先 | 項目 | 種別 | ひとことで |
|---|---|---|---|
| 高 | A-1 | 設計 | 有効画素マスクの単一ソース化（不整合の根治） |
| 高 | C-1 | 性能 | 重い純粋計算を Web Worker へ |
| 中 | A-3 | 設計 | `erodeBoundaryFaces`「テスト用」の正式化 or 撤去 |
| 中 | A-4 | 設計 | backfill ノブの収束・整理、優先方針の一貫化 |
| 中 | B-1 | 正確性 | EXIF オリエンション対応 |
| 中 | D-1 | テスト | 純粋ロジックの回帰テスト常設化 |
| 中 | B-3 | 堅牢性 | メモリ解放をリロード非依存に／入力上限 |
| 低 | A-2 / B-2 / B-4 / C-2 / C-3 / D-2〜D-4 | 各種 | 前提明文化・閾値共有・分割・重複解消 |
| 参考 | E-1 / E-2 | 限界 | 設計上の既知トレードオフ（将来 inpainting 領域） |
