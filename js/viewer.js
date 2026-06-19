// viewer.js — three.js World Position メッシュビューア
// 参照元 viewer/js/main.js を移植し、ドロップ非依存の API (Viewer.setData) に再構成。

const Viewer = (function () {
    let scene, camera, renderer, controls;
    let mesh, pointsMesh;
    let currentWorldPosData = null;   // { data: Float32Array(H*W*4) RGBA=XYZ+1, width, height }
    let currentColorTexture = null;   // { data: Uint8Array RGBA, width, height }
    let currentTextureObject = null;  // THREE.DataTexture cache
    let currentBaseName = '';

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

        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.screenSpacePanning = false;
        controls.minDistance = 0.1;
        controls.maxDistance = 1000;
        controls.maxPolarAngle = Math.PI;

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
    function setData(worldPos, w, h, colorTex, baseName) {
        init();
        currentWorldPosData = { data: worldPos, width: w, height: h };
        currentColorTexture = colorTex || null;
        currentTextureObject = null; // 再生成
        currentBaseName = baseName || 'mesh';
        createMesh(false);
    }

    function createMesh(skipCameraReset) {
        if (!currentWorldPosData) return;
        const { data: worldPosData, width, height } = currentWorldPosData;

        let meshWidth, meshHeight;
        if (currentColorTexture) {
            meshWidth = Math.min(currentColorTexture.width, 4096);
            meshHeight = Math.min(currentColorTexture.height, 4096);
        } else {
            meshWidth = Math.min(width, 4096);
            meshHeight = Math.min(height, 4096);
        }

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
        if (!target) return;
        const box = new THREE.Box3().setFromObject(target);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = camera.fov * (Math.PI / 180);
        let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.5;
        camera.position.set(center.x + cameraZ * 0.5, center.y + cameraZ * 0.7, center.z + cameraZ);
        camera.lookAt(center);
        controls.target.copy(center);
        controls.update();
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
    function exportOBJ() {
        const target = mesh || pointsMesh;
        if (!target) { alert('メッシュが読み込まれていません。'); return; }
        const geometry = target.geometry;
        const positions = geometry.attributes.position.array;
        const uvs = geometry.attributes.uv.array;
        const indices = geometry.index ? geometry.index.array : null;

        let obj = '# World Position Mesh\n# Exported from Image to Mesh Web\n\n';
        for (let i = 0; i < positions.length; i += 3) {
            obj += `v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}\n`;
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

    function exportPNG() {
        if (!mesh && !pointsMesh) { alert('メッシュが読み込まれていません。'); return; }
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
        setPointsMode, setPointSize, toggleWireframe,
        setLighting, setColorDisabled, isPoints,
        exportOBJ, exportPNG
    };
})();
