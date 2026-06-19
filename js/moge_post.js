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

    // focal/shift を線形最小二乗で復元（legacy 版）。
    // mask があれば有効画素のみ使用。
    function recoverFocalShift(points, W, H, maskBin) {
        const { spanX, spanY } = makeUV(W, H);

        let M00 = 0, M01 = 0, M11 = 0, c0 = 0, c1 = 0;
        let count = 0;

        for (let y = 0; y < H; y++) {
            const v = spanY * (2 * y - (H - 1)) / H;
            for (let x = 0; x < W; x++) {
                const idx = y * W + x;
                if (maskBin && maskBin[idx] === 0) continue;
                const pi = idx * 3;
                const px = points[pi];
                const py = points[pi + 1];
                const pz = points[pi + 2];
                const u = spanX * (2 * x - (W - 1)) / W;

                const dotXY = px * u + py * v;        // xy·uv
                const uu = u * u + v * v;             // |uv|²
                M00 += px * px + py * py;
                M01 += -dotXY;
                M11 += uu;
                c0 += pz * dotXY;
                c1 += -pz * uu;
                count++;
            }
        }

        // 有効画素が少なすぎる場合は全画素で再計算
        if (count < 16 && maskBin) {
            return recoverFocalShift(points, W, H, null);
        }

        const e = 1e-6;
        const a = M00 + e, d = M11 + e, b = M01;
        const det = a * d - b * b;
        let focal, shift;
        if (Math.abs(det) < 1e-12) {
            focal = 1.0; shift = 0.0;
        } else {
            focal = (d * c0 - b * c1) / det;
            shift = (-b * c0 + a * c1) / det;
        }
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
