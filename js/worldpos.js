// worldpos.js — depth → world position 計算
// 参照元: modules/camera_utils.py, modules/world_position.py を移植。
// 単一画像のため extrinsics は単位行列とみなし camera_to_world は恒等。

const WorldPos = (function () {

    // FOV からカメラ内部パラメータを推定（モデルは intrinsics を出力しないため）
    // fx = fy = 0.5 * W / tan(FOV/2), cx = W/2, cy = H/2
    function estimateIntrinsics(width, height, fovDeg) {
        const fovRad = fovDeg * Math.PI / 180;
        // 長辺基準で焦点距離を決める（水平/垂直で破綻しにくいよう短辺は同じfを共有）
        const f = 0.5 * Math.max(width, height) / Math.tan(fovRad / 2);
        return { fx: f, fy: f, cx: width / 2, cy: height / 2 };
    }

    // depth(Float32Array, dW*dH) → world position RGBA(Float32Array, W*H*4)
    // 戻り値の解像度は depth と同じ（dW x dH）。viewer 側で色テクスチャ解像度に補間。
    // opts: { fovDeg, scale, useMetricScale }
    function compute(depth, dW, dH, opts) {
        const fovDeg = opts.fovDeg != null ? opts.fovDeg : 60;
        const scale = opts.scale != null ? opts.scale : 1.0;
        const useMetricScale = opts.useMetricScale !== false;

        const intr = estimateIntrinsics(dW, dH, fovDeg);
        const { fx, fy, cx, cy } = intr;

        // focal メトリックスケール（参照元 _calculate_metric_depth と同思想）
        const focalScale = useMetricScale ? ((fx + fy) / 2.0) / 300.0 : 1.0;

        const out = new Float32Array(dW * dH * 4);

        for (let v = 0; v < dH; v++) {
            for (let u = 0; u < dW; u++) {
                const di = v * dW + u;
                let z = depth[di];
                if (!(z > 0) || !isFinite(z)) z = 0; // 負値/NaN クランプ
                z = z * focalScale;

                // 逆投影（screen → camera）
                let x = (u - cx) * z / fx;
                let y = (v - cy) * z / fy;

                // Houdini 化（X, Y 反転）
                x = -x;
                y = -y;

                // スケール適用
                const oi = di * 4;
                out[oi]     = x * scale;
                out[oi + 1] = y * scale;
                out[oi + 2] = z * scale;
                out[oi + 3] = 1.0;
            }
        }

        return { data: out, width: dW, height: dH, intrinsics: intr };
    }

    return { estimateIntrinsics, compute };
})();
