// viewer.js — three.js World Position メッシュビューア
// 参照元 viewer/js/main.js を移植し、ドロップ非依存の API (Viewer.setData) に再構成。

const Viewer = (function () {
    let scene, camera, renderer, controls;
    let mesh, pointsMesh;
    let currentWorldPosData = null;   // { data: Float32Array(H*W*4) RGBA=XYZ+1, width, height }
    let currentColorTexture = null;   // { data: Uint8Array RGBA, width, height }
    let currentTextureObject = null;  // THREE.DataTexture cache
    let currentBaseName = '';
    let currentIntrinsics = null;     // normalized { fx, fy, cx, cy }
    let raycaster, pointerNdc, selectionMarkers;
    let orbitPlaneGrid = null;
    let orbitPlaneUpArrow = null;
    let orbitPlanePoints = [];
    let orbitPlaneSelectionActive = false;
    let orbitPlaneAdjustmentOpen = false;
    let activeOrbitPlane = null;
    let pendingOrbitPlane = null;
    let pointerDownPosition = null;

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

        createOrbitControls(new THREE.Vector3(), false);

        raycaster = new THREE.Raycaster();
        pointerNdc = new THREE.Vector2();
        selectionMarkers = new THREE.Group();
        scene.add(selectionMarkers);
        canvas.addEventListener('pointerdown', onSelectionPointerDown);
        canvas.addEventListener('pointerup', onSelectionPointerUp);
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && orbitPlaneAdjustmentOpen) cancelOrbitPlaneAdjustment(true);
        });

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
        if (controls) controls.update();
        if (renderer) renderer.render(scene, camera);
    }

    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // 外部から推論結果を受け取る
    // worldPos: Float32Array(H*W*4) RGBA(=XYZ+1), w/h: WP解像度
    // colorTex: { data: Uint8Array RGBA, width, height } | null
    function setData(worldPos, w, h, colorTex, baseName, intrinsics) {
        init();
        currentWorldPosData = { data: worldPos, width: w, height: h };
        currentColorTexture = colorTex || null;
        currentTextureObject = null; // 再生成
        currentBaseName = baseName || 'mesh';
        currentIntrinsics = intrinsics || null;
        createMesh(false);
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

        for (let i = 0; i < positions.length; i += 3) {
            const vertexIndex = i / 3;
            const row = Math.floor(vertexIndex / meshWidth);
            const col = vertexIndex % meshWidth;

            const u = col / (meshWidth - 1);
            const v = row / (meshHeight - 1);
            const srcX = u * (width - 1);
            const srcY = v * (height - 1);

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
        removeInvalidAndDiscontinuousFaces(geometry, positions);
        updateFiniteGeometryBounds(geometry, positions);
        geometry.computeVertexNormals();

        // 頂点カラー（ポイントモード等で使用）
        if (currentColorTexture && !disableColor) {
            const colors = new Float32Array(positions.length);
            const uvs = geometry.attributes.uv.array;
            for (let i = 0; i < uvs.length / 2; i++) {
                const u = uvs[i * 2];
                const vv = uvs[i * 2 + 1];
                const texX = Math.floor(u * (currentColorTexture.width - 1));
                const texY = Math.floor((1 - vv) * (currentColorTexture.height - 1));
                const texIndex = (texY * currentColorTexture.width + texX) * 4;
                colors[i * 3] = currentColorTexture.data[texIndex] / 255;
                colors[i * 3 + 1] = currentColorTexture.data[texIndex + 1] / 255;
                colors[i * 3 + 2] = currentColorTexture.data[texIndex + 2] / 255;
            }
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }

        const material = createMaterial();

        if (mesh) { scene.remove(mesh); }
        if (pointsMesh) { scene.remove(pointsMesh); }

        if (isPointsMode) {
            const pm = createPointsMaterial();
            pointsMesh = new THREE.Points(geometry, pm);
            scene.add(pointsMesh);
            mesh = null;
        } else {
            mesh = new THREE.Mesh(geometry, material);
            mesh.material.wireframe = isWireframeMode;
            scene.add(mesh);
            pointsMesh = null;
        }

        const bounds = calculateBounds(worldPosData);
        updateMeshInfo(meshWidth, meshHeight, bounds);

        if (!skipCameraReset) resetCamera();
    }

    function createOrbitControls(target, frontSideOnly) {
        if (controls) controls.dispose();
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.screenSpacePanning = false;
        controls.minDistance = 0.1;
        controls.maxDistance = 1000;
        controls.minPolarAngle = frontSideOnly ? 0.001 : 0;
        controls.maxPolarAngle = frontSideOnly ? Math.PI * 0.5 - 0.001 : Math.PI;
        controls.target.copy(target);
    }

    // Do not connect masked pixels or surfaces separated by a large depth jump.
    // A regular image-grid mesh otherwise produces long sheets at silhouettes.
    function removeInvalidAndDiscontinuousFaces(geometry, positions) {
        if (!geometry.index) return;
        const source = geometry.index.array;
        const kept = [];
        const relativeDepthThreshold = 0.10;

        for (let i = 0; i < source.length; i += 3) {
            const a = source[i], b = source[i + 1], c = source[i + 2];
            const ai = a * 3, bi = b * 3, ci = c * 3;
            const az = positions[ai + 2], bz = positions[bi + 2], cz = positions[ci + 2];
            if (!Number.isFinite(positions[ai]) || !Number.isFinite(positions[ai + 1]) || !Number.isFinite(az) ||
                !Number.isFinite(positions[bi]) || !Number.isFinite(positions[bi + 1]) || !Number.isFinite(bz) ||
                !Number.isFinite(positions[ci]) || !Number.isFinite(positions[ci + 1]) || !Number.isFinite(cz)) {
                continue;
            }

            const minDepth = Math.min(Math.abs(az), Math.abs(bz), Math.abs(cz));
            const depthJump = Math.max(az, bz, cz) - Math.min(az, bz, cz);
            if (depthJump > relativeDepthThreshold * Math.max(minDepth, 1e-6)) continue;
            kept.push(a, b, c);
        }

        geometry.setIndex(kept);
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
        }
        return currentTextureObject;
    }

    function createMaterial() {
        const MaterialClass = disableLighting ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
        if (disableColor) {
            return new MaterialClass({ color: 0xffffff, side: THREE.DoubleSide, flatShading: false });
        } else if (currentColorTexture) {
            return new MaterialClass({ map: getTextureObject(), side: THREE.DoubleSide, flatShading: false });
        }
        return new MaterialClass({ color: 0x888888, side: THREE.DoubleSide, flatShading: false });
    }

    function createPointsMaterial() {
        const adjustedSize = pointSize / renderer.getPixelRatio();
        if (disableColor) {
            return new THREE.PointsMaterial({ color: 0xffffff, size: adjustedSize, sizeAttenuation: false, vertexColors: false });
        } else if (currentColorTexture) {
            const tex = getTextureObject();
            if (tex) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.needsUpdate = true; }
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
        const adjustedPlane = activeOrbitPlane;
        camera.up.copy(adjustedPlane ? adjustedPlane.normal : new THREE.Vector3(0, 1, 0));
        createOrbitControls(adjustedPlane ? adjustedPlane.center : new THREE.Vector3(), !!adjustedPlane);
        if (hasValidIntrinsics(currentIntrinsics) && bounds.minZ > 0) {
            // WorldPos flips camera X/Y while preserving Z. Looking from the
            // estimated camera origin toward +Z therefore reproduces the source
            // image orientation instead of showing the mesh from its back/side.
            const sourceVfov = 2 * Math.atan(0.5 / currentIntrinsics.fy);
            const sourceHfov = 2 * Math.atan(0.5 / currentIntrinsics.fx);
            const vfovForWidth = 2 * Math.atan(Math.tan(sourceHfov * 0.5) / camera.aspect);
            camera.fov = THREE.MathUtils.radToDeg(Math.max(sourceVfov, vfovForWidth)) * 1.02;
            camera.position.set(0, 0, 0);
            if (adjustedPlane) controls.target.copy(adjustedPlane.center);
            else controls.target.set(0, 0, center.z);
        } else {
            // Fallback for imported/invalid data: fit the bounds from the same
            // front side as the source camera, without the previous X/Y offset.
            camera.fov = 60;
            const vfov = THREE.MathUtils.degToRad(camera.fov);
            const hfov = 2 * Math.atan(Math.tan(vfov * 0.5) * camera.aspect);
            const fitDistance = Math.max(
                size.y * 0.5 / Math.tan(vfov * 0.5),
                size.x * 0.5 / Math.tan(hfov * 0.5)
            ) * 1.1;
            const distance = Math.max(fitDistance, size.z * 0.5 + Math.max(fitDistance * 0.05, 1e-3));
            camera.position.set(center.x, center.y, center.z - distance);
            controls.target.copy(adjustedPlane ? adjustedPlane.center : center);
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

    function hasValidIntrinsics(value) {
        return value && Number.isFinite(value.fx) && value.fx > 0 &&
            Number.isFinite(value.fy) && value.fy > 0;
    }

    // ---- 3-point orbit plane calibration ----
    function toggleHorizontalGridAdjustment() {
        if (!mesh && !pointsMesh) return;
        if (orbitPlaneAdjustmentOpen) {
            cancelOrbitPlaneAdjustment(true);
            return;
        }

        orbitPlaneAdjustmentOpen = true;
        orbitPlaneSelectionActive = true;
        pendingOrbitPlane = null;
        orbitPlanePoints = [];
        clearSelectionMarkers();

        const currentCenter = activeOrbitPlane ? activeOrbitPlane.center : controls.target;
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
        if (!orbitPlaneSelectionActive || event.button !== 0) return;
        pointerDownPosition = { x: event.clientX, y: event.clientY };
    }

    function onSelectionPointerUp(event) {
        if (!orbitPlaneSelectionActive || event.button !== 0 || !pointerDownPosition) return;
        const dx = event.clientX - pointerDownPosition.x;
        const dy = event.clientY - pointerDownPosition.y;
        pointerDownPosition = null;
        if (dx * dx + dy * dy > 16) return;

        const target = isPointsMode ? pointsMesh : mesh;
        if (!target) return;
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
        if (!hits.length) {
            updateOrbitPlaneUI(`No surface at that position (${orbitPlanePoints.length + 1}/3).`, true, false);
            return;
        }

        const point = hits[0].point.clone();
        orbitPlanePoints.push(point);
        addSelectionMarker(point, orbitPlanePoints.length - 1);
        if (orbitPlanePoints.length < 3) {
            updateOrbitPlaneUI(`Select a point on the horizontal plane (${orbitPlanePoints.length + 1}/3).`, true, false);
            return;
        }
        previewOrbitPlane();
    }

    function addSelectionMarker(point, index) {
        const bounds = calculateBounds(currentWorldPosData.data);
        const diagonal = Math.hypot(
            bounds.maxX - bounds.minX,
            bounds.maxY - bounds.minY,
            bounds.maxZ - bounds.minZ
        );
        const geometry = new THREE.SphereGeometry(Math.max(diagonal * 0.008, 1e-4), 16, 12);
        const colors = [0xff5c5c, 0x63e67b, 0x66a3ff];
        const material = new THREE.MeshBasicMaterial({ color: colors[index], depthTest: false });
        const marker = new THREE.Mesh(geometry, material);
        marker.position.copy(point);
        marker.renderOrder = 1000;
        selectionMarkers.add(marker);
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
        const center = p0.clone().add(p1).add(p2).multiplyScalar(1 / 3);
        const frontReference = hasValidIntrinsics(currentIntrinsics)
            ? center.clone().negate()
            : camera.position.clone().sub(center);
        // Point order only changes the sign. Prefer the estimated source-camera
        // side so Reset View always returns to the selected plane's front side.
        if (normal.dot(frontReference) < 0) normal.negate();

        pendingOrbitPlane = { center: center.clone(), normal: normal.clone(), size: maxEdge };
        showOrbitPlaneHelper(center, normal, maxEdge);

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
        camera.up.copy(activeOrbitPlane.normal);
        // OrbitControls r128 caches the up-axis transform at construction.
        createOrbitControls(activeOrbitPlane.center, true);
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

    function exportOBJ() {
        const target = mesh || pointsMesh;
        if (!target) { alert('No mesh is loaded.'); return; }
        const geometry = target.geometry;
        const positions = geometry.attributes.position.array;
        const uvs = geometry.attributes.uv.array;
        const indices = geometry.index ? geometry.index.array : null;
        const alignment = getAlignmentTransform();
        const exportRotation = activeOrbitPlane ? alignment.rotation : null;
        const exportPoint = new THREE.Vector3();

        let obj = '# World Position Mesh\n# Exported from Image to Mesh Web\n\n';
        if (activeOrbitPlane) obj += '# Aligned to the selected horizontal grid: center=origin, normal=+Y\n\n';
        for (let i = 0; i < positions.length; i += 3) {
            let x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (exportRotation && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                exportPoint.set(x, y, z)
                    .sub(alignment.center)
                    .applyQuaternion(exportRotation);
                x = exportPoint.x; y = exportPoint.y; z = exportPoint.z;
            }
            obj += `v ${x} ${y} ${z}\n`;
        }
        obj += '\n';
        for (let i = 0; i < uvs.length; i += 2) {
            obj += `vt ${uvs[i]} ${uvs[i + 1]}\n`;
        }
        obj += '\n';
        if (indices) {
            for (let i = 0; i < indices.length; i += 3) {
                const i1 = indices[i] + 1, i2 = indices[i + 1] + 1, i3 = indices[i + 2] + 1;
                obj += `f ${i1}/${i1} ${i2}/${i2} ${i3}/${i3}\n`;
            }
        }
        const fname = (currentBaseName || 'mesh').replace(/_worldposition$/, '') + '.obj';
        downloadBlob(new Blob([obj], { type: 'text/plain' }), fname);
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

        const exportTexture = createGLBTexture();
        const exportMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            map: exportTexture,
            side: THREE.DoubleSide
        });
        const exportMesh = new THREE.Mesh(exportGeometry, exportMaterial);
        exportMesh.name = 'AlignedMesh';
        exportScene.add(exportMesh);

        addExportCameras(exportScene);
        const exporter = new THREE.GLTFExporter();
        const cleanup = () => {
            exportGeometry.dispose();
            exportMaterial.dispose();
            if (exportTexture) exportTexture.dispose();
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

    function createGLBTexture() {
        if (!currentColorTexture) return null;
        const canvas = document.createElement('canvas');
        canvas.width = currentColorTexture.width;
        canvas.height = currentColorTexture.height;
        const context = canvas.getContext('2d');
        const pixels = new Uint8ClampedArray(currentColorTexture.data);
        context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
        const texture = new THREE.CanvasTexture(canvas);
        texture.flipY = true;
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
        init, setData, resetCamera,
        toggleHorizontalGridAdjustment, useHorizontalGrid,
        setPointsMode, setPointSize, toggleWireframe,
        setLighting, setColorDisabled, isPoints,
        getAlignedWorldPositions, exportOBJ, exportGLB, exportPNG
    };
})();
