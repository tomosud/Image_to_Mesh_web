// main.js — 全体オーケストレーション。ドロップ受付→推論→WP→ビューア表示、UI配線。

(function () {
    // 状態
    let currentFile = null;        // 元画像 File
    let currentImageData = null;   // 元解像度 ImageData
    let currentMoge = null;        // 生 MoGe 出力 { points, normal, mask, metricScale, width, height }
    let currentPost = null;        // 後処理結果 { points, depth, mask, intrinsics, width, height }
    let currentWP = null;          // { data, width, height } (モデル解像度)
    let currentBaseName = 'mesh';
    let modelReady = false;
    let lastNumTokens = 1800;
    let currentModelKey = 'vitb';
    const MODEL_STORAGE_KEY = 'image-to-mesh:model';

    const $ = (id) => document.getElementById(id);

    function showLoading(show, text, ratio) {
        const overlay = $('loadingOverlay');
        if (show) {
            $('loadingText').textContent = text || 'Loading...';
            const prog = $('loadingProgress');
            if (ratio != null) {
                prog.style.display = 'block';
                $('loadingBar').style.width = `${Math.round(ratio * 100)}%`;
            } else {
                prog.style.display = 'none';
            }
            overlay.style.display = 'flex';
        } else {
            overlay.style.display = 'none';
        }
    }

    function showUI() {
        $('dropZone').classList.add('hidden');
        $('controls').style.display = 'block';
        $('sidePanel').style.display = 'block';
        $('info').style.display = 'block';
        $('meshInfo').style.display = 'block';
    }

    function setDownloadEnabled(on) {
        ['dlImage', 'dlDepth', 'dlWorldPos', 'exportOBJ', 'exportGLB', 'exportPNG', 'recompute'].forEach(id => {
            $(id).disabled = !on;
        });
    }

    // ---- 画像読み込み ----
    function readImageFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    resolve(ctx.getImageData(0, 0, img.width, img.height));
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function colorTexFromImageData(imageData) {
        return {
            data: new Uint8Array(imageData.data),
            width: imageData.width,
            height: imageData.height
        };
    }

    function getNumTokens() { return parseInt($('numTokens').value, 10); }

    function getOpts() {
        return {
            scale: parseFloat($('scale').value),
            applyMask: $('applyMask').checked,
            edgeThreshold: parseFloat($('edgeThreshold').value)
        };
    }

    // 後処理 → WP → ビューア反映（推論はやり直さない、軽量）
    function recompute() {
        if (!currentMoge) return;
        // metric scale 適用は常時。mask 適用は表示側 opts。
        currentPost = MogePost.process(currentMoge, { useMetric: true });
        const opts = getOpts();
        const cleanedMask = MogePost.cleanDepthMask(
            currentPost.depth,
            currentPost.mask,
            currentPost.width,
            currentPost.height,
            opts.edgeThreshold,
            opts.applyMask
        );
        currentPost.cleanedMask = cleanedMask;
        currentWP = WorldPos.fromCameraPoints(
            currentPost.points,
            currentPost.width,
            currentPost.height,
            cleanedMask,
            { scale: opts.scale, applyMask: true }
        );
        const colorTex = colorTexFromImageData(currentImageData);
        Viewer.setData(
            currentWP.data,
            currentWP.width,
            currentWP.height,
            colorTex,
            currentBaseName,
            currentPost.intrinsics,
            { disableDepthEdgeCleanup: opts.edgeThreshold >= 1 }
        );
        setDownloadEnabled(true);
    }

    // ---- メイン処理: 画像 → 推論 → 表示 ----
    async function processImage(file) {
        currentFile = file;
        currentBaseName = file.name.replace(/\.(jpg|jpeg|png)$/i, '');

        try {
            showLoading(true, 'Loading image...');
            currentImageData = await readImageFile(file);

            if (!modelReady) {
                showLoading(true, 'Preparing model...', 0);
                await Inference.loadModel((p) => {
                    if (p.phase === 'download') {
                        const mb = p.total ? ` (${(p.received / 1048576).toFixed(0)}/${(p.total / 1048576).toFixed(0)}MB)` : '';
                        showLoading(true, `Downloading model...${mb}`, p.ratio);
                    } else if (p.phase === 'cache') {
                        showLoading(true, 'Loading model from cache...', 1);
                    } else if (p.phase === 'session') {
                        showLoading(true, `Initializing inference engine (${p.provider})...`);
                    } else if (p.phase === 'capability' && !p.available) {
                        console.info('WebGPU unavailable:', p.reason);
                        showLoading(true, 'WebGPU unavailable; initializing WASM...');
                    } else if (p.phase === 'fallback') {
                        console.warn('WebGPU fallback:', p.reason);
                        showLoading(true, 'WebGPU initialization failed; switching to WASM...');
                    }
                });
                modelReady = true;
            }

            showLoading(true, 'Estimating depth with MoGe-2...');
            lastNumTokens = getNumTokens();
            currentMoge = await Inference.run(currentImageData, lastNumTokens);

            showLoading(true, 'Computing world positions...');
            recompute();

            const provider = Inference.getActiveProvider();
            $('executionProvider').textContent = provider ? provider.toUpperCase() : '--';
            try {
                localStorage.setItem(MODEL_STORAGE_KEY, currentModelKey);
            } catch (e) {
                console.warn('Failed to save the model preference:', e);
            }

            showUI();
            showLoading(false);
        } catch (e) {
            console.error(e);
            showLoading(false);
            alert('Processing failed:\n' + (e && e.message ? e.message : e));
        }
    }

    // ---- ドロップ / ファイル選択 ----
    function setupDropZone() {
        const dropZone = $('dropZone');
        const fileInput = $('fileInput');

        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });
        fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

        // ウィンドウ全体でもドロップ受付（メッシュ表示後の差し替え用）
        window.addEventListener('dragover', (e) => e.preventDefault());
        window.addEventListener('drop', (e) => {
            e.preventDefault();
            if (e.target === dropZone) return;
            handleFiles(e.dataTransfer.files);
        });
    }

    function handleFiles(files) {
        if (!files || files.length === 0) return;
        let imageFile = null;
        for (const f of files) {
            if (/\.(jpg|jpeg|png)$/i.test(f.name)) { imageFile = f; break; }
        }
        if (!imageFile) {
            alert('Please drop a JPG or PNG image.');
            return;
        }
        processImage(imageFile);
    }

    // ---- コントロール配線 ----
    function setupControls() {
        $('toggleUI').addEventListener('click', () => {
            const hidden = document.body.classList.toggle('ui-hidden');
            $('toggleUI').textContent = hidden ? 'UI ON' : 'UI OFF';
            $('toggleUI').setAttribute('aria-pressed', hidden ? 'true' : 'false');
        });

        // 表示モード
        $('pointsMode').addEventListener('change', (e) => {
            const on = e.target.checked;
            $('pointSizeControl').style.display = on ? 'block' : 'none';
            $('toggleWireframe').disabled = on;
            $('disableLighting').disabled = on;
            Viewer.setPointsMode(on);
        });
        $('pointSize').addEventListener('input', (e) => {
            const px = parseFloat(e.target.value);
            $('pointSizeValue').textContent = px.toFixed(1);
            Viewer.setPointSize(px);
        });
        $('toggleWireframe').addEventListener('click', () => {
            if (Viewer.isPoints()) return;
            const wf = Viewer.toggleWireframe();
            $('toggleWireframe').textContent = wf ? 'Solid' : 'Wireframe';
        });
        $('disableLighting').addEventListener('change', (e) => {
            if (Viewer.isPoints()) return;
            Viewer.setLighting(e.target.checked);
        });
        $('disableColor').addEventListener('change', (e) => Viewer.setColorDisabled(e.target.checked));
        $('resetView').addEventListener('click', Viewer.resetCamera);
        $('adjustHorizontalGrid').addEventListener('click', Viewer.toggleHorizontalGridAdjustment);
        $('useHorizontalGrid').addEventListener('click', Viewer.useHorizontalGrid);

        $('showCaptureFrame').addEventListener('change', (e) => {
            const f = $('captureFrame');
            if (e.target.checked) f.classList.add('visible'); else f.classList.remove('visible');
        });

        // 推論パラメータ
        $('modelSelect').addEventListener('change', (e) => {
            currentModelKey = e.target.value;
            Inference.setModel(currentModelKey);
            modelReady = false; // 次回処理時に再ロード
        });
        $('numTokens').addEventListener('input', (e) => { $('numTokensValue').textContent = e.target.value; });
        $('scale').addEventListener('input', (e) => { $('scaleValue').textContent = parseFloat(e.target.value).toFixed(1); });
        $('edgeThreshold').addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            $('edgeThresholdValue').textContent = value >= 1 ? 'Off' : value.toFixed(3);
        });
        $('edgeThreshold').addEventListener('change', recompute);
        $('applyMask').addEventListener('change', recompute);
        $('recompute').addEventListener('click', () => {
            // モデル変更 or num_tokens が変わっていれば再推論、そうでなければ後処理のみ
            if ((!modelReady || getNumTokens() !== lastNumTokens) && currentImageData) {
                processImage(currentFile);
            } else {
                recompute();
            }
        });
        $('loadAnother').addEventListener('click', () => $('fileInput').click());

        // ダウンロード
        $('dlImage').addEventListener('click', () => Downloader.saveOriginal(currentFile));
        $('dlDepth').addEventListener('click', () => {
            if (!currentPost) return;
            Downloader.saveDepthEXR(currentPost.depth, currentPost.width, currentPost.height, currentBaseName);
        });
        $('dlWorldPos').addEventListener('click', () => {
            if (!currentWP) return;
            const aligned = Viewer.getAlignedWorldPositions(currentWP.data);
            Downloader.saveWorldPosEXR(aligned, currentWP.width, currentWP.height, currentBaseName, true);
        });
        $('exportOBJ').addEventListener('click', Viewer.exportOBJ);
        $('exportGLB').addEventListener('click', Viewer.exportGLB);
        $('exportPNG').addEventListener('click', Viewer.exportPNG);
    }

    function restorePreferences() {
        try {
            const savedModel = localStorage.getItem(MODEL_STORAGE_KEY);
            if (savedModel && Inference.MODELS[savedModel]) {
                currentModelKey = savedModel;
                $('modelSelect').value = savedModel;
                Inference.setModel(savedModel);
            }
        } catch (e) {
            console.warn('Failed to restore the model preference:', e);
        }
    }

    window.addEventListener('DOMContentLoaded', () => {
        Viewer.init();
        restorePreferences();
        setupDropZone();
        setupControls();
    });
})();
