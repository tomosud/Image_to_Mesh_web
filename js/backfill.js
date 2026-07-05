// backfill.js — 遮蔽穴インペイント（docs/archive/PLAN_INPAINT_HISTORY.md 参照）
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
        // 穴の連結成分ごとに境界有効画素を分類し、最も手前（=前景）の帯より奥の
        // 画素をすべて種に加える。幾何平均しきい値だと中景の奥面が落ちて最奥1枚に
        // 吸着したため、「最寄り帯(dmin)より jumpTol 以上奥」を全部種にする。前景帯
        // だけ除外するので手前へ突き出さず、複数の背景面がそれぞれラベル付けされる。
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
                const t = dmin * (1 + jumpTol);   // 前景帯の上限。これより奥を全部種に
                for (const j of ringSet) {
                    if (depth[j] > t && !seed[j]) { seed[j] = 1; seedCount++; }
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

        // ---- 1d. 種を背景面ごとにラベル分け ----
        // 4近傍の種を disparity(=1/depth) 比が近いもの同士で連結成分にまとめる。
        // 前景を挟んで分かれた背景（例: 空 vs 建物）は互いに非隣接なので別ラベルに
        // なり、各ラベルが独立に裏へ延長される（＝各奥側エッジからの延長）。
        // これにより「最奥1枚へ吸着」ではなく「各奥側の面をそれぞれ伸ばす」になる。
        const label = new Int32Array(N).fill(-1);
        {
            let lab = 0;
            for (let s = 0; s < N; s++) {
                if (!seed[s] || label[s] >= 0) continue;
                let head = 0, tail = 0;
                queue[tail++] = s; label[s] = lab;
                while (head < tail) {
                    const i = queue[head++];
                    const x = i % W, y = (i / W) | 0;
                    const di = 1 / depth[i];
                    for (const [dx, dy] of OFFS) {
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                        const j = ny * W + nx;
                        if (!seed[j] || label[j] >= 0) continue;
                        const dj = 1 / depth[j];
                        const hi = Math.max(di, dj), lo = Math.min(di, dj);
                        if (hi > lo * (1 + jumpTol)) continue;  // 段差は別背景面
                        label[j] = lab; queue[tail++] = j;
                    }
                }
                lab++;
            }
        }

        // 色の基準（元解像度→モデル解像度）。BFS での種色伝播に使う。
        const colorBase = resampleColor(input.color, W, H);

        // ---- 1e. 種の depth/色をロバスト化（突出画素・混色・縞の無視）----
        // エッジ直上の種は、前景との混色や EdgeSnap で吸着し切れなかった中間段差
        // （＝背景の台地より手前に突出した薄い帯）を含みやすい。これらは段差で別ラベルに
        // なり、前景に隣接するため BFS で勝ってしまい、手前へ伸びる・縞になる原因になる。
        // 各種の近傍窓で「最も奥の台地」を推定し、その台地の深度・色に置き換える:
        //   1. 窓内の有効画素の disparity から far 側(10%ile)を台地の目安 dfar とする
        //   2. dfar 近傍（disp <= dfar*(1+jumpTol)）＝台地の帯だけを集める
        //      → これで前景・突出画素・別の手前面（大 disparity）は自動的に除外される
        //   3. 帯の disparity 中央値を深度ターゲット、帯の色中央値を色にする
        // 近くに台地が無い（本当に手前の孤立背景）場合は帯＝自分自身になり元の値を保つ。
        // 種の描画ジオメトリ（節6）は主メッシュ接続のため元 depth のまま。ここでの値は
        // 「延長のターゲット深度・色」としてのみ使う。
        const ROBUST_R = 4;               // 近傍窓の半径(px)
        const ROBUST_FAR_Q = 0.10;        // 台地 disparity の目安に使う far 側パーセンタイル
        const seedDispRobust = new Float32Array(N);
        const seedColRobust = new Float32Array(N * 3);
        {
            const da = [], ra = [], ga = [], ba = [];
            const median = (arr) => { const t = arr.slice().sort((a, b) => a - b); return t[t.length >> 1]; };
            for (let s = 0; s < N; s++) {
                if (!seed[s]) continue;
                const sx = s % W, sy = (s / W) | 0;
                da.length = ra.length = ga.length = ba.length = 0;
                for (let dy = -ROBUST_R; dy <= ROBUST_R; dy++) {
                    const ny = sy + dy; if (ny < 0 || ny >= H) continue;
                    for (let dx = -ROBUST_R; dx <= ROBUST_R; dx++) {
                        const nx = sx + dx; if (nx < 0 || nx >= W) continue;
                        const j = ny * W + nx;
                        if (!validMask[j]) continue;              // 穴は対象外
                        da.push(1 / depth[j]);
                        ra.push(colorBase[j * 4]); ga.push(colorBase[j * 4 + 1]); ba.push(colorBase[j * 4 + 2]);
                    }
                }
                if (da.length === 0) {
                    seedDispRobust[s] = 1 / depth[s];
                    seedColRobust[s * 3] = colorBase[s * 4];
                    seedColRobust[s * 3 + 1] = colorBase[s * 4 + 1];
                    seedColRobust[s * 3 + 2] = colorBase[s * 4 + 2];
                    continue;
                }
                const sorted = da.slice().sort((a, b) => a - b);
                const dfar = sorted[Math.floor(sorted.length * ROBUST_FAR_Q)];
                const thr = dfar * (1 + jumpTol);            // 台地の帯（前景・突出画素を除外）
                const bd = [], br = [], bg = [], bb = [];
                for (let k = 0; k < da.length; k++) {
                    if (da[k] <= thr) { bd.push(da[k]); br.push(ra[k]); bg.push(ga[k]); bb.push(ba[k]); }
                }
                seedDispRobust[s] = median(bd);
                seedColRobust[s * 3] = median(br);
                seedColRobust[s * 3 + 1] = median(bg);
                seedColRobust[s * 3 + 2] = median(bb);
            }
        }

        // ---- 2. 種からマージン付き BFS（最寄り奥側エッジの延長を割り当て）----
        // 多源 BFS で各種から disparity・ラベル・色を同時に伝播する。各穴/前景画素は
        // 「最も近い奥側エッジ」に割り当てられ、その背景面の等深度延長になる。前景を
        // 挟んだ反対側の背景とは別ラベルなので、深度も色も混ざらない。
        const synth = new Uint8Array(N);
        const dist = new Int32Array(N).fill(-1);
        const bgDisp = new Float32Array(N);
        const colorF = new Float32Array(N * 3);
        let head = 0, tail = 0, filledPx = 0;
        for (let i = 0; i < N; i++) {
            if (!seed[i]) continue;
            dist[i] = 0;
            bgDisp[i] = seedDispRobust[i];       // 突出画素を無視した台地深度をターゲットに
            colorF[i * 3] = seedColRobust[i * 3];
            colorF[i * 3 + 1] = seedColRobust[i * 3 + 1];
            colorF[i * 3 + 2] = seedColRobust[i * 3 + 2];
            queue[tail++] = i;
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
                label[j] = label[i];
                colorF[j * 3] = colorF[i * 3];
                colorF[j * 3 + 1] = colorF[i * 3 + 1];
                colorF[j * 3 + 2] = colorF[i * 3 + 2];
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

        // ---- 2c. 残り穴を最寄りリムで閉じる（黒穴を消す・奥へ出さない）----
        // BFS の margin 外に残った holeMask 画素が黒く残ると視差で穴が見える。層(synth∪seed)
        // から holeMask 内へ「最も手前(=最大 disparity)のリム値」を伝播して閉じる。最寄りリムを
        // 採るので埋めた面が周囲より奥へ突き出さない。ラベル・色もそのリムから引き継ぐ。
        // 各画素は反復で「より手前のリム」が届けば更新する（単調増加＝収束）。
        {
            const closeList = [];
            for (let i = 0; i < N; i++) if (holeMask[i] && !seed[i] && !synth[i]) closeList.push(i);
            if (closeList.length) {
                const CLOSE_PASSES = 64;   // 穴を閉じる最大伝播距離(px)。超える巨大穴の芯は黒のまま
                for (let p = 0; p < CLOSE_PASSES; p++) {
                    let changed = false;
                    for (const i of closeList) {
                        const x = i % W, y = (i / W) | 0;
                        let best = -1, bj = -1;
                        for (const [dx, dy] of OFFS) {
                            const nx = x + dx, ny = y + dy;
                            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                            const j = ny * W + nx;
                            if (!(synth[j] || seed[j])) continue;
                            if (bgDisp[j] > best) { best = bgDisp[j]; bj = j; }
                        }
                        if (bj < 0) continue;
                        const cur = synth[i] ? bgDisp[i] : -1;
                        if (best > cur) {
                            synth[i] = 1;
                            bgDisp[i] = best;
                            label[i] = label[bj];
                            colorF[i * 3] = colorF[bj * 3];
                            colorF[i * 3 + 1] = colorF[bj * 3 + 1];
                            colorF[i * 3 + 2] = colorF[bj * 3 + 2];
                            dist[i] = RAMP_PX;   // 裏当てとして PUSH_BACK フル
                            changed = true;
                        }
                    }
                    if (!changed) break;
                }
                synthList.length = 0;
                for (let i = 0; i < N; i++) if (synth[i]) synthList.push(i);
            }
        }

        // ---- 3. 深度の伸長（同一ラベル内のみ平滑化）----
        // 初期値 = BFS で割り当てた最寄り奥側エッジの disparity（等深度延長）。
        // 同じラベル（同じ背景面）の隣接のみで Gauss-Seidel 平滑化し、別背景面とは
        // 繋がない。これにより深度の異なる背景を跨ぐ「膜」が張られない。各画素は反復
        // 内で「割り当てエッジより手前に出ない・種の4倍より奥へ行かない」でクランプ。
        const disp = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            if (seed[i]) { disp[i] = seedDispRobust[i]; continue; }  // Dirichlet も台地深度
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
                    if (label[j] !== label[i]) continue;           // 別背景面とは混ぜない
                    sum += disp[j]; cnt++;
                }
                if (cnt === 0) continue;
                let v = sum / cnt;
                if (v > bgDisp[i]) v = bgDisp[i];              // 割り当てエッジより手前に出さない
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

        // ---- 5. 色の伸長（同一ラベル内・多スケールで徐々に拡散）----
        // 初期値 = BFS で伝播した最寄り奥側エッジの中央値色（1e）。等深度延長は種色を延長
        // 方向へ平行に敷くため高周波エッジでは縞に見える。間隔を 16,8,4,2,1 と変える à-trous
        // 平滑化で「徐々に広がる」拡散をかけ、少ないパスで遠方まで均して縞を溶かす（別ラベル
        // とは混ぜない）。粗いスケールほど広く、細かいスケールで局所を整える。
        // 縞が残るなら ATROUS_PASSES を増やす。完全な除去は将来 inpainting で対応。
        const ATROUS_SCALES = [16, 8, 4, 2, 1];
        const ATROUS_PASSES = 3;
        const OFFS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (const s of ATROUS_SCALES) {
            for (let it = 0; it < ATROUS_PASSES; it++) {
                for (const i of synthList) {
                    const x = i % W, y = (i / W) | 0;
                    const li = label[i];
                    let r = colorF[i * 3], g = colorF[i * 3 + 1], b = colorF[i * 3 + 2], cnt = 1;
                    for (const [dx, dy] of OFFS8) {
                        const nx = x + dx * s, ny = y + dy * s;
                        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                        const j = ny * W + nx;
                        if (!synth[j] && !seed[j]) continue;
                        if (label[j] !== li) continue;
                        r += colorF[j * 3]; g += colorF[j * 3 + 1]; b += colorF[j * 3 + 2]; cnt++;
                    }
                    colorF[i * 3] = r / cnt; colorF[i * 3 + 1] = g / cnt; colorF[i * 3 + 2] = b / cnt;
                }
            }
        }
        // 出力テクスチャ: RGB は全画素（非対象は元画像色 → シーム/バイリニアのにじみ防止）、
        // alpha=255 は生成領域 ∪ 種のみ（有効領域の判定用）
        const colorOut = new Uint8Array(N * 4);
        const layerMask = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
            const isLayer = (synth[i] || seed[i]) ? 1 : 0;
            const r = isLayer ? colorF[i * 3] : colorBase[i * 4];
            const g = isLayer ? colorF[i * 3 + 1] : colorBase[i * 4 + 1];
            const b = isLayer ? colorF[i * 3 + 2] : colorBase[i * 4 + 2];
            colorOut[i * 4] = Math.max(0, Math.min(255, Math.round(r)));
            colorOut[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g)));
            colorOut[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b)));
            layerMask[i] = isLayer;
            colorOut[i * 4 + 3] = isLayer ? 255 : 0;
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
