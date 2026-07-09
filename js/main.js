// main.js — 全体オーケストレーション。ドロップ受付→推論→WP→ビューア表示、UI配線。

(function () {
    // 状態
    let currentFile = null;        // 元画像 File
    let currentImageData = null;   // 元解像度 ImageData
    let currentMoge = null;        // 生 MoGe 出力 { points, normal, mask, metricScale, width, height }
    let currentPost = null;        // 後処理結果 { points, depth, mask, intrinsics, width, height }
    let currentWP = null;          // { data, width, height } (モデル解像度)
    let currentBaseName = 'mesh';
    let currentNormalMap = null;   // tangent-space RGBA8 normal map
    let currentBackfill = null;    // 遮蔽穴インペイントの第2レイヤー（Backfill.generate）
    let currentFillB = null;       // 最奥バックドロップ層（FillB.generate）
    let currentPatchedImage = null; // エッジ混色帯をパッチした表示/backfill用画像（ColorPatch）
    let currentDepthUpsampleDebug = null;
    let modelReady = false;
    let processingImage = false;
    let recomputingPost = false;
    let lastNumTokens = 1800;
    let currentModelKey = 'vitb';
    const MODEL_STORAGE_KEY = 'image-to-mesh:model';
    const SUPPORTED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp']);

    const $ = (id) => document.getElementById(id);

    function getFileExtension(name) {
        const match = String(name || '').match(/\.([^.\\\/]+)$/);
        return match ? match[1].toLowerCase() : '';
    }

    function getImageBaseName(file) {
        return (file && file.name ? file.name : 'mesh').replace(/\.[^.\\\/]+$/, '') || 'mesh';
    }

    function isSupportedImageFile(file) {
        if (!file) return false;
        const type = String(file.type || '').toLowerCase();
        if (type.startsWith('image/')) return true;
        return SUPPORTED_IMAGE_EXTENSIONS.has(getFileExtension(file.name));
    }

    function showLoading(show, text, ratio) {
        const overlay = $('loadingOverlay');
        if (show) {
            $('loadingText').textContent = text || 'Loading...';
            setProgress(text || 'Loading...', formatProgressDetail(ratio));
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
            clearProgress();
        }
    }

    function formatProgressDetail(ratio) {
        return ratio != null ? `${Math.round(ratio * 100)}%` : '';
    }

    function setProgress(title, detail) {
        const hud = $('progressHud');
        if (!hud) return;
        if (!title) {
            hud.classList.add('hidden');
            return;
        }
        $('progressTitle').textContent = title;
        $('progressDetail').textContent = detail || '';
        hud.classList.remove('hidden');
    }

    function clearProgress() {
        setProgress('', '');
    }

    window.AppProgress = {
        set: setProgress,
        clear: clearProgress
    };

    function showUI() {
        $('dropZone').classList.add('hidden');
        $('controls').style.display = 'block';
        $('sidePanel').style.display = 'block';
        $('info').style.display = 'block';
        $('meshInfo').style.display = 'block';
    }

    function setDownloadEnabled(on) {
        ['dlImage', 'dlDepth', 'dlDepthInitial', 'dlNormal', 'dlWorldPos', 'exportOBJ', 'exportGLB', 'exportPNG', 'recompute'].forEach(id => {
            $(id).disabled = !on;
        });
        if (!on) {
            $('dlBackfillWP').disabled = true;
            $('dlBackfillTex').disabled = true;
            $('dlDepthInitial').disabled = true;
        }
    }

    function isBusy() {
        return processingImage || recomputingPost;
    }

    function reportBusy() {
        console.warn('Processing is already running. Ignoring the new request.');
        alert('Processing is already running. Please wait for the current image to finish.');
    }

    // ---- 画像読み込み ----
    function readImageFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    try {
                        const width = img.naturalWidth || img.width;
                        const height = img.naturalHeight || img.height;
                        if (!width || !height) {
                            reject(new Error('The selected image has no readable pixel dimensions.'));
                            return;
                        }
                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        resolve(ctx.getImageData(0, 0, width, height));
                    } catch (err) {
                        reject(err);
                    }
                };
                img.onerror = () => reject(new Error('The selected image format could not be decoded by this browser.'));
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
            // 'sky'   : mask 除去領域を最奥の書き割り平面として残す（既定）
            // 'off'   : mask を適用せず、モデルの生の深度をそのまま使う
            // 'remove': mask 領域を除去する（穴になる）
            maskMode: $('maskMode').value,
            edgeThreshold: parseFloat($('edgeThreshold').value),
            snapWidth: parseInt($('snapWidth').value, 10),
            smallComponentMinFaces: getSmallComponentMinFaces()
        };
    }

    function getDepthUpsampleOpts() {
        return {
            enabled: $('depthUpsampleEnable').checked,
            initialMode: $('depthInitialMode').value,
            radius: parseInt($('depthUpsampleRadius').value, 10),
            sigmaSpace: parseFloat($('depthSigmaSpace').value),
            sigmaColor: parseFloat($('depthSigmaColor').value),
            sigmaDepthMeters: parseFloat($('depthSigmaDepth').value),
            treatZeroAsInvalid: $('depthTreatZeroInvalid').checked,
            invalidDepthValue: parseFloat($('depthInvalidValue').value),
            maxLongEdge: 2048
        };
    }

    function updateDepthUpsampleStatus(info) {
        const status = $('depthUpsampleStatus');
        if (!status) return;
        status.classList.remove('warning');
        status.removeAttribute('title');
        if (!info || !info.enabled) {
            status.textContent = 'Depth upsampling: off';
            return;
        }
        const sizeText = `${info.sourceWidth}x${info.sourceHeight} -> ${info.width}x${info.height}`;
        if (info.provider === 'webgpu') {
            status.textContent = `Depth: ${sizeText} (WebGPU)`;
            return;
        }
        status.classList.add('warning');
        status.textContent = `Depth: ${sizeText} (WebGPU unavailable - using initial resize fallback)`;
        if (info.warning) status.title = info.warning;
    }

    function updateDepthUpsampleLabels() {
        $('depthUpsampleRadiusValue').textContent = $('depthUpsampleRadius').value;
        $('depthSigmaSpaceValue').textContent = Number($('depthSigmaSpace').value).toFixed(1);
        $('depthSigmaColorValue').textContent = Number($('depthSigmaColor').value).toFixed(3);
        $('depthSigmaDepthValue').textContent = Number($('depthSigmaDepth').value).toFixed(2);
    }

    // 後処理 → WP → ビューア反映（推論はやり直さない、軽量）
    async function recompute(showProgress, fromProcessImage) {
        if (!currentMoge) return;
        if (recomputingPost || (processingImage && !fromProcessImage)) {
            reportBusy();
            return;
        }
        recomputingPost = true;
        try {
            if (showProgress) showLoading(true, 'Recomputing high-resolution depth...');
            setProgress('Depth: preparing post-process', 'Cleaning mask and preparing depth buffers');
            // metric scale 適用は常時。mask 適用は表示側 opts。
            const basePost = MogePost.process(currentMoge, { useMetric: true });
            setProgress('Depth: upsampling', 'Refining metric depth before mesh generation');
            currentPost = await DepthUpsampler.process(basePost, currentImageData, getDepthUpsampleOpts());
            currentDepthUpsampleDebug = currentPost.debug || null;
            updateDepthUpsampleStatus(currentPost.upsampleInfo);
            const opts = getOpts();
            setProgress('Depth: cleaning edges', `Mask ${opts.maskMode}, threshold ${opts.edgeThreshold.toFixed(4)}`);
            // エッジ画素の削除は EdgeSnap（スナップ+シーム分割）に置き換えたため、
            // cleanDepthMask は無効深度と mask の処理のみに使う（rtol=1 で削除Off）。
            // maskMode 'sky'/'remove' は mask を適用して実ジオメトリを確定し、
            // 'sky' はその後、除去された画素を最奥の書き割りで埋め戻す。
            let cleanedMask = MogePost.cleanDepthMask(
                currentPost.depth,
                currentPost.mask,
                currentPost.width,
                currentPost.height,
                1,
                opts.maskMode !== 'off'
            );
            let skyBackdropMask = null;
            if (opts.maskMode === 'sky') {
                setProgress('Depth: building sky backdrop', 'Filling sky or uncertain regions');
                skyBackdropMask = new Uint8Array(cleanedMask);
                const backdrop = MogePost.fillBackdrop(
                    currentPost.depth,
                    currentPost.points,
                    cleanedMask,
                    currentPost.intrinsics,
                    currentPost.width,
                    currentPost.height
                );
                if (backdrop) {
                    currentPost.depth = backdrop.depth;
                    currentPost.points = backdrop.points;
                    cleanedMask = backdrop.validMask;
                }
            }
            currentPost.cleanedMask = cleanedMask;
            // 深度エッジのランプ画素を両側の台地へ吸着（中間値の除去）。
            // uvSrcIndex（吸着元 index）は現在未使用（UV差し替えは廃止、
            // docs/archive/PLAN_EDGE_COLOR_HISTORY.md。将来の色パッチ用に配線は残す）。
            let uvSrcIndex = null;
            if (opts.edgeThreshold < 1) {
                setProgress('Depth: snapping edge ramps', `Snap width ${opts.snapWidth}px`);
                const snap = EdgeSnap.process({
                    depth: currentPost.depth,
                    points: currentPost.points,
                    validMask: cleanedMask,
                    width: currentPost.width,
                    height: currentPost.height
                }, { rtol: opts.edgeThreshold, maxRampPx: opts.snapWidth });
                if (snap) {
                    currentPost.depth = snap.depth;
                    currentPost.points = snap.points;
                    uvSrcIndex = snap.uvSrcIndex;
                }
            }
            setProgress('World positions', `${currentPost.width} x ${currentPost.height}`);
            currentWP = WorldPos.fromCameraPoints(
                currentPost.points,
                currentPost.width,
                currentPost.height,
                cleanedMask,
                { scale: 1.0, applyMask: true }
            );
            setProgress('Normal map', 'Computing tangent-space normals');
            currentNormalMap = NormalMap.create(
                currentPost.normal,
                currentPost.points,
                currentPost.width,
                currentPost.height,
                cleanedMask
            );
            // エッジ混色帯のテクスチャ色パッチ（docs/archive/PLAN_EDGE_COLOR_HISTORY.md A案）。
            // UV は元のまま、混色帯だけを各側の台地色で埋めた画像を表示/backfill に使う。
            // Original ダウンロードは原本ファイルのまま。
            currentPatchedImage = null;
            let colorSource = currentImageData;
            if (skyBackdropMask) {
                setProgress('Texture: filling masked color', 'Preparing display texture');
                colorSource = SkyMaskColorFill.apply({
                    image: colorSource,
                    validMask: skyBackdropMask,
                    width: currentPost.width,
                    height: currentPost.height,
                    radius: 4
                }) || colorSource;
            }
            if (opts.edgeThreshold < 1) {
                setProgress('Texture: patching edge colors', 'Reducing color fringes around cut edges');
                currentPatchedImage = ColorPatch.apply({
                    image: colorSource,
                    depth: currentPost.depth,
                    validMask: cleanedMask,
                    srcRoot: uvSrcIndex,
                    width: currentPost.width,
                    height: currentPost.height
                });
            }
            currentPatchedImage = currentPatchedImage || (colorSource !== currentImageData ? colorSource : null);
            const colorTex = colorTexFromImageData(currentPatchedImage || currentImageData);
            setProgress('Mesh: building viewer geometry', 'Creating main mesh and texture bindings');
            Viewer.setData(
                currentWP.data,
                currentWP.width,
                currentWP.height,
                colorTex,
                currentBaseName,
                currentPost.intrinsics,
                {
                    disableDepthEdgeCleanup: opts.edgeThreshold >= 1,
                    uvSrcIndex,
                    smallComponentMinFaces: opts.smallComponentMinFaces,
                    preserveCamera: !fromProcessImage
                },
                currentNormalMap
            );
            if (fromProcessImage) Viewer.startOrbitCenterHint();
            setDownloadEnabled(true);
            $('dlDepthInitial').disabled = !currentDepthUpsampleDebug;
            setProgress('Backfill: occlusion layer', $('fillOcclusion').checked ? 'Generating hidden background fill' : 'Skipped');
            updateBackfill();
            setProgress('Backfill: far backdrop', $('fillBackdropLayer').checked ? 'Generating far background layer' : 'Skipped');
            updateFillB();
        } finally {
            recomputingPost = false;
            if (showProgress) showLoading(false);
        }
    }

    function handleAsyncError(e) {
        console.error(e);
        showLoading(false);
        clearProgress();
        alert('Processing failed:\n' + (e && e.message ? e.message : e));
    }

    function requestRecompute() {
        if (isBusy()) {
            reportBusy();
            return;
        }
        recompute(true).catch(handleAsyncError);
    }

    function getFillMarginPercent() {
        return parseFloat($('fillMargin').value);
    }

    function getBackfillParallaxCutK() {
        const value = parseFloat($('backfillParallaxCut').value);
        return Number.isFinite(value) ? value : 0.5;
    }

    function getBackfillFrontClamp() {
        const value = parseFloat($('backfillFrontClamp').value);
        return Number.isFinite(value) ? value : 1.0;
    }

    function getBackfillFarClamp() {
        const value = parseFloat($('backfillFarClamp').value);
        return Number.isFinite(value) ? value : 4.0;
    }

    function getBackfillHolePreclaimPx() {
        const value = parseInt($('backfillHolePreclaim').value, 10);
        return Number.isFinite(value) ? Math.max(0, value) : 3;
    }

    function getBackfillFarPriorityPx() {
        const value = parseInt($('backfillFarPriority').value, 10);
        return Number.isFinite(value) ? Math.max(0, value) : 12;
    }

    function getSmallComponentMinFaces() {
        const value = parseInt($('smallComponentFaces').value, 10);
        return Number.isFinite(value) ? Math.max(0, value) : 64;
    }

    function getBackfillMarginPx() {
        const percent = getFillMarginPercent();
        if (!currentImageData || !currentPost) return Math.max(1, Math.round(percent));
        const sourceLong = Math.max(currentImageData.width, currentImageData.height);
        const processLong = Math.max(currentPost.width, currentPost.height);
        const sourcePx = sourceLong * percent / 100;
        return Math.max(1, Math.round(sourcePx * processLong / sourceLong));
    }

    function updateFillMarginLabel() {
        const percent = getFillMarginPercent();
        const px = currentImageData && currentPost ? ` (${getBackfillMarginPx()}px)` : '';
        $('fillMarginValue').textContent = `${percent.toFixed(1)}%${px}`;
    }

    function updateBackfillParallaxCutLabel() {
        $('backfillParallaxCutValue').textContent = `${getBackfillParallaxCutK().toFixed(2)}x`;
    }

    function updateBackfillClampLabels() {
        $('backfillFrontClampValue').textContent = `${getBackfillFrontClamp().toFixed(2)}x`;
        $('backfillFarClampValue').textContent = `${getBackfillFarClamp().toFixed(1)}x`;
    }

    function updateBackfillHolePreclaimLabel() {
        $('backfillHolePreclaimValue').textContent = String(getBackfillHolePreclaimPx());
    }

    function updateBackfillFarPriorityLabel() {
        $('backfillFarPriorityValue').textContent = String(getBackfillFarPriorityPx());
    }

    // 遮蔽穴インペイント（backfill.js）。推論・主レイヤーは再計算しない軽量パス。
    function updateBackfill() {
        if (!currentPost || !currentImageData) return;
        currentBackfill = null;
        updateFillMarginLabel();
        if ($('fillOcclusion').checked) {
            const { depth, width, height } = currentPost;
            const cleaned = currentPost.cleanedMask;
            // 埋め対象 = ジオメトリが無い全画素（エッジ切断 + mask除去 + 無効深度）。
            // 種（奥側エッジ）からマージン内に届く範囲しか埋まらないため、空などの
            // 大きな除去領域は自然に対象外になる。
            const holeMask = new Uint8Array(width * height);
            for (let i = 0; i < holeMask.length; i++) {
                holeMask[i] = cleaned[i] ? 0 : 1;
            }
            currentBackfill = Backfill.generate({
                depth,
                validMask: cleaned,
                holeMask,
                intrinsics: currentPost.intrinsics,
                // パッチ済み画像を使う: エッジの混色（手前色）が種に入らない
                color: currentPatchedImage || currentImageData,
                width,
                height
            }, {
                marginPx: getBackfillMarginPx(),
                frontDispLimit: getBackfillFrontClamp(),
                maxDepthFactor: getBackfillFarClamp(),
                holePreclaimPx: getBackfillHolePreclaimPx(),
                farPriorityPx: getBackfillFarPriorityPx()
            });
        }
        Viewer.setBackfillLayer(currentBackfill);
        $('dlBackfillWP').disabled = !currentBackfill;
        $('dlBackfillTex').disabled = !currentBackfill;
    }

    // 最奥バックドロップ層（fillb.js）。主メッシュ/backfill の穴の向こうに
    // 「最奥エンベロープ + ぼかした最奥色」の面を置く。軽量パス。
    function updateFillB() {
        if (!currentPost || !currentImageData) return;
        currentFillB = null;
        if ($('fillBackdropLayer').checked) {
            currentFillB = FillB.generate({
                depth: currentPost.depth,
                validMask: currentPost.cleanedMask,
                intrinsics: currentPost.intrinsics,
                color: currentPatchedImage || currentImageData,
                width: currentPost.width,
                height: currentPost.height
            }, {});
        }
        Viewer.setFillBLayer(currentFillB);
    }

    // ---- メイン処理: 画像 → 推論 → 表示 ----
    async function processImage(file) {
        if (isBusy()) {
            reportBusy();
            return;
        }
        processingImage = true;
        setDownloadEnabled(false);
        currentFile = file;
        currentBaseName = getImageBaseName(file);

        try {
            showLoading(true, 'Loading image...');
            setProgress('Image: loading source', file && file.name ? file.name : '');
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
            setProgress('Depth: running MoGe-2 inference', `${currentImageData.width} x ${currentImageData.height}, tokens ${getNumTokens()}`);
            lastNumTokens = getNumTokens();
            currentMoge = await Inference.run(currentImageData, lastNumTokens);

            showLoading(true, 'Computing high-resolution depth and world positions...');
            setProgress('Depth: post-processing', 'Upsample, edge cleanup, world positions, normals');
            await recompute(false, true);

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
            clearProgress();
            alert('Processing failed:\n' + (e && e.message ? e.message : e));
        } finally {
            processingImage = false;
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
        if (isBusy()) {
            reportBusy();
            return;
        }
        if (!files || files.length === 0) return;
        let imageFile = null;
        for (const f of files) {
            if (isSupportedImageFile(f)) { imageFile = f; break; }
        }
        if (!imageFile) {
            alert('Please drop a browser-supported image file such as JPG, PNG, WebP, AVIF, GIF, or BMP.');
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
        $('setOrbitCenter').addEventListener('click', Viewer.toggleOrbitCenterSelection);
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
        $('edgeThreshold').addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            const fixed4 = value.toFixed(4);
            $('edgeThresholdValue').textContent = value >= 1 ? 'Off' : (fixed4.endsWith('0') ? value.toFixed(3) : fixed4);
        });
        $('edgeThreshold').addEventListener('change', requestRecompute);
        $('snapWidth').addEventListener('input', (e) => {
            $('snapWidthValue').textContent = e.target.value;
        });
        $('snapWidth').addEventListener('change', requestRecompute);
        $('smallComponentFaces').addEventListener('change', requestRecompute);
        $('maskMode').addEventListener('change', requestRecompute);
        $('fillOcclusion').addEventListener('change', updateBackfill);
        $('fillBackdropLayer').addEventListener('change', updateFillB);
        $('fillMargin').addEventListener('input', (e) => {
            updateFillMarginLabel();
        });
        $('fillMargin').addEventListener('change', updateBackfill);
        $('backfillParallaxCut').addEventListener('input', (e) => {
            updateBackfillParallaxCutLabel();
            Viewer.setBackfillParallaxCutK(getBackfillParallaxCutK());
        });
        $('backfillFrontClamp').addEventListener('input', (e) => {
            updateBackfillClampLabels();
        });
        $('backfillFrontClamp').addEventListener('change', updateBackfill);
        $('backfillFarClamp').addEventListener('input', (e) => {
            updateBackfillClampLabels();
        });
        $('backfillFarClamp').addEventListener('change', updateBackfill);
        $('backfillHolePreclaim').addEventListener('input', (e) => {
            updateBackfillHolePreclaimLabel();
        });
        $('backfillHolePreclaim').addEventListener('change', updateBackfill);
        $('backfillFarPriority').addEventListener('input', (e) => {
            updateBackfillFarPriorityLabel();
        });
        $('backfillFarPriority').addEventListener('change', updateBackfill);
        $('recompute').addEventListener('click', () => {
            // モデル変更 or num_tokens が変わっていれば再推論、そうでなければ後処理のみ
            if ((!modelReady || getNumTokens() !== lastNumTokens) && currentImageData) {
                processImage(currentFile);
            } else {
                requestRecompute();
            }
        });
        // A full reload reliably releases ONNX/WebGPU resources and large typed
        // arrays before processing the next image. Model bytes remain cached.
        $('loadAnother').addEventListener('click', () => window.location.reload());

        // ダウンロード
        $('dlImage').addEventListener('click', () => Downloader.saveOriginal(currentFile));
        $('dlDepth').addEventListener('click', () => {
            if (!currentPost) return;
            Downloader.saveDepthEXR(currentPost.depth, currentPost.width, currentPost.height, currentBaseName);
        });
        $('dlDepthInitial').addEventListener('click', () => {
            if (!currentDepthUpsampleDebug) return;
            Downloader.saveDepthEXRAs(
                currentDepthUpsampleDebug.initialDepth,
                currentDepthUpsampleDebug.width,
                currentDepthUpsampleDebug.height,
                `${currentBaseName}_depth_initial.exr`
            );
        });
        $('dlNormal').addEventListener('click', () => {
            Downloader.saveNormalPNG(currentNormalMap, currentBaseName);
        });
        $('dlWorldPos').addEventListener('click', () => {
            if (!currentWP) return;
            const aligned = Viewer.getAlignedWorldPositions(currentWP.data);
            Downloader.saveWorldPosEXR(aligned, currentWP.width, currentWP.height, currentBaseName, true);
        });
        $('dlBackfillWP').addEventListener('click', () => {
            if (!currentBackfill) return;
            const aligned = Viewer.getAlignedWorldPositions(currentBackfill.worldPos);
            Downloader.saveWorldPosEXR(
                aligned, currentBackfill.width, currentBackfill.height,
                `${currentBaseName}_backfill`, true
            );
        });
        $('dlBackfillTex').addEventListener('click', () => {
            if (!currentBackfill) return;
            Downloader.saveTexturePNG(currentBackfill.colorTex, `${currentBaseName}_backfill.png`);
        });
        $('exportOBJ').addEventListener('click', Viewer.exportOBJ);
        $('exportGLB').addEventListener('click', Viewer.exportGLB);
        $('exportPNG').addEventListener('click', Viewer.exportPNG);

        updateDepthUpsampleLabels();
        updateFillMarginLabel();
        updateBackfillParallaxCutLabel();
        updateBackfillClampLabels();
        updateBackfillHolePreclaimLabel();
        updateBackfillFarPriorityLabel();
        Viewer.setBackfillParallaxCutK(getBackfillParallaxCutK());
        [
            'depthUpsampleEnable',
            'depthInitialMode',
            'depthTreatZeroInvalid',
            'depthInvalidValue'
        ].forEach(id => $(id).addEventListener('change', requestRecompute));
        [
            'depthUpsampleRadius',
            'depthSigmaSpace',
            'depthSigmaColor',
            'depthSigmaDepth'
        ].forEach(id => {
            $(id).addEventListener('input', updateDepthUpsampleLabels);
            $(id).addEventListener('change', requestRecompute);
        });
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
