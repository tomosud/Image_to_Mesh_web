// inference.js — onnxruntime-web による DA3METRIC-LARGE 推論
// モデルは HuggingFace CDN から実行時取得し Cache Storage に永続化。
// 入力 [1,3,280,504] (ImageNet正規化, [0,1])、出力 depth(メートル) / sky。

const Inference = (function () {
    const MODEL_URL = 'https://huggingface.co/TillBeemelmanns/Depth-Anything-V3-ONNX/resolve/main/DA3METRIC-LARGE.onnx';
    const CACHE_NAME = 'da3-onnx-cache-v1';
    const IN_W = 504;
    const IN_H = 280;
    const MEAN = [0.485, 0.456, 0.406];
    const STD = [0.229, 0.224, 0.225];

    let session = null;

    // モデルバイトを Cache から取得、無ければ fetch + 進捗 + 保存
    async function fetchModelBytes(onProgress) {
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
        if (!resp.ok) throw new Error(`モデル取得失敗: HTTP ${resp.status}`);

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
            } catch (e) { console.warn('モデルキャッシュ保存失敗:', e); }
        }
        return bytes.buffer;
    }

    async function loadModel(onProgress) {
        if (session) return session;

        // ort wasm の取得元（CDN）
        if (typeof ort !== 'undefined' && ort.env && ort.env.wasm) {
            ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
        }

        const modelBuffer = await fetchModelBytes(onProgress);

        // EP: WebGPU 優先 → WASM フォールバック
        const tryProviders = [];
        if (navigator.gpu) tryProviders.push(['webgpu']);
        tryProviders.push(['wasm']);

        let lastErr = null;
        for (const eps of tryProviders) {
            try {
                if (onProgress) onProgress({ phase: 'session', provider: eps[0] });
                session = await ort.InferenceSession.create(modelBuffer, {
                    executionProviders: eps,
                    graphOptimizationLevel: 'all'
                });
                console.log('ONNX session created with EP:', eps[0]);
                return session;
            } catch (e) {
                console.warn(`EP ${eps[0]} 失敗:`, e);
                lastErr = e;
            }
        }
        throw new Error('ONNX セッション作成に失敗: ' + (lastErr ? lastErr.message : 'unknown'));
    }

    // imageData: ImageData (任意解像度) → NCHW Float32 [1,3,280,504]
    function preprocess(imageData) {
        // オフスクリーンで 504x280 にリサイズ
        const off = document.createElement('canvas');
        off.width = IN_W; off.height = IN_H;
        const octx = off.getContext('2d');

        // 元画像を一旦 canvas 化してから縮小描画
        const src = document.createElement('canvas');
        src.width = imageData.width; src.height = imageData.height;
        src.getContext('2d').putImageData(imageData, 0, 0);
        octx.drawImage(src, 0, 0, IN_W, IN_H);

        const resized = octx.getImageData(0, 0, IN_W, IN_H).data; // RGBA
        const out = new Float32Array(1 * 3 * IN_H * IN_W);
        const planeSize = IN_W * IN_H;
        for (let i = 0; i < planeSize; i++) {
            const r = resized[i * 4] / 255;
            const g = resized[i * 4 + 1] / 255;
            const b = resized[i * 4 + 2] / 255;
            out[i] = (r - MEAN[0]) / STD[0];                 // R plane
            out[planeSize + i] = (g - MEAN[1]) / STD[1];     // G plane
            out[planeSize * 2 + i] = (b - MEAN[2]) / STD[2]; // B plane
        }
        return out;
    }

    // imageData → { depth: Float32Array(IN_W*IN_H), width: IN_W, height: IN_H }
    async function run(imageData) {
        if (!session) throw new Error('モデル未ロード');
        const inputData = preprocess(imageData);
        const inputTensor = new ort.Tensor('float32', inputData, [1, 3, IN_H, IN_W]);

        const inputName = session.inputNames[0];
        const feeds = {}; feeds[inputName] = inputTensor;

        const results = await session.run(feeds);

        // depth 出力を特定（名前に depth を含む、なければ最初の出力）
        let depthKey = session.outputNames.find(n => /depth/i.test(n));
        if (!depthKey) depthKey = session.outputNames[0];
        const depthTensor = results[depthKey];
        const depth = depthTensor.data; // Float32Array, [1,1,H,W] flattened

        return { depth: depth instanceof Float32Array ? depth : Float32Array.from(depth), width: IN_W, height: IN_H };
    }

    return { loadModel, run, preprocess, IN_W, IN_H, MODEL_URL };
})();
