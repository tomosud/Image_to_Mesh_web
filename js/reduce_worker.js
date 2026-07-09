let meshoptSimplifierPromise = null;
const queue = [];
let running = false;

self.onmessage = (event) => {
    queue.push(event.data);
    if (!running) processQueue();
};

async function processQueue() {
    running = true;
    while (queue.length) {
        const request = queue.shift();
        try {
            const result = await reduceMesh(request);
            self.postMessage(result, [
                result.positions.buffer,
                result.uvs.buffer,
                result.normals.buffer,
                result.index.buffer
            ]);
        } catch (error) {
            self.postMessage({
                token: request && request.token,
                name: request && request.name,
                ok: false,
                message: error && error.message ? error.message : String(error)
            });
        }
    }
    running = false;
}

async function loadMeshoptSimplifier() {
    if (!meshoptSimplifierPromise) {
        meshoptSimplifierPromise = import('./vendor/meshopt_simplifier.js')
            .then(async (module) => {
                const simplifier = module.MeshoptSimplifier;
                if (!simplifier || simplifier.supported === false) throw new Error('MeshoptSimplifier is not supported');
                await simplifier.ready;
                return simplifier;
            });
    }
    return meshoptSimplifierPromise;
}

async function reduceMesh(request) {
    const started = performance.now();
    const simplifier = await loadMeshoptSimplifier();
    const params = request.params || {};
    const compact = createFiniteCompactMesh(request.positions, request.uvs, request.index);
    if (!compact || compact.index.length === 0) {
        throw new Error('No valid mesh faces are available for reduction.');
    }
    if (request.smooth) smoothBoundaryScreenSpace(compact, params);
    const reduced = simplifyCompactMesh(compact, simplifier, params);
    const artifactStats = request.smooth ? pruneBoundaryArtifacts(reduced, params) : { removedFaces: 0 };
    reduced.normals = computeVertexNormals(reduced.positions, reduced.index);
    const elapsed = performance.now() - started;
    return {
        token: request.token,
        name: request.name,
        ok: true,
        positions: reduced.positions,
        uvs: reduced.uvs,
        normals: reduced.normals,
        index: reduced.index,
        stats: {
            facesBefore: request.index.length / 3,
            facesAfter: reduced.index.length / 3,
            error: reduced.error,
            dispRef: reduced.dispRef,
            lockedBorderVerts: reduced.lockedBorderVerts,
            totalBorderVerts: reduced.totalBorderVerts,
            removedArtifactFaces: artifactStats.removedFaces,
            ms: elapsed
        }
    };
}

function createFiniteCompactMesh(sourcePositions, sourceUVs, sourceIndices) {
    const sourceVertexCount = sourcePositions.length / 3;
    const remap = new Int32Array(sourceVertexCount);
    remap.fill(-1);
    const positions = new Float32Array(sourceVertexCount * 3);
    const uvs = new Float32Array(sourceVertexCount * 2);
    const indices = new Uint32Array(sourceIndices.length);
    let vertexCount = 0;
    let indexCount = 0;

    for (let i = 0; i < sourceIndices.length; i += 3) {
        const a = sourceIndices[i], b = sourceIndices[i + 1], c = sourceIndices[i + 2];
        if (!isFiniteSourceVertex(sourcePositions, a) ||
            !isFiniteSourceVertex(sourcePositions, b) ||
            !isFiniteSourceVertex(sourcePositions, c)) {
            continue;
        }
        indices[indexCount++] = compactSourceVertex(a);
        indices[indexCount++] = compactSourceVertex(b);
        indices[indexCount++] = compactSourceVertex(c);
    }
    if (indexCount === 0) return null;

    return {
        positions: positions.slice(0, vertexCount * 3),
        uvs: uvs.slice(0, vertexCount * 2),
        index: indices.slice(0, indexCount)
    };

    function compactSourceVertex(sourceIndex) {
        let outIndex = remap[sourceIndex];
        if (outIndex >= 0) return outIndex;
        outIndex = vertexCount++;
        remap[sourceIndex] = outIndex;
        positions.set(sourcePositions.subarray(sourceIndex * 3, sourceIndex * 3 + 3), outIndex * 3);
        uvs.set(sourceUVs.subarray(sourceIndex * 2, sourceIndex * 2 + 2), outIndex * 2);
        return outIndex;
    }
}

function isFiniteSourceVertex(positions, vertexIndex) {
    const pi = vertexIndex * 3;
    return Number.isFinite(positions[pi]) &&
        Number.isFinite(positions[pi + 1]) &&
        Number.isFinite(positions[pi + 2]);
}

function smoothBoundaryScreenSpace(mesh, params) {
    if (!hasValidIntrinsics(params)) return;
    const positions = mesh.positions;
    const uvs = mesh.uvs;
    const index = mesh.index;
    const vertexCount = positions.length / 3;
    const boundaryNeighbors = collectBoundaryNeighbors(index, vertexCount);
    const u0 = new Float32Array(vertexCount);
    const v0 = new Float32Array(vertexCount);
    const u = new Float32Array(vertexCount);
    const v = new Float32Array(vertexCount);
    const zValues = new Float32Array(vertexCount);
    const movable = new Uint8Array(vertexCount);
    const dims = getGridSize(uvs, vertexCount, params);
    const maxStep = params.SMOOTH_CLAMP_CELLS;

    for (let i = 0; i < vertexCount; i++) {
        const pi = i * 3;
        const z = positions[pi + 2];
        zValues[i] = z;
        if (!Number.isFinite(z) || Math.abs(z) < 1e-8) {
            u0[i] = u[i] = uvs[i * 2];
            v0[i] = v[i] = 1 - uvs[i * 2 + 1];
            continue;
        }
        u0[i] = params.cx + (-positions[pi] / z) * params.fx;
        v0[i] = params.cy + (-positions[pi + 1] / z) * params.fy;
        u[i] = u0[i];
        v[i] = v0[i];
        if (!Number.isFinite(u0[i]) || !Number.isFinite(v0[i])) continue;
        const neighbors = boundaryNeighbors[i];
        if (!neighbors || neighbors.length !== 2) continue;
        if (isOuterFrameVertex(u0[i], v0[i], dims.width, dims.height)) continue;
        movable[i] = 1;
    }

    for (let iter = 0; iter < params.SMOOTH_ITERS; iter++) {
        const nextU = new Float32Array(u);
        const nextV = new Float32Array(v);
        for (let i = 0; i < vertexCount; i++) {
            if (!movable[i]) continue;
            const neighbors = boundaryNeighbors[i];
            const targetU = (u[neighbors[0]] + u[neighbors[1]]) * 0.5;
            const targetV = (v[neighbors[0]] + v[neighbors[1]]) * 0.5;
            let candidateU = u[i] + (targetU - u[i]) * params.SMOOTH_LAMBDA;
            let candidateV = v[i] + (targetV - v[i]) * params.SMOOTH_LAMBDA;
            const cellDx = (candidateU - u0[i]) * Math.max(1, dims.width - 1);
            const cellDy = (candidateV - v0[i]) * Math.max(1, dims.height - 1);
            const cellLen = Math.hypot(cellDx, cellDy);
            if (cellLen > maxStep) {
                const scale = maxStep / cellLen;
                candidateU = u0[i] + (candidateU - u0[i]) * scale;
                candidateV = v0[i] + (candidateV - v0[i]) * scale;
            }
            nextU[i] = candidateU;
            nextV[i] = candidateV;
        }
        u.set(nextU);
        v.set(nextV);
    }

    for (let i = 0; i < vertexCount; i++) {
        if (!movable[i]) continue;
        const du = u[i] - u0[i];
        const dv = v[i] - v0[i];
        if (Math.abs(du) < 1e-8 && Math.abs(dv) < 1e-8) continue;
        const pi = i * 3;
        const z = zValues[i];
        positions[pi] = -((u[i] - params.cx) / params.fx) * z;
        positions[pi + 1] = -((v[i] - params.cy) / params.fy) * z;
        uvs[i * 2] = Math.max(0, Math.min(1, uvs[i * 2] + du));
        uvs[i * 2 + 1] = Math.max(0, Math.min(1, uvs[i * 2 + 1] - dv));
    }
}

function hasValidIntrinsics(value) {
    return value &&
        Number.isFinite(value.fx) && Number.isFinite(value.fy) &&
        Number.isFinite(value.cx) && Number.isFinite(value.cy) &&
        value.fx !== 0 && value.fy !== 0;
}

const EDGE_KEY_STRIDE = 67108864;

function collectBoundaryNeighbors(index, vertexCount) {
    const edgeUse = new Map();
    const neighbors = Array.from({ length: vertexCount }, () => []);
    for (let i = 0; i < index.length; i += 3) {
        addEdgeUse(edgeUse, index[i], index[i + 1]);
        addEdgeUse(edgeUse, index[i + 1], index[i + 2]);
        addEdgeUse(edgeUse, index[i + 2], index[i]);
    }
    edgeUse.forEach((count, key) => {
        if (count !== 1) return;
        const a = Math.floor(key / EDGE_KEY_STRIDE);
        const b = key - a * EDGE_KEY_STRIDE;
        neighbors[a].push(b);
        neighbors[b].push(a);
    });
    return neighbors;
}

function addEdgeUse(edgeUse, a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * EDGE_KEY_STRIDE + hi;
    edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
}

function getGridSize(uvs, vertexCount, params) {
    if (Number.isFinite(params.gridW) && Number.isFinite(params.gridH) && params.gridW > 1 && params.gridH > 1) {
        return { width: params.gridW, height: params.gridH };
    }
    return inferGeometryGridSize(uvs, vertexCount);
}

function inferGeometryGridSize(uvs, vertexCount) {
    let minPositiveDu = Infinity;
    let minPositiveDv = Infinity;
    let prevU = uvs[0], prevV = uvs[1];
    for (let i = 1; i < vertexCount; i++) {
        const u = uvs[i * 2], v = uvs[i * 2 + 1];
        const du = Math.abs(u - prevU);
        const dv = Math.abs(v - prevV);
        if (du > 1e-7) minPositiveDu = Math.min(minPositiveDu, du);
        if (dv > 1e-7) minPositiveDv = Math.min(minPositiveDv, dv);
        prevU = u; prevV = v;
    }
    const width = Number.isFinite(minPositiveDu) ? Math.max(2, Math.round(1 / minPositiveDu)) : Math.max(2, Math.round(Math.sqrt(vertexCount)));
    const height = Number.isFinite(minPositiveDv) ? Math.max(2, Math.round(1 / minPositiveDv)) : Math.max(2, Math.round(vertexCount / width));
    return { width, height };
}

function isOuterFrameVertex(u, v, width, height) {
    const uPad = 1 / Math.max(1, width);
    const vPad = 1 / Math.max(1, height);
    return u <= uPad || u >= 1 - uPad || v <= vPad || v >= 1 - vPad;
}

function simplifyCompactMesh(mesh, simplifier, params) {
    const positions = mesh.positions;
    const uvs = mesh.uvs;
    const indices = mesh.index instanceof Uint32Array ? mesh.index : Uint32Array.from(mesh.index);
    const targetIndexCount = Math.max(3, Math.floor(indices.length * params.REDUCE_TARGET_RATIO / 3) * 3);
    const adaptive = createAdaptiveSimplifierInput(mesh, params);
    const simplifyPositions = adaptive.positions || positions;
    if (targetIndexCount >= indices.length) {
        return {
            positions,
            uvs,
            index: indices,
            error: undefined,
            dispRef: adaptive.dispRef,
            lockedBorderVerts: adaptive.lockedBorderVerts,
            totalBorderVerts: adaptive.totalBorderVerts
        };
    }

    const flags = adaptive.vertexLock ? [] : ['LockBorder'];
    const [newIndices, error] = simplifier.simplifyWithAttributes(
        indices,
        simplifyPositions,
        3,
        uvs,
        2,
        [params.REDUCE_UV_WEIGHT, params.REDUCE_UV_WEIGHT],
        adaptive.vertexLock,
        targetIndexCount,
        params.REDUCE_TARGET_ERROR,
        flags
    );
    const [remap, uniqueVertexCount] = simplifier.compactMesh(newIndices);
    const outPositions = new Float32Array(uniqueVertexCount * 3);
    const outUVs = new Float32Array(uniqueVertexCount * 2);
    for (let oldIndex = 0; oldIndex < remap.length; oldIndex++) {
        const newIndex = remap[oldIndex];
        if (newIndex === 0xffffffff || newIndex < 0) continue;
        outPositions.set(positions.subarray(oldIndex * 3, oldIndex * 3 + 3), newIndex * 3);
        outUVs.set(uvs.subarray(oldIndex * 2, oldIndex * 2 + 2), newIndex * 2);
    }
    const outIndices = new Uint32Array(newIndices.length);
    outIndices.set(newIndices);
    return {
        positions: outPositions,
        uvs: outUVs,
        index: outIndices,
        error,
        dispRef: adaptive.dispRef,
        lockedBorderVerts: adaptive.lockedBorderVerts,
        totalBorderVerts: adaptive.totalBorderVerts
    };
}

function createAdaptiveSimplifierInput(mesh, params) {
    const empty = {
        positions: null,
        vertexLock: null,
        dispRef: undefined,
        lockedBorderVerts: 0,
        totalBorderVerts: 0
    };
    if (!hasValidIntrinsics(params)) return empty;

    const positions = mesh.positions;
    const vertexCount = positions.length / 3;
    const dispRef = calculateMedianDisparity(positions);
    if (!Number.isFinite(dispRef) || dispRef <= 0) return empty;

    const dims = getGridSize(mesh.uvs, vertexCount, params);
    const longEdge = Math.max(dims.width, dims.height, 1);
    const warped = new Float32Array(positions.length);
    for (let i = 0; i < vertexCount; i++) {
        const pi = i * 3;
        const z = positions[pi + 2];
        const invZ = (Number.isFinite(z) && Math.abs(z) > 1e-8) ? 1 / Math.abs(z) : 0;
        const u01 = (Number.isFinite(z) && Math.abs(z) > 1e-8)
            ? params.cx + (-positions[pi] / z) * params.fx
            : 0;
        const v01 = (Number.isFinite(z) && Math.abs(z) > 1e-8)
            ? params.cy + (-positions[pi + 1] / z) * params.fy
            : 0;
        warped[pi] = u01 * dims.width / longEdge;
        warped[pi + 1] = v01 * dims.height / longEdge;
        warped[pi + 2] = params.DEPTH_AXIS_WEIGHT * (invZ / dispRef);
    }

    const lockStats = createFarBorderVertexLock(mesh.index, positions, vertexCount, dispRef, params);
    return {
        positions: warped,
        vertexLock: lockStats.vertexLock,
        dispRef,
        lockedBorderVerts: lockStats.lockedBorderVerts,
        totalBorderVerts: lockStats.totalBorderVerts
    };
}

function calculateMedianDisparity(positions) {
    const values = new Float32Array(positions.length / 3);
    let count = 0;
    for (let i = 2; i < positions.length; i += 3) {
        const z = positions[i];
        if (Number.isFinite(z) && Math.abs(z) > 1e-8) {
            values[count++] = 1 / Math.abs(z);
        }
    }
    if (count === 0) return undefined;
    const used = values.slice(0, count);
    used.sort();
    return used[used.length >> 1];
}

function createFarBorderVertexLock(index, positions, vertexCount, dispRef, params) {
    const stats = { vertexLock: null, lockedBorderVerts: 0, totalBorderVerts: 0 };
    if (!params.UNLOCK_FAR_BORDERS) return stats;
    const boundaryNeighbors = collectBoundaryNeighbors(index, vertexCount);
    const vertexLock = new Uint8Array(vertexCount);
    const threshold = dispRef * params.FAR_BORDER_DISP_RATIO;
    for (let i = 0; i < vertexCount; i++) {
        const neighbors = boundaryNeighbors[i];
        if (!neighbors || neighbors.length === 0) continue;
        stats.totalBorderVerts++;
        const z = positions[i * 3 + 2];
        const disparity = (Number.isFinite(z) && Math.abs(z) > 1e-8) ? 1 / Math.abs(z) : 0;
        if (disparity >= threshold) {
            vertexLock[i] = 1;
            stats.lockedBorderVerts++;
        }
    }
    if (stats.totalBorderVerts === 0) return stats;
    stats.vertexLock = vertexLock;
    return stats;
}

function pruneBoundaryArtifacts(mesh, params) {
    const stats = { removedFaces: 0 };
    if (!params.CLEAN_BOUNDARY_ARTIFACTS || !mesh || !mesh.index || mesh.index.length < 3) return stats;
    const vertexCount = mesh.positions.length / 3;
    const boundaryNeighbors = collectBoundaryNeighbors(mesh.index, vertexCount);
    const boundaryVertex = new Uint8Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        if (boundaryNeighbors[i] && boundaryNeighbors[i].length > 0) boundaryVertex[i] = 1;
    }
    const screen = createScreenCellPositions(mesh.positions, mesh.uvs, params);
    const source = mesh.index;
    const kept = new Uint32Array(source.length);
    let keptCount = 0;
    const minAltitude = Number.isFinite(params.BOUNDARY_ARTIFACT_MIN_ALTITUDE_CELLS)
        ? params.BOUNDARY_ARTIFACT_MIN_ALTITUDE_CELLS
        : 0.75;

    for (let i = 0; i < source.length; i += 3) {
        const a = source[i], b = source[i + 1], c = source[i + 2];
        const boundaryCount = boundaryVertex[a] + boundaryVertex[b] + boundaryVertex[c];
        let remove = false;
        if (boundaryCount === 3) {
            remove = true;
        } else if (boundaryCount === 2) {
            remove = isThinBoundaryTriangle(a, b, c, boundaryVertex, screen, minAltitude);
        }
        if (remove) {
            stats.removedFaces++;
            continue;
        }
        kept[keptCount++] = a;
        kept[keptCount++] = b;
        kept[keptCount++] = c;
    }
    if (stats.removedFaces > 0) {
        mesh.index = kept.slice(0, keptCount);
        compactMeshByIndex(mesh);
    }
    return stats;
}

function createScreenCellPositions(positions, uvs, params) {
    const vertexCount = positions.length / 3;
    const dims = getGridSize(uvs, vertexCount, params);
    const out = new Float32Array(vertexCount * 2);
    const useIntrinsics = hasValidIntrinsics(params);
    for (let i = 0; i < vertexCount; i++) {
        const pi = i * 3;
        const z = positions[pi + 2];
        let u01 = uvs[i * 2];
        let v01 = 1 - uvs[i * 2 + 1];
        if (useIntrinsics && Number.isFinite(z) && Math.abs(z) > 1e-8) {
            u01 = params.cx + (-positions[pi] / z) * params.fx;
            v01 = params.cy + (-positions[pi + 1] / z) * params.fy;
        }
        out[i * 2] = u01 * Math.max(1, dims.width - 1);
        out[i * 2 + 1] = v01 * Math.max(1, dims.height - 1);
    }
    return out;
}

function isThinBoundaryTriangle(a, b, c, boundaryVertex, screen, minAltitude) {
    if (boundaryVertex[a] && boundaryVertex[b]) return pointSegmentDistance(c, a, b, screen) < minAltitude;
    if (boundaryVertex[b] && boundaryVertex[c]) return pointSegmentDistance(a, b, c, screen) < minAltitude;
    return pointSegmentDistance(b, c, a, screen) < minAltitude;
}

function pointSegmentDistance(point, edgeA, edgeB, screen) {
    const px = screen[point * 2], py = screen[point * 2 + 1];
    const ax = screen[edgeA * 2], ay = screen[edgeA * 2 + 1];
    const bx = screen[edgeB * 2], by = screen[edgeB * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-12) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const qx = ax + dx * t, qy = ay + dy * t;
    return Math.hypot(px - qx, py - qy);
}

function compactMeshByIndex(mesh) {
    const oldPositions = mesh.positions;
    const oldUVs = mesh.uvs;
    const oldIndex = mesh.index;
    const oldVertexCount = oldPositions.length / 3;
    const remap = new Int32Array(oldVertexCount);
    remap.fill(-1);
    let vertexCount = 0;
    for (let i = 0; i < oldIndex.length; i++) {
        const oldVertex = oldIndex[i];
        if (remap[oldVertex] < 0) remap[oldVertex] = vertexCount++;
    }
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    for (let oldVertex = 0; oldVertex < oldVertexCount; oldVertex++) {
        const newVertex = remap[oldVertex];
        if (newVertex < 0) continue;
        positions.set(oldPositions.subarray(oldVertex * 3, oldVertex * 3 + 3), newVertex * 3);
        uvs.set(oldUVs.subarray(oldVertex * 2, oldVertex * 2 + 2), newVertex * 2);
    }
    const index = new Uint32Array(oldIndex.length);
    for (let i = 0; i < oldIndex.length; i++) index[i] = remap[oldIndex[i]];
    mesh.positions = positions;
    mesh.uvs = uvs;
    mesh.index = index;
}

function computeVertexNormals(positions, index) {
    const normals = new Float32Array(positions.length);
    const pA = [0, 0, 0], pB = [0, 0, 0], pC = [0, 0, 0];
    const cb = [0, 0, 0], ab = [0, 0, 0];
    for (let i = 0; i < index.length; i += 3) {
        const vA = index[i], vB = index[i + 1], vC = index[i + 2];
        readPosition(positions, vA, pA);
        readPosition(positions, vB, pB);
        readPosition(positions, vC, pC);
        cb[0] = pC[0] - pB[0];
        cb[1] = pC[1] - pB[1];
        cb[2] = pC[2] - pB[2];
        ab[0] = pA[0] - pB[0];
        ab[1] = pA[1] - pB[1];
        ab[2] = pA[2] - pB[2];
        const nx = cb[1] * ab[2] - cb[2] * ab[1];
        const ny = cb[2] * ab[0] - cb[0] * ab[2];
        const nz = cb[0] * ab[1] - cb[1] * ab[0];
        addNormal(normals, vA, nx, ny, nz);
        addNormal(normals, vB, nx, ny, nz);
        addNormal(normals, vC, nx, ny, nz);
    }
    for (let i = 0; i < normals.length; i += 3) {
        const x = normals[i], y = normals[i + 1], z = normals[i + 2];
        const len = Math.hypot(x, y, z);
        if (len > 0) {
            normals[i] = x / len;
            normals[i + 1] = y / len;
            normals[i + 2] = z / len;
        }
    }
    return normals;
}

function readPosition(positions, index, out) {
    const i = index * 3;
    out[0] = positions[i];
    out[1] = positions[i + 1];
    out[2] = positions[i + 2];
}

function addNormal(normals, index, x, y, z) {
    const i = index * 3;
    normals[i] += x;
    normals[i + 1] += y;
    normals[i + 2] += z;
}
