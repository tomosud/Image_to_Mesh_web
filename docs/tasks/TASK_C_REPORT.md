# TASK C REPORT: meshoptimizer simplifier 調査

確認日: 2026-07-09

## 1. 推奨構成

結論: meshoptimizer の `MeshoptSimplifier` で進めてよい。現行 npm パッケージでは `meshopt_simplifier.module.js` という名前の配布物は確認できず、該当するブラウザ向け ES module は `meshopt_simplifier.js`。

- パッケージ: `meshoptimizer@1.2.0`
- 取得元:
  - npm tarball: `https://registry.npmjs.org/meshoptimizer/-/meshoptimizer-1.2.0.tgz`
  - CDN: `https://cdn.jsdelivr.net/npm/meshoptimizer@1.2.0/meshopt_simplifier.js`
  - GitHub: `https://github.com/zeux/meshoptimizer/tree/master/js`
- vendor 配置案: `js/vendor/meshopt_simplifier.js`
- ランタイムサイズ: `55,177` bytes（npm tarball 内 `package/meshopt_simplifier.js` の非圧縮サイズ）
- 型定義サイズ: `2,281` bytes（任意、実行には不要）
- LICENSE サイズ: `1,079` bytes
- ライセンス: MIT License
- LICENSE 一次確認元:
  - `https://raw.githubusercontent.com/zeux/meshoptimizer/master/LICENSE.md`
  - npm tarball 内 `package/LICENSE.md`

`meshopt_simplifier.js` は WASM を文字列として内包する単一 JS ファイルで、ビルド工程なしに `js/vendor/` へ置ける。GitHub Pages の静的ホスト条件に合う。ただし ES module なので、現行の非モジュール `<script>` 群からは次のどちらかで読む。

案 A: 非モジュール側で必要時に dynamic import する。

```js
async function loadMeshoptSimplifier() {
    const module = await import('./js/vendor/meshopt_simplifier.js');
    const simplifier = module.MeshoptSimplifier;
    if (!simplifier.supported) throw new Error('MeshoptSimplifier is not supported');
    await simplifier.ready;
    return simplifier;
}
```

案 B: 小さな `<script type="module">` ブリッジを追加し、`window.MeshoptSimplifierReady` に Promise を置く。既存の IIFE 群は `await window.MeshoptSimplifierReady` だけを見る。

`exportOBJ()` は既に `async` なので導入しやすい。`exportGLB()` は現在同期関数なので、同じ流れにするなら `async function exportGLB()` へ変更する必要がある。

## 2. README に追記すべきライセンス文面案

```md
### Third-party libraries

- meshoptimizer (`js/vendor/meshopt_simplifier.js`)  
  License: MIT License  
  Copyright (c) 2016-2026 Arseny Kapoulkine  
  Source: https://github.com/zeux/meshoptimizer / https://www.npmjs.com/package/meshoptimizer
```

MIT の条件として、配布時は上記著作権表示と MIT ライセンス本文を含める必要がある。README への短い記載に加え、`LICENSE` または README の third-party section に MIT 本文への参照を残すのが安全。

## 3. API 適用可否と統合コードスケッチ

対象の `createCompactExportGeometry(sourceGeometry)` は、`position` / `uv` / `index` を持つ indexed `THREE.BufferGeometry` を作り、最後に normal を再計算している。meshoptimizer はこの直後、normal 再計算の前に入れるのが自然。

主要 API:

- `MeshoptSimplifier.ready`: WASM 初期化 Promise。呼び出し前に必ず await する。
- `simplify(indices, vertex_positions, vertex_positions_stride, target_index_count, target_error, flags) => [Uint32Array, number]`
- `simplifyWithAttributes(indices, vertex_positions, vertex_positions_stride, vertex_attributes, vertex_attributes_stride, attribute_weights, vertex_lock, target_index_count, target_error, flags) => [Uint32Array, number]`
- `compactMesh(indices) => [Uint32Array, number]`
- `getScale(vertex_positions, vertex_positions_stride) => number`

引数整理:

- index は `Uint32Array`。three.js の index が `Uint16Array` の場合も `Uint32Array.from(...)` に変換する。
- position は `Float32Array`、stride は float 単位なので `3`。
- uv は `Float32Array`、stride は `2`。`simplifyWithAttributes` に渡す場合の weight は `[1.0, 1.0]` を初期値にする。UV 伸びが目立つ場合は `2.0` 以上を試すが、位置形状の品質とトレードオフ。
- `target_error` は相対誤差。`0.01` は概ねメッシュ extents の 1% 上限という扱い。保守的な初期値は `0.005` から `0.02`。
- `flags` は `['LockBorder']` を基本にする。深度段差で切り離したシームや外周の輪郭を縮ませにくくするため。
- `Permissive` は使わない。属性不連続を跨ぐ collapse を許しやすく、UV/シーム保護と逆方向。
- `Prune` は初期導入では使わない。孤立成分を削除し得るため、このアプリの意図的な連結成分や既存の small component 処理と衝突しやすい。

削減率スライダー案:

- UI 表示: `100%` から `10%`
- `ratio = sliderPercent / 100`
- `100%` は simplifier を呼ばずそのまま返す
- `targetIndexCount = Math.max(3, Math.floor(index.length * ratio / 3) * 3)`
- 推奨初期値: `50%` または `30%`
- `target_error` は別固定値でもよいが、スライダーだけにするなら `ratio >= 0.5: 0.005`, `ratio >= 0.25: 0.01`, `ratio < 0.25: 0.02` 程度から開始

擬似コード:

```js
async function simplifyCompactExportGeometry(geometry, options) {
    const simplifier = await loadMeshoptSimplifier();

    const posAttr = geometry.getAttribute('position');
    const uvAttr = geometry.getAttribute('uv');
    const indexAttr = geometry.getIndex();
    if (!posAttr || !indexAttr) return geometry;

    const sourceIndex = indexAttr.array;
    const indices = sourceIndex instanceof Uint32Array
        ? sourceIndex
        : Uint32Array.from(sourceIndex);

    const positions = posAttr.array instanceof Float32Array
        ? posAttr.array
        : Float32Array.from(posAttr.array);

    const ratio = Math.max(0.1, Math.min(1.0, options.ratio));
    if (ratio >= 0.999) return geometry;

    const targetIndexCount = Math.max(3, Math.floor(indices.length * ratio / 3) * 3);
    const targetError = options.targetError ?? 0.01;
    const flags = ['LockBorder'];

    let newIndices;
    let error;

    if (uvAttr) {
        const uvs = uvAttr.array instanceof Float32Array
            ? uvAttr.array
            : Float32Array.from(uvAttr.array);

        [newIndices, error] = simplifier.simplifyWithAttributes(
            indices,
            positions,
            3,
            uvs,
            2,
            [options.uvWeight ?? 1.0, options.uvWeight ?? 1.0],
            null,
            targetIndexCount,
            targetError,
            flags
        );
    } else {
        [newIndices, error] = simplifier.simplify(
            indices,
            positions,
            3,
            targetIndexCount,
            targetError,
            flags
        );
    }

    const [remap, uniqueVertexCount] = simplifier.compactMesh(newIndices);
    const outPositions = new Float32Array(uniqueVertexCount * 3);
    const outUVs = uvAttr ? new Float32Array(uniqueVertexCount * 2) : null;

    for (let oldIndex = 0; oldIndex < remap.length; oldIndex++) {
        const newVertex = remap[oldIndex];
        if (newVertex === 0xffffffff) continue;

        outPositions.set(positions.subarray(oldIndex * 3, oldIndex * 3 + 3), newVertex * 3);
        if (outUVs) {
            const uvs = uvAttr.array;
            outUVs.set(uvs.subarray(oldIndex * 2, oldIndex * 2 + 2), newVertex * 2);
        }
    }

    const outIndices = new Uint32Array(newIndices.length);
    for (let i = 0; i < newIndices.length; i++) outIndices[i] = remap[newIndices[i]];

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(outPositions, 3));
    if (outUVs) out.setAttribute('uv', new THREE.BufferAttribute(outUVs, 2));
    out.setIndex(new THREE.BufferAttribute(outIndices, 1));
    out.computeVertexNormals();
    out.computeBoundingBox();
    out.computeBoundingSphere();
    out.userData.simplifyError = error;
    return out;
}
```

注意: `simplifyWithAttributes` は元の vertex buffer を再利用し、新しい index buffer を返す API。強い削減で頂点位置や UV 自体も更新したい場合は `simplifyWithUpdate` が候補になるが、既存の export geometry 生成ロジックへの影響が大きいので初期導入では避ける。

## 4. リスクと未確認事項

- `meshopt_simplifier.module.js` というファイル名は現行 `meshoptimizer@1.2.0` では確認できない。導入時は `meshopt_simplifier.js` を使う前提で README/実装名を合わせる。
- ES module と現行の非モジュール IIFE 構成の共存は可能だが、`ready` の await が必要。OBJ/GLB export の UI 状態やエラーハンドリングも非同期化する。
- `Uint16Array` index は `Uint32Array` に変換する。simplify 後の index が 65,535 以下でも、まず `Uint32Array` のまま扱うのが安全。
- `LockBorder` は境界保持に有効だが、切り離しシームが多い入力では削減率に到達しないことがある。返却された index count と error を UI/log で確認した方がよい。
- `simplifyWithAttributes` の UV weight は入力依存。`[1, 1]` から始め、テクスチャ伸びが出る画像で調整が必要。
- 800万面クラスの公式 JS simplifier ベンチは今回確認できなかった。WASM 実装なので three.js の JS 実装より有利だが、24M indices だけで `Uint32Array` 約 96 MB になり、positions/uv/一時バッファを含めると数百 MB 級になる。メインスレッド実行では数秒フリーズの可能性があるため、大入力では Web Worker 化を検討する。
- 初回呼び出しは WASM compile/initialization が入る。アプリ起動時ではなく export 初回に遅延ロードするなら、ボタン押下後に短い待ち時間が出る。
- `simplifyWithUpdate` は UV 更新に有利だが、元 vertex buffer を破壊的に更新する API。既存 geometry をコピーしてから使う必要があり、初期導入のリスクが高い。

## 5. 代替案の簡易比較

three.js `SimplifyModifier`:
three.js r128 の実装は attributes のうち `position` 以外を削除し、`BufferGeometryUtils.mergeVertices` 後に JS の progressive mesh collapse を行う。`minimumCostEdge` が O(n*n) とコメントされており、大規模 mesh には不適。UV を保持できないので今回の export 用途には不向き。

自前の頂点クラスタリング:
グリッド量子化で近い頂点をマージするだけなら実装は軽く、速度も出しやすい。品質はカメラ距離や局所形状に弱く、シーム/UV/細い構造を壊しやすい。緊急の粗削減 fallback としては可だが、主経路にはしない。

MeshLab / MeshLabJS 系:
高品質な QEM 系機能はあるが、MeshLab は GPL 系で、このリポジトリの「商用利用可能な MIT 互換のみ」という条件に合わない。ブラウザ静的配置だけで軽く組み込む候補としても重い。

## 6. 判断

meshoptimizer で進めてよい。

理由:

- LICENSE 原文で MIT を確認でき、商用利用可能条件に合う。
- `meshopt_simplifier.js` は WASM 内包の単一 ES module で、ビルドなしの静的配置に合う。
- API が indexed position/uv geometry にそのまま近く、normal を export 時に再計算する現行仕様とも合う。
- `LockBorder` と属性不連続保持により、深度段差シームや UV を守る方向で調整できる。
- three.js `SimplifyModifier` は速度・属性保持の両面で今回の規模と用途に合わない。

初期実装方針は、`createCompactExportGeometry` の出力直後に `simplifyWithAttributes` + `LockBorder` を適用し、`compactMesh` で未使用頂点を落としてから normal/bounds を再計算する構成がよい。削減率は 100% なら bypass、10% から 100% の index count target に変換し、error 上限は保守的に `0.005` から `0.02` で開始する。

