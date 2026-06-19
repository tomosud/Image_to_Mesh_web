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

    // focal/shift を復元（MoGe-2 と同じ非線形 solve_optimal_focal_shift 相当）。
    //   min_{shift,focal} | focal * xy / (z + shift) - uv |
    // focal は shift が決まれば閉形式: focal = Σ(xy_proj·uv) / Σ|xy_proj|²
    // shift は 1 次元なので、粗グリッド探索 + 黄金分割で最小化する。
    // 高速化のため ~64x64 にダウンサンプリング。mask があれば有効画素のみ。
    function recoverFocalShift(points, W, H, maskBin) {
        const { spanX, spanY } = makeUV(W, H);

        const us = [], vs = [], xs = [], ys = [], zs = [];
        const strideX = Math.max(1, Math.floor(W / 64));
        const strideY = Math.max(1, Math.floor(H / 64));
        let zmin = Infinity, zmax = -Infinity;

        for (let y = 0; y < H; y += strideY) {
            const v = spanY * (2 * y - (H - 1)) / H;
            for (let x = 0; x < W; x += strideX) {
                const idx = y * W + x;
                if (maskBin && maskBin[idx] === 0) continue;
                const pi = idx * 3;
                const px = points[pi], py = points[pi + 1], pz = points[pi + 2];
                const u = spanX * (2 * x - (W - 1)) / W;
                us.push(u); vs.push(v); xs.push(px); ys.push(py); zs.push(pz);
                if (pz < zmin) zmin = pz;
                if (pz > zmax) zmax = pz;
            }
        }

        let n = zs.length;
        // 有効画素が少なすぎる場合は全画素で再計算
        if (n < 2 && maskBin) return recoverFocalShift(points, W, H, null);
        if (n < 2) return { focal: 1.0, shift: 0.0 };

        // 与えられた shift に対する最適 focal と残差二乗和
        function evalShift(shift) {
            let num = 0, den = 0;
            for (let i = 0; i < n; i++) {
                const inv = 1 / (zs[i] + shift);
                const xp = xs[i] * inv, yp = ys[i] * inv;
                num += xp * us[i] + yp * vs[i];
                den += xp * xp + yp * yp;
            }
            const f = den > 1e-12 ? num / den : 1.0;
            let res = 0;
            for (let i = 0; i < n; i++) {
                const inv = 1 / (zs[i] + shift);
                const ex = f * xs[i] * inv - us[i];
                const ey = f * ys[i] * inv - vs[i];
                res += ex * ex + ey * ey;
            }
            return { f, res };
        }

        // shift の探索範囲: z + shift > 0 を満たす範囲。中心 0 付近。
        const span = Math.max(zmax - zmin, Math.abs(zmax), 1e-3);
        const lo = -zmin + 1e-4;        // 下限（最小 z でも正を保つ）
        const hi = lo + 2 * span;       // 上限

        // 粗グリッド探索で最小付近を特定
        const GRID = 64;
        let bestS = lo, bestRes = Infinity;
        for (let i = 0; i <= GRID; i++) {
            const s = lo + (hi - lo) * (i / GRID);
            const r = evalShift(s).res;
            if (r < bestRes) { bestRes = r; bestS = s; }
        }

        // 黄金分割で精緻化
        let a = Math.max(lo, bestS - (hi - lo) / GRID);
        let b = Math.min(hi, bestS + (hi - lo) / GRID);
        const gr = (Math.sqrt(5) - 1) / 2;
        let c = b - gr * (b - a);
        let d = a + gr * (b - a);
        let fc = evalShift(c).res;
        let fd = evalShift(d).res;
        for (let it = 0; it < 60 && (b - a) > 1e-7; it++) {
            if (fc < fd) {
                b = d; d = c; fd = fc;
                c = b - gr * (b - a); fc = evalShift(c).res;
            } else {
                a = c; c = d; fc = fd;
                d = a + gr * (b - a); fd = evalShift(d).res;
            }
        }
        const shift = (a + b) / 2;
        let focal = evalShift(shift).f;
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

    return { process, recoverFocalShift };
})();
