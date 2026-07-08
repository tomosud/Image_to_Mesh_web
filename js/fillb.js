// fillb.js — FillB: 最奥バックドロップ層
// 画面全体を覆う「最奥エンベロープ」メッシュを作る。各グリッドセルの最奥深度から
// スクリーンスペースの下側エンベロープ（min disparity）を作り、少し奥へ押し出した
// 連続グリッド（面カット無し）に、最奥側の色を強くぼかしたテクスチャを貼る。
// 主メッシュ・backfill の穴（視差で開く黒穴）の背後に常にぼけた背景色が見える。
// 主メッシュ・backfill には一切手を加えない。
//
// input: { depth: Float32[H*W](metric), validMask: Uint8[H*W],
//          intrinsics: {fx,fy,cx,cy}(正規化), color: ImageData(元解像度), width, height }
// opts:  { step, pushFactor, envelopePasses, smoothPasses, colorBlurPasses }
// 戻り値: { worldPos: Float32[gh*gw*4], colorTex, width: gw, height: gh } | null

const FillB = (function () {

    function generate(input, opts) {
        const { depth, validMask, intrinsics, color, width: W, height: H } = input;
        if (!depth || !intrinsics || !color) return null;
        const step = Math.max(2, (opts && opts.step) || 8);              // 1セル = step px
        const pushFactor = Math.max(1.0, (opts && opts.pushFactor) || 1.10);
        const envelopePasses = Math.max(1, (opts && opts.envelopePasses) ?? 4);   // 凸包近似の反復スイープ数
        const smoothPasses = Math.max(0, (opts && opts.smoothPasses) ?? 2);
        const colorBlurPasses = Math.max(0, (opts && opts.colorBlurPasses) ?? 6);

        const gw = Math.ceil(W / step), gh = Math.ceil(H / step);
        const G = gw * gh;
        const cellDisp = new Float32Array(G);   // セル内の最小 disparity（=最奥）
        const known = new Uint8Array(G);
        const cellColor = new Float32Array(G * 3);

        const src = color.data, sw = color.width, sh = color.height;

        // ---- 1. セル毎の最奥深度と、最奥側画素の平均色 ----
        for (let gy = 0; gy < gh; gy++) {
            for (let gx = 0; gx < gw; gx++) {
                const x0 = gx * step, y0 = gy * step;
                const x1 = Math.min(x0 + step, W), y1 = Math.min(y0 + step, H);
                let maxZ = 0;
                for (let y = y0; y < y1; y++) {
                    for (let x = x0; x < x1; x++) {
                        const i = y * W + x;
                        if (!validMask[i]) continue;
                        const z = depth[i];
                        if (Number.isFinite(z) && z > maxZ) maxZ = z;
                    }
                }
                const gi = gy * gw + gx;
                if (maxZ <= 0) { known[gi] = 0; continue; }
                // 最奥から相対20%以内の画素だけで色を平均（前景色を混ぜない）
                const zNearLimit = maxZ / 1.2;
                let r = 0, g = 0, b = 0, cnt = 0;
                for (let y = y0; y < y1; y++) {
                    for (let x = x0; x < x1; x++) {
                        const i = y * W + x;
                        if (!validMask[i]) continue;
                        const z = depth[i];
                        if (!Number.isFinite(z) || z < zNearLimit) continue;
                        const sx = Math.min(sw - 1, ((x + 0.5) * sw / W) | 0);
                        const sy = Math.min(sh - 1, ((y + 0.5) * sh / H) | 0);
                        const si = (sy * sw + sx) * 4;
                        r += src[si]; g += src[si + 1]; b += src[si + 2]; cnt++;
                    }
                }
                if (!cnt) { known[gi] = 0; continue; }
                known[gi] = 1;
                cellDisp[gi] = 1 / maxZ;
                cellColor[gi * 3] = r / cnt;
                cellColor[gi * 3 + 1] = g / cnt;
                cellColor[gi * 3 + 2] = b / cnt;
            }
        }

        // ---- 2. 空セル（全画素無効）を既知近傍の平均で反復充填 ----
        let unknownLeft = 0;
        for (let i = 0; i < G; i++) if (!known[i]) unknownLeft++;
        if (unknownLeft === G) return null;
        let guard = gw + gh;
        while (unknownLeft > 0 && guard-- > 0) {
            const nowKnown = new Uint8Array(known);
            for (let gy = 0; gy < gh; gy++) {
                for (let gx = 0; gx < gw; gx++) {
                    const gi = gy * gw + gx;
                    if (known[gi]) continue;
                    let d = 0, r = 0, g = 0, b = 0, cnt = 0;
                    for (let k = 0; k < 4; k++) {
                        const nx = gx + (k === 0 ? 1 : k === 1 ? -1 : 0);
                        const ny = gy + (k === 2 ? 1 : k === 3 ? -1 : 0);
                        if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
                        const ni = ny * gw + nx;
                        if (!known[ni]) continue;
                        d += cellDisp[ni];
                        r += cellColor[ni * 3]; g += cellColor[ni * 3 + 1]; b += cellColor[ni * 3 + 2];
                        cnt++;
                    }
                    if (!cnt) continue;
                    cellDisp[gi] = d / cnt;
                    cellColor[gi * 3] = r / cnt;
                    cellColor[gi * 3 + 1] = g / cnt;
                    cellColor[gi * 3 + 2] = b / cnt;
                    nowKnown[gi] = 1;
                    unknownLeft--;
                }
            }
            known.set(nowKnown);
        }

        // ---- 3. 下側凸エンベロープ（頂点群の3D凸包の奥側） ----
        // disparity(=1/z) は 3D 平面に対してスクリーン座標のアフィン関数なので、
        // (x, y, disparity) 空間の下側凸包 = カメラから見た凸包の奥側を各レイで
        // 評価したものに一致する。多スパンの中点最小化（env[i] = min(env[i],
        // (env[i-s]+env[i+s])/2) を4方向×スパン大→小で反復）で近似する。
        // 値は下げる方向にしか動かないので常に全サンプル以下（=全ジオメトリの奥）。
        // 前景に引っ張られて手前へ伸びることがない。
        const dispOrig = new Float32Array(cellDisp); // 色の帰属判定用（セル毎の最奥 disparity）
        const envDisp = cellDisp;
        {
            const spans = [];
            for (let s = 1; s < Math.max(gw, gh); s *= 2) spans.push(s);
            spans.reverse(); // 大スパン→小スパン
            const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
            for (let sweep = 0; sweep < envelopePasses; sweep++) {
                for (const s of spans) {
                    for (const [dx, dy] of DIRS) {
                        const ox = dx * s, oy = dy * s;
                        for (let gy = 0; gy < gh; gy++) {
                            const yA = gy - oy, yB = gy + oy;
                            if (yA < 0 || yA >= gh || yB < 0 || yB >= gh) continue;
                            for (let gx = 0; gx < gw; gx++) {
                                const xA = gx - ox, xB = gx + ox;
                                if (xA < 0 || xA >= gw || xB < 0 || xB >= gw) continue;
                                const mid = (envDisp[yA * gw + xA] + envDisp[yB * gw + xB]) * 0.5;
                                const gi = gy * gw + gx;
                                if (mid < envDisp[gi]) envDisp[gi] = mid;
                            }
                        }
                    }
                }
            }
            // 軽い平滑化（凸包の稜線をならす。下げ方向のみ = min(元, 平均)）
            const tmp = new Float32Array(G);
            for (let p = 0; p < smoothPasses; p++) {
                boxBlur(envDisp, tmp, gw, gh);
                for (let i = 0; i < G; i++) if (tmp[i] < envDisp[i]) envDisp[i] = tmp[i];
            }
            // pushFactor で奥へ押し出す
            for (let i = 0; i < G; i++) envDisp[i] /= pushFactor;
        }

        // ---- 4. 色: 凸包に接する（≒最奥に届く）セルの色だけを使い、前景しか無い
        // セルは近傍から充填→強めのぼかし。前景色が深い背景層に乗らないようにする。
        {
            const colorKnown = new Uint8Array(G);
            let colorUnknown = 0;
            for (let i = 0; i < G; i++) {
                // セルの最奥がエンベロープ（push 前）に disparity 比 50% 以内で近いセルのみ採用
                if (known[i] && dispOrig[i] <= envDisp[i] * pushFactor * 1.5) colorKnown[i] = 1;
                else colorUnknown++;
            }
            let guard2 = gw + gh;
            while (colorUnknown > 0 && guard2-- > 0) {
                const nowKnown = new Uint8Array(colorKnown);
                for (let gy = 0; gy < gh; gy++) {
                    for (let gx = 0; gx < gw; gx++) {
                        const gi = gy * gw + gx;
                        if (colorKnown[gi]) continue;
                        let r = 0, g = 0, b = 0, cnt = 0;
                        for (let k = 0; k < 4; k++) {
                            const nx = gx + (k === 0 ? 1 : k === 1 ? -1 : 0);
                            const ny = gy + (k === 2 ? 1 : k === 3 ? -1 : 0);
                            if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
                            const ni = ny * gw + nx;
                            if (!colorKnown[ni]) continue;
                            r += cellColor[ni * 3]; g += cellColor[ni * 3 + 1]; b += cellColor[ni * 3 + 2];
                            cnt++;
                        }
                        if (!cnt) continue;
                        cellColor[gi * 3] = r / cnt;
                        cellColor[gi * 3 + 1] = g / cnt;
                        cellColor[gi * 3 + 2] = b / cnt;
                        nowKnown[gi] = 1;
                        colorUnknown--;
                    }
                }
                colorKnown.set(nowKnown);
            }
        }

        // ---- 5. 色のぼかし ----
        let colA = cellColor, colB = new Float32Array(G * 3);
        for (let p = 0; p < colorBlurPasses; p++) {
            boxBlur3(colA, colB, gw, gh);
            const t = colA; colA = colB; colB = t;
        }
        const colorOut = new Uint8Array(G * 4);
        for (let i = 0; i < G; i++) {
            colorOut[i * 4] = Math.max(0, Math.min(255, Math.round(colA[i * 3])));
            colorOut[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(colA[i * 3 + 1])));
            colorOut[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(colA[i * 3 + 2])));
            colorOut[i * 4 + 3] = 255;
        }

        // ---- 5. world position 化（backfill と同じレイ上配置 + WorldPos 変換） ----
        const camPoints = new Float32Array(G * 3);
        const layerMask = new Uint8Array(G).fill(1);
        const { fx, fy, cx, cy } = intrinsics;
        for (let gy = 0; gy < gh; gy++) {
            for (let gx = 0; gx < gw; gx++) {
                const gi = gy * gw + gx;
                const z = 1 / Math.max(envDisp[gi], 1e-9);
                // セル中心の元画像内位置（端の欠けセルは画像内へクランプ）
                const u01 = Math.min(gx * step + step * 0.5, W - 0.5) / W;
                const v01 = Math.min(gy * step + step * 0.5, H - 0.5) / H;
                camPoints[gi * 3] = (u01 - cx) / fx * z;
                camPoints[gi * 3 + 1] = (v01 - cy) / fy * z;
                camPoints[gi * 3 + 2] = z;
            }
        }
        const wp = WorldPos.fromCameraPoints(camPoints, gw, gh, layerMask, { scale: 1.0, applyMask: true });

        console.log('[FillB]', { grid: `${gw}x${gh}`, step, pushFactor, envelopePasses, smoothPasses, colorBlurPasses });
        return {
            worldPos: wp.data,
            colorTex: { data: colorOut, width: gw, height: gh },
            width: gw,
            height: gh
        };
    }

    // 3x3 box blur（1ch）
    function boxBlur(srcArr, dstArr, w, h) {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let s = 0, cnt = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= h) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        if (nx < 0 || nx >= w) continue;
                        s += srcArr[ny * w + nx]; cnt++;
                    }
                }
                dstArr[y * w + x] = s / cnt;
            }
        }
    }

    // 3x3 box blur（RGB 3ch）
    function boxBlur3(srcArr, dstArr, w, h) {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let r = 0, g = 0, b = 0, cnt = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= h) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        if (nx < 0 || nx >= w) continue;
                        const ni = (ny * w + nx) * 3;
                        r += srcArr[ni]; g += srcArr[ni + 1]; b += srcArr[ni + 2]; cnt++;
                    }
                }
                const oi = (y * w + x) * 3;
                dstArr[oi] = r / cnt; dstArr[oi + 1] = g / cnt; dstArr[oi + 2] = b / cnt;
            }
        }
    }

    return { generate };
})();
