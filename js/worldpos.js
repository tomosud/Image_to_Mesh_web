// worldpos.js — MoGe のカメラ空間 point map → world position(Houdini系)
// 参照元: modules/camera_utils.py convert_to_houdini_space（X,Y 反転）
// MoGe が focal/shift を復元済みのため、ここでは座標系変換とスケールのみ。

const WorldPos = (function () {

    // camPoints: Float32[H*W*3] (camera空間, X右/Y下/Z前, metric)
    // maskBin: Uint8[H*W] | null
    // opts: { scale, applyMask }
    // 戻り値: { data: Float32[H*W*4] RGBA(=XYZ+1), width, height }
    function fromCameraPoints(camPoints, W, H, maskBin, opts) {
        opts = opts || {};
        const scale = opts.scale != null ? opts.scale : 1.0;
        const applyMask = !!opts.applyMask;

        const out = new Float32Array(W * H * 4);
        for (let i = 0; i < W * H; i++) {
            const pi = i * 3;
            const oi = i * 4;

            if (applyMask && maskBin && maskBin[i] === 0) {
                out[oi] = NaN; out[oi + 1] = NaN; out[oi + 2] = NaN; out[oi + 3] = 0;
                continue;
            }

            // Houdini 化（X, Y 反転）+ スケール
            out[oi]     = -camPoints[pi] * scale;
            out[oi + 1] = -camPoints[pi + 1] * scale;
            out[oi + 2] =  camPoints[pi + 2] * scale;
            out[oi + 3] = 1.0;
        }
        return { data: out, width: W, height: H };
    }

    return { fromCameraPoints };
})();
