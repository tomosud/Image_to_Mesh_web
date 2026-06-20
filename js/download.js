// download.js — 各種ファイルのダウンロードヘルパ

const Downloader = (function () {

    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // 元画像（読み込んだ File をそのまま）
    function saveOriginal(file) {
        if (!file) return;
        saveBlob(file, file.name);
    }

    // depth EXR
    function saveDepthEXR(depth, width, height, baseName) {
        const blob = EXR.encodeDepth(depth, width, height);
        saveBlob(blob, `${baseName}_depth.exr`);
    }

    // world position EXR (RGBA Float32, XYZ+1)
    function saveWorldPosEXR(rgba, width, height, baseName, aligned) {
        const blob = EXR.encodeWorldPos(rgba, width, height);
        const suffix = aligned ? '_worldposition_aligned.exr' : '_worldposition.exr';
        saveBlob(blob, `${baseName}${suffix}`);
    }

    return { saveBlob, saveOriginal, saveDepthEXR, saveWorldPosEXR };
})();
