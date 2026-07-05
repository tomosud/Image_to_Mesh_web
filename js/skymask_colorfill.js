// Patch only the inner boundary of sky/masked color regions.
// The geometry mask is not changed; this only reduces foreground-colored
// contamination in the color texture used by Sky Backdrop and Backfill.
const SkyMaskColorFill = (function () {
    function buildSkyMask(validMask) {
        const out = new Uint8Array(validMask.length);
        for (let i = 0; i < validMask.length; i++) out[i] = validMask[i] ? 0 : 1;
        return out;
    }

    function erodeMask(mask, width, height, radius) {
        const eroded = new Uint8Array(mask.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (!mask[i]) continue;
                let keep = true;
                for (let dy = -radius; dy <= radius && keep; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= height) { keep = false; break; }
                    for (let dx = -radius; dx <= radius; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= width || !mask[yy * width + xx]) {
                            keep = false;
                            break;
                        }
                    }
                }
                eroded[i] = keep ? 1 : 0;
            }
        }
        return eroded;
    }

    function modelIndexForImagePixel(x, y, imgW, imgH, modelW, modelH) {
        const mx = Math.min(modelW - 1, Math.floor((x + 0.5) * modelW / imgW));
        const my = Math.min(modelH - 1, Math.floor((y + 0.5) * modelH / imgH));
        return my * modelW + mx;
    }

    // input: {
    //   image: ImageData | {data,width,height}
    //   validMask: Uint8Array(modelW*modelH), 1=non-sky/non-masked geometry
    //   width, height: model mask size
    //   radius: erosion radius in model pixels; default 2
    // }
    // Returns ImageData-like {data,width,height} or null when there is no target ring.
    function apply(input) {
        const image = input.image;
        const modelW = input.width;
        const modelH = input.height;
        const radius = Math.max(1, input.radius || 2);
        const skyMask = buildSkyMask(input.validMask);
        const eroded = erodeMask(skyMask, modelW, modelH, radius);

        const imgW = image.width;
        const imgH = image.height;
        const src = image.data;
        const out = new Uint8ClampedArray(src);
        const state = new Uint8Array(imgW * imgH); // 0=unchanged/source, 1=target ring, 2=inner sky seed
        let seedCount = 0;
        let targetCount = 0;

        for (let y = 0; y < imgH; y++) {
            for (let x = 0; x < imgW; x++) {
                const p = y * imgW + x;
                const mi = modelIndexForImagePixel(x, y, imgW, imgH, modelW, modelH);
                if (eroded[mi]) {
                    state[p] = 2;
                    seedCount++;
                } else if (skyMask[mi]) {
                    state[p] = 1;
                    targetCount++;
                }
            }
        }
        if (seedCount === 0 || targetCount === 0) return null;

        // Fill only the sky-mask ring from the eroded inner sky side. Non-mask
        // pixels are never read as sources and never modified.
        let pending = [];
        for (let i = 0; i < state.length; i++) if (state[i] === 1) pending.push(i);

        let filled = 0;
        const maxPasses = Math.max(imgW, imgH);
        for (let pass = 0; pass < maxPasses && pending.length; pass++) {
            const updates = [];
            const rest = [];
            for (const p of pending) {
                const x = p % imgW;
                let r = 0, g = 0, b = 0, a = 0, count = 0;
                for (let k = 0; k < 4; k++) {
                    let q = -1;
                    if (k === 0 && x + 1 < imgW) q = p + 1;
                    else if (k === 1 && x > 0) q = p - 1;
                    else if (k === 2 && p + imgW < state.length) q = p + imgW;
                    else if (k === 3 && p - imgW >= 0) q = p - imgW;
                    if (q < 0 || state[q] !== 2) continue;
                    const qi = q * 4;
                    r += out[qi];
                    g += out[qi + 1];
                    b += out[qi + 2];
                    a += out[qi + 3];
                    count++;
                }
                if (count > 0) {
                    updates.push(p, r / count, g / count, b / count, a / count);
                } else {
                    rest.push(p);
                }
            }
            if (!updates.length) break;
            for (let i = 0; i < updates.length; i += 5) {
                const p = updates[i];
                const pi = p * 4;
                out[pi] = updates[i + 1];
                out[pi + 1] = updates[i + 2];
                out[pi + 2] = updates[i + 3];
                out[pi + 3] = updates[i + 4];
                state[p] = 2;
                filled++;
            }
            pending = rest;
        }

        console.log('[SkyMaskColorFill]', {
            radius,
            seedPx: seedCount,
            targetPx: targetCount,
            filledPx: filled,
            unresolvedPx: pending.length,
            imageSize: `${imgW}x${imgH}`,
            maskSize: `${modelW}x${modelH}`
        });
        return { data: out, width: imgW, height: imgH };
    }

    return { apply };
})();
