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

    // Snap Width パスを超えても台地深度が届かなかった画素（未解決の中間深度）は、
    // シルエット沿いの前後スパイク（櫛状の膜）の頂点になる。true でそれらを無効化し、
    // 面を張らず backfill に裏打ちさせる（三重点セル skip と同じ思想。TASK_G G-1）。
    const INVALIDATE_UNRESOLVED = true;

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
        // 1b. 窓内の急勾配ランプを追加検出（隣接対では拾えない「数pxの大勾配」）。
        // 各ステップが rtol 未満でも数px で大きく変化する遷移帯（fg/bg 境界のボケ）は
        // 上の隣接対比較を通り抜け、主メッシュで奥へ長く伸びる薄板になる。半径 WIN_R 内に
        // 「自分より WIN_T 以上手前の画素」と「WIN_T 以上奥の画素」が両方あれば、手前台地と
        // 奥台地に挟まれた中間ランプとみなしフラグする。台地は片側しか差が無いので拾わず、
        // 総変化の小さい gentle な連続斜面も（窓内で両側の大差が揃わないので）拾わない。
        const WIN_R = 3;       // 窓半径(px)。「スクリーンスペースで数px」の勾配を対象
        const WIN_T = 0.12;    // 手前/奥それぞれの相対しきい値（両側必要＝実質2倍で急勾配のみ）
        let windowFlagged = 0;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!validMask[i] || flagged[i]) continue;
                const di = depth[i];
                if (!(di > 0)) continue;
                const nearD = di / (1 + WIN_T), farD = di * (1 + WIN_T);
                let hasNear = false, hasFar = false;
                for (let dy = -WIN_R; dy <= WIN_R && !(hasNear && hasFar); dy++) {
                    const ny = y + dy; if (ny < 0 || ny >= H) continue;
                    for (let dx = -WIN_R; dx <= WIN_R; dx++) {
                        const nx = x + dx; if (nx < 0 || nx >= W) continue;
                        const j = ny * W + nx;
                        if (!validMask[j]) continue;
                        const dj = depth[j];
                        if (dj < nearD) hasNear = true;
                        else if (dj > farD) hasFar = true;
                        if (hasNear && hasFar) break;
                    }
                }
                if (hasNear && hasFar) { flagged[i] = 1; windowFlagged++; }
            }
        }
        // 1c. ソフトランプの走査検出（TASK_G G-6）。毛・草など「ソフトな輪郭が背景と
        // 重なる」場所では、深度が数十px かけてなだらかに遷移する（台地→緩い坂→台地）。
        // 1画素あたりの勾配が小さいため隣接対（1）にも半径3pxの窓（1b）にも掛からず、
        // 視線方向へ伸びる膜になる。本物の斜面（床・壁）と区別できる特徴は勾配ではなく
        // 「長さ」: 膜になるランプは短い距離で大きな総変化があり両端が台地で終わる。
        // 本物の斜面は同程度の勾配が何百pxも続く。行/列を走査し、同符号の disparity 勾配が
        // 連続する区間（run）が「長さ RAMP_MAX_PX 以下 かつ 総変化しきい値超」のときだけ
        // 全画素をフラグする。台地・符号反転で run が切れるので、長い連続斜面は拾わない。
        //
        // しきい値は視差（parallax）基準: 切り離すべきかどうかは深度比ではなく、視点を
        // 動かしたときの画面上のズレ量 ∝ disparity 差 (1/z_near - 1/z_far) で決まる。
        // 遠景は深度比が2倍でも disparity 差が小さく（視差ほぼ無し）フラグ不要、近景は
        // 小さな深度比でも disparity 差が大きく膜が目立つ。backfill メッシュの視差カットと
        // 同じ「シーン中央値 disparity に対する比」でスケール不変にする。
        const RAMP_MAX_PX = 48;          // これより長い遷移は本物の斜面とみなす
        const RAMP_TOTAL_K = 0.25;       // run 総 disparity 変化のしきい値（×中央値 disparity）
        const RAMP_STEP_MIN_K = 0.003;   // run を構成する最小 disparity 勾配/px（×中央値 disparity）
        let rampFlagged = 0;
        {
            // 有効画素の disparity と、その中央値（サブサンプルで十分）
            const dispArr = new Float32Array(N);
            for (let i = 0; i < N; i++) dispArr[i] = depth[i] > 0 ? 1 / depth[i] : NaN;
            const stride = Math.max(1, Math.floor(N / 262144));
            const samples = [];
            for (let i = 0; i < N; i += stride) {
                if (validMask[i] && dispArr[i] > 0) samples.push(dispArr[i]);
            }
            samples.sort((a, b) => a - b);
            const dispMed = samples.length ? samples[samples.length >> 1] : 0;
            const rampTotalMin = RAMP_TOTAL_K * dispMed;
            const rampStepMin = RAMP_STEP_MIN_K * dispMed;
            const scan = (len, count, idx) => {
                for (let s = 0; s < count; s++) {
                    let runStart = -1, runSign = 0, runSum = 0;
                    let prev = -1, prevJ = -1;
                    const flush = (endPos) => {
                        if (runStart >= 0) {
                            const runLen = endPos - runStart;
                            if (runLen >= 2 && runLen <= RAMP_MAX_PX && Math.abs(runSum) > rampTotalMin) {
                                for (let p = runStart; p <= endPos; p++) {
                                    const j = idx(s, p);
                                    if (!flagged[j]) { flagged[j] = 1; rampFlagged++; }
                                }
                            }
                        }
                        runStart = -1; runSign = 0; runSum = 0;
                    };
                    for (let p = 0; p < len; p++) {
                        const j = idx(s, p);
                        if (!validMask[j] || !Number.isFinite(dispArr[j])) {
                            flush(prev);
                            prev = -1; prevJ = -1;
                            continue;
                        }
                        if (prev < 0) { prev = p; prevJ = j; continue; }
                        const step = dispArr[j] - dispArr[prevJ];
                        const sign = step > rampStepMin ? 1 : step < -rampStepMin ? -1 : 0;
                        if (sign !== 0 && sign === runSign) {
                            runSum += step;
                        } else {
                            flush(prev);
                            if (sign !== 0) { runStart = prev; runSign = sign; runSum = step; }
                        }
                        prev = p; prevJ = j;
                    }
                    flush(prev);
                }
            };
            if (dispMed > 0) {
                scan(W, H, (y, x) => y * W + x);   // 行方向
                scan(H, W, (x, y) => y * W + x);   // 列方向
            }
        }
        if (edgePairs === 0 && windowFlagged === 0 && rampFlagged === 0) return null;

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
        // maxRampPx を超えて残ったランプ画素の処置:
        // - INVALIDATE_UNRESOLVED=true: 無効化する。中間深度のまま頂点になると
        //   シルエットで前後スパイクになるため、面を張らず backfill に埋めさせる
        // - false: 元の値のまま残す（従来動作）
        let invalidated = 0;
        let newValidMask = null;
        if (INVALIDATE_UNRESOLVED && pending.length) {
            newValidMask = Uint8Array.from(validMask);
            for (const i of pending) {
                newValidMask[i] = 0;
                invalidated++;
            }
        }

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

        const stats = { edgePairs, windowFlagged, rampFlagged, snapped, unresolved: pending.length, invalidated };
        console.log('[EdgeSnap]', { rtol, maxRampPx, ...stats });
        return { depth: newDepth, points: newPoints, uvSrcIndex: srcRoot, validMask: newValidMask, stats };
    }

    return { process };
})();
