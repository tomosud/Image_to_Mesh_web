# TASK B: viewer.js ジオメトリ経路の typed array 化と無駄削減（結果不変）

## 背景（このファイルだけで完結）

このリポジトリはブラウザ内で単一画像から depth 推論しメッシュ化する静的 Web アプリ。
`js/viewer.js` は three.js でメッシュを構築する。最大 2048×2048 グリッド（約420万頂点、
約830万面）を扱うが、インデックス構築が通常の JS 配列 push で行われており、
一時的に数百 MB の boxed array と GC 停止が発生する。これを typed array 化する。
描画結果・エクスポート結果の**幾何値は1ビットも変えない**こと。

対象リポジトリ: `C:\work\script\Image_to_Mesh_web`

## 絶対条件

1. **頂点位置・UV・インデックスの値と並び順を変えない。** 面の順序、頂点追加の順序、
   浮動小数の演算順序を維持する。アルゴリズム・しきい値の変更は禁止。
2. 変更してよいファイルは `js/viewer.js` と、`index.html` のキャッシュバスター
   （`viewer.js?v=YYYYMMDD-N` の版数を今日の日付で +1）のみ。
3. git commit / push はしない（ユーザーが行う）。ブラウザでの実機確認もしない
   （確認はユーザーが行う。`node --check js/viewer.js` の構文確認のみ行う）。
4. ファイルは UTF-8。日本語コメントを文字化けさせない。既存コメントは削除しない。
5. 新しい md は作らない（完了報告はチャットで返す）。

## 変更内容

### B-1. `splitDiscontinuousFaces`（最重要）

`indices` / `extraPos` / `extraUV` が JS 配列 push（最大約 5,000 万要素の boxed array）。

- 2パス方式にする: 1パス目で各セルの分類（非シーム / シーム時の各プレートの張り判定と
  複製頂点数）だけを行い、必要な indices 長と extra 頂点数を数える。2パス目で
  `Uint32Array` / `Float32Array` を確保して書き込む。
  判定ロジック（finite チェック、isSeam、幾何平均 t、sideCount、スパン skip、
  refCorner 選択）は現状のコードを**そのまま**2回実行する形でよい
  （判定を関数に括り出して共有し、コピペの不一致を防ぐこと）。
- 面・頂点の**出力順序は現状と完全一致**させる（複製頂点の index 採番順も同じ）。
- `geometry.setIndex(indices)` は three.js が JS 配列から Uint16/Uint32 を自動選択する。
  置き換え後も同じ規則（頂点総数 > 65535 なら Uint32Array、以下なら Uint16Array）で
  `THREE.BufferAttribute` を作って渡し、エクスポート時のインデックス型を変えない。

### B-2. `removeInvalidAndDiscontinuousFaces` / `removeSmallFaceComponents` / `erodeBoundaryFaces`

- `kept = []` push を typed array 化する。kept は元の index 長以下なので、元と同じ型の
  typed array を確保 → 書き込み → `subarray(0, n)` ではなく **正確な長さで new して copy**
  （subarray はバッファ全体を保持し続けるため）。
- `erodeBoundaryFaces` の `edgeUse` が文字列キー Map（エッジごとに文字列生成）。
  現在 `passes=0` で停止中だが、整数キー化しておく:
  `key = lo * vertexCount + hi` は 2048 級で 53bit を超え得るため、
  `Map<number, number>` に `lo * 2^26 + hi` のような安全な合成（vertexCount < 2^26 を
  assert）か、`lo` ごとの配列など、浮動小数で正確に表現できる方式にする。
  動作は現状と同値（削る face の集合が同じ）であること。

### B-3. 頂点カラーの遅延生成

`createMesh` は mesh 表示時も毎回、全頂点の頂点カラー（`colors` Float32Array、
sRGB→Linear 変換つき）を生成しているが、使用されるのは points モードのみ（と思われる）。

- 先に `createMaterial` / `createPointsMaterial` / `updateMaterial` を読み、mesh 用
  マテリアルが `vertexColors` を使っていないことを**確認**する。使っていた場合は
  この項目を中止し、報告に記載する。
- 確認できたら、`isPointsMode` のときだけ colors を生成する。
  `setPointsMode` が `createMesh` を呼び直すこと（呼ばなければモード切替時に colors が
  無い）も確認し、呼んでいなければ切替時に生成されるよう最小限の修正を加える。

### B-4. `rebuildBackfillMesh` の中央値計算

`disps = []` に全有効画素を push → 比較関数つき sort している。
`Float32Array` に詰めて `subarray(0, n).sort()`（比較関数なし・数値昇順）に変える。
中央値の添字 `disps[disps.length >> 1]` の規則は変えない。値は同一になる
（間引き・近似はしない）。

### B-5. 旧ジオメトリの dispose

`createMesh` で `scene.remove(mesh)` する際、旧 `mesh.geometry` / 旧マテリアルを
dispose していない（GPU/CPU メモリが再計算のたびに残る）。旧 mesh / pointsMesh の
geometry・material を dispose する。ただし直後に再利用しているオブジェクト
（テクスチャ `currentTextureObject` 等）は dispose しないこと。

### B-6. やらないこと

- `createMesh` の bilinear リサンプリングループ、`splitDiscontinuousFaces` の判定式、
  `updateFiniteGeometryBounds` は触らない。
- Web Worker 化、ジオメトリ簡略化、描画設定の変更はしない。
- 迷ったら「変えない」を選ぶ。

## 検証

- `node --check js/viewer.js` で構文確認。
- B-1/B-2 は「出力順序が完全一致」であることをコードレビューレベルで自己検証し、
  完了報告に「順序が一致する理由」を1〜2行で書く。
  （最終確認はユーザーがブラウザで行う。表示・エクスポートが変わらないことが合格条件）

## 完了報告フォーマット

- B-1〜B-5 それぞれの実施/見送りと、見送り理由
- B-3 の事前確認結果（vertexColors の使用箇所）
- 出力順序不変の根拠（B-1/B-2）
- 期待されるメモリ削減の概算
