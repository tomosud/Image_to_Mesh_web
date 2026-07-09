// viewer.js — three.js World Position メッシュビューア
// 参照元 viewer/js/main.js を移植し、ドロップ非依存の API (Viewer.setData) に再構成。

const Viewer = (function () {
    let scene, camera, renderer, controls;
    let mesh, pointsMesh;
    let currentWorldPosData = null;   // { data: Float32Array(H*W*4) RGBA=XYZ+1, width, height }
    let currentColorTexture = null;   // { data: Uint8Array RGBA, width, height }
    let currentTextureObject = null;  // THREE.DataTexture cache
    let currentNormalTexture = null;  // { data: Uint8Array RGBA, width, height }
    let currentNormalTextureObject = null;
    let currentBackfillLayer = null;  // Backfill.generate() の戻り値
    let backfillMesh = null;          // THREE.Mesh | THREE.Points
    let backfillTextureObject = null;
    let backfillParallaxCutK = 0.5;
    let currentFillBLayer = null;     // FillB.generate() の戻り値（最奥バックドロップ）
    let fillBMesh = null;
    let fillBTextureObject = null;
    let currentBaseName = '';
    let currentIntrinsics = null;     // normalized { fx, fy, cx, cy }
    let currentViewerOptions = {};
    let raycaster, pointerNdc, selectionMarkers;
    let selectionMarkerTexture = null;
    let orbitPlaneGrid = null;
    let orbitPlaneUpArrow = null;
    let orbitPlanePoints = [];
    let orbitPlaneSelectionActive = false;
    let orbitPlaneAdjustmentOpen = false;
    let orbitCenterSelectionActive = false;
    let activeOrbitPlane = null;
    let pendingOrbitPlane = null;
    let pointerDownPosition = null;
    const movementKeys = new Set();
    let lastFrameTime = 0;

    let isWireframeMode = false;
    let isPointsMode = false;
    let pointSize = 2.0;
    let disableLighting = true;
    let disableColor = false;
    let initialized = false;

    function init() {
        if (initialized) return;
        const canvas = document.getElementById('canvas');

        scene = new THREE.Scene();
        scene.background = null;

        camera = new THREE.PerspectiveCamera(
            60, window.innerWidth / window.innerHeight, 0.1, 1000
        );
        camera.position.set(0, 5, 10);

        renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            antialias: true,
            alpha: true,
            preserveDrawingBuffer: true
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0x000000, 0);
        renderer.outputEncoding = THREE.sRGBEncoding;

        createOrbitControls(new THREE.Vector3(), false);

        raycaster = new THREE.Raycaster();
        pointerNdc = new THREE.Vector2();
        selectionMarkers = new THREE.Group();
        scene.add(selectionMarkers);
        canvas.addEventListener('mousedown', onMayaMouseGate, true);
        canvas.addEventListener('contextmenu', (event) => event.preventDefault());
        canvas.addEventListener('pointerdown', onSelectionPointerDown);
        canvas.addEventListener('pointerup', onSelectionPointerUp);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', () => movementKeys.clear());

        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const d1 = new THREE.DirectionalLight(0xffffff, 0.8);
        d1.position.set(5, 10, 7.5);
        scene.add(d1);
        const d2 = new THREE.DirectionalLight(0x8888ff, 0.4);
        d2.position.set(-5, 5, -5);
        scene.add(d2);

        window.addEventListener('resize', onWindowResize, false);
        animate();
        initialized = true;
    }

    function animate() {
        requestAnimationFrame(animate);
        updateKeyboardMovement();
        if (controls) controls.update();
        if (renderer) renderer.render(scene, camera);
    }

    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    function isTypingTarget() {
        const el = document.activeElement;
        return el && (
            el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
        );
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            if (orbitCenterSelectionActive) cancelOrbitCenterSelection();
            if (orbitPlaneAdjustmentOpen) cancelOrbitPlaneAdjustment(true);
            movementKeys.clear();
            return;
        }

        if ((event.key === 'f' || event.key === 'F') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            if (!isTypingTarget()) {
                event.preventDefault();
                toggleOrbitCenterSelection();
            }
            return;
        }

        if (isTypingTarget() || event.altKey || event.metaKey) return;
        const key = normalizeMovementKey(event);
        if (!key) return;
        event.preventDefault();
        movementKeys.add(key);
    }

    function onKeyUp(event) {
        const key = normalizeMovementKey(event);
        if (key) movementKeys.delete(key);
    }

    function normalizeMovementKey(event) {
        if (event.code === 'KeyW') return 'w';
        if (event.code === 'KeyA') return 'a';
        if (event.code === 'KeyS') return 's';
        if (event.code === 'KeyD') return 'd';
        if (event.key === 'Shift') return 'up';
        if (event.key === 'Control') return 'down';
        return null;
    }

    function updateKeyboardMovement() {
        const now = performance.now();
        if (!lastFrameTime) { lastFrameTime = now; return; }
        const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
        lastFrameTime = now;
        if (!movementKeys.size || !camera || !controls) return;
        if (isTypingTarget()) { movementKeys.clear(); return; }

        const move = new THREE.Vector3();
        const viewDir = controls.target.clone().sub(camera.position);
        const distance = Math.max(viewDir.length(), 1e-3);
        viewDir.normalize();
        const right = new THREE.Vector3().crossVectors(viewDir, camera.up);
        if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
        else right.normalize();
        const forward = viewDir.clone().addScaledVector(camera.up, -viewDir.dot(camera.up));
        if (forward.lengthSq() < 1e-8) forward.copy(viewDir);
        forward.normalize();
        const up = camera.up.clone().normalize();

        if (movementKeys.has('w')) move.add(forward);
        if (movementKeys.has('s')) move.sub(forward);
        if (movementKeys.has('d')) move.add(right);
        if (movementKeys.has('a')) move.sub(right);
        if (movementKeys.has('up')) move.add(up);
        if (movementKeys.has('down')) move.sub(up);
        if (move.lengthSq() === 0) return;

        move.normalize();
        const sceneStep = Math.max(getSceneDiagonal() * 0.25, 1e-3);
        const distanceStep = distance * 0.75;
        const speed = Math.max(Math.min(sceneStep, distanceStep), 1e-3) * 0.2;
        move.multiplyScalar(speed * dt);
        camera.position.add(move);
        controls.target.add(move);
    }

    // 外部から推論結果を受け取る
    // worldPos: Float32Array(H*W*4) RGBA(=XYZ+1), w/h: WP解像度
    // colorTex: { data: Uint8Array RGBA, width, height } | null
    function setData(worldPos, w, h, colorTex, baseName, intrinsics, viewerOptions, normalTex) {
        init();
        const options = viewerOptions || {};
        currentWorldPosData = { data: worldPos, width: w, height: h };
        currentColorTexture = colorTex || null;
        if (currentTextureObject) currentTextureObject.dispose();
        if (currentNormalTextureObject) currentNormalTextureObject.dispose();
        currentTextureObject = null;
        currentNormalTexture = normalTex || null;
        currentNormalTextureObject = null;
        currentBaseName = baseName || 'mesh';
        currentIntrinsics = intrinsics || null;
        currentViewerOptions = options;
        createMesh(!!options.preserveCamera);
    }

    function disposeGeometryAndMaterial(object) {
        if (!object) return;
        if (object.geometry) object.geometry.dispose();
        const material = object.material;
        if (Array.isArray(material)) {
            for (const m of material) if (m) m.dispose();
        } else if (material) {
            material.dispose();
        }
    }

    function createMesh(skipCameraReset) {
        if (!currentWorldPosData) return;
        cancelOrbitPlaneAdjustment(true);
        const { data: worldPosData, width, height } = currentWorldPosData;

        // Geometry cannot contain more detail than the inferred point map.
        // Using the source image resolution only creates millions of interpolated
        // vertices and makes discontinuity artifacts worse.
        const meshWidth = Math.min(width, 2048);
        const meshHeight = Math.min(height, 2048);

        const geometry = new THREE.PlaneGeometry(1, 1, meshWidth - 1, meshHeight - 1);
        const positions = geometry.attributes.position.array;
        const geometryUVs = geometry.attributes.uv.array;

        // 色の UV は常に元画像のまま（深度のみ EdgeSnap でスナップ）。
        // UV も吸着元へ差し替える方式はモデル解像度粒度のブロック/スジが出たため
        // 廃止（docs/archive/PLAN_EDGE_COLOR_HISTORY.md）。エッジの混色はテクスチャ側に残る。
        for (let i = 0; i < positions.length; i += 3) {
            const vertexIndex = i / 3;
            const row = Math.floor(vertexIndex / meshWidth);
            const col = vertexIndex % meshWidth;

            const u = col / (meshWidth - 1);
            const v = row / (meshHeight - 1);
            const srcX = u * (width - 1);
            const srcY = v * (height - 1);

            // MoGe and MogePost treat samples as pixel centers. Keep texture
            // coordinates on the same convention instead of mapping the first
            // and last sample to the outer image edges.
            geometryUVs[vertexIndex * 2] = (srcX + 0.5) / width;
            geometryUVs[vertexIndex * 2 + 1] = 1 - (srcY + 0.5) / height;

            const x0 = Math.floor(srcX);
            const y0 = Math.floor(srcY);
            const x1 = Math.min(x0 + 1, width - 1);
            const y1 = Math.min(y0 + 1, height - 1);
            const fx = srcX - x0;
            const fy = srcY - y0;

            const idx00 = (y0 * width + x0) * 4;
            const idx10 = (y0 * width + x1) * 4;
            const idx01 = (y1 * width + x0) * 4;
            const idx11 = (y1 * width + x1) * 4;

            for (let c = 0; c < 3; c++) {
                const v00 = worldPosData[idx00 + c];
                const v10 = worldPosData[idx10 + c];
                const v01 = worldPosData[idx01 + c];
                const v11 = worldPosData[idx11 + c];
                const v0 = v00 * (1 - fx) + v10 * fx;
                const v1 = v01 * (1 - fx) + v11 * fx;
                positions[i + c] = v0 * (1 - fy) + v1 * fy;
            }
        }

        geometry.attributes.position.needsUpdate = true;
        splitDiscontinuousFaces(
            geometry,
            meshWidth,
            meshHeight,
            !currentViewerOptions.disableDepthEdgeCleanup
        );
        // 段差カットで孤立した小さい/細いポリ（フリンジのちぎれ等）を除去する
        // テスト: 境界1層の erode を停止中（戻すには passes を 1 にする）
        erodeBoundaryFaces(geometry, 0);
        removeSmallFaceComponents(geometry, getSmallComponentMinFaces());
        // シーム分割で頂点が追加されると attribute 配列が差し替わる
        const finalPositions = geometry.attributes.position.array;
        updateFiniteGeometryBounds(geometry, finalPositions);
        geometry.computeVertexNormals();

        // 頂点カラー（ポイントモード等で使用）
        if (isPointsMode && currentColorTexture && !disableColor) {
            const colors = new Float32Array(finalPositions.length);
            const uvs = geometry.attributes.uv.array;
            const linearColor = new THREE.Color();
            for (let i = 0; i < uvs.length / 2; i++) {
                const u = uvs[i * 2];
                const vv = uvs[i * 2 + 1];
                const texX = Math.min(currentColorTexture.width - 1, Math.floor(u * currentColorTexture.width));
                const texY = Math.min(currentColorTexture.height - 1, Math.floor((1 - vv) * currentColorTexture.height));
                const texIndex = (texY * currentColorTexture.width + texX) * 4;
                linearColor.setRGB(
                    currentColorTexture.data[texIndex] / 255,
                    currentColorTexture.data[texIndex + 1] / 255,
                    currentColorTexture.data[texIndex + 2] / 255
                ).convertSRGBToLinear();
                colors[i * 3] = linearColor.r;
                colors[i * 3 + 1] = linearColor.g;
                colors[i * 3 + 2] = linearColor.b;
            }
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }

        if (mesh) {
            scene.remove(mesh);
            disposeGeometryAndMaterial(mesh);
            mesh = null;
        }
        if (pointsMesh) {
            scene.remove(pointsMesh);
            disposeGeometryAndMaterial(pointsMesh);
            pointsMesh = null;
        }

        if (isPointsMode) {
            const pm = createPointsMaterial();
            pointsMesh = new THREE.Points(geometry, pm);
            scene.add(pointsMesh);
            mesh = null;
        } else {
            const material = createMaterial();
            mesh = new THREE.Mesh(geometry, material);
            mesh.material.wireframe = isWireframeMode;
            scene.add(mesh);
            pointsMesh = null;
        }

        const bounds = calculateBounds(worldPosData);
        updateMeshInfo(meshWidth, meshHeight, bounds);
        rebuildBackfillMesh();
        rebuildFillBMesh();

        if (!skipCameraReset) resetCamera();
    }

    // ---- 遮蔽穴インペイントの第2レイヤー（backfill.js の出力）----
    function setBackfillLayer(layer) {
        currentBackfillLayer = layer || null;
        if (backfillTextureObject) { backfillTextureObject.dispose(); backfillTextureObject = null; }
        if (initialized) rebuildBackfillMesh();
    }

    function setBackfillParallaxCutK(value) {
        const k = Number(value);
        backfillParallaxCutK = Number.isFinite(k) ? Math.max(0.001, k) : 0.5;
        if (initialized) rebuildBackfillMesh();
    }

    function getBackfillTextureObject() {
        if (!currentBackfillLayer) return null;
        if (!backfillTextureObject) {
            const tex = currentBackfillLayer.colorTex;
            backfillTextureObject = new THREE.DataTexture(
                tex.data, tex.width, tex.height, THREE.RGBAFormat, THREE.UnsignedByteType
            );
            backfillTextureObject.needsUpdate = true;
            backfillTextureObject.flipY = true;
            backfillTextureObject.magFilter = THREE.LinearFilter;
            backfillTextureObject.minFilter = THREE.LinearFilter;
            backfillTextureObject.generateMipmaps = false;
            backfillTextureObject.encoding = THREE.sRGBEncoding;
        }
        return backfillTextureObject;
    }

    function createBackfillMaterial() {
        const MaterialClass = disableLighting ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
        if (disableColor || !currentBackfillLayer) {
            return new MaterialClass({ color: 0xffffff, side: THREE.DoubleSide, flatShading: false });
        }
        return new MaterialClass({ map: getBackfillTextureObject(), side: THREE.DoubleSide, flatShading: false });
    }

    function disposeBackfillMesh() {
        if (!backfillMesh) return;
        scene.remove(backfillMesh);
        backfillMesh.geometry.dispose();
        backfillMesh.material.dispose();
        backfillMesh = null;
    }

    function rebuildBackfillMesh() {
        disposeBackfillMesh();
        const layer = currentBackfillLayer;
        if (!layer || !currentWorldPosData) return;

        // レイヤーはモデル解像度そのまま（≤2048 前提）なので 1:1 のグリッドを張る
        const W = layer.width, H = layer.height;
        const geometry = new THREE.PlaneGeometry(1, 1, W - 1, H - 1);
        const positions = geometry.attributes.position.array;
        const uvs = geometry.attributes.uv.array;
        for (let i = 0; i < W * H; i++) {
            const pi = i * 4;
            positions[i * 3] = layer.worldPos[pi];
            positions[i * 3 + 1] = layer.worldPos[pi + 1];
            positions[i * 3 + 2] = layer.worldPos[pi + 2];
            uvs[i * 2] = ((i % W) + 0.5) / W;
            uvs[i * 2 + 1] = 1 - (((i / W) | 0) + 0.5) / H;
        }
        geometry.attributes.position.needsUpdate = true;
        // backfill の面カットは「相対深度比」ではなく「視差(disparity)差」で判定する。
        // 目的は視差で背面が見えることの緩和で、視差量 ∝ disparity 差 (1/z_near - 1/z_far)。
        // 遠い面同士は比が大きくても disparity 差が小さい（視差小）ので繋がり、奥穴を埋める。
        // 手前を含む面は disparity 差が大きい（視差大）ので切れ、奥から手前へ伸びる smear を除去する。
        // しきい値はシーン中央値 disparity に対する比 backfillParallaxCutK（スケール不変）。
        //   上げる→切りにくい（黒穴減・smear 増） / 下げる→切りやすい（smear 減・黒穴増）
        const disps = new Float32Array(positions.length / 3);
        let dispCount = 0;
        for (let p = 2; p < positions.length; p += 3) {
            const z = positions[p];
            if (Number.isFinite(z) && Math.abs(z) > 1e-6) disps[dispCount++] = 1 / Math.abs(z);
        }
        let dispGapThreshold = Infinity;   // データ無し時は切らない
        if (dispCount) {
            const validDisps = disps.subarray(0, dispCount);
            validDisps.sort();
            dispGapThreshold = backfillParallaxCutK * validDisps[validDisps.length >> 1];
        }
        removeInvalidAndDiscontinuousFaces(geometry, positions, true, dispGapThreshold);
        // 視差カットで孤立した小さい/細い fill 片（面張りの元）を除去する
        // テスト: 境界1層の erode を停止中（戻すには passes を 1 にする）
        erodeBoundaryFaces(geometry, 0);
        removeSmallFaceComponents(geometry, getSmallComponentMinFaces());
        if (!geometry.index || geometry.index.count === 0) { geometry.dispose(); return; }
        updateFiniteGeometryBounds(geometry, positions);
        geometry.computeVertexNormals();

        if (isPointsMode) {
            const colors = new Float32Array(W * H * 3);
            const linearColor = new THREE.Color();
            const tex = layer.colorTex;
            for (let i = 0; i < W * H; i++) {
                linearColor.setRGB(
                    tex.data[i * 4] / 255, tex.data[i * 4 + 1] / 255, tex.data[i * 4 + 2] / 255
                ).convertSRGBToLinear();
                colors[i * 3] = linearColor.r;
                colors[i * 3 + 1] = linearColor.g;
                colors[i * 3 + 2] = linearColor.b;
            }
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            backfillMesh = new THREE.Points(geometry, createPointsMaterial());
        } else {
            const material = createBackfillMaterial();
            material.wireframe = isWireframeMode;
            backfillMesh = new THREE.Mesh(geometry, material);
        }
        backfillMesh.name = 'BackfillMesh';
        scene.add(backfillMesh);
    }

    // ---- FillB: 最奥バックドロップ層（fillb.js の出力）----
    // 面カット無しの連続グリッド。常に全ジオメトリの後ろにあり、
    // 主メッシュ/backfill の穴の向こうにぼけた背景色を見せる。
    function setFillBLayer(layer) {
        currentFillBLayer = layer || null;
        if (fillBTextureObject) { fillBTextureObject.dispose(); fillBTextureObject = null; }
        if (initialized) rebuildFillBMesh();
    }

    function disposeFillBMesh() {
        if (!fillBMesh) return;
        scene.remove(fillBMesh);
        fillBMesh.geometry.dispose();
        fillBMesh.material.dispose();
        fillBMesh = null;
    }

    function getFillBTextureObject() {
        if (!currentFillBLayer) return null;
        if (!fillBTextureObject) {
            const tex = currentFillBLayer.colorTex;
            fillBTextureObject = new THREE.DataTexture(
                tex.data, tex.width, tex.height, THREE.RGBAFormat, THREE.UnsignedByteType
            );
            fillBTextureObject.needsUpdate = true;
            fillBTextureObject.flipY = true;
            fillBTextureObject.magFilter = THREE.LinearFilter;
            fillBTextureObject.minFilter = THREE.LinearFilter;
            fillBTextureObject.generateMipmaps = false;
            fillBTextureObject.encoding = THREE.sRGBEncoding;
        }
        return fillBTextureObject;
    }

    function rebuildFillBMesh() {
        disposeFillBMesh();
        const layer = currentFillBLayer;
        if (!layer || !currentWorldPosData) return;

        const W = layer.width, H = layer.height;
        const geometry = new THREE.PlaneGeometry(1, 1, W - 1, H - 1);
        const positions = geometry.attributes.position.array;
        const uvs = geometry.attributes.uv.array;
        for (let i = 0; i < W * H; i++) {
            const pi = i * 4;
            positions[i * 3] = layer.worldPos[pi];
            positions[i * 3 + 1] = layer.worldPos[pi + 1];
            positions[i * 3 + 2] = layer.worldPos[pi + 2];
            uvs[i * 2] = ((i % W) + 0.5) / W;
            uvs[i * 2 + 1] = 1 - (((i / W) | 0) + 0.5) / H;
        }
        geometry.attributes.position.needsUpdate = true;
        updateFiniteGeometryBounds(geometry, positions);
        geometry.computeVertexNormals();

        const material = disableColor
            ? new THREE.MeshBasicMaterial({ color: 0x888888, side: THREE.DoubleSide })
            : new THREE.MeshBasicMaterial({ map: getFillBTextureObject(), side: THREE.DoubleSide });
        material.wireframe = isWireframeMode;
        fillBMesh = new THREE.Mesh(geometry, material);
        fillBMesh.name = 'FillBMesh';
        scene.add(fillBMesh);
    }

    function createOrbitControls(target, frontSideOnly) {
        if (controls) controls.dispose();
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.zoomSpeed = 0.4;
        controls.screenSpacePanning = true;
        controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.DOLLY
        };
        controls.minDistance = 0.1;
        controls.maxDistance = 1000;
        controls.minPolarAngle = frontSideOnly ? 0.001 : 0;
        controls.maxPolarAngle = frontSideOnly ? Math.PI * 0.5 - 0.001 : Math.PI;
        controls.target.copy(target);
    }

    function onMayaMouseGate(event) {
        if (!controls) return;
        if ((event.button === 0 || event.button === 1 || event.button === 2) && !event.altKey) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    // 主メッシュ用: 深度段差をまたぐセルを「削除」せず「切り離す」。
    // 段差セルは near/far の2枚のプレートに分割し、各プレートは相手側の角を
    // 「自分側の深度へ複製した頂点」で置き換えて1セル分延長する。
    //   2 2 3 4 5 5 →（EdgeSnap 後）2 2 2 5 5 5 → 段差セルは
    //   手前プレート（正面ビューを隙間なく覆う）と奥プレート（覗き込み時に
    //   奥面が続いて見える）の両方が所有する。
    // 複製頂点は同一画素レイ上の移動なので位置は元頂点の比率スケールで正確。
    // しきい値は従来の面カットと同じ 0.10 固定（Edge Threshold とは非連動）。
    function createIndexArray(length, vertexCount) {
        return vertexCount > 65535 ? new Uint32Array(length) : new Uint16Array(length);
    }

    function setGeometryIndexArray(geometry, indices) {
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }

    function copyExactIndexPrefix(source, length) {
        const exact = new source.constructor(length);
        exact.set(source.subarray(0, length));
        return exact;
    }

    function splitDiscontinuousFaces(geometry, W, H, splitDepthEdges) {
        if (!geometry.index) return;
        const positions = geometry.attributes.position.array;
        const uvs = geometry.attributes.uv.array;
        const relativeDepthThreshold = 0.10;
        const baseCount = W * H;
        let indexCount = 0;
        let indexWrite = 0;
        let duplicateWrite = 0;
        let indices = null;
        let extraPos = null;
        let extraUV = null;

        // セル角の並び: 0=左上 1=右上 2=左下 3=右下
        const cornerIdx = new Int32Array(4);
        const cornerZ = new Float64Array(4);
        const adjacentCorners = [[1, 2], [0, 3], [0, 3], [1, 2]];
        const mapped = new Int32Array(4);

        function emitTriangle(a, b, c, write) {
            if (write) {
                indices[indexWrite++] = a;
                indices[indexWrite++] = b;
                indices[indexWrite++] = c;
            } else {
                indexCount += 3;
            }
        }

        function addDuplicate(corner, refCorner, write) {
            const src = cornerIdx[corner];
            const ref = cornerIdx[refCorner];
            const scale = cornerZ[refCorner] / cornerZ[corner];
            const index = baseCount + duplicateWrite;
            if (write) {
                const pi = duplicateWrite * 3;
                extraPos[pi] = positions[src * 3] * scale;
                extraPos[pi + 1] = positions[src * 3 + 1] * scale;
                extraPos[pi + 2] = positions[src * 3 + 2] * scale;
                const ui = duplicateWrite * 2;
                // UV は延長元（同じプレート側）の角からコピー。テクスチャは ColorPatch 済み
                // なので延長面は自分側の純色になる（複製元の UV のままだと、延長面が
                // 相手側の色を拾ってフリンジになる。docs/archive/PLAN_EDGE_COLOR_HISTORY.md 3.6）
                extraUV[ui] = uvs[ref * 2];
                extraUV[ui + 1] = uvs[ref * 2 + 1];
            }
            duplicateWrite++;
            return index;
        }

        function processCell(x, y, write) {
            const tl = y * W + x;
            cornerIdx[0] = tl;
            cornerIdx[1] = tl + 1;
            cornerIdx[2] = tl + W;
            cornerIdx[3] = tl + W + 1;

            let finite = true;
            let zMin = Infinity, zMax = -Infinity;
            for (let k = 0; k < 4; k++) {
                const pi = cornerIdx[k] * 3;
                const px = positions[pi], py = positions[pi + 1], pz = positions[pi + 2];
                if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
                    finite = false;
                    break;
                }
                const z = Math.abs(pz);
                cornerZ[k] = Math.max(z, 1e-9);
                if (z < zMin) zMin = z;
                if (z > zMax) zMax = z;
            }
            if (!finite) return;

            const isSeam = splitDepthEdges &&
                (zMax - zMin) > relativeDepthThreshold * Math.max(zMin, 1e-6);
            if (!isSeam) {
                // PlaneGeometry と同じ三角形分割: (TL,BL,TR), (BL,BR,TR)
                emitTriangle(cornerIdx[0], cornerIdx[2], cornerIdx[1], write);
                emitTriangle(cornerIdx[2], cornerIdx[3], cornerIdx[1], write);
                return;
            }

            // near/far の2値分類（幾何平均しきい値）
            const t = Math.sqrt(zMin * zMax);
            // far プレートと near プレートを両方張る
            for (let side = 0; side < 2; side++) {
                const wantFar = side === 0;
                // このプレート側の実在角が内部でさらに段差を持つ場合（＝3つ以上の深度が
                // 集まる三重点セル）、2値分割では中間深度を跨ぐ面（スパイク）になる。
                // そのプレートは張らずに欠かせ、背後は backfill が埋める。
                let sMin = Infinity, sMax = -Infinity, sideCount = 0;
                for (let k = 0; k < 4; k++) {
                    if ((cornerZ[k] > t) === wantFar) {
                        sideCount++;
                        if (cornerZ[k] < sMin) sMin = cornerZ[k];
                        if (cornerZ[k] > sMax) sMax = cornerZ[k];
                    }
                }
                if (sideCount === 0) continue;
                if (sMax - sMin > relativeDepthThreshold * Math.max(sMin, 1e-6)) continue;
                for (let k = 0; k < 4; k++) {
                    const isFar = cornerZ[k] > t;
                    if (isFar === wantFar) {
                        mapped[k] = cornerIdx[k];
                        continue;
                    }
                    // 自分と反対側の角 → 同じプレート側の隣接角（無ければ対角）を
                    // 参照に、その深度へ複製
                    const adj = adjacentCorners[k];
                    let refCorner = (cornerZ[adj[0]] > t) === wantFar ? adj[0]
                        : (cornerZ[adj[1]] > t) === wantFar ? adj[1]
                            : 3 - k;
                    mapped[k] = addDuplicate(k, refCorner, write);
                }
                emitTriangle(mapped[0], mapped[2], mapped[1], write);
                emitTriangle(mapped[2], mapped[3], mapped[1], write);
            }
        }

        for (let y = 0; y < H - 1; y++) {
            for (let x = 0; x < W - 1; x++) {
                processCell(x, y, false);
            }
        }

        const extraVertexCount = duplicateWrite;
        const totalVertexCount = baseCount + extraVertexCount;
        indices = createIndexArray(indexCount, totalVertexCount);
        extraPos = new Float32Array(extraVertexCount * 3);
        extraUV = new Float32Array(extraVertexCount * 2);
        indexWrite = 0;
        duplicateWrite = 0;

        for (let y = 0; y < H - 1; y++) {
            for (let x = 0; x < W - 1; x++) {
                processCell(x, y, true);
            }
        }

        if (extraVertexCount) {
            const newPositions = new Float32Array(positions.length + extraPos.length);
            newPositions.set(positions, 0);
            newPositions.set(extraPos, positions.length);
            geometry.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
            const newUVs = new Float32Array(uvs.length + extraUV.length);
            newUVs.set(uvs, 0);
            newUVs.set(extraUV, uvs.length);
            geometry.setAttribute('uv', new THREE.BufferAttribute(newUVs, 2));
        }
        setGeometryIndexArray(geometry, indices);
    }

    // Do not connect masked pixels or surfaces separated by a large depth jump.
    // A regular image-grid mesh otherwise produces long sheets at silhouettes.
    // dispGapThreshold は視差(disparity)差の上限。面の (1/z_near - 1/z_far) がこれを超えたら
    // 切る。視差差が小さい遠い面同士は繋がり(奥穴を埋める)、視差差が大きい手前を含む面は
    // 切れる(奥から手前へ伸びる smear を除去)。呼び出し側でシーン中央値 disparity 基準で渡す。
    function removeInvalidAndDiscontinuousFaces(geometry, positions, removeDepthEdges, dispGapThreshold) {
        if (!geometry.index) return;
        const source = geometry.index.array;
        const kept = new source.constructor(source.length);
        let keptCount = 0;
        const gapThreshold = (typeof dispGapThreshold === 'number') ? dispGapThreshold : Infinity;

        for (let i = 0; i < source.length; i += 3) {
            const a = source[i], b = source[i + 1], c = source[i + 2];
            const ai = a * 3, bi = b * 3, ci = c * 3;
            const az = positions[ai + 2], bz = positions[bi + 2], cz = positions[ci + 2];
            if (!Number.isFinite(positions[ai]) || !Number.isFinite(positions[ai + 1]) || !Number.isFinite(az) ||
                !Number.isFinite(positions[bi]) || !Number.isFinite(positions[bi + 1]) || !Number.isFinite(bz) ||
                !Number.isFinite(positions[ci]) || !Number.isFinite(positions[ci + 1]) || !Number.isFinite(cz)) {
                continue;
            }

            if (removeDepthEdges) {
                const zNear = Math.min(Math.abs(az), Math.abs(bz), Math.abs(cz));
                const zFar = Math.max(Math.abs(az), Math.abs(bz), Math.abs(cz));
                // 視差差 = 近点と遠点の disparity 差。近点が手前ほど、遠点との差が大きい。
                const dispGap = 1 / Math.max(zNear, 1e-6) - 1 / Math.max(zFar, 1e-6);
                if (dispGap > gapThreshold) continue;
            }
            kept[keptCount++] = a;
            kept[keptCount++] = b;
            kept[keptCount++] = c;
        }

        setGeometryIndexArray(geometry, copyExactIndexPrefix(kept, keptCount));
    }

    // 境界エッジの頂点に触る face を指定回数削る。Small Component Faces の前に1層削ることで、
    // 1ポリ幅でつながった細いブリッジを連結成分から切り離すテスト用処理。
    const EDGE_KEY_STRIDE = 67108864; // 2^26。lo/hi が 26bit 未満なら IEEE-754 整数で正確。

    function erodeBoundaryFaces(geometry, passes) {
        if (!geometry.index || passes <= 0) return;
        const vertexCount = geometry.attributes.position.count;
        if (vertexCount >= EDGE_KEY_STRIDE) {
            throw new Error('erodeBoundaryFaces requires vertexCount < 2^26 for exact numeric edge keys');
        }
        for (let pass = 0; pass < passes; pass++) {
            const idx = geometry.index.array;
            const nF = idx.length / 3;
            if (nF === 0) return;

            const edgeUse = new Map();
            for (let f = 0; f < nF; f++) {
                const b = f * 3;
                const a = idx[b], c = idx[b + 1], d = idx[b + 2];
                addEdgeUse(edgeUse, a, c);
                addEdgeUse(edgeUse, c, d);
                addEdgeUse(edgeUse, d, a);
            }

            const boundaryVertex = new Uint8Array(geometry.attributes.position.count);
            edgeUse.forEach((count, key) => {
                if (count !== 1) return;
                const lo = Math.floor(key / EDGE_KEY_STRIDE);
                const hi = key - lo * EDGE_KEY_STRIDE;
                boundaryVertex[lo] = 1;
                boundaryVertex[hi] = 1;
            });

            let removed = 0;
            const kept = new idx.constructor(idx.length);
            let keptCount = 0;
            for (let f = 0; f < nF; f++) {
                const b = f * 3;
                const a = idx[b], c = idx[b + 1], d = idx[b + 2];
                if (boundaryVertex[a] || boundaryVertex[c] || boundaryVertex[d]) {
                    removed++;
                } else {
                    kept[keptCount++] = a;
                    kept[keptCount++] = c;
                    kept[keptCount++] = d;
                }
            }
            if (removed === 0) return;
            setGeometryIndexArray(geometry, copyExactIndexPrefix(kept, keptCount));
        }
    }

    function addEdgeUse(edgeUse, a, b) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const key = lo * EDGE_KEY_STRIDE + hi;
        edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }

    // 面カット後に孤立して残る「小さい/細い」連結成分を除去する。face を頂点共有で
    // union-find し、面数が minFaces 未満の成分の面を捨てる。段差カット（視差カット・
    // 三重点・NaN）で切り離された小片や、それを種にした backfill の細い面張りを消す。
    // 巨大な連結面（主メッシュ本体・広い背景）は残る。除去面は透明になり再充填しない。
    function removeSmallFaceComponents(geometry, minFaces) {
        if (!geometry.index || minFaces <= 1) return;
        const idx = geometry.index.array;
        const nF = idx.length / 3;
        if (nF === 0) return;
        const vCount = geometry.attributes.position.count;
        const parent = new Int32Array(nF);
        for (let f = 0; f < nF; f++) parent[f] = f;
        const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
        const vFirst = new Int32Array(vCount).fill(-1);
        for (let f = 0; f < nF; f++) {
            for (let k = 0; k < 3; k++) {
                const v = idx[f * 3 + k];
                const p = vFirst[v];
                if (p < 0) vFirst[v] = f;
                else { const ra = find(f), rb = find(p); if (ra !== rb) parent[ra] = rb; }
            }
        }
        const size = new Int32Array(nF);
        for (let f = 0; f < nF; f++) size[find(f)]++;
        let removed = 0;
        const kept = new idx.constructor(idx.length);
        let keptCount = 0;
        for (let f = 0; f < nF; f++) {
            if (size[find(f)] >= minFaces) {
                const b = f * 3;
                kept[keptCount++] = idx[b];
                kept[keptCount++] = idx[b + 1];
                kept[keptCount++] = idx[b + 2];
            } else removed++;
        }
        if (removed > 0) setGeometryIndexArray(geometry, copyExactIndexPrefix(kept, keptCount));
    }

    function getSmallComponentMinFaces() {
        const value = currentViewerOptions && Number(currentViewerOptions.smallComponentMinFaces);
        return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 64;
    }

    // Masked vertices remain NaN so exports and point mode preserve invalid
    // pixels. three.js cannot derive raycast bounds from such an array, so use
    // only finite vertices for the mesh bounding volumes.
    function updateFiniteGeometryBounds(geometry, positions) {
        const min = new THREE.Vector3(Infinity, Infinity, Infinity);
        const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            min.x = Math.min(min.x, x); max.x = Math.max(max.x, x);
            min.y = Math.min(min.y, y); max.y = Math.max(max.y, y);
            min.z = Math.min(min.z, z); max.z = Math.max(max.z, z);
        }
        if (!Number.isFinite(min.x)) return;

        geometry.boundingBox = new THREE.Box3(min, max);
        const center = min.clone().add(max).multiplyScalar(0.5);
        let radiusSq = 0;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            radiusSq = Math.max(radiusSq,
                (x - center.x) * (x - center.x) +
                (y - center.y) * (y - center.y) +
                (z - center.z) * (z - center.z));
        }
        geometry.boundingSphere = new THREE.Sphere(center, Math.sqrt(radiusSq));
    }

    function getTextureObject() {
        if (!currentColorTexture) return null;
        if (!currentTextureObject) {
            currentTextureObject = new THREE.DataTexture(
                currentColorTexture.data,
                currentColorTexture.width,
                currentColorTexture.height,
                THREE.RGBAFormat,
                THREE.UnsignedByteType
            );
            currentTextureObject.needsUpdate = true;
            currentTextureObject.flipY = true;
            currentTextureObject.magFilter = THREE.LinearFilter;
            currentTextureObject.minFilter = THREE.LinearFilter;
            currentTextureObject.generateMipmaps = false;
            currentTextureObject.anisotropy = renderer.capabilities.getMaxAnisotropy();
            currentTextureObject.encoding = THREE.sRGBEncoding;
        }
        return currentTextureObject;
    }

    function getNormalTextureObject() {
        if (!currentNormalTexture) return null;
        if (!currentNormalTextureObject) {
            currentNormalTextureObject = new THREE.DataTexture(
                currentNormalTexture.data,
                currentNormalTexture.width,
                currentNormalTexture.height,
                THREE.RGBAFormat,
                THREE.UnsignedByteType
            );
            currentNormalTextureObject.needsUpdate = true;
            currentNormalTextureObject.flipY = true;
            currentNormalTextureObject.magFilter = THREE.LinearFilter;
            currentNormalTextureObject.minFilter = THREE.LinearFilter;
            currentNormalTextureObject.generateMipmaps = false;
            currentNormalTextureObject.anisotropy = renderer.capabilities.getMaxAnisotropy();
        }
        return currentNormalTextureObject;
    }

    function createMaterial() {
        const MaterialClass = disableLighting ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
        const lightingOptions = !disableLighting && currentNormalTexture
            ? { normalMap: getNormalTextureObject() }
            : {};
        if (disableColor) {
            return new MaterialClass({ color: 0xffffff, side: THREE.DoubleSide, flatShading: false, ...lightingOptions });
        } else if (currentColorTexture) {
            return new MaterialClass({ map: getTextureObject(), side: THREE.DoubleSide, flatShading: false, ...lightingOptions });
        }
        return new MaterialClass({ color: 0x888888, side: THREE.DoubleSide, flatShading: false, ...lightingOptions });
    }

    function createPointsMaterial() {
        const adjustedSize = pointSize / renderer.getPixelRatio();
        if (disableColor) {
            return new THREE.PointsMaterial({ color: 0xffffff, size: adjustedSize, sizeAttenuation: false, vertexColors: false });
        } else if (currentColorTexture) {
            getTextureObject();
            return new THREE.PointsMaterial({ size: adjustedSize, sizeAttenuation: false, vertexColors: true });
        }
        return new THREE.PointsMaterial({ color: 0x888888, size: adjustedSize, sizeAttenuation: false, vertexColors: false });
    }

    function calculateBounds(data) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < data.length; i += 4) {
            const x = data[i], y = data[i + 1], z = data[i + 2];
            if (isFinite(x)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
            if (isFinite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
            if (isFinite(z)) { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
        }
        return { minX, maxX, minY, maxY, minZ, maxZ };
    }

    function updateMeshInfo(width, height, bounds) {
        document.getElementById('meshResolution').textContent = `${width} x ${height}`;
        document.getElementById('rangeX').textContent = `[${bounds.minX.toFixed(2)}, ${bounds.maxX.toFixed(2)}]`;
        document.getElementById('rangeY').textContent = `[${bounds.minY.toFixed(2)}, ${bounds.maxY.toFixed(2)}]`;
        document.getElementById('rangeZ').textContent = `[${bounds.minZ.toFixed(2)}, ${bounds.maxZ.toFixed(2)}]`;
    }

    function getInitialOrbitCenter(bounds) {
        if (!bounds) {
            if (!currentWorldPosData) return new THREE.Vector3();
            bounds = calculateBounds(currentWorldPosData.data);
        }
        const center = new THREE.Vector3(
            (bounds.minX + bounds.maxX) * 0.5,
            (bounds.minY + bounds.maxY) * 0.5,
            (bounds.minZ + bounds.maxZ) * 0.5
        );
        if (hasValidIntrinsics(currentIntrinsics) && bounds.minZ > 0) {
            return new THREE.Vector3(0, 0, center.z);
        }
        return center;
    }

    function updateMaterial() {
        if (isPointsMode && pointsMesh) {
            const old = pointsMesh.material;
            pointsMesh.material = createPointsMaterial();
            old.dispose();
        } else if (mesh) {
            const old = mesh.material;
            const nm = createMaterial();
            nm.wireframe = isWireframeMode;
            mesh.material = nm;
            old.dispose();
        }
        if (backfillMesh && backfillMesh.isMesh) {
            const old = backfillMesh.material;
            const nm = createBackfillMaterial();
            nm.wireframe = isWireframeMode;
            backfillMesh.material = nm;
            old.dispose();
        }
    }

    function resetCamera() {
        const target = isPointsMode ? pointsMesh : mesh;
        if (!target || !currentWorldPosData) return;

        const bounds = calculateBounds(currentWorldPosData.data);
        if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, bounds.minZ, bounds.maxZ].every(Number.isFinite)) return;

        const center = new THREE.Vector3(
            (bounds.minX + bounds.maxX) * 0.5,
            (bounds.minY + bounds.maxY) * 0.5,
            (bounds.minZ + bounds.maxZ) * 0.5
        );
        const size = new THREE.Vector3(
            bounds.maxX - bounds.minX,
            bounds.maxY - bounds.minY,
            bounds.maxZ - bounds.minZ
        );

        cancelOrbitPlaneAdjustment(true);
        cancelOrbitCenterSelection();
        const resetTarget = activeOrbitPlane
            ? activeOrbitPlane.center.clone()
            : getInitialOrbitCenter(bounds);

        // Reset View restores the estimated source-camera position. When a
        // horizontal grid is active, only its normal changes; the pivot stays
        // at the initial source-camera target.
        camera.up.set(0, 1, 0);
        createOrbitControls(new THREE.Vector3(), false);
        if (hasValidIntrinsics(currentIntrinsics) && bounds.minZ > 0) {
            // WorldPos flips camera X/Y while preserving Z. Looking from the
            // estimated camera origin toward +Z therefore reproduces the source
            // image orientation instead of showing the mesh from its back/side.
            const sourceVfov = 2 * Math.atan(0.5 / currentIntrinsics.fy);
            const sourceHfov = 2 * Math.atan(0.5 / currentIntrinsics.fx);
            const vfovForWidth = 2 * Math.atan(Math.tan(sourceHfov * 0.5) / camera.aspect);
            camera.fov = THREE.MathUtils.radToDeg(Math.max(sourceVfov, vfovForWidth)) * 1.02;
            camera.position.set(0, 0, 0);
            controls.target.copy(resetTarget);
        } else {
            // Fallback for imported/invalid data: fit the bounds from the same
            // front side as the source camera, without the previous X/Y offset.
            const fallbackTarget = activeOrbitPlane ? activeOrbitPlane.center : center;
            camera.fov = 60;
            const vfov = THREE.MathUtils.degToRad(camera.fov);
            const hfov = 2 * Math.atan(Math.tan(vfov * 0.5) * camera.aspect);
            const fitDistance = Math.max(
                size.y * 0.5 / Math.tan(vfov * 0.5),
                size.x * 0.5 / Math.tan(hfov * 0.5)
            ) * 1.1;
            const distance = Math.max(fitDistance, size.z * 0.5 + Math.max(fitDistance * 0.05, 1e-3));
            camera.position.set(fallbackTarget.x, fallbackTarget.y, fallbackTarget.z - distance);
            controls.target.copy(fallbackTarget);
        }

        const distance = camera.position.distanceTo(controls.target);
        camera.near = Math.max(1e-4, bounds.minZ > 0 && camera.position.z === 0 ? bounds.minZ * 0.1 : distance * 0.001);
        camera.far = Math.max(bounds.maxZ + Math.abs(camera.position.z), distance * 10, camera.near * 1000);
        camera.updateProjectionMatrix();
        controls.minDistance = Math.max(1e-4, distance * 0.01);
        controls.maxDistance = Math.max(distance * 100, controls.minDistance * 10);
        camera.lookAt(controls.target);
        controls.update();
    }

    // ---- Orbit center one-click selection ----
    function toggleOrbitCenterSelection() {
        if (!mesh && !pointsMesh) return;
        if (orbitCenterSelectionActive) {
            cancelOrbitCenterSelection();
            return;
        }
        if (orbitPlaneAdjustmentOpen) cancelOrbitPlaneAdjustment(true);
        orbitCenterSelectionActive = true;
        pointerDownPosition = null;
        if (renderer) renderer.domElement.classList.add('selecting-orbit-center');
        updateOrbitCenterUI('Click a surface point for the orbit center. Press F or Esc to cancel.', true);
    }

    function cancelOrbitCenterSelection() {
        orbitCenterSelectionActive = false;
        pointerDownPosition = null;
        if (renderer) renderer.domElement.classList.remove('selecting-orbit-center');
        updateOrbitCenterUI('', false);
    }

    function updateOrbitCenterUI(message, active) {
        const button = document.getElementById('setOrbitCenter');
        const status = document.getElementById('orbitCenterStatus');
        if (button) {
            button.textContent = active ? 'Cancel Orbit Center' : 'Set Orbit Center';
            button.classList.toggle('active', active);
        }
        if (status) status.textContent = message;
    }

    function applyOrbitCenter(point) {
        if (!controls || !camera) return;
        const viewDir = controls.target.clone().sub(camera.position);
        if (viewDir.lengthSq() < 1e-8) viewDir.copy(point).sub(camera.position);
        if (viewDir.lengthSq() < 1e-8) return;
        viewDir.normalize();
        const distance = Math.max(camera.position.distanceTo(point), 1e-4);
        controls.target.copy(point);
        camera.position.copy(point).addScaledVector(viewDir, -distance);
        camera.lookAt(point);
        controls.update();
    }

    function hasValidIntrinsics(value) {
        return value && Number.isFinite(value.fx) && value.fx > 0 &&
            Number.isFinite(value.fy) && value.fy > 0;
    }

    // ---- 3-point orbit plane calibration ----
    function toggleHorizontalGridAdjustment() {
        if (!mesh && !pointsMesh) return;
        if (orbitCenterSelectionActive) cancelOrbitCenterSelection();
        if (orbitPlaneAdjustmentOpen) {
            cancelOrbitPlaneAdjustment(true);
            return;
        }

        orbitPlaneAdjustmentOpen = true;
        orbitPlaneSelectionActive = true;
        pendingOrbitPlane = null;
        orbitPlanePoints = [];
        clearSelectionMarkers();

        const currentCenter = activeOrbitPlane ? activeOrbitPlane.center : getInitialOrbitCenter();
        const currentNormal = activeOrbitPlane ? activeOrbitPlane.normal : camera.up.clone().normalize();
        showOrbitPlaneHelper(currentCenter, currentNormal, getSceneDiagonal() * 0.25);
        renderer.domElement.classList.add('selecting-orbit-plane');
        updateOrbitPlaneUI('Select 3 points on the horizontal plane (1/3).', true, false);
    }

    function cancelOrbitPlaneAdjustment(clearVisuals) {
        orbitPlaneAdjustmentOpen = false;
        orbitPlaneSelectionActive = false;
        pendingOrbitPlane = null;
        orbitPlanePoints = [];
        pointerDownPosition = null;
        if (renderer) renderer.domElement.classList.remove('selecting-orbit-plane');
        if (clearVisuals) {
            clearSelectionMarkers();
            clearOrbitPlaneHelper();
        }
        updateOrbitPlaneUI('', false, false);
    }

    function clearSelectionMarkers() {
        if (!selectionMarkers) return;
        while (selectionMarkers.children.length) {
            const marker = selectionMarkers.children[selectionMarkers.children.length - 1];
            selectionMarkers.remove(marker);
            if (marker.geometry) marker.geometry.dispose();
            if (marker.material) marker.material.dispose();
        }
    }

    function clearOrbitPlaneHelper() {
        if (orbitPlaneGrid) {
            scene.remove(orbitPlaneGrid);
            orbitPlaneGrid.geometry.dispose();
            orbitPlaneGrid.material.dispose();
            orbitPlaneGrid = null;
        }
        if (orbitPlaneUpArrow) {
            scene.remove(orbitPlaneUpArrow);
            orbitPlaneUpArrow.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
            orbitPlaneUpArrow = null;
        }
    }

    function updateOrbitPlaneUI(message, active, canUse) {
        const button = document.getElementById('adjustHorizontalGrid');
        const useButton = document.getElementById('useHorizontalGrid');
        const help = document.getElementById('orbitPlaneHelp');
        const status = document.getElementById('orbitPlaneStatus');
        if (button) {
            button.textContent = active ? 'Cancel' : 'Adjust Horizontal Grid';
            button.classList.toggle('active', active);
        }
        if (useButton) useButton.classList.toggle('hidden-control', !canUse);
        if (help) {
            help.textContent = active ? 'Select 3 well-spaced points on the horizontal plane.' : '';
            help.classList.toggle('hidden-control', !active);
        }
        if (status) status.textContent = message;
    }

    function onSelectionPointerDown(event) {
        if ((!orbitPlaneSelectionActive && !orbitCenterSelectionActive) || event.button !== 0) return;
        pointerDownPosition = { x: event.clientX, y: event.clientY };
    }

    function onSelectionPointerUp(event) {
        if ((!orbitPlaneSelectionActive && !orbitCenterSelectionActive) || event.button !== 0 || !pointerDownPosition) return;
        const dx = event.clientX - pointerDownPosition.x;
        const dy = event.clientY - pointerDownPosition.y;
        pointerDownPosition = null;
        if (dx * dx + dy * dy > 16) return;

        const point = pickSurfacePoint(event);
        if (orbitCenterSelectionActive) {
            if (!point) {
                updateOrbitCenterUI('No surface at that position. Click a visible mesh point.', true);
                return;
            }
            applyOrbitCenter(point);
            cancelOrbitCenterSelection();
            return;
        }

        if (!point) {
            updateOrbitPlaneUI(`No surface at that position (${orbitPlanePoints.length + 1}/3).`, true, false);
            return;
        }

        orbitPlanePoints.push(point);
        addSelectionMarker(point, orbitPlanePoints.length - 1);
        if (orbitPlanePoints.length < 3) {
            updateOrbitPlaneUI(`Select a point on the horizontal plane (${orbitPlanePoints.length + 1}/3).`, true, false);
            return;
        }
        previewOrbitPlane();
    }

    function pickSurfacePoint(event) {
        const target = isPointsMode ? pointsMesh : mesh;
        if (!target) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        pointerNdc.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        raycaster.setFromCamera(pointerNdc, camera);
        if (isPointsMode && currentWorldPosData) {
            const bounds = calculateBounds(currentWorldPosData.data);
            const diagonal = Math.hypot(
                bounds.maxX - bounds.minX,
                bounds.maxY - bounds.minY,
                bounds.maxZ - bounds.minZ
            );
            raycaster.params.Points.threshold = Math.max(diagonal * 0.005, 1e-4);
        }
        const hits = raycaster.intersectObject(target, false);
        return hits.length ? hits[0].point.clone() : null;
    }

    function addSelectionMarker(point, index) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([point.x, point.y, point.z], 3));
        const colors = [0xff5c5c, 0x63e67b, 0x66a3ff];
        const material = new THREE.PointsMaterial({
            color: colors[index],
            size: 18 / renderer.getPixelRatio(),
            sizeAttenuation: false,
            map: getSelectionMarkerTexture(),
            transparent: true,
            alphaTest: 0.5,
            depthTest: false,
            depthWrite: false
        });
        const marker = new THREE.Points(geometry, material);
        marker.renderOrder = 1000;
        selectionMarkers.add(marker);
    }

    function getSelectionMarkerTexture() {
        if (selectionMarkerTexture) return selectionMarkerTexture;
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, 64, 64);
        context.fillStyle = '#ffffff';
        context.beginPath();
        context.arc(32, 32, 28, 0, Math.PI * 2);
        context.fill();
        selectionMarkerTexture = new THREE.CanvasTexture(canvas);
        selectionMarkerTexture.needsUpdate = true;
        return selectionMarkerTexture;
    }

    function previewOrbitPlane() {
        const p0 = orbitPlanePoints[0], p1 = orbitPlanePoints[1], p2 = orbitPlanePoints[2];
        const edge1 = new THREE.Vector3().subVectors(p1, p0);
        const edge2 = new THREE.Vector3().subVectors(p2, p0);
        const edge3 = new THREE.Vector3().subVectors(p2, p1);
        const normal = new THREE.Vector3().crossVectors(edge1, edge2);
        const maxEdge = Math.max(edge1.length(), edge2.length(), edge3.length());

        if (!(maxEdge > 0) || normal.length() < maxEdge * maxEdge * 1e-4) {
            clearSelectionMarkers();
            orbitPlanePoints = [];
            updateOrbitPlaneUI('The points are nearly collinear. Select 3 wider-spaced points.', true, false);
            return;
        }

        normal.normalize();
        const selectedCenter = p0.clone().add(p1).add(p2).multiplyScalar(1 / 3);
        const pivotCenter = getInitialOrbitCenter();
        const frontReference = hasValidIntrinsics(currentIntrinsics)
            ? selectedCenter.clone().negate()
            : camera.position.clone().sub(selectedCenter);
        // Point order only changes the sign. Prefer the estimated source-camera
        // side so Reset View always returns to the selected plane's front side.
        if (normal.dot(frontReference) < 0) normal.negate();

        pendingOrbitPlane = { center: pivotCenter.clone(), normal: normal.clone(), size: maxEdge };
        showOrbitPlaneHelper(pivotCenter, normal, maxEdge);

        orbitPlaneSelectionActive = false;
        orbitPlanePoints = [];
        renderer.domElement.classList.remove('selecting-orbit-plane');
        updateOrbitPlaneUI('Review the preview grid, then use or cancel it.', true, true);
    }

    function useHorizontalGrid() {
        if (!pendingOrbitPlane) return;
        activeOrbitPlane = {
            center: pendingOrbitPlane.center.clone(),
            normal: pendingOrbitPlane.normal.clone()
        };

        const cameraOffset = camera.position.clone().sub(activeOrbitPlane.center);
        const side = cameraOffset.dot(activeOrbitPlane.normal);
        if (side < 0) {
            cameraOffset.addScaledVector(activeOrbitPlane.normal, -2 * side);
            camera.position.copy(activeOrbitPlane.center).add(cameraOffset);
        }
        camera.up.set(0, 1, 0);
        // OrbitControls r128 caches the up-axis transform at construction.
        createOrbitControls(activeOrbitPlane.center, false);
        camera.lookAt(activeOrbitPlane.center);
        controls.update();
        cancelOrbitPlaneAdjustment(true);
    }

    function showOrbitPlaneHelper(center, normal, selectedSize) {
        clearOrbitPlaneHelper();
        const bounds = calculateBounds(currentWorldPosData.data);
        const sceneDiagonal = Math.hypot(
            bounds.maxX - bounds.minX,
            bounds.maxY - bounds.minY,
            bounds.maxZ - bounds.minZ
        );
        const size = Math.max(selectedSize * 2, sceneDiagonal * 0.25, 1e-3);
        const offset = Math.max(sceneDiagonal * 0.001, 1e-5);
        const helperCenter = center.clone().addScaledVector(normal, offset);

        orbitPlaneGrid = new THREE.GridHelper(size, 20, 0xffd54f, 0x6f7890);
        orbitPlaneGrid.position.copy(helperCenter);
        orbitPlaneGrid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        orbitPlaneGrid.material.transparent = true;
        orbitPlaneGrid.material.opacity = 0.7;
        orbitPlaneGrid.renderOrder = 900;
        scene.add(orbitPlaneGrid);

        orbitPlaneUpArrow = new THREE.ArrowHelper(normal, helperCenter, size * 0.3, 0xffd54f, size * 0.06, size * 0.035);
        orbitPlaneUpArrow.renderOrder = 901;
        scene.add(orbitPlaneUpArrow);
    }

    function getSceneDiagonal() {
        if (!currentWorldPosData) return 1;
        const bounds = calculateBounds(currentWorldPosData.data);
        return Math.hypot(
            bounds.maxX - bounds.minX,
            bounds.maxY - bounds.minY,
            bounds.maxZ - bounds.minZ
        );
    }

    // ---- 表示モード切替 ----
    function setPointsMode(on) {
        isPointsMode = on;
        createMesh(true);
    }
    function setPointSize(px) {
        pointSize = px;
        if (pointsMesh && pointsMesh.material) {
            pointsMesh.material.size = pointSize / renderer.getPixelRatio();
            pointsMesh.material.needsUpdate = true;
        }
    }
    function toggleWireframe() {
        isWireframeMode = !isWireframeMode;
        if (mesh) mesh.material.wireframe = isWireframeMode;
        if (backfillMesh && backfillMesh.isMesh) backfillMesh.material.wireframe = isWireframeMode;
        if (fillBMesh) fillBMesh.material.wireframe = isWireframeMode;
        return isWireframeMode;
    }
    function setLighting(disabled) { disableLighting = disabled; updateMaterial(); }
    function setColorDisabled(disabled) { disableColor = disabled; createMesh(true); }
    function isPoints() { return isPointsMode; }

    // ---- エクスポート ----
    function getAlignmentTransform() {
        return {
            center: activeOrbitPlane ? activeOrbitPlane.center : new THREE.Vector3(),
            rotation: activeOrbitPlane
                ? new THREE.Quaternion().setFromUnitVectors(activeOrbitPlane.normal, new THREE.Vector3(0, 1, 0))
                : new THREE.Quaternion()
        };
    }

    function getAlignedWorldPositions(data) {
        const out = new Float32Array(data.length);
        const alignment = getAlignmentTransform();
        const point = new THREE.Vector3();
        for (let i = 0; i < data.length; i += 4) {
            const x = data[i], y = data[i + 1], z = data[i + 2];
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                point.set(x, y, z).sub(alignment.center).applyQuaternion(alignment.rotation);
                out[i] = point.x; out[i + 1] = point.y; out[i + 2] = point.z; out[i + 3] = data[i + 3];
            } else {
                out[i] = x; out[i + 1] = y; out[i + 2] = z; out[i + 3] = data[i + 3];
            }
        }
        return out;
    }

    async function exportOBJ() {
        const target = mesh || pointsMesh;
        if (!target) { alert('No mesh is loaded.'); return; }
        if (!currentColorTexture) { alert('No texture is available for OBJ export.'); return; }
        const base = sanitizeFileBase((currentBaseName || 'mesh').replace(/_worldposition$/, ''));
        const objName = `${base}.obj`;
        const mtlName = `${base}.mtl`;
        const textureName = `${base}_texture.png`;
        const normalName = currentNormalTexture ? `${base}_normal.png` : null;
        const backfillTextureName = currentBackfillLayer && backfillMesh ? `${base}_backfill_texture.png` : null;
        const fillBTextureName = currentFillBLayer && fillBMesh ? `${base}_fillb_texture.png` : null;
        const geometry = createCompactExportGeometry(target.geometry);
        if (!geometry || !geometry.index || geometry.index.count === 0) {
            alert('No valid mesh faces are available for OBJ export.');
            return;
        }
        let backfillGeometry = null;
        if (backfillMesh && currentBackfillLayer) {
            backfillGeometry = createCompactExportGeometry(backfillMesh.geometry);
            if (!backfillGeometry || !backfillGeometry.index || backfillGeometry.index.count === 0) {
                if (backfillGeometry) backfillGeometry.dispose();
                backfillGeometry = null;
            }
        }
        let fillBGeometry = null;
        if (fillBMesh && currentFillBLayer) {
            fillBGeometry = createCompactExportGeometry(fillBMesh.geometry);
            if (!fillBGeometry || !fillBGeometry.index || fillBGeometry.index.count === 0) {
                if (fillBGeometry) fillBGeometry.dispose();
                fillBGeometry = null;
            }
        }
        const objects = [
            { name: 'AlignedMesh', material: 'image_to_mesh_material', geometry }
        ];
        if (backfillGeometry && backfillTextureName) {
            objects.push({ name: 'BackfillMesh', material: 'backfill_material', geometry: backfillGeometry });
        }
        if (fillBGeometry && fillBTextureName) {
            objects.push({ name: 'FillBMesh', material: 'fillb_material', geometry: fillBGeometry });
        }
        const obj = createOBJText(objects, objName, mtlName);
        const mtl = createMTLText({
            textureName,
            normalName,
            backfillTextureName: backfillGeometry ? backfillTextureName : null,
            fillBTextureName: fillBGeometry ? fillBTextureName : null
        });
        try {
            const files = [
                { name: objName, data: encodeText(obj) },
                { name: mtlName, data: encodeText(mtl) },
                { name: textureName, data: await textureToPngBytes(currentColorTexture) }
            ];
            if (currentNormalTexture && normalName) {
                files.push({ name: normalName, data: await textureToPngBytes(currentNormalTexture) });
            }
            if (backfillGeometry && currentBackfillLayer && backfillTextureName) {
                files.push({ name: backfillTextureName, data: await textureToPngBytes(currentBackfillLayer.colorTex) });
            }
            if (fillBGeometry && currentFillBLayer && fillBTextureName) {
                files.push({ name: fillBTextureName, data: await textureToPngBytes(currentFillBLayer.colorTex) });
            }
            const zip = createZip(files);
            downloadBlob(new Blob([zip], { type: 'application/zip' }), `${base}_obj.zip`);
        } catch (error) {
            console.error(error);
            alert('OBJ ZIP export failed: ' + (error && error.message ? error.message : error));
        } finally {
            geometry.dispose();
            if (backfillGeometry) backfillGeometry.dispose();
            if (fillBGeometry) fillBGeometry.dispose();
        }
    }

    function createOBJText(objects, objName, mtlName) {
        let obj = '# World Position Mesh\n# Exported from Image to Mesh Web\n';
        obj += `# Package: ${objName}\n`;
        if (activeOrbitPlane) obj += '# Aligned to the selected horizontal grid: center=origin, normal=+Y\n';
        obj += `mtllib ${mtlName}\n`;
        let vertexOffset = 0;
        let uvOffset = 0;
        let normalOffset = 0;
        for (const item of objects) {
            const geometry = item.geometry;
            const positions = geometry.attributes.position.array;
            const uvs = geometry.attributes.uv.array;
            const normals = geometry.attributes.normal ? geometry.attributes.normal.array : null;
            const indices = geometry.index ? geometry.index.array : null;

            obj += `\no ${item.name}\n`;
            for (let i = 0; i < positions.length; i += 3) {
                obj += `v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}\n`;
            }
            obj += '\n';
            for (let i = 0; i < uvs.length; i += 2) {
                obj += `vt ${uvs[i]} ${uvs[i + 1]}\n`;
            }
            obj += '\n';
            if (normals) {
                for (let i = 0; i < normals.length; i += 3) {
                    obj += `vn ${normals[i]} ${normals[i + 1]} ${normals[i + 2]}\n`;
                }
                obj += '\n';
            }
            obj += `usemtl ${item.material}\n`;
            obj += 's 1\n';
            if (indices) {
                for (let i = 0; i < indices.length; i += 3) {
                    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
                    const i1 = a + 1 + vertexOffset, i2 = b + 1 + vertexOffset, i3 = c + 1 + vertexOffset;
                    const t1 = a + 1 + uvOffset, t2 = b + 1 + uvOffset, t3 = c + 1 + uvOffset;
                    if (normals) {
                        const n1 = a + 1 + normalOffset, n2 = b + 1 + normalOffset, n3 = c + 1 + normalOffset;
                        obj += `f ${i1}/${t1}/${n1} ${i2}/${t2}/${n2} ${i3}/${t3}/${n3}\n`;
                    } else {
                        obj += `f ${i1}/${t1} ${i2}/${t2} ${i3}/${t3}\n`;
                    }
                }
            }
            vertexOffset += positions.length / 3;
            uvOffset += uvs.length / 2;
            normalOffset += normals ? normals.length / 3 : 0;
        }
        return obj;
    }

    function createMTLText({ textureName, normalName, backfillTextureName, fillBTextureName }) {
        let mtl = 'newmtl image_to_mesh_material\n';
        mtl += 'Ka 1 1 1\n';
        mtl += 'Kd 1 1 1\n';
        mtl += 'Ks 0 0 0\n';
        mtl += 'd 1\n';
        mtl += 'illum 2\n';
        mtl += `map_Kd ${textureName}\n`;
        if (normalName) {
            mtl += `map_Bump ${normalName}\n`;
            mtl += `bump ${normalName}\n`;
            mtl += `norm ${normalName}\n`;
        }
        if (backfillTextureName) {
            mtl += '\nnewmtl backfill_material\n';
            mtl += 'Ka 1 1 1\n';
            mtl += 'Kd 1 1 1\n';
            mtl += 'Ks 0 0 0\n';
            mtl += 'd 1\n';
            mtl += 'illum 2\n';
            mtl += `map_Kd ${backfillTextureName}\n`;
        }
        if (fillBTextureName) {
            mtl += '\nnewmtl fillb_material\n';
            mtl += 'Ka 1 1 1\n';
            mtl += 'Kd 1 1 1\n';
            mtl += 'Ks 0 0 0\n';
            mtl += 'd 1\n';
            mtl += 'illum 2\n';
            mtl += `map_Kd ${fillBTextureName}\n`;
        }
        return mtl;
    }

    function sanitizeFileBase(value) {
        return String(value || 'mesh')
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, '_')
            .replace(/^_+|_+$/g, '') || 'mesh';
    }

    function encodeText(text) {
        return new TextEncoder().encode(text);
    }

    function textureToPngBytes(source) {
        return new Promise((resolve, reject) => {
            const canvas = document.createElement('canvas');
            canvas.width = source.width;
            canvas.height = source.height;
            const context = canvas.getContext('2d');
            const pixels = new Uint8ClampedArray(source.data);
            context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('Failed to encode texture PNG.'));
                    return;
                }
                blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
            }, 'image/png');
        });
    }

    function makeCrcTable() {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c >>> 0;
        }
        return table;
    }

    const crcTable = makeCrcTable();

    function crc32(data) {
        let c = 0xffffffff;
        for (let i = 0; i < data.length; i++) {
            c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
        }
        return (c ^ 0xffffffff) >>> 0;
    }

    function createZip(files) {
        const localParts = [];
        const centralParts = [];
        let offset = 0;
        for (const file of files) {
            const name = encodeText(file.name);
            const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
            const crc = crc32(data);

            const local = new ArrayBuffer(30 + name.length);
            const lv = new DataView(local);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);
            lv.setUint16(6, 0, true);
            lv.setUint16(8, 0, true);
            lv.setUint16(10, 0, true);
            lv.setUint16(12, 0, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, data.length, true);
            lv.setUint32(22, data.length, true);
            lv.setUint16(26, name.length, true);
            lv.setUint16(28, 0, true);
            new Uint8Array(local, 30).set(name);
            localParts.push(new Uint8Array(local), data);

            const central = new ArrayBuffer(46 + name.length);
            const cv = new DataView(central);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);
            cv.setUint16(6, 20, true);
            cv.setUint16(8, 0, true);
            cv.setUint16(10, 0, true);
            cv.setUint16(12, 0, true);
            cv.setUint16(14, 0, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, data.length, true);
            cv.setUint32(24, data.length, true);
            cv.setUint16(28, name.length, true);
            cv.setUint16(30, 0, true);
            cv.setUint16(32, 0, true);
            cv.setUint16(34, 0, true);
            cv.setUint16(36, 0, true);
            cv.setUint32(38, 0, true);
            cv.setUint32(42, offset, true);
            new Uint8Array(central, 46).set(name);
            centralParts.push(new Uint8Array(central));

            offset += local.byteLength + data.length;
        }

        const centralOffset = offset;
        const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
        const end = new ArrayBuffer(22);
        const ev = new DataView(end);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);
        ev.setUint16(6, 0, true);
        ev.setUint16(8, files.length, true);
        ev.setUint16(10, files.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, centralOffset, true);
        ev.setUint16(20, 0, true);

        const totalSize = centralOffset + centralSize + end.byteLength;
        const out = new Uint8Array(totalSize);
        let cursor = 0;
        for (const part of localParts.concat(centralParts, [new Uint8Array(end)])) {
            out.set(part, cursor);
            cursor += part.length;
        }
        return out;
    }

    function exportGLB() {
        const source = mesh || pointsMesh;
        if (!source) { alert('No mesh is loaded.'); return; }
        if (!THREE.GLTFExporter) { alert('GLTFExporter failed to load.'); return; }

        const exportScene = new THREE.Scene();
        exportScene.name = 'ImageToMeshScene';
        const exportGeometry = createCompactExportGeometry(source.geometry);
        if (!exportGeometry || !exportGeometry.index || exportGeometry.index.count === 0) {
            alert('No valid mesh faces are available for GLB export.');
            return;
        }

        const exportTexture = createGLBTexture(currentColorTexture, true);
        const exportNormalTexture = createGLBTexture(currentNormalTexture, false);
        const exportMaterial = new THREE.MeshStandardMaterial({
            color: 0x000000,
            emissive: 0xffffff,
            emissiveMap: exportTexture,
            metalness: 1.0,
            roughness: 1.0,
            normalMap: exportNormalTexture,
            side: THREE.DoubleSide
        });
        const exportMesh = new THREE.Mesh(exportGeometry, exportMaterial);
        exportMesh.name = 'AlignedMesh';
        exportScene.add(exportMesh);

        // 遮蔽穴インペイントの第2レイヤーも同じ整列でエクスポート
        let backfillGeometry = null, backfillMaterial = null, backfillGlbTexture = null;
        if (backfillMesh && currentBackfillLayer) {
            backfillGeometry = createCompactExportGeometry(backfillMesh.geometry);
            if (backfillGeometry && backfillGeometry.index && backfillGeometry.index.count > 0) {
                backfillGlbTexture = createGLBTexture(currentBackfillLayer.colorTex, true);
                backfillMaterial = new THREE.MeshStandardMaterial({
                    color: 0x000000,
                    emissive: 0xffffff,
                    emissiveMap: backfillGlbTexture,
                    metalness: 1.0,
                    roughness: 1.0,
                    side: THREE.DoubleSide
                });
                const backfillExportMesh = new THREE.Mesh(backfillGeometry, backfillMaterial);
                backfillExportMesh.name = 'BackfillMesh';
                exportScene.add(backfillExportMesh);
            }
        }

        // 最奥バックドロップ層（FillB）も同じ整列でエクスポート
        let fillBGeometry = null, fillBMaterial = null, fillBGlbTexture = null;
        if (fillBMesh && currentFillBLayer) {
            fillBGeometry = createCompactExportGeometry(fillBMesh.geometry);
            if (fillBGeometry && fillBGeometry.index && fillBGeometry.index.count > 0) {
                fillBGlbTexture = createGLBTexture(currentFillBLayer.colorTex, true);
                fillBMaterial = new THREE.MeshStandardMaterial({
                    color: 0x000000,
                    emissive: 0xffffff,
                    emissiveMap: fillBGlbTexture,
                    metalness: 1.0,
                    roughness: 1.0,
                    side: THREE.DoubleSide
                });
                const fillBExportMesh = new THREE.Mesh(fillBGeometry, fillBMaterial);
                fillBExportMesh.name = 'FillBMesh';
                exportScene.add(fillBExportMesh);
            }
        }

        addExportCameras(exportScene);
        const exporter = new THREE.GLTFExporter();
        const cleanup = () => {
            exportGeometry.dispose();
            exportMaterial.dispose();
            if (exportTexture) exportTexture.dispose();
            if (exportNormalTexture) exportNormalTexture.dispose();
            if (backfillGeometry) backfillGeometry.dispose();
            if (backfillMaterial) backfillMaterial.dispose();
            if (backfillGlbTexture) backfillGlbTexture.dispose();
            if (fillBGeometry) fillBGeometry.dispose();
            if (fillBMaterial) fillBMaterial.dispose();
            if (fillBGlbTexture) fillBGlbTexture.dispose();
        };
        try {
            exporter.parse(exportScene, (result) => {
                downloadBlob(
                    new Blob([result], { type: 'model/gltf-binary' }),
                    `${(currentBaseName || 'scene').replace(/_worldposition$/, '')}_scene.glb`
                );
                cleanup();
            }, { binary: true, onlyVisible: true, truncateDrawRange: true });
        } catch (error) {
            cleanup();
            console.error(error);
            alert('GLB export failed: ' + (error && error.message ? error.message : error));
        }
    }

    function createCompactExportGeometry(sourceGeometry) {
        const positions = sourceGeometry.attributes.position.array;
        const uvs = sourceGeometry.attributes.uv ? sourceGeometry.attributes.uv.array : null;
        const sourceIndices = sourceGeometry.index ? sourceGeometry.index.array : null;
        if (!sourceIndices) return null;

        const alignment = getAlignmentTransform();
        const remap = new Map();
        const outPositions = [];
        const outUVs = [];
        const outIndices = [];
        const point = new THREE.Vector3();

        for (let i = 0; i < sourceIndices.length; i++) {
            const sourceIndex = sourceIndices[i];
            let exportIndex = remap.get(sourceIndex);
            if (exportIndex == null) {
                const pi = sourceIndex * 3;
                const x = positions[pi], y = positions[pi + 1], z = positions[pi + 2];
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
                point.set(x, y, z).sub(alignment.center).applyQuaternion(alignment.rotation);
                exportIndex = outPositions.length / 3;
                remap.set(sourceIndex, exportIndex);
                outPositions.push(point.x, point.y, point.z);
                if (uvs) outUVs.push(uvs[sourceIndex * 2], uvs[sourceIndex * 2 + 1]);
            }
            outIndices.push(exportIndex);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(outPositions, 3));
        if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(outUVs, 2));
        geometry.setIndex(outIndices);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        return geometry;
    }

    function createGLBTexture(source, isColor) {
        if (!source) return null;
        const canvas = document.createElement('canvas');
        canvas.width = source.width;
        canvas.height = source.height;
        const context = canvas.getContext('2d');
        const pixels = new Uint8ClampedArray(source.data);
        context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
        const texture = new THREE.CanvasTexture(canvas);
        texture.flipY = true;
        if (isColor) texture.encoding = THREE.sRGBEncoding;
        texture.needsUpdate = true;
        return texture;
    }

    function addExportCameras(exportScene) {
        const alignment = getAlignmentTransform();
        const transformPoint = (value) => value.clone().sub(alignment.center).applyQuaternion(alignment.rotation);
        const transformDirection = (value) => value.clone().applyQuaternion(alignment.rotation).normalize();

        const viewCamera = camera.clone();
        viewCamera.name = 'CurrentViewCamera';
        viewCamera.position.copy(transformPoint(camera.position));
        viewCamera.up.copy(transformDirection(camera.up));
        viewCamera.lookAt(transformPoint(controls.target));
        viewCamera.updateProjectionMatrix();
        exportScene.add(viewCamera);

        if (hasValidIntrinsics(currentIntrinsics) && currentWorldPosData) {
            const sourceFov = THREE.MathUtils.radToDeg(2 * Math.atan(0.5 / currentIntrinsics.fy));
            const sourceCamera = new THREE.PerspectiveCamera(
                sourceFov,
                currentWorldPosData.width / currentWorldPosData.height,
                camera.near,
                camera.far
            );
            sourceCamera.name = 'EstimatedSourceCamera';
            const bounds = calculateBounds(currentWorldPosData.data);
            const sourceTarget = new THREE.Vector3(0, 0, (bounds.minZ + bounds.maxZ) * 0.5);
            sourceCamera.position.copy(transformPoint(new THREE.Vector3()));
            sourceCamera.up.copy(transformDirection(new THREE.Vector3(0, 1, 0)));
            sourceCamera.lookAt(transformPoint(sourceTarget));
            sourceCamera.updateProjectionMatrix();
            exportScene.add(sourceCamera);
        }
    }

    function exportPNG() {
        if (!mesh && !pointsMesh) { alert('No mesh is loaded.'); return; }
        const exportSize = 2048;
        const currentAspect = camera.aspect;
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = exportSize;
        exportCanvas.height = exportSize;
        const exportRenderer = new THREE.WebGLRenderer({ canvas: exportCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
        exportRenderer.setSize(exportSize, exportSize, false);
        exportRenderer.setPixelRatio(1);
        exportRenderer.setClearColor(0x000000, 0);
        exportRenderer.outputEncoding = THREE.sRGBEncoding;
        camera.aspect = 1.0;
        camera.updateProjectionMatrix();
        exportRenderer.render(scene, camera);
        camera.aspect = currentAspect;
        camera.updateProjectionMatrix();
        exportCanvas.toBlob((blob) => {
            let filename = (currentBaseName || 'capture').replace(/_worldposition$/, '');
            downloadBlob(blob, `${filename}_cap.png`);
            exportRenderer.dispose();
        }, 'image/png');
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    return {
        init, setData, setBackfillLayer, setBackfillParallaxCutK, setFillBLayer, resetCamera, toggleOrbitCenterSelection,
        toggleHorizontalGridAdjustment, useHorizontalGrid,
        setPointsMode, setPointSize, toggleWireframe,
        setLighting, setColorDisabled, isPoints,
        getAlignedWorldPositions, exportOBJ, exportGLB, exportPNG
    };
})();
