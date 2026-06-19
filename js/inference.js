// inference.js — onnxruntime-web による MoGe-2 (moge-2-vitl-normal-onnx) 推論
// 出力は中間結果のみ: points(affine point map), normal, mask, metric_scale。
// 後処理(focal/shift復元・再投影・metric適用)は moge_post.js で実施する。

const Inference = (function () {
    // 利用可能なモデル（FP32, 動的形状, 可変トークン）
    // ViT-L は約1.32GB でブラウザの WASM ヒープに載らず確保失敗するため、
    // 既定はブラウザで動作する ViT-B。WebGPU 環境では ViT-L も選択可。
    const MODELS = {
        vits: {
            label: 'ViT-S (Smallest / Fastest / ~150 MB)',
            url: 'https://huggingface.co/Ruicheng/moge-2-vits-normal-onnx/resolve/main/model.onnx',
            cache: 'moge2-vits-onnx-cache-v1'
        },
        vitb: {
            label: 'ViT-B (Balanced / ~400 MB)',
            url: 'https://huggingface.co/Ruicheng/moge-2-vitb-normal-onnx/resolve/main/model.onnx',
            cache: 'moge2-vitb-onnx-cache-v1'
        },
        vitl: {
            label: 'ViT-L (Highest Quality / ~1.32 GB / WebGPU)',
            url: 'https://huggingface.co/Ruicheng/moge-2-vitl-normal-onnx/resolve/main/model.onnx',
            cache: 'moge2-vitl-onnx-cache-v1'
        }
    };
    let currentModelKey = 'vitb';

    const PATCH = 14; // DINOv2 patch size
    let session = null;
    let hasNumTokensInput = false;
    let loadedModelKey = null;
    let activeProvider = null;

    function setModel(key) {
        if (!MODELS[key]) return;
        if (key !== currentModelKey) {
            // モデル変更時は既存セッションを破棄して再ロードを促す
            if (session) { try { session.release && session.release(); } catch (e) { } }
            session = null;
            loadedModelKey = null;
            activeProvider = null;
        }
        currentModelKey = key;
    }

    // モデルバイトを Cache から取得、無ければ fetch + 進捗 + 保存
    async function fetchModelBytes(onProgress) {
        const model = MODELS[currentModelKey];
        const MODEL_URL = model.url;
        const CACHE_NAME = model.cache;
        let cache = null;
        try {
            cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(MODEL_URL);
            if (cached) {
                if (onProgress) onProgress({ phase: 'cache', ratio: 1 });
                return await cached.arrayBuffer();
            }
        } catch (e) {
            // Cache API 不可環境はそのまま fetch にフォールバック
            console.warn('Cache API unavailable:', e);
        }

        const resp = await fetch(MODEL_URL);
        if (!resp.ok) throw new Error(`Failed to download the model: HTTP ${resp.status}`);

        const total = Number(resp.headers.get('content-length')) || 0;
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (onProgress) onProgress({ phase: 'download', ratio: total ? received / total : 0, received, total });
        }
        const bytes = new Uint8Array(received);
        let pos = 0;
        for (const c of chunks) { bytes.set(c, pos); pos += c.length; }

        if (cache) {
            try {
                await cache.put(MODEL_URL, new Response(bytes.slice(0), {
                    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(received) }
                }));
            } catch (e) { console.warn('Failed to cache the model:', e); }
        }
        return bytes.buffer;
    }

    async function loadModel(onProgress) {
        if (session && loadedModelKey === currentModelKey) return session;

        // ort wasm の取得元（CDN）
        if (typeof ort !== 'undefined' && ort.env && ort.env.wasm) {
            ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
        }

        const modelBuffer = await fetchModelBytes(onProgress);

        // WebGPUはAPIの存在だけでなく、secure contextとadapter取得まで確認する。
        const tryProviders = [];
        const webgpu = await detectWebGPU();
        if (onProgress) onProgress({ phase: 'capability', provider: 'webgpu', ...webgpu });
        if (webgpu.available) tryProviders.push(['webgpu']);
        tryProviders.push(['wasm']);

        let lastErr = null;
        for (const eps of tryProviders) {
            try {
                if (onProgress) onProgress({ phase: 'session', provider: eps[0] });
                session = await ort.InferenceSession.create(modelBuffer, {
                    executionProviders: eps,
                    graphOptimizationLevel: 'all'
                });
                hasNumTokensInput = session.inputNames.includes('num_tokens');
                loadedModelKey = currentModelKey;
                activeProvider = eps[0];
                console.log('MoGe ONNX session created with EP:', eps[0], 'model:', currentModelKey, 'inputs:', session.inputNames, 'outputs:', session.outputNames);
                return session;
            } catch (e) {
                console.warn(`Execution provider ${eps[0]} failed:`, e);
                if (eps[0] === 'webgpu' && onProgress) {
                    onProgress({
                        phase: 'fallback',
                        from: 'webgpu',
                        to: 'wasm',
                        reason: e && e.message ? e.message : String(e)
                    });
                }
                session = null;
                activeProvider = null;
                lastErr = e;
            }
        }
        throw new Error('Failed to create an ONNX session: ' + (lastErr ? lastErr.message : 'unknown'));
    }

    async function detectWebGPU() {
        if (!window.isSecureContext) {
            return { available: false, reason: 'WebGPU requires HTTPS or localhost' };
        }
        if (!navigator.gpu) {
            return { available: false, reason: 'The WebGPU API is not available in this browser' };
        }
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) {
                return { available: false, reason: 'No compatible GPU adapter was found' };
            }
            return { available: true, reason: '' };
        } catch (e) {
            return {
                available: false,
                reason: e && e.message ? e.message : 'Failed to acquire a GPU adapter'
            };
        }
    }

    // imageData: ImageData (任意解像度) → NCHW Float32 [1,3,inH,inW]
    function preprocess(imageData, inW, inH) {
        // オフスクリーンで inW x inH にリサイズ
        const off = document.createElement('canvas');
        off.width = inW; off.height = inH;
        const octx = off.getContext('2d');

        // 元画像を一旦 canvas 化してから縮小描画
        const src = document.createElement('canvas');
        src.width = imageData.width; src.height = imageData.height;
        src.getContext('2d').putImageData(imageData, 0, 0);
        octx.drawImage(src, 0, 0, inW, inH);

        const resized = octx.getImageData(0, 0, inW, inH).data; // RGBA
        const out = new Float32Array(1 * 3 * inH * inW);
        const planeSize = inW * inH;
        for (let i = 0; i < planeSize; i++) {
            const r = resized[i * 4] / 255;
            const g = resized[i * 4 + 1] / 255;
            const b = resized[i * 4 + 2] / 255;
            // MoGe's DINOv2 encoder performs ImageNet normalization inside
            // the ONNX graph. The external input must remain RGB in [0, 1].
            out[i] = r;                 // R plane
            out[planeSize + i] = g;     // G plane
            out[planeSize * 2 + i] = b; // B plane
        }
        return out;
    }

    // num_tokens から ViT パッチ基準のモデル入力解像度を求める
    function computeInputSize(origW, origH, numTokens) {
        const aspect = origW / origH;
        let baseH = Math.round(Math.sqrt(numTokens / aspect));
        let baseW = Math.round(Math.sqrt(numTokens * aspect));
        baseH = Math.max(1, baseH);
        baseW = Math.max(1, baseW);
        return { inW: baseW * PATCH, inH: baseH * PATCH };
    }

    // imageData → 生の MoGe 出力
    // 戻り値: { points: Float32[inH*inW*3], normal, mask: Float32[inH*inW],
    //          metricScale: number, width: inW, height: inH }
    async function run(imageData, numTokens) {
        if (!session) throw new Error('The model is not loaded');
        numTokens = numTokens || 1800;
        const { inW, inH } = computeInputSize(imageData.width, imageData.height, numTokens);

        const inputData = preprocess(imageData, inW, inH);
        const imageTensor = new ort.Tensor('float32', inputData, [1, 3, inH, inW]);

        const feeds = {};
        feeds[session.inputNames[0]] = imageTensor; // 'image'
        if (hasNumTokensInput) {
            feeds['num_tokens'] = new ort.Tensor('int64', BigInt64Array.from([BigInt(numTokens)]), []);
        }

        const results = await session.run(feeds);

        const find = (re, fallbackIdx) => {
            let k = session.outputNames.find(n => re.test(n));
            if (!k && fallbackIdx >= 0) k = session.outputNames[fallbackIdx];
            return k ? results[k] : null;
        };

        const pointsT = find(/point/i, 0);
        const normalT = find(/normal/i, -1);
        const maskT = find(/mask/i, 2);
        const scaleT = find(/scale/i, 3);

        const toF32 = (t) => t ? (t.data instanceof Float32Array ? t.data : Float32Array.from(t.data)) : null;

        return {
            points: toF32(pointsT),
            normal: toF32(normalT),
            mask: toF32(maskT),
            metricScale: scaleT ? Number(scaleT.data[0]) : 1.0,
            width: inW,
            height: inH
        };
    }

    function getActiveProvider() {
        return activeProvider;
    }

    return { loadModel, run, preprocess, computeInputSize, setModel, getActiveProvider, MODELS };
})();
