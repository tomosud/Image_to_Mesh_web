// moge_post.js — MoGe-2 後処理（PyTorch infer() の ONNX外ロジックを移植）
// 入力: 生の points(affine point map), mask(0..1), metric_scale
// 出力: カメラ空間メトリック point map / depth / intrinsics / 二値mask
//
// 参照: moge/model/v2.py infer(), moge/utils/geometry_numpy.py
//   - normalized_view_plane_uv, point_map_to_depth_legacy (focal/shift 線形解)

const MogePost = (function () {

    // normalized view plane uv の格子値（インライン計算）
    // span_x = aspect/√(1+aspect²), span_y = 1/√(1+aspect²)
    // u(x) = span_x*(2x-(W-1))/W, v(y) = span_y*(2y-(H-1))/H
    function makeUV(W, H) {
        const aspect = W / H;
        const sq = Math.sqrt(1 + aspect * aspect);
        const spanX = aspect / sq;
        const spanY = 1 / sq;
        return { aspect, sq, spanX, spanY };
    }

    // focal/shift を復元（MoGe-2 の solve_optimal_focal_shift 相当）。
    //   min_{shift,focal} | focal * xy / (z + shift) - uv |
    // focal は shift が決まれば閉形式: focal = Σ(xy_proj·uv) / Σ|xy_proj|²
    // 公式実装と同じく shift=0 から LM 法で最小化する。shift を正の
    // depth 範囲に事前制約すると外れ値に引っ張られるため、制約しない。
    // 高速化のため最大 64x64 点を均等サンプリングする。
    function recoverFocalShift(points, W, H, maskBin) {
        const { spanX, spanY } = makeUV(W, H);

        const us = [], vs = [], xs = [], ys = [], zs = [];
        const sampleW = Math.min(64, W);
        const sampleH = Math.min(64, H);

        for (let sy = 0; sy < sampleH; sy++) {
            const y = Math.min(H - 1, Math.round((sy + 0.5) * H / sampleH - 0.5));
            const v = spanY * (2 * y - (H - 1)) / H;
            for (let sx = 0; sx < sampleW; sx++) {
                const x = Math.min(W - 1, Math.round((sx + 0.5) * W / sampleW - 0.5));
                const idx = y * W + x;
                if (maskBin && maskBin[idx] === 0) continue;
                const pi = idx * 3;
                const px = points[pi], py = points[pi + 1], pz = points[pi + 2];
                if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
                const u = spanX * (2 * x - (W - 1)) / W;
                us.push(u); vs.push(v); xs.push(px); ys.push(py); zs.push(pz);
            }
        }

        let n = zs.length;
        // 有効画素が少なすぎる場合は全画素で再計算
        if (n < 2 && maskBin) return recoverFocalShift(points, W, H, null);
        if (n < 2) return { focal: 1.0, shift: 0.0 };

        // 与えられた shift に対する最適 focal と残差二乗和
        function evalShift(shift, keepResiduals) {
            let num = 0, den = 0;
            for (let i = 0; i < n; i++) {
                let d = zs[i] + shift;
                if (Math.abs(d) < 1e-7) d = d < 0 ? -1e-7 : 1e-7;
                const inv = 1 / d;
                const xp = xs[i] * inv, yp = ys[i] * inv;
                num += xp * us[i] + yp * vs[i];
                den += xp * xp + yp * yp;
            }
            const f = den > 1e-12 ? num / den : 1.0;
            let res = 0;
            const residuals = keepResiduals ? new Float64Array(n * 2) : null;
            for (let i = 0; i < n; i++) {
                let d = zs[i] + shift;
                if (Math.abs(d) < 1e-7) d = d < 0 ? -1e-7 : 1e-7;
                const inv = 1 / d;
                const ex = f * xs[i] * inv - us[i];
                const ey = f * ys[i] * inv - vs[i];
                res += ex * ex + ey * ey;
                if (residuals) {
                    residuals[i * 2] = ex;
                    residuals[i * 2 + 1] = ey;
                }
            }
            return { f, res, residuals };
        }

        // 1変数 Levenberg-Marquardt。数値微分には focal の再最適化も含む。
        let shift = 0.0;
        let lambda = 1e-3;
        let current = evalShift(shift, true);
        const zScale = Math.max(1e-3, Math.sqrt(zs.reduce((s, z) => s + z * z, 0) / n));

        for (let it = 0; it < 50; it++) {
            const h = 1e-4 * Math.max(zScale, Math.abs(shift), 1e-3);
            const plus = evalShift(shift + h, true).residuals;
            const minus = evalShift(shift - h, true).residuals;
            let jtj = 0, jtr = 0;
            for (let i = 0; i < current.residuals.length; i++) {
                const jac = (plus[i] - minus[i]) / (2 * h);
                jtj += jac * jac;
                jtr += jac * current.residuals[i];
            }
            if (!(jtj > 1e-12)) break;

            const delta = -jtr / (jtj + lambda * Math.max(jtj, 1));
            if (!Number.isFinite(delta)) break;
            const candidateShift = shift + delta;
            const candidate = evalShift(candidateShift, true);
            if (Number.isFinite(candidate.res) && candidate.res < current.res) {
                shift = candidateShift;
                current = candidate;
                lambda = Math.max(1e-9, lambda * 0.3);
                if (Math.abs(delta) < 1e-6 * Math.max(1, Math.abs(shift))) break;
            } else {
                lambda = Math.min(1e9, lambda * 10);
            }
        }

        let focal = current.f;
        if (!(focal > 1e-6)) focal = 1e-3;
        return { focal, shift };
    }

    // メイン後処理
    // moge: { points, normal, mask, metricScale, width, height }
    // opts: { useMetric: bool }（既定 true）
    // 戻り値: { points: Float32[H*W*3] (camera, metric), depth: Float32[H*W],
    //          mask: Uint8[H*W], intrinsics: {fx,fy,cx,cy,focal,shift}, width, height }
    function process(moge, opts) {
        opts = opts || {};
        const useMetric = opts.useMetric !== false;
        const W = moge.width, H = moge.height;
        const points = moge.points;
        const maskRaw = moge.mask;
        const metricScale = useMetric ? (moge.metricScale || 1.0) : 1.0;

        // mask 二値化
        const maskBin = new Uint8Array(W * H);
        if (maskRaw) {
            for (let i = 0; i < W * H; i++) maskBin[i] = maskRaw[i] > 0.5 ? 1 : 0;
        } else {
            maskBin.fill(1);
        }

        // focal/shift 復元
        const { focal, shift } = recoverFocalShift(points, W, H, maskRaw ? maskBin : null);

        // 正規化 intrinsics（cx=cy=0.5）
        const { aspect, sq } = makeUV(W, H);
        const fx = focal / 2 * sq / aspect;
        const fy = focal / 2 * sq;
        const cx = 0.5, cy = 0.5;

        // depth と再投影（force_projection 相当）
        const outPoints = new Float32Array(W * H * 3);
        const depth = new Float32Array(W * H);

        for (let y = 0; y < H; y++) {
            const v01 = (y + 0.5) / H;
            for (let x = 0; x < W; x++) {
                const idx = y * W + x;
                const pz = points[idx * 3 + 2];
                let z = pz + shift;
                if (!(z > 0)) {
                    // 無効深度
                    z = 0;
                    maskBin[idx] = 0;
                }
                z *= metricScale;

                const u01 = (x + 0.5) / W;
                const X = (u01 - cx) / fx * z;
                const Y = (v01 - cy) / fy * z;

                const oi = idx * 3;
                outPoints[oi] = X;
                outPoints[oi + 1] = Y;
                outPoints[oi + 2] = z;
                depth[idx] = z;
            }
        }

        // 確認用デバッグログ（厚み/スケール診断）
        let zMin = Infinity, zMax = -Infinity, valid = 0;
        for (let i = 0; i < W * H; i++) {
            if (maskBin[i] === 0) continue;
            const z = depth[i];
            if (z < zMin) zMin = z;
            if (z > zMax) zMax = z;
            valid++;
        }
        console.log('[MogePost]', {
            focal: focal.toFixed(4), shift: shift.toFixed(4),
            fx: fx.toFixed(3), fy: fy.toFixed(3),
            metricScale: metricScale.toFixed(4),
            depthMin: zMin.toFixed(4), depthMax: zMax.toFixed(4),
            depthRange: (zMax - zMin).toFixed(4),
            validPx: valid, size: `${W}x${H}`
        });

        return {
            points: outPoints,
            depth: depth,
            mask: maskBin,
            normal: moge.normal || null,
            intrinsics: { fx, fy, cx, cy, focal, shift },
            width: W,
            height: H,
            metricScale
        };
    }

    // MoGe's official mesh export removes depth-edge pixels before topology is
    // built. This browser equivalent invalidates both sides of a discontinuity,
    // so the same cleanup affects points, meshes, and all geometry exports.
    function cleanDepthMask(depth, baseMask, W, H, rtol, applyBaseMask) {
        rtol = Number.isFinite(rtol) ? Math.max(rtol, 0) : 0.04;
        const mask = new Uint8Array(W * H);
        const rejected = new Uint8Array(W * H);

        for (let i = 0; i < W * H; i++) {
            const validDepth = Number.isFinite(depth[i]) && depth[i] > 0;
            const validBase = !applyBaseMask || !baseMask || baseMask[i] !== 0;
            mask[i] = validDepth && validBase ? 1 : 0;
        }

        if (rtol >= 1) {
            let kept = 0;
            for (let i = 0; i < mask.length; i++) kept += mask[i];
            console.log('[MogePost edge cleanup]', { rtol: 'off', kept, removed: mask.length - kept, size: `${W}x${H}` });
            return mask;
        }

        // Compare each horizontal/vertical grid edge once. Diagonal checks and
        // mask erosion make silhouettes unnecessarily thick.
        const offsets = [[1, 0], [0, 1]];
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!mask[i]) continue;
                for (const [dx, dy] of offsets) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                    const j = ny * W + nx;
                    if (!mask[j]) continue;
                    const minDepth = Math.max(Math.min(depth[i], depth[j]), 1e-6);
                    const relativeJump = Math.abs(depth[i] - depth[j]) / minDepth;
                    if (relativeJump > rtol) {
                        rejected[i] = 1;
                        rejected[j] = 1;
                    }
                }
            }
        }

        let kept = 0, removed = 0;
        for (let i = 0; i < mask.length; i++) {
            if (rejected[i]) mask[i] = 0;
            if (mask[i]) kept++; else removed++;
        }
        console.log('[MogePost edge cleanup]', { rtol, kept, removed, size: `${W}x${H}` });
        return mask;
    }

    // 空の書き割り（Sky Backdrop）: mask が除去する画素（空・不確実領域・無効深度）を
    // 削除する代わりに「有効画素の最大深度×2 か 100m の大きい方」の一定Z平面として
    // レイ上に再配置する。色は元画像の UV がそのまま使われるため、遠景のマット
    // ペインティングとして違和感なく最奥に置かれる。
    // 建物等との境界の大段差は EdgeSnap + シーム分割が通常のエッジとして処理する。
    // validMask: 1=実ジオメトリ（cleanDepthMask の結果）。戻り値の validMask は全画素 1。
    function fillBackdrop(depth, points, validMask, intrinsics, W, H) {
        let maxD = 0;
        for (let i = 0; i < W * H; i++) {
            if (validMask[i] && depth[i] > maxD) maxD = depth[i];
        }
        if (!(maxD > 0)) return null; // 有効画素なし（backdrop の基準が取れない）
        const dFar = Math.max(maxD * 2, 100);

        const outDepth = Float32Array.from(depth);
        const outPoints = Float32Array.from(points);
        const outMask = new Uint8Array(W * H).fill(1);
        const { fx, fy, cx, cy } = intrinsics;
        let filled = 0;
        for (let y = 0; y < H; y++) {
            const v01 = (y + 0.5) / H;
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (validMask[i]) continue;
                const u01 = (x + 0.5) / W;
                outDepth[i] = dFar;
                outPoints[i * 3] = (u01 - cx) / fx * dFar;
                outPoints[i * 3 + 1] = (v01 - cy) / fy * dFar;
                outPoints[i * 3 + 2] = dFar;
                filled++;
            }
        }
        console.log('[MogePost backdrop]', { dFar: dFar.toFixed(2), maxValidDepth: maxD.toFixed(2), filled });
        return { depth: outDepth, points: outPoints, validMask: outMask, backdropDepth: dFar };
    }

    return { process, recoverFocalShift, cleanDepthMask, fillBackdrop };
})();
