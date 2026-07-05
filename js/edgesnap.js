// edgesnap.js — 深度エッジのスナップ（中間値の除去）
// cleanDepthMask の「エッジ両側の画素削除」を置き換える。エッジ検出は従来と同一基準
// （隣接画素対の相対段差 > rtol）のまま、検出したランプ画素を削除せずに、周囲の
// 確定画素（台地）から値を伝播して中間値を消す。
//   例: 2 2 3 4 5 5 → 2 2 2 5 5 5
// - 各ランプ画素は「元の深度と対数距離が最も近い側」の確定値へ吸着する
// - 吸着元の画素 index を uvSrcIndex に記録し、viewer が UV を差し替える
//   （テクスチャ画像は変更しない。中間色はサンプリングされなくなる）
// - 面の切り離し（シーム分割・頂点複製）は viewer.js 側で行う
// - しきい値の役割分担は既存方針を維持: 面分割 0.10 固定 / backfill 0.10 固定。
//   本モジュールだけが Edge Threshold UI に連動する。
const EdgeSnap = (function () {

    // input:
    //   depth: Float32Array(W*H) メトリック深度（有効画素は正）
    //   points: Float32Array(W*H*3) カメラ空間点（X,Y は z に線形）
    //   validMask: Uint8Array(W*H) 1=有効
    // opts:
    //   rtol: エッジ検出の相対段差しきい値（Edge Threshold UI。>=1 で Off）
    //   maxRampPx: 台地からの伝播上限 px（Snap Width UI）
    // 戻り値: { depth, points, uvSrcIndex, stats } | null（Off またはエッジ無し）
    function process(input, opts) {
        const { depth, points, validMask, width: W, height: H } = input;
        const rtol = opts.rtol;
        const maxRampPx = Math.max(1, opts.maxRampPx | 0);
        if (!(rtol > 0) || rtol >= 1) return null;
        const N = W * H;

        // 1. エッジ検出（cleanDepthMask と同一: 右/下の隣接対を各1回比較）
        const flagged = new Uint8Array(N);
        let edgePairs = 0;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!validMask[i]) continue;
                for (let k = 0; k < 2; k++) {
                    const j = k === 0 ? (x + 1 < W ? i + 1 : -1) : (y + 1 < H ? i + W : -1);
                    if (j < 0 || !validMask[j]) continue;
                    const minD = Math.max(Math.min(depth[i], depth[j]), 1e-6);
                    if (Math.abs(depth[i] - depth[j]) / minD > rtol) {
                        flagged[i] = 1;
                        flagged[j] = 1;
                        edgePairs++;
                    }
                }
            }
        }
        if (edgePairs === 0) return null;

        // 2. 台地からの伝播。有効かつ非フラグの画素を種（確定）とし、各ランプ画素は
        //    確定済み4近傍のうち「元の深度と対数距離が最も近い」値へ吸着する。
        //    更新はパス末尾で一括適用し、両側のフロントが1画素/パスずつ対等に進む。
        const newDepth = Float32Array.from(depth);
        const srcRoot = new Int32Array(N).fill(-1);
        const assigned = new Uint8Array(N);
        let pending = [];
        for (let i = 0; i < N; i++) {
            if (!validMask[i]) continue;
            if (flagged[i]) pending.push(i);
            else assigned[i] = 1;
        }

        let snapped = 0;
        for (let pass = 0; pass < maxRampPx && pending.length; pass++) {
            const updates = [];
            const rest = [];
            for (const i of pending) {
                const x = i % W;
                const logOrig = Math.log(Math.max(depth[i], 1e-6));
                let best = -1, bestDist = Infinity;
                for (let k = 0; k < 4; k++) {
                    let j = -1;
                    if (k === 0 && x + 1 < W) j = i + 1;
                    else if (k === 1 && x > 0) j = i - 1;
                    else if (k === 2 && i + W < N) j = i + W;
                    else if (k === 3 && i - W >= 0) j = i - W;
                    if (j < 0 || !assigned[j]) continue;
                    const dist = Math.abs(logOrig - Math.log(Math.max(newDepth[j], 1e-6)));
                    if (dist < bestDist) { bestDist = dist; best = j; }
                }
                if (best >= 0) updates.push(i, best);
                else rest.push(i);
            }
            if (!updates.length) break;
            for (let u = 0; u < updates.length; u += 2) {
                const i = updates[u], j = updates[u + 1];
                newDepth[i] = newDepth[j];
                srcRoot[i] = srcRoot[j] >= 0 ? srcRoot[j] : j;
                assigned[i] = 1;
                snapped++;
            }
            pending = rest;
        }
        // maxRampPx を超えて残ったランプ画素は元の値のまま（削除もしない）。

        // 3. points を新しい深度で更新。X,Y は z に線形（X=(u-cx)/fx*z）なので
        //    同一画素レイ上の移動は比率スケールで正確に表せる。
        const newPoints = Float32Array.from(points);
        for (let i = 0; i < N; i++) {
            if (srcRoot[i] < 0) continue;
            const oldZ = depth[i];
            if (!(oldZ > 0)) continue;
            const s = newDepth[i] / oldZ;
            newPoints[i * 3] *= s;
            newPoints[i * 3 + 1] *= s;
            newPoints[i * 3 + 2] = newDepth[i];
        }

        const stats = { edgePairs, snapped, unresolved: pending.length };
        console.log('[EdgeSnap]', { rtol, maxRampPx, ...stats });
        return { depth: newDepth, points: newPoints, uvSrcIndex: srcRoot, stats };
    }

    return { process };
})();
