# TASK E: ポリゴンリダクションの Web Worker 化（フリーズ解消）

## 背景（このファイルだけで完結）

このリポジトリはブラウザ内で単一画像から depth 推論しメッシュ化する静的 Web アプリ。
直前のタスク（docs/tasks/TASK_D_EXPORT_REDUCE.md、実装済み）で、表示メッシュへの
遅延ポリゴンリダクション（境界スムース化 + meshoptimizer 簡略化、`Reduce Polygons`
チェックボックス既定 ON）が入った。結果は良いが、`runReduction` が
compact 化 → 境界スムース化 → simplify → 法線計算をメインスレッドで3メッシュ分
実行するため、**実行の瞬間に数秒 UI が固まる**。

このタスクでは、リダクションの計算部を **module Web Worker** へ移し、フリーズを
解消する。処理内容・数値結果は現在のメインスレッド実装と同一に保つ（コードの移動で
あってアルゴリズムの書き換えではない）。

対象リポジトリ: `C:\work\script\Image_to_Mesh_web`
現在の実装: `js/viewer.js` の `scheduleReduction` / `flushReduction` / `runReduction` /
`reduceDisplayMesh` / `createFiniteCompactGeometry` / `smoothBoundaryScreenSpace` /
`simplifyCompactGeometry` 一帯（コミット 56d0ab5 で追加）。

## 絶対条件

1. **リダクションの数値結果を変えない。** 既存関数の計算式・定数・処理順を worker へ
   移すだけにする（THREE.BufferGeometry 依存を生配列操作に置き換える変換は可。
   その際も演算順は維持）。
2. **`Reduce Polygons` OFF のときの挙動は現状と完全同一。**
3. 変更してよいファイル: `js/viewer.js`、新規 `js/reduce_worker.js`、
   `index.html`（キャッシュバスターのみ）。vendor / README は変更しない。
4. git commit / push はしない。ブラウザ実機確認はしない（`node --check` のみ）。
5. ファイルは UTF-8。日本語コメントを壊さない。既存コメントは移動時も保持する。
6. 新しい md は作らない（完了報告はチャットで返す）。

## 設計

### E-1. Worker ファイル

`js/reduce_worker.js` を **ES module worker** として新設する。

- 先頭で `import('./vendor/meshopt_simplifier.js')`（または静的 import）し、
  `MeshoptSimplifier.ready` を await してからジョブを処理する。
- viewer.js から移す処理（生配列版に変換）:
  1. finite compact 化（NaN 頂点を落とし使用頂点だけ詰め直す）
  2. 境界スムース化（境界抽出・可動判定・スクリーン空間平滑化・uv 差分加算。
     main/backfill のみ、fillb はスキップのフラグ制御）
  3. `simplifyWithAttributes` + `compactMesh`
  4. **法線計算**: 面法線（外積）を頂点へ加算し正規化する area-weighted 方式。
     three.js の `computeVertexNormals` と同じ計算（クロス積を正規化せず加算）に
     合わせること。worker で計算して返し、メインスレッドでは再計算しない
- メッセージ受信は FIFO で1件ずつ処理する。

### E-2. プロトコル

リクエスト（viewer → worker）:

```
{ token, name: 'main'|'backfill'|'fillb',
  positions: Float32Array, uvs: Float32Array, index: Uint16/32Array,
  smooth: boolean,
  params: { fx, fy, cx, cy, gridW, gridH,
            SMOOTH_ITERS, SMOOTH_LAMBDA, SMOOTH_CLAMP_CELLS,
            REDUCE_TARGET_RATIO, REDUCE_TARGET_ERROR, REDUCE_UV_WEIGHT } }
```

- 定数は viewer.js の既存定義を**唯一の定義元**とし、メッセージで渡す
  （worker 側に重複定義しない）。
- 送信前に geometry の各配列を**コピーしてから transferable で渡す**
  （表示中の geometry が使用中のため。`array.slice()` で可）。
- grid 寸法と intrinsics は現行実装が使っている値をそのまま渡す
  （現行の `inferGeometryGridSize` 相当を worker へ移すか、viewer 側で確定して渡すかは
  現行コードの構造に合わせて選ぶ。計算結果が変わらないこと）。

レスポンス（worker → viewer）:

```
{ token, name, ok: true,
  positions, uvs, normals, index, stats: { facesBefore, facesAfter, error, ms } }
```

失敗時は `{ token, name, ok: false, message }`。全バッファ transferable で返す。

### E-3. viewer.js 側

- `scheduleReduction` の debounce・世代トークンはそのまま。`runReduction` は
  「3メッシュ分のジョブを worker へ投げ、応答ごとに差し替える」形に変える。
- **応答受信時**: token が最新でなければ破棄。最新なら BufferGeometry を組み立て
  （position/uv/normal/index を受信配列から `THREE.BufferAttribute` で設定、
  `computeVertexNormals` は呼ばない）、既存の差し替え処理（dispose・material 維持・
  bounds 計算）を行う。
- **ジョブの間引き**: worker 処理中に新しい世代が来たら、処理中のものはそのまま
  完了させて結果だけ破棄し、**最新の1世代だけ**を次に送る（キューに溜めない）。
- `flushReduction`（export 前の完了待ち）は「未送信ならすぐ送信し、送信済みの
  最新 token の応答が返るまで await」に変える。export の「表示中ジオメトリを使う」
  構造は変えない。
- **Worker が使えない/初期化に失敗した場合**: console.warn を出してリダクションを
  無効化し、フル解像度表示のまま動かす（メインスレッド実行のフォールバックは
  残さない。旧メインスレッド実装は worker へ移した後、viewer.js から削除する）。
- Worker の生成 URL にもキャッシュバスターを付ける:
  `new Worker('js/reduce_worker.js?v=YYYYMMDD-N', { type: 'module' })`。
  viewer.js 内にバージョン文字列定数を置き、`index.html` の `viewer.js?v=` と同時に
  更新する運用コメントを付ける。

### E-4. キャッシュバスター

`index.html` の `viewer.js?v=` を今日の日付で +1。

## 検証

- `node --check js/viewer.js` と `node --check js/reduce_worker.js`
  （module worker だが構文チェックは可能。import 文がある場合は
  `node --check --input-type=module` 相当の確認方法を使う）
- **数値同一性の自己検証**: スムース化・simplify 呼び出し・法線計算の式が移動前と
  同一であることをコードレビューレベルで確認し、報告に根拠を書く
- 可能なら Node で境界スムース化関数の移動前後の同値テスト（生配列版にした部分。
  合成の小さなグリッドで byte 比較。一時スクリプトは終了時に削除）
- フリーズ解消・表示差し替わりの実機確認はユーザーが行う

## 完了報告フォーマット

- E-1〜E-4 の実施状況
- 数値同一性の根拠（移動時に式を変えた箇所があれば列挙）
- メインスレッドに残る処理とその見込み時間
  （配列コピー・GPU アップロードなど。数十〜百ms 台のはず）
- 既知の制限（例: worker 初回起動 + WASM 初期化の遅延、file:// 直開きでは worker 不可
  ＝ run.bat のローカルサーバ経由が前提であること）
