// Convert MoGe's camera-space normals into a tangent-space RGB normal map.
// The tangent basis comes from the projected point map and its image UVs.
const NormalMap = (function () {
    function create(cameraNormals, cameraPoints, width, height, mask) {
        if (!cameraNormals || cameraNormals.length < width * height * 3) return null;

        const pixels = new Uint8Array(width * height * 4);
        const valid = (index) => {
            if (index < 0 || index >= width * height || (mask && mask[index] === 0)) return false;
            const offset = index * 3;
            return Number.isFinite(cameraPoints[offset]) &&
                Number.isFinite(cameraPoints[offset + 1]) &&
                Number.isFinite(cameraPoints[offset + 2]);
        };
        const point = (index) => {
            const offset = index * 3;
            // Same camera-to-viewer rotation used by WorldPos.fromCameraPoints.
            return [-cameraPoints[offset], -cameraPoints[offset + 1], cameraPoints[offset + 2]];
        };
        const normalize = (value) => {
            const length = Math.hypot(value[0], value[1], value[2]);
            return length > 1e-8
                ? [value[0] / length, value[1] / length, value[2] / length]
                : null;
        };
        const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const cross = (a, b) => [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]
        ];
        const neutral = (offset) => {
            pixels[offset] = 128;
            pixels[offset + 1] = 128;
            pixels[offset + 2] = 255;
            pixels[offset + 3] = 255;
        };
        const encode = (offset, normal) => {
            pixels[offset] = Math.round((normal[0] * 0.5 + 0.5) * 255);
            pixels[offset + 1] = Math.round((normal[1] * 0.5 + 0.5) * 255);
            pixels[offset + 2] = Math.round((normal[2] * 0.5 + 0.5) * 255);
            pixels[offset + 3] = 255;
        };

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = y * width + x;
                const pixelOffset = index * 4;
                if (!valid(index)) {
                    neutral(pixelOffset);
                    continue;
                }

                const left = x > 0 && valid(index - 1) ? index - 1 : index;
                const right = x + 1 < width && valid(index + 1) ? index + 1 : index;
                const up = y > 0 && valid(index - width) ? index - width : index;
                const down = y + 1 < height && valid(index + width) ? index + width : index;
                if (left === right || up === down) {
                    neutral(pixelOffset);
                    continue;
                }

                // U increases image-right; V increases image-up.
                let tangent = normalize(subtract(point(right), point(left)));
                const bitangentApprox = normalize(subtract(point(up), point(down)));
                const geometryNormal = tangent && bitangentApprox
                    ? normalize(cross(tangent, bitangentApprox))
                    : null;
                if (!tangent || !bitangentApprox || !geometryNormal) {
                    neutral(pixelOffset);
                    continue;
                }

                const normalOffset = index * 3;
                let predictedNormal = normalize([
                    -cameraNormals[normalOffset],
                    -cameraNormals[normalOffset + 1],
                    cameraNormals[normalOffset + 2]
                ]);
                if (!predictedNormal) {
                    neutral(pixelOffset);
                    continue;
                }
                if (dot(predictedNormal, geometryNormal) < 0) {
                    predictedNormal = predictedNormal.map(value => -value);
                }

                const tangentAlongNormal = dot(tangent, geometryNormal);
                tangent = normalize([
                    tangent[0] - geometryNormal[0] * tangentAlongNormal,
                    tangent[1] - geometryNormal[1] * tangentAlongNormal,
                    tangent[2] - geometryNormal[2] * tangentAlongNormal
                ]);
                if (!tangent) {
                    neutral(pixelOffset);
                    continue;
                }
                const bitangent = normalize(cross(geometryNormal, tangent));
                const tangentNormal = normalize([
                    dot(predictedNormal, tangent),
                    dot(predictedNormal, bitangent),
                    Math.max(0, dot(predictedNormal, geometryNormal))
                ]);
                if (tangentNormal) encode(pixelOffset, tangentNormal); else neutral(pixelOffset);
            }
        }

        return { data: pixels, width, height };
    }

    return { create };
})();
