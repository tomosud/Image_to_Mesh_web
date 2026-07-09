# PLAN_OPTIMIZE.md — 高速化・メモリ改善 → エッジ伸び改善 → ポリゴンリダクション

作成: 2026-07-09。完了したフェーズは PROGRESS.md に要約を移し、本 md は全完了後に
`docs/archive/` へ退避する。

## 進行順序（推奨）

| Phase | 内容 | 結果への影響 | 状態 |
|---|---|---|---|
| 0 | 計測と「結果不変」検証ハーネス | なし | 未着手 |
| 1 | リファクタリング（高速化・メモリ） | なし（ハッシュで保証） | 未着手 |
| 2 | エッジパディング伸びすぎ改善 | あり（見た目改善） | 未着手 |
| 3 | エクスポート時ポリゴンリダクション | エクスポートのみ（既定OFF） | 未着手 |

順序の理由:

- Phase 1 を先にやるのはユーザー方針どおり。ただし「結果を変えない」を口約束にしない
  ために Phase 0 の検証手段を先に入れる（半日以下の小さな作業）。
- Phase 2 はパラメータ調整の反復が多い作業なので、Phase 1 でパイプラインが速くなって
  から着手した方が反復コストが安い。
- Phase 3 は独立（エクスポート経路のみ）。Phase 2 でゴミポリが減ってからの方が
  リダクション品質の評価がしやすいので最後。

---

## 作業分担（別 AI への委譲）

ファイル単位で分離できる作業は `docs/tasks/` の指示書で別 AI に委譲できる:

| 指示書 | 内容 | 対応フェーズ | 触るファイル |
|---|---|---|---|
| [TASK_A](docs/tasks/TASK_A_BACKFILL_OPT.md) | backfill.js 定数倍最適化 | 1-D | js/backfill.js + index.html(版数) |
| [TASK_B](docs/tasks/TASK_B_VIEWER_GEOM_OPT.md) | viewer.js typed array 化ほか | 1-A/1-B/1-C/1-F 一部 | js/viewer.js + index.html(版数) |
| [TASK_C](docs/tasks/TASK_C_MESHOPT_RESEARCH.md) | meshoptimizer 調査（コード変更なし） | 3 の準備 | docs/tasks/TASK_C_REPORT.md のみ |
| [TASK_D](docs/tasks/TASK_D_EXPORT_REDUCE.md) | 境界スムース化 + エクスポート時リダクション | 3 本体 | js/viewer.js, index.html, README, js/vendor/ |

2026-07-09: A / B / C 完了（A は Node 同値テスト15ケース一致・2.5倍、B はコードレビュー合格、
C は meshoptimizer 採用の結論）。Phase 3 は方針決定: **境界スムース化を先に行ってから
LockBorder 付き簡略化**（テクスチャ＝画面投影なので UV を同変位させれば見た目不変）。
UI はチェックボックス1つ・誤差駆動の安全設定のみ。詳細は TASK_D。
同日改訂: リダクションは**表示メッシュへの遅延適用（既定 ON、debounce + 世代トークン）**
に変更。エクスポートは表示中ジオメトリを使う既存構造のため自動的に縮小版になる。
v1 はメインスレッド実行（実行瞬間のフリーズは Phase 1-G の Worker 化で解消予定）。

主セッション側に残す作業: Phase 0（main/viewer/backfill を横断）、1-E ステージキャッシュ
（main.js の構造変更）、Phase 2（設計判断が必要）、Phase 3 の統合。
A と B は同一作業ツリーでは**同時に走らせない**（順番に、またはブランチを分ける）。
C はコードを変えないのでいつでも並行可。

## Phase 0: 計測とリグレッション検証

目的: (a) どこが遅いかを数値で特定、(b) Phase 1 の各変更が結果を変えていないことの機械的確認。

- 各ステージの所要時間を `performance.now()` で計測し、`[Perf]` として console.table に出す:
  - MogePost.process / DepthUpsampler / cleanDepthMask / SkyBackdrop / EdgeSnap /
    SkyMaskColorFill / ColorPatch / WorldPos / createMesh（内訳: bilinear / split /
    smallComp / vertexColor / normals）/ Backfill（内訳: 1a-1f / 2 / 2a-2d / 2c / 3 / 5 / 6）/
    rebuildBackfillMesh / FillB
- 結果不変の検証: デバッグフラグ ON のとき主要出力バッファの FNV-1a ハッシュをログに出す
  （depth, worldPos, mesh index+position, backfill worldPos+colorTex）。
  同一画像・同一パラメータでリファクタ前後のハッシュ一致を確認する。
  ※ 浮動小数の演算順を変えない変更のみ「完全一致」を要求。演算順が変わる変更は
  最大絶対差でしきい値判定（その場合は md に明記して個別承認）。
- 主要保持バッファの合計 MB をログ（currentMoge / currentPost / currentWP / geometry /
  backfill / debug）。

## Phase 1: 結果を変えない高速化・メモリ改善

計測前の静的読解で特定済みのホットスポット。1項目=1ステップで進め、各ステップ後に
Phase 0 のハッシュ一致とタイム比較を確認する。

### 1-A. viewer.js ジオメトリ経路の typed array 化（最大の無駄）

- `splitDiscontinuousFaces`: `indices` / `extraPos` / `extraUV` を JS 配列 push で構築している
  （2048 級グリッドで最大 2,500 万要素の boxed array → 一時数百 MB + GC 停止）。
  2パス方式（カウント→書き込み）か拡張型 Uint32Array/Float32Array に置き換える。
- `removeInvalidAndDiscontinuousFaces` / `removeSmallFaceComponents` / `erodeBoundaryFaces` の
  `kept = []` push も同様に typed array 化。
- `erodeBoundaryFaces` の edgeUse が文字列キー Map（`"a,b"`）でエッジ 1,200 万本ぶん文字列を
  生成する。現在 passes=0 で停止中だが、復活に備えて整数キー（`lo * vCount + hi` の
  Float64 キー or 2段 Uint32）へ。
- 期待効果: メッシュ再構築（パラメータ変更のたびに走る）の時間と一時メモリを大幅削減。

### 1-B. 頂点カラーの遅延生成

- `createMesh` は mesh 表示時も毎回 全頂点（最大 420 万）の頂点カラーを sRGB→Linear 変換つきで
  生成している（約 50 MB + 数百 ms）。実際に使うのは points モードのみ。
  points モードへ切り替えた時にだけ生成する。

### 1-C. rebuildBackfillMesh の中央値計算

- `disps` を全画素 push → sort（O(N log N)、最大 400 万要素）している。中央値が欲しいだけ
  なので、格子サンプリング（例: 1/16 間引き）+ typed array sort で十分。
  ※ 中央値がわずかに変わり得るため、間引きは Phase 0 の差分しきい値方式で確認。

### 1-D. backfill.js ホットループの定数倍最適化（アルゴリズム不変）

- `for (const [dx, dy] of OFFS)` の分割代入イテレーションを全ループで展開済み整数オフセットに
  置き換える（BFS / preclaim / farPriority / 2c close / Gauss-Seidel 40 反復 / à-trous 15 パス、
  いずれも synth 領域 × 4〜8 近傍で回る最内周）。
- `1 / depth[i]` を毎回計算している箇所を invDisp の Float32Array 前計算に置き換える。
- 1e の median 用 `slice().sort()`、fitAffine の `ds.slice().sort()` を再利用バッファ化。
- 期待効果: backfill 生成（パラメータ変更のたびに走る）で 2〜4 倍。

### 1-E. ステージキャッシュ（dirty flag）— 体感面で最大の効果

現状 `requestRecompute` は **どのパラメータ変更でも全段再実行**する:

- `smallComponentFaces` 変更 → 本来 createMesh のフィルタだけで済むのに、
  MogePost + DepthUpsampler(GPU JBU) + EdgeSnap + ColorPatch + WorldPos まで再実行
- `edgeThreshold` / `snapWidth` 変更 → DepthUpsampler 再実行は不要
- `maskMode` 変更 → cleanDepthMask 以降だけで良い

対策: recompute() を段に分割し、各段の入力（上流出力 + 関係 opts）が不変なら結果を再利用。
注意点: 現在 `currentPost.depth` / `points` を EdgeSnap や backdrop が**差し替えていく**
書き方なので、キャッシュには「上流段の出力の凍結コピー」を持つ構造に変える
（depth 1枚 ≈ 16 MB / points ≈ 50 MB の追加保持と引き換え。1-F の解放と合わせて収支を取る）。

期待効果: 後段パラメータの反復調整が 10 倍以上速くなる（Phase 2 の作業効率に直結）。

### 1-F. メモリ削減

- `currentDepthUpsampleDebug`（initial depth EXR 用の high-res float32）を
  「Initial Depth DL ボタンを押すまで保持しない」または生成オプション化。
- 使い終わった中間バッファ（basePost の低解像度 points 等）の参照を明示的に切る。
- geometry 差し替え時の dispose 徹底（createMesh で旧 geometry を dispose していない）。
- 目標: 2048 級で処理後の常駐を数百 MB 削減。

### 1-G.（任意・Phase 1 の最後に判断）Web Worker 化

- recompute + backfill を Worker へ移し UI フリーズを解消（transferable ArrayBuffer）。
- 効果は「体感」でハッシュ不変。ただし構造変更が大きいので、1-A〜1-F の結果を見て
  必要ならやる。やらない判断も可。

## Phase 2: エッジパディングの伸びすぎ改善（結果が変わる）

対象: 前景エッジ際で backfill が横に長く伸びる筋状のジオメトリ/色（スクリーンショットの
木の幹の右側のような伸び）。

### 2-A. まず診断（実装より先）

伸びの「正体」候補が複数あり、どれかで対策が変わる:

1. BFS margin（Fill Margin 25% ≈ 長辺の 1/4）で前景裏へ大きく延長された synth
2. 2c close（最前面=最大 disparity のリム値を最大 64px 伝播 → **手前色が奥へ引き伸ばされる**）
3. 1f 平面フィットの外挿（クランプ帯 ±50% 内での傾き延長）
4. preclaim / farPriority / collar の副作用

対策: backfill 画素の由来（seed / collar / BFS / preclaim / farPriority / 2c close）を色分けした
デバッグテクスチャを一時的に表示できるようにし、実機で伸びている箇所の由来を特定する
（ユーザーがスクリーンショットで報告 → 由来確定）。

### 2-B. 由来に応じた対策（診断後に 1 つずつ）

- ラベル毎に「実際に埋めるべき穴の幅」を測り、延長距離の上限を marginPx 一律ではなく
  穴幅ベースの適応値にする（例: 穴幅 × 係数 + 固定 px）
- 2c close の伝播距離の短縮、または「最前面リム」ではなく「穴周囲の中央値リム」への変更
- 種からの距離に比例して面カットしきい値を厳しくする（遠くまで伸びた面ほど切れやすく）
- collar / preclaim / farPriority の既定値見直し

各対策は独立に ON/OFF できる形で入れ、実機確認（ユーザー）で採否を決める。

## Phase 3: エクスポート時ポリゴンリダクション

- 推奨: **meshoptimizer (MIT ライセンス)** の `meshopt_simplifier`（WASM 単体、ビルド工程
  不要で js + wasm を同梱可能 → GitHub Pages 静的構成 OK）。数百万トライアングルを
  1 秒未満〜数秒で quadric 簡略化でき「高速に」の要件を満たす。
  - 導入前にライセンスを確認し README に記載（CLAUDE.md ルール）
  - 代替案（外部ライブラリなし）: 頂点クラスタリング自前実装。速いが輪郭が劣化しやすく、
    quadric 自前実装は工数大。まず meshoptimizer を第一候補にする
- 適用位置: `createCompactExportGeometry` の後（welded / indexed / aligned 済み）。
  OBJ / GLB で共通に効く。ビューア表示は変えない。
- UI: Export 欄に Reduce スライダー（target 比率 or error 上限）。既定 OFF（=現状と同一出力）。
- 注意点:
  - シーム分割メッシュは切り離し境界が多い → 境界エッジ保持（simplify の border lock）必須
  - UV の破綻防止に error 上限を保守的に（attribute 込み簡略化 `simplifyWithAttributes` を検討）
  - backfill / FillB レイヤーにも同じ簡略化を適用

## 各フェーズの完了条件

- Phase 0: `[Perf]` テーブルとハッシュログが出る。基準値を PROGRESS.md に記録
- Phase 1: 全ステップでハッシュ一致（または承認済み差分）+ 計測値の前後比較を記録
- Phase 2: 実機確認（ユーザー）で伸びの改善を確認、既定値を確定
- Phase 3: OBJ/GLB を DCC で開き UV/輪郭を確認（ユーザー）、README にライセンス追記
