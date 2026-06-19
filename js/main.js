// main.js — 全体オーケストレーション。ドロップ受付→推論→WP→ビューア表示、UI配線。

(function () {
    // 状態
    let currentFile = null;        // 元画像 File
    let currentImageData = null;   // 元解像度 ImageData
    let currentDepth = null;       // { depth, width, height } (504x280)
    let currentWP = null;          // { data, width, height, intrinsics } (元解像度)
    let currentBaseName = 'mesh';
    let modelReady = false;

    const $ = (id) => document.getElementById(id);

    function showLoading(show, text, ratio) {
        const overlay = $('loadingOverlay');
        if (show) {
            $('loadingText').textContent = text || '読み込み中...';
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
        ['dlImage', 'dlDepth', 'dlWorldPos', 'exportOBJ', 'exportPNG', 'recompute'].forEach(id => {
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

    // depth(504x280) を元画像解像度へバイリニア補間
    function upscaleDepth(depth, dW, dH, tW, tH) {
        const out = new Float32Array(tW * tH);
        for (let y = 0; y < tH; y++) {
            const sy = (y / (tH - 1)) * (dH - 1);
            const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, dH - 1);
            const fy = sy - y0;
            for (let x = 0; x < tW; x++) {
                const sx = (x / (tW - 1)) * (dW - 1);
                const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, dW - 1);
                const fx = sx - x0;
                const v00 = depth[y0 * dW + x0];
                const v10 = depth[y0 * dW + x1];
                const v01 = depth[y1 * dW + x0];
                const v11 = depth[y1 * dW + x1];
                const v0 = v00 * (1 - fx) + v10 * fx;
                const v1 = v01 * (1 - fx) + v11 * fx;
                out[y * tW + x] = v0 * (1 - fy) + v1 * fy;
            }
        }
        return out;
    }

    function getOpts() {
        return {
            fovDeg: parseFloat($('fov').value),
            scale: parseFloat($('scale').value),
            useMetricScale: $('metricScale').checked
        };
    }

    // depth → WP → ビューア反映
    function recompute() {
        if (!currentImageData || !currentDepth) return;
        const tW = currentImageData.width;
        const tH = currentImageData.height;
        const upDepth = upscaleDepth(currentDepth.depth, currentDepth.width, currentDepth.height, tW, tH);
        currentWP = WorldPos.compute(upDepth, tW, tH, getOpts());
        currentWP.upDepth = upDepth; // depth EXR 用に元解像度depthを保持

        const colorTex = colorTexFromImageData(currentImageData);
        Viewer.setData(currentWP.data, currentWP.width, currentWP.height, colorTex, currentBaseName);
        setDownloadEnabled(true);
    }

    // ---- メイン処理: 画像 → 推論 → 表示 ----
    async function processImage(file) {
        currentFile = file;
        currentBaseName = file.name.replace(/\.(jpg|jpeg|png)$/i, '');

        try {
            showLoading(true, '画像を読み込み中...');
            currentImageData = await readImageFile(file);

            if (!modelReady) {
                showLoading(true, 'モデルを準備中...', 0);
                await Inference.loadModel((p) => {
                    if (p.phase === 'download') {
                        const mb = p.total ? ` (${(p.received / 1048576).toFixed(0)}/${(p.total / 1048576).toFixed(0)}MB)` : '';
                        showLoading(true, `モデルをダウンロード中...${mb}`, p.ratio);
                    } else if (p.phase === 'cache') {
                        showLoading(true, 'キャッシュからモデル読込...', 1);
                    } else if (p.phase === 'session') {
                        showLoading(true, `推論エンジン初期化中 (${p.provider})...`);
                    }
                });
                modelReady = true;
            }

            showLoading(true, 'デプス推定中...');
            currentDepth = await Inference.run(currentImageData);

            showLoading(true, 'ワールドポジション計算中...');
            recompute();

            showUI();
            showLoading(false);
        } catch (e) {
            console.error(e);
            showLoading(false);
            alert('処理に失敗しました:\n' + (e && e.message ? e.message : e));
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
            alert('JPG / PNG 画像をドロップしてください。');
            return;
        }
        processImage(imageFile);
    }

    // ---- コントロール配線 ----
    function setupControls() {
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
            $('toggleWireframe').textContent = wf ? 'ソリッド表示' : 'ワイヤーフレーム';
        });
        $('disableLighting').addEventListener('change', (e) => {
            if (Viewer.isPoints()) return;
            Viewer.setLighting(e.target.checked);
        });
        $('disableColor').addEventListener('change', (e) => Viewer.setColorDisabled(e.target.checked));
        $('resetView').addEventListener('click', Viewer.resetCamera);

        $('showCaptureFrame').addEventListener('change', (e) => {
            const f = $('captureFrame');
            if (e.target.checked) f.classList.add('visible'); else f.classList.remove('visible');
        });

        // 推論パラメータ
        $('fov').addEventListener('input', (e) => { $('fovValue').textContent = e.target.value; });
        $('scale').addEventListener('input', (e) => { $('scaleValue').textContent = parseFloat(e.target.value).toFixed(1); });
        $('recompute').addEventListener('click', recompute);
        $('loadAnother').addEventListener('click', () => $('fileInput').click());

        // ダウンロード
        $('dlImage').addEventListener('click', () => Downloader.saveOriginal(currentFile));
        $('dlDepth').addEventListener('click', () => {
            if (!currentWP) return;
            Downloader.saveDepthEXR(currentWP.upDepth, currentWP.width, currentWP.height, currentBaseName);
        });
        $('dlWorldPos').addEventListener('click', () => {
            if (!currentWP) return;
            Downloader.saveWorldPosEXR(currentWP.data, currentWP.width, currentWP.height, currentBaseName);
        });
        $('exportOBJ').addEventListener('click', Viewer.exportOBJ);
        $('exportPNG').addEventListener('click', Viewer.exportPNG);
    }

    window.addEventListener('DOMContentLoaded', () => {
        Viewer.init();
        setupDropZone();
        setupControls();
    });
})();
