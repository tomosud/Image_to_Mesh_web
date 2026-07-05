// RGB-guided metric depth upsampling.
// Keeps depth in float32 meters and uses WebGPU compute when available.
const DepthUpsampler = (function () {
    const DEFAULTS = {
        enabled: true,
        maxLongEdge: 2048,
        initialMode: 'bilinear',
        radius: 3,
        sigmaSpace: 2.0,
        sigmaColor: 0.08,
        sigmaDepthMeters: 0.15,
        invalidDepthValue: -1.0,
        treatZeroAsInvalid: true
    };

    let cachedDevicePromise = null;
    let cachedPipeline = null;

    const shaderCode = `
struct Params {
    width: u32,
    height: u32,
    radius: u32,
    treatZeroAsInvalid: u32,
    sigmaSpace: f32,
    sigmaColor: f32,
    sigmaDepthMeters: f32,
    invalidDepthValue: f32,
};

@group(0) @binding(0) var<storage, read> guideRgb: array<u32>;
@group(0) @binding(1) var<storage, read> inputDepth: array<f32>;
@group(0) @binding(2) var<storage, read_write> outputDepth: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

fn unpackRgb(packed: u32) -> vec3<f32> {
    let r = f32(packed & 255u) / 255.0;
    let g = f32((packed >> 8u) & 255u) / 255.0;
    let b = f32((packed >> 16u) & 255u) / 255.0;
    return vec3<f32>(r, g, b);
}

fn invalidDepth(d: f32) -> bool {
    if (d != d || abs(d) > 3.402823e38 || d < 0.0) {
        return true;
    }
    if (params.treatZeroAsInvalid != 0u && abs(d) < 0.0000001) {
        return true;
    }
    if (params.invalidDepthValue == params.invalidDepthValue &&
        abs(params.invalidDepthValue) < 3.402823e38 &&
        abs(d - params.invalidDepthValue) < 0.000001) {
        return true;
    }
    return false;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.width || gid.y >= params.height) {
        return;
    }

    let x = i32(gid.x);
    let y = i32(gid.y);
    let w = i32(params.width);
    let h = i32(params.height);
    let idx = u32(y * w + x);
    let centerDepth = inputDepth[idx];

    if (invalidDepth(centerDepth)) {
        outputDepth[idx] = centerDepth;
        return;
    }

    let centerRgb = unpackRgb(guideRgb[idx]);
    let radius = i32(params.radius);
    let sigmaSpace2 = max(params.sigmaSpace * params.sigmaSpace * 2.0, 0.000001);
    let sigmaColor2 = max(params.sigmaColor * params.sigmaColor * 2.0, 0.000001);
    let sigmaDepth2 = max(params.sigmaDepthMeters * params.sigmaDepthMeters * 2.0, 0.000001);
    var weightedSum = 0.0;
    var weightSum = 0.0;

    for (var dy = -radius; dy <= radius; dy = dy + 1) {
        let sy = y + dy;
        if (sy < 0 || sy >= h) {
            continue;
        }
        for (var dx = -radius; dx <= radius; dx = dx + 1) {
            let sx = x + dx;
            if (sx < 0 || sx >= w) {
                continue;
            }
            let sidx = u32(sy * w + sx);
            let sampleDepth = inputDepth[sidx];
            if (invalidDepth(sampleDepth)) {
                continue;
            }

            let sampleRgb = unpackRgb(guideRgb[sidx]);
            let spatialD2 = f32(dx * dx + dy * dy);
            let rgbDelta = centerRgb - sampleRgb;
            let colorD2 = dot(rgbDelta, rgbDelta);
            let depthDelta = centerDepth - sampleDepth;
            let depthD2 = depthDelta * depthDelta;
            let weight =
                exp(-spatialD2 / sigmaSpace2) *
                exp(-colorD2 / sigmaColor2) *
                exp(-depthD2 / sigmaDepth2);
            weightedSum = weightedSum + weight * sampleDepth;
            weightSum = weightSum + weight;
        }
    }

    if (weightSum > 0.0) {
        outputDepth[idx] = weightedSum / weightSum;
    } else {
        outputDepth[idx] = centerDepth;
    }
}
`;

    function getOptions(opts) {
        return { ...DEFAULTS, ...(opts || {}) };
    }

    function targetSize(imageWidth, imageHeight, maxLongEdge) {
        const maxEdge = Math.max(1, maxLongEdge || DEFAULTS.maxLongEdge);
        const scale = Math.min(1, maxEdge / Math.max(imageWidth, imageHeight));
        return {
            width: Math.max(1, Math.round(imageWidth * scale)),
            height: Math.max(1, Math.round(imageHeight * scale))
        };
    }

    function isInvalidDepth(value, maskValue, opts) {
        if (maskValue === 0) return true;
        if (!Number.isFinite(value) || value < 0) return true;
        if (opts.treatZeroAsInvalid && Math.abs(value) < 1e-7) return true;
        if (Number.isFinite(opts.invalidDepthValue) && Math.abs(value - opts.invalidDepthValue) < 1e-6) return true;
        return false;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function nearestIndex(x, y, srcW, srcH, dstW, dstH) {
        const sx = clamp(Math.floor((x + 0.5) * srcW / dstW), 0, srcW - 1);
        const sy = clamp(Math.floor((y + 0.5) * srcH / dstH), 0, srcH - 1);
        return sy * srcW + sx;
    }

    function resampleDepthAndMask(depth, mask, srcW, srcH, dstW, dstH, opts) {
        const outDepth = new Float32Array(dstW * dstH);
        const outMask = new Uint8Array(dstW * dstH);
        const mode = opts.initialMode === 'nearest' ? 'nearest' : 'bilinear';

        for (let y = 0; y < dstH; y++) {
            const srcY = (y + 0.5) * srcH / dstH - 0.5;
            const y0 = clamp(Math.floor(srcY), 0, srcH - 1);
            const y1 = clamp(y0 + 1, 0, srcH - 1);
            const wy = clamp(srcY - y0, 0, 1);
            for (let x = 0; x < dstW; x++) {
                const outIndex = y * dstW + x;
                const ni = nearestIndex(x, y, srcW, srcH, dstW, dstH);
                const nearestMask = mask ? mask[ni] : 1;
                if (isInvalidDepth(depth[ni], nearestMask, opts)) {
                    outDepth[outIndex] = 0;
                    outMask[outIndex] = 0;
                    continue;
                }

                if (mode === 'nearest') {
                    outDepth[outIndex] = depth[ni];
                    outMask[outIndex] = 1;
                    continue;
                }

                const srcX = (x + 0.5) * srcW / dstW - 0.5;
                const x0 = clamp(Math.floor(srcX), 0, srcW - 1);
                const x1 = clamp(x0 + 1, 0, srcW - 1);
                const wx = clamp(srcX - x0, 0, 1);
                const samples = [
                    [x0, y0, (1 - wx) * (1 - wy)],
                    [x1, y0, wx * (1 - wy)],
                    [x0, y1, (1 - wx) * wy],
                    [x1, y1, wx * wy]
                ];
                let sum = 0;
                let weightSum = 0;
                for (const [sx, sy, weight] of samples) {
                    const si = sy * srcW + sx;
                    const sampleMask = mask ? mask[si] : 1;
                    if (isInvalidDepth(depth[si], sampleMask, opts)) continue;
                    sum += depth[si] * weight;
                    weightSum += weight;
                }
                outDepth[outIndex] = weightSum > 0 ? sum / weightSum : depth[ni];
                outMask[outIndex] = 1;
            }
        }

        return { depth: outDepth, mask: outMask };
    }

    function resizeGuide(imageData, width, height) {
        const source = document.createElement('canvas');
        source.width = imageData.width;
        source.height = imageData.height;
        source.getContext('2d').putImageData(imageData, 0, 0);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(source, 0, 0, width, height);
        const pixels = ctx.getImageData(0, 0, width, height).data;
        const packed = new Uint32Array(width * height);
        for (let i = 0; i < packed.length; i++) {
            const pi = i * 4;
            packed[i] = (
                pixels[pi] |
                (pixels[pi + 1] << 8) |
                (pixels[pi + 2] << 16) |
                (pixels[pi + 3] << 24)
            ) >>> 0;
        }
        return { pixels: new Uint8Array(pixels), packed, width, height };
    }

    function resampleNormals(normals, srcW, srcH, dstW, dstH) {
        if (!normals || normals.length < srcW * srcH * 3) return null;
        const out = new Float32Array(dstW * dstH * 3);
        for (let y = 0; y < dstH; y++) {
            const srcY = (y + 0.5) * srcH / dstH - 0.5;
            const y0 = clamp(Math.floor(srcY), 0, srcH - 1);
            const y1 = clamp(y0 + 1, 0, srcH - 1);
            const wy = clamp(srcY - y0, 0, 1);
            for (let x = 0; x < dstW; x++) {
                const srcX = (x + 0.5) * srcW / dstW - 0.5;
                const x0 = clamp(Math.floor(srcX), 0, srcW - 1);
                const x1 = clamp(x0 + 1, 0, srcW - 1);
                const wx = clamp(srcX - x0, 0, 1);
                const weights = [
                    [x0, y0, (1 - wx) * (1 - wy)],
                    [x1, y0, wx * (1 - wy)],
                    [x0, y1, (1 - wx) * wy],
                    [x1, y1, wx * wy]
                ];
                let nx = 0, ny = 0, nz = 0;
                for (const [sx, sy, weight] of weights) {
                    const si = (sy * srcW + sx) * 3;
                    nx += normals[si] * weight;
                    ny += normals[si + 1] * weight;
                    nz += normals[si + 2] * weight;
                }
                const len = Math.hypot(nx, ny, nz);
                const oi = (y * dstW + x) * 3;
                if (len > 1e-8) {
                    out[oi] = nx / len;
                    out[oi + 1] = ny / len;
                    out[oi + 2] = nz / len;
                } else {
                    out[oi + 2] = 1;
                }
            }
        }
        return out;
    }

    function intrinsicsForSize(intrinsics, width, height) {
        if (!intrinsics) return null;
        if (Number.isFinite(intrinsics.focal) && intrinsics.focal > 0) {
            const aspect = width / height;
            const sq = Math.sqrt(1 + aspect * aspect);
            return {
                ...intrinsics,
                fx: intrinsics.focal / 2 * sq / aspect,
                fy: intrinsics.focal / 2 * sq,
                cx: intrinsics.cx == null ? 0.5 : intrinsics.cx,
                cy: intrinsics.cy == null ? 0.5 : intrinsics.cy
            };
        }
        return { ...intrinsics };
    }

    function projectDepthToPoints(depth, mask, width, height, intrinsics) {
        const out = new Float32Array(width * height * 3);
        const fx = intrinsics && intrinsics.fx ? intrinsics.fx : 1;
        const fy = intrinsics && intrinsics.fy ? intrinsics.fy : 1;
        const cx = intrinsics && intrinsics.cx != null ? intrinsics.cx : 0.5;
        const cy = intrinsics && intrinsics.cy != null ? intrinsics.cy : 0.5;
        for (let y = 0; y < height; y++) {
            const v01 = (y + 0.5) / height;
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (mask && mask[i] === 0) continue;
                const z = depth[i];
                if (!Number.isFinite(z) || z <= 0) continue;
                const u01 = (x + 0.5) / width;
                const oi = i * 3;
                out[oi] = (u01 - cx) / fx * z;
                out[oi + 1] = (v01 - cy) / fy * z;
                out[oi + 2] = z;
            }
        }
        return out;
    }

    async function getDevice() {
        if (!window.isSecureContext || !navigator.gpu) {
            throw new Error('WebGPU is unavailable in this browser/context');
        }
        if (!cachedDevicePromise) {
            cachedDevicePromise = (async () => {
                const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
                if (!adapter) throw new Error('No WebGPU adapter was found');
                const device = await adapter.requestDevice();
                device.lost.then((info) => {
                    console.warn('Depth upsample WebGPU device lost:', info);
                    cachedDevicePromise = null;
                    cachedPipeline = null;
                });
                return device;
            })();
        }
        return cachedDevicePromise;
    }

    function createStorageBuffer(device, typedArray) {
        const buffer = device.createBuffer({
            size: typedArray.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(buffer, 0, typedArray);
        return buffer;
    }

    function writeUniforms(device, opts, width, height) {
        const uniformBytes = new ArrayBuffer(32);
        const u32 = new Uint32Array(uniformBytes);
        const f32 = new Float32Array(uniformBytes);
        u32[0] = width;
        u32[1] = height;
        u32[2] = Math.max(0, Math.min(16, opts.radius | 0));
        u32[3] = opts.treatZeroAsInvalid ? 1 : 0;
        f32[4] = Math.max(0.001, Number(opts.sigmaSpace) || DEFAULTS.sigmaSpace);
        f32[5] = Math.max(0.0001, Number(opts.sigmaColor) || DEFAULTS.sigmaColor);
        f32[6] = Math.max(0.0001, Number(opts.sigmaDepthMeters) || DEFAULTS.sigmaDepthMeters);
        f32[7] = Number.isFinite(opts.invalidDepthValue) ? opts.invalidDepthValue : DEFAULTS.invalidDepthValue;

        const buffer = device.createBuffer({
            size: uniformBytes.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(buffer, 0, uniformBytes);
        return buffer;
    }

    async function filterWebGPU(initialDepth, guidePacked, width, height, opts) {
        const device = await getDevice();
        if (!cachedPipeline) {
            cachedPipeline = device.createComputePipeline({
                layout: 'auto',
                compute: {
                    module: device.createShaderModule({ code: shaderCode }),
                    entryPoint: 'main'
                }
            });
        }

        const guideBuffer = createStorageBuffer(device, guidePacked);
        const inputBuffer = createStorageBuffer(device, initialDepth);
        const outputBuffer = device.createBuffer({
            size: initialDepth.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        const uniformBuffer = writeUniforms(device, opts, width, height);
        const readBuffer = device.createBuffer({
            size: initialDepth.byteLength,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const bindGroup = device.createBindGroup({
            layout: cachedPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: guideBuffer } },
                { binding: 1, resource: { buffer: inputBuffer } },
                { binding: 2, resource: { buffer: outputBuffer } },
                { binding: 3, resource: { buffer: uniformBuffer } }
            ]
        });

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(cachedPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, initialDepth.byteLength);
        device.queue.submit([encoder.finish()]);

        await readBuffer.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(readBuffer.getMappedRange()).slice();
        readBuffer.unmap();

        guideBuffer.destroy();
        inputBuffer.destroy();
        outputBuffer.destroy();
        uniformBuffer.destroy();
        readBuffer.destroy();

        return result;
    }

    async function process(post, imageData, opts) {
        const options = getOptions(opts);
        if (!options.enabled || !post || !imageData) {
            return {
                ...post,
                upsampleInfo: { enabled: false, provider: 'disabled', width: post.width, height: post.height },
                debug: null
            };
        }

        const target = targetSize(imageData.width, imageData.height, options.maxLongEdge);
        const initial = resampleDepthAndMask(
            post.depth,
            post.mask,
            post.width,
            post.height,
            target.width,
            target.height,
            options
        );
        const guide = resizeGuide(imageData, target.width, target.height);

        let filteredDepth = initial.depth;
        let provider = 'initial-only';
        let warning = '';
        try {
            filteredDepth = await filterWebGPU(initial.depth, guide.packed, target.width, target.height, options);
            provider = 'webgpu';
        } catch (e) {
            warning = e && e.message ? e.message : String(e);
            console.warn('[DepthUpsampler] WebGPU filter unavailable; using initial resized depth only:', e);
        }

        for (let i = 0; i < filteredDepth.length; i++) {
            if (!initial.mask[i]) filteredDepth[i] = 0;
        }

        const intrinsics = intrinsicsForSize(post.intrinsics, target.width, target.height);
        const points = projectDepthToPoints(filteredDepth, initial.mask, target.width, target.height, intrinsics);
        const normal = resampleNormals(post.normal, post.width, post.height, target.width, target.height);
        const info = {
            enabled: true,
            provider,
            warning,
            initialMode: options.initialMode,
            width: target.width,
            height: target.height,
            sourceWidth: post.width,
            sourceHeight: post.height,
            imageWidth: imageData.width,
            imageHeight: imageData.height
        };
        console.log('[DepthUpsampler]', info);

        return {
            ...post,
            points,
            depth: filteredDepth,
            mask: initial.mask,
            normal,
            intrinsics,
            width: target.width,
            height: target.height,
            upsampleInfo: info,
            debug: {
                initialDepth: initial.depth,
                finalDepth: filteredDepth,
                guideRgb: guide.pixels,
                width: target.width,
                height: target.height,
                info
            }
        };
    }

    return { process, targetSize };
})();
