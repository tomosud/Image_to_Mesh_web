// backfill.js — 遮蔽穴インペイント（PLAN_INPAINT.md 参照）
// viewer が深度段差で面を除去して開く「幅ゼロの隙間」と、エッジ切断で消えた画素の両方を対象に、
// 深度不連続の奥側画素を種として深度（disparity 平面フィット + ラプラス平滑化）と
// 色（プルプッシュ + 拡散）を前景の裏へ伸長し、第2レイヤー（world position + テクスチャ）を生成する。
// 手前側の位置・色は一切参照しない。

const Backfill = (function () {

    const OFFS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    // 元解像度の ImageData をモデル解像度 W×H へバイリニア縮小
    function resampleColor(imageData, W, H) {
        const sw = imageData.width, sh = imageData.height;
        const src = imageData.data;
        const out = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) {
            const fy = (y + 0.5) * sh / H - 0.5;
            const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1);
            const wy = fy - y0;
            for (let x = 0; x < W; x++) {
                const fx = (x + 0.5) * sw / W - 0.5;
                const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1);
                const wx = fx - x0;
                const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
                const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
                const oi = (y * W + x) * 4;
                for (let c = 0; c < 4; c++) {
                    const v0 = src[i00 + c] * (1 - wx) + src[i10 + c] * wx;
                    const v1 = src[i01 + c] * (1 - wx) + src[i11 + c] * wx;
                    out[oi + c] = Math.round(v0 * (1 - wy) + v1 * wy);
                }
            }
        }
        return out;
    }

    // 種画素の色のみを起点にしたプルプッシュ（画像ピラミッド）。全画素の補完色を返す。
    function pullPush(W, H, seedMask, colorBase) {
        // 各レベル: [r,g,b] 正規化済み + valid。level0 から 2x2 平均で縮小。
        const levels = [];
        let lw = W, lh = H;
        let data = new Float32Array(W * H * 3);
        let valid = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) {
            if (!seedMask[i]) continue;
            valid[i] = 1;
            data[i * 3] = colorBase[i * 4];
            data[i * 3 + 1] = colorBase[i * 4 + 1];
            data[i * 3 + 2] = colorBase[i * 4 + 2];
        }
        levels.push({ w: lw, h: lh, data, valid });

        while (lw > 2 || lh > 2) {
            const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
            const nd = new Float32Array(nw * nh * 3);
            const nv = new Uint8Array(nw * nh);
            for (let y = 0; y < nh; y++) {
                for (let x = 0; x < nw; x++) {
                    let r = 0, g = 0, b = 0, wsum = 0;
                    for (let dy = 0; dy < 2; dy++) {
                        for (let dx = 0; dx < 2; dx++) {
                            const sx = Math.min(lw - 1, x * 2 + dx);
                            const sy = Math.min(lh - 1, y * 2 + dy);
                            const si = sy * lw + sx;
                            if (!valid[si]) continue;
                            r += data[si * 3]; g += data[si * 3 + 1]; b += data[si * 3 + 2];
                            wsum++;
                        }
                    }
                    const ni = y * nw + x;
                    if (wsum > 0) {
                        nv[ni] = 1;
                        nd[ni * 3] = r / wsum; nd[ni * 3 + 1] = g / wsum; nd[ni * 3 + 2] = b / wsum;
                    }
                }
            }
            levels.push({ w: nw, h: nh, data: nd, valid: nv });
            lw = nw; lh = nh; data = nd; valid = nv;
        }

        // 最粗レベル: 無効画素は有効平均で埋める
        const top = levels[levels.length - 1];
        let ar = 0, ag = 0, ab = 0, an = 0;
        for (let i = 0; i < top.w * top.h; i++) {
            if (!top.valid[i]) continue;
            ar += top.data[i * 3]; ag += top.data[i * 3 + 1]; ab += top.data[i * 3 + 2]; an++;
        }
        if (an === 0) return null;
        for (let i = 0; i < top.w * top.h; i++) {
            if (top.valid[i]) continue;
            top.data[i * 3] = ar / an; top.data[i * 3 + 1] = ag / an; top.data[i * 3 + 2] = ab / an;
        }

        // 粗→細: 無効画素を1段粗いレベル（全埋め済み）からバイリニアで補完
        for (let L = levels.length - 2; L >= 0; L--) {
            const fine = levels[L], coarse = levels[L + 1];
            for (let y = 0; y < fine.h; y++) {
                const fy = (y + 0.5) * coarse.h / fine.h - 0.5;
                const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(coarse.h - 1, y0 + 1);
                const wy = fy - y0;
                for (let x = 0; x < fine.w; x++) {
                    const fi = y * fine.w + x;
                    if (fine.valid[fi]) continue;
                    const fx = (x + 0.5) * coarse.w / fine.w - 0.5;
                    const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(coarse.w - 1, x0 + 1);
                    const wx = fx - x0;
                    const i00 = (y0 * coarse.w + x0) * 3, i10 = (y0 * coarse.w + x1) * 3;
                    const i01 = (y1 * coarse.w + x0) * 3, i11 = (y1 * coarse.w + x1) * 3;
                    for (let c = 0; c < 3; c++) {
                        const v0 = coarse.data[i00 + c] * (1 - wx) + coarse.data[i10 + c] * wx;
                        const v1 = coarse.data[i01 + c] * (1 - wx) + coarse.data[i11 + c] * wx;
                        fine.data[fi * 3 + c] = v0 * (1 - wy) + v1 * wy;
                    }
                }
            }
        }
        return levels[0].data;
    }

    // メイン処理
    // input: { depth: Float32[H*W](metric), validMask: Uint8(切断後有効), holeMask: Uint8(エッジ切断で消えた画素),
    //          intrinsics: {fx,fy,cx,cy}(正規化), color: ImageData(元解像度), width, height }
    // opts: { marginPx, jumpTol }
    // 戻り値: { worldPos: Float32[H*W*4], colorTex, validMask: Uint8, width, height, stats } | null
    function generate(input, opts) {
        const { depth, validMask, holeMask, intrinsics, width: W, height: H } = input;
        const marginPx = Math.max(1, (opts && opts.marginPx) || 48);
        // viewer.removeInvalidAndDiscontinuousFaces の relativeDepthThreshold と同じ既定値。
        // これを超える段差で面が除去され隙間が開くため、同じ基準で種を検出する。
        const jumpTol = (opts && opts.jumpTol) || 0.10;
        const COLLAR_PX = 4;      // 奥面への食い込み幅（継ぎ目を主メッシュの裏に隠す）
        const PUSH_BASE = 0.015;  // 層全体の基礎押し込み（z-fighting とクラック回避）
        const PUSH_BACK = 0.04;   // 種から離れるほど追加で奥へ押し込む最大比率
        const RAMP_PX = 12;       // PUSH_BACK がフルに効くまでの距離
        const N = W * H;

        // ---- 1a. 種の検出: 有効画素同士の深度不連続エッジの「奥側」画素 ----
        // （面除去で開く幅ゼロの隙間に対応。手前側は種にしない）
        const seed = new Uint8Array(N);
        let seedCount = 0;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!validMask[i]) continue;
                for (let k = 0; k < 2; k++) {
                    const nx = x + (k === 0 ? 1 : 0), ny = y + (k === 0 ? 0 : 1);
                    if (nx >= W || ny >= H) continue;
                    const j = ny * W + nx;
                    if (!validMask[j]) continue;
                    const di = depth[i], dj = depth[j];
                    const rel = Math.abs(di - dj) / Math.max(Math.min(di, dj), 1e-6);
                    if (rel > jumpTol) {
                        const f = di > dj ? i : j;
                        if (!seed[f]) { seed[f] = 1; seedCount++; }
                    }
                }
            }
        }

        // ---- 1b. 種の追加: エッジ切断で消えた画素（穴）の奥側境界 ----
        // 穴の連結成分ごとに境界有効画素を near/far 分類（幾何平均しきい値）し、far を種に加える。
        const hlabel = new Int32Array(N).fill(-1);
        const queue = new Int32Array(N);
        {
            let compId = 0;
            for (let start = 0; start < N; start++) {
                if (!holeMask[start] || hlabel[start] >= 0) continue;
                let head = 0, tail = 0;
                queue[tail++] = start;
                hlabel[start] = compId;
                const ringSet = new Set();
                while (head < tail) {
                    const i = queue[head++];
                    const x = i % W, y = (i / W) | 0;
                    for (const [dx, dy] of OFFS) {
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                        const j = ny * W + nx;
                        if (holeMask[j] && hlabel[j] < 0) { hlabel[j] = compId; queue[tail++] = j; }
                        else if (validMask[j]) ringSet.add(j);
                    }
                }
                compId++;
                if (ringSet.size < 8) continue;
                let dmin = Infinity, dmax = 0;
                for (const j of ringSet) { const d = depth[j]; if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
                if (!(dmax / dmin >= 1 + jumpTol)) continue;
                const t = Math.sqrt(dmin * dmax);
                for (const j of ringSet) {
                    if (depth[j] >= t && !seed[j]) { seed[j] = 1; seedCount++; }
                }
            }
        }
        if (seedCount === 0) {
            console.log('[Backfill] no seeds (no depth discontinuities found)');
            return null;
        }

        // ---- 1c. 襟(collar): 種から奥面に沿って有効画素を数px層へ取り込む ----
        // 種の1px鎖だけだと斜めの段差でピンホールが残り、主メッシュと完全同位置の
        // ためクラックも見え得る。奥面へ COLLAR_PX 食い込ませて重ね、層全体を
        // わずかに奥へ置く（PUSH_BASE、節6）ことで継ぎ目を主メッシュの裏に隠す。
        {
            const cdist = new Int32Array(N).fill(-1);
            let head = 0, tail = 0;
            for (let i = 0; i < N; i++) if (seed[i]) { cdist[i] = 0; queue[tail++] = i; }
            while (head < tail) {
                const i = queue[head++];
                if (cdist[i] >= COLLAR_PX) continue;
                const x = i % W, y = (i / W) | 0;
                const di = 1 / depth[i];
                for (const [dx, dy] of OFFS) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                    const j = ny * W + nx;
                    if (cdist[j] >= 0 || !validMask[j]) continue;
                    // 奥面上（種と同等かそれより奥）のみ。前景へは広げない
                    if ((1 / depth[j]) > di * (1 + jumpTol)) continue;
                    cdist[j] = cdist[i] + 1;
                    seed[j] = 1;
                    seedCount++;
                    queue[tail++] = j;
                }
            }
        }

        // ---- 2. 種からマージン付き BFS ----
        // 種の背景 disparity を伝播し、「背景より明確に手前の画素」と「穴画素」にのみ潜り込む。
        // これで背景面そのものには広がらず、前景シルエットの裏側だけが生成対象になる。
        const synth = new Uint8Array(N);
        const dist = new Int32Array(N).fill(-1);
        const bgDisp = new Float32Array(N);
        let head = 0, tail = 0, filledPx = 0;
        for (let i = 0; i < N; i++) {
            if (seed[i]) { dist[i] = 0; bgDisp[i] = 1 / depth[i]; queue[tail++] = i; }
        }
        while (head < tail) {
            const i = queue[head++];
            if (dist[i] >= marginPx) continue;
            const x = i % W, y = (i / W) | 0;
            for (const [dx, dy] of OFFS) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                const j = ny * W + nx;
                if (dist[j] >= 0) continue;
                const isHole = holeMask[j] === 1;
                const isForeground = validMask[j] === 1 &&
                    (1 / depth[j]) > bgDisp[i] * (1 + jumpTol);
                if (!isHole && !isForeground) continue;
                dist[j] = dist[i] + 1;
                bgDisp[j] = bgDisp[i];
                synth[j] = 1;
                filledPx++;
                queue[tail++] = j;
            }
        }
        if (filledPx === 0) {
            console.log('[Backfill] seeds found but nothing to fill', { seedCount });
            return null;
        }
        const synthList = [];
        for (let i = 0; i < N; i++) if (synth[i]) synthList.push(i);

        // ---- 2b. 奥側優先の深化 ----
        // bgDisp を領域内で min 拡散（Jacobi、1パス=1px）し、内部の目標深度を
        // 「最寄りの種」ではなく「近傍で最も奥の種」へ寄せる。手前の中景（茂み等）の
        // 種に引っ張られて生成面が前へ突き出すのを抑える。
        const DEEPEN_PASSES = 12;
        for (let p = 0; p < DEEPEN_PASSES; p++) {
            const prev = bgDisp.slice();
            let changed = false;
            for (const i of synthList) {
                const x = i % W, y = (i / W) | 0;
                let m = prev[i];
                for (const [dx, dy] of OFFS) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                    const j = ny * W + nx;
                    if (!synth[j] && !seed[j]) continue;
                    if (prev[j] < m) m = prev[j];
                }
                if (m < bgDisp[i]) { bgDisp[i] = m; changed = true; }
            }
            if (!changed) break;
        }

        // ---- 3. 深度の伸長 ----
        // 初期値 = 深化済み bgDisp（=近傍で最も奥のエッジの等深度延長）。
        // 種を Dirichlet とする Gauss-Seidel で滑らかに繋ぎ、各画素は反復内で
        // 「目標より手前に出ない・種の4倍より奥へ行かない」ようクランプする。
        // 平面フィトは廃止: 生成領域が繋がって1成分になると、深度の異なる種
        // （壁・机・天井）に1枚の平面が張られ、場所により手前へ飛び出すため。
        const disp = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            if (seed[i]) { disp[i] = 1 / depth[i]; continue; }
            if (synth[i]) disp[i] = bgDisp[i];
        }
        for (let it = 0; it < 40; it++) {
            const forward = (it % 2) === 0;
            for (let k = 0; k < synthList.length; k++) {
                const i = synthList[forward ? k : synthList.length - 1 - k];
                const x = i % W, y = (i / W) | 0;
                let sum = 0, cnt = 0;
                for (const [dx, dy] of OFFS) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                    const j = ny * W + nx;
                    if (!synth[j] && !seed[j]) continue;
                    sum += disp[j]; cnt++;
                }
                if (cnt === 0) continue;
                let v = sum / cnt;
                if (v > bgDisp[i]) v = bgDisp[i];              // 奥側エッジより手前に出さない
                const minDisp = bgDisp[i] * 0.25;
                if (v < minDisp) v = minDisp;                  // 外挿の暴走防止（種の4倍まで）
                disp[i] = v;
            }
        }
        // 層全体を PUSH_BASE 分、さらに種から離れるほど PUSH_BACK 分奥へ押し込む。
        // 継ぎ目は襟（1c）が主メッシュの裏に隠すため、基礎押し込みしても切れ目は見えない。
        const depthOut = new Float32Array(N);
        for (const i of synthList) {
            const t = Math.min(dist[i], RAMP_PX) / RAMP_PX;
            depthOut[i] = (1 / disp[i]) * (1 + PUSH_BASE + PUSH_BACK * t);
        }

        // ---- 5. 色の伸長: プルプッシュ + 拡散平滑化 ----
        const colorBase = resampleColor(input.color, W, H);
        const filled = pullPush(W, H, seed, colorBase);
        if (!filled) return null;
        const colorF = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const src = synth[i] ? filled : null;
            colorF[i * 3] = src ? src[i * 3] : colorBase[i * 4];
            colorF[i * 3 + 1] = src ? src[i * 3 + 1] : colorBase[i * 4 + 1];
            colorF[i * 3 + 2] = src ? src[i * 3 + 2] : colorBase[i * 4 + 2];
        }
        for (let it = 0; it < 3; it++) {
            for (const i of synthList) {
                const x = i % W, y = (i / W) | 0;
                let r = 0, g = 0, b = 0, cnt = 0;
                for (const [dx, dy] of OFFS) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                    const j = ny * W + nx;
                    if (!synth[j] && !seed[j]) continue;
                    r += colorF[j * 3]; g += colorF[j * 3 + 1]; b += colorF[j * 3 + 2]; cnt++;
                }
                if (cnt > 0) { colorF[i * 3] = r / cnt; colorF[i * 3 + 1] = g / cnt; colorF[i * 3 + 2] = b / cnt; }
            }
        }
        // 出力テクスチャ: RGB は全画素（非対象は元画像色 → シーム/バイリニアのにじみ防止）、
        // alpha=255 は生成領域 ∪ 種のみ（有効領域の判定用）
        const colorOut = new Uint8Array(N * 4);
        const layerMask = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
            colorOut[i * 4] = Math.max(0, Math.min(255, Math.round(colorF[i * 3])));
            colorOut[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(colorF[i * 3 + 1])));
            colorOut[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(colorF[i * 3 + 2])));
            layerMask[i] = (synth[i] || seed[i]) ? 1 : 0;
            colorOut[i * 4 + 3] = layerMask[i] ? 255 : 0;
        }

        // ---- 6. world position 化(既存パスを流用) ----
        // 種・襟は元 depth を PUSH_BASE 分だけ奥へ。主メッシュのすぐ裏に重なり、
        // 襟の食い込み幅の分だけ視差が付いても継ぎ目が見えない。
        const camPoints = new Float32Array(N * 3);
        const { fx, fy, cx, cy } = intrinsics;
        for (let i = 0; i < N; i++) {
            if (!layerMask[i]) continue;
            const z = seed[i] ? depth[i] * (1 + PUSH_BASE) : depthOut[i];
            const u01 = ((i % W) + 0.5) / W;
            const v01 = (((i / W) | 0) + 0.5) / H;
            camPoints[i * 3] = (u01 - cx) / fx * z;
            camPoints[i * 3 + 1] = (v01 - cy) / fy * z;
            camPoints[i * 3 + 2] = z;
        }
        const wp = WorldPos.fromCameraPoints(camPoints, W, H, layerMask, { scale: 1.0, applyMask: true });

        const stats = { seeds: seedCount, filledPx };
        console.log('[Backfill]', { ...stats, marginPx, jumpTol, size: `${W}x${H}` });
        return {
            worldPos: wp.data,
            colorTex: { data: colorOut, width: W, height: H },
            validMask: layerMask,
            width: W,
            height: H,
            stats
        };
    }

    return { generate };
})();
