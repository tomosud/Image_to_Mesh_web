// exr.js — 最小 OpenEXR エンコーダ (FLOAT 32bit, 無圧縮スキャンライン)
// 後工程 (Houdini 等) 互換のため、参照元 exr_writer.py と同じチャンネル割当で出力する。
//   depth        : 単一 'Y' チャンネル
//   worldposition: 'R'=X, 'G'=Y, 'B'=Z
//
// 仕様参考: OpenEXR file layout (magic, version, header attributes, offset table, scanline chunks)

const EXR = (function () {

    const PIXELTYPE_FLOAT = 2;
    const COMPRESSION_NONE = 0;
    const LINEORDER_INCREASING_Y = 0;

    function strBytes(s) {
        const out = [];
        for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
        return out;
    }

    // channels: [{ name, src: Float32Array(width*height) }] — name はアルファベット順で渡すこと
    function encode(channels, width, height) {
        const numCh = channels.length;

        // ---- header attributes をバイト配列で組み立て ----
        const header = [];
        const push = (arr) => { for (const b of arr) header.push(b); };
        const pushU32 = (v) => { push([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]); };
        const pushI32 = pushU32;
        const pushF32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); push([b[0], b[1], b[2], b[3]]); };
        const pushAttrHeader = (name, type, size) => {
            push(strBytes(name)); header.push(0);
            push(strBytes(type)); header.push(0);
            pushU32(size);
        };

        // channels (chlist)
        // 各チャンネル: name\0 + pixelType(i32) + pLinear(u8)+pad(3) + xSampling(i32) + ySampling(i32)
        const chBytes = [];
        const cpush = (arr) => { for (const b of arr) chBytes.push(b); };
        const cpushU32 = (v) => { cpush([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]); };
        for (const ch of channels) {
            cpush(strBytes(ch.name)); chBytes.push(0);
            cpushU32(PIXELTYPE_FLOAT);
            chBytes.push(0); chBytes.push(0); chBytes.push(0); chBytes.push(0); // pLinear + 3 pad
            cpushU32(1); // xSampling
            cpushU32(1); // ySampling
        }
        chBytes.push(0); // chlist terminator
        pushAttrHeader('channels', 'chlist', chBytes.length);
        push(chBytes);

        // compression (1 byte)
        pushAttrHeader('compression', 'compression', 1);
        header.push(COMPRESSION_NONE);

        // dataWindow (box2i: xMin,yMin,xMax,yMax)
        pushAttrHeader('dataWindow', 'box2i', 16);
        pushI32(0); pushI32(0); pushI32(width - 1); pushI32(height - 1);

        // displayWindow (box2i)
        pushAttrHeader('displayWindow', 'box2i', 16);
        pushI32(0); pushI32(0); pushI32(width - 1); pushI32(height - 1);

        // lineOrder (1 byte)
        pushAttrHeader('lineOrder', 'lineOrder', 1);
        header.push(LINEORDER_INCREASING_Y);

        // pixelAspectRatio (float)
        pushAttrHeader('pixelAspectRatio', 'float', 4);
        pushF32(1.0);

        // screenWindowCenter (v2f)
        pushAttrHeader('screenWindowCenter', 'v2f', 8);
        pushF32(0.0); pushF32(0.0);

        // screenWindowWidth (float)
        pushAttrHeader('screenWindowWidth', 'float', 4);
        pushF32(1.0);

        // header terminator
        header.push(0);

        // ---- offset table + scanline chunks ----
        // NO_COMPRESSION: 1 scanline = 1 chunk
        const pixelDataSize = width * numCh * 4; // bytes per scanline
        const chunkSize = 4 /*y*/ + 4 /*dataSize*/ + pixelDataSize;

        const magicVersionSize = 4 + 4;
        const offsetTableSize = height * 8;
        const headerSize = header.length;
        const firstChunkOffset = magicVersionSize + headerSize + offsetTableSize;

        const totalSize = firstChunkOffset + height * chunkSize;
        const buf = new ArrayBuffer(totalSize);
        const dv = new DataView(buf);
        const u8 = new Uint8Array(buf);
        let p = 0;

        // magic
        dv.setUint32(p, 20000630, true); p += 4;
        // version: version=2, flags=0
        dv.setUint32(p, 2, true); p += 4;
        // header
        for (let i = 0; i < headerSize; i++) u8[p++] = header[i];

        // offset table
        let chunkPos = firstChunkOffset;
        for (let y = 0; y < height; y++) {
            // 8 byte unsigned long (little endian). 32bit で十分なので下位に書き上位0。
            dv.setUint32(p, chunkPos >>> 0, true);
            dv.setUint32(p + 4, Math.floor(chunkPos / 4294967296), true);
            p += 8;
            chunkPos += chunkSize;
        }

        // scanline chunks
        for (let y = 0; y < height; y++) {
            dv.setInt32(p, y, true); p += 4;
            dv.setInt32(p, pixelDataSize, true); p += 4;
            // チャンネル順に width 個の float を連続書き込み
            for (let c = 0; c < numCh; c++) {
                const src = channels[c].src;
                const rowOff = y * width;
                for (let x = 0; x < width; x++) {
                    dv.setFloat32(p, src[rowOff + x], true);
                    p += 4;
                }
            }
        }

        return new Blob([buf], { type: 'application/octet-stream' });
    }

    // depth(Float32Array w*h) → EXR Blob ('Y')
    function encodeDepth(depth, width, height) {
        return encode([{ name: 'Y', src: depth }], width, height);
    }

    // worldPos RGBA(Float32Array w*h*4, XYZ+1) → EXR Blob (R=X,G=Y,B=Z)
    // チャンネルはアルファベット順 B,G,R で並べる
    function encodeWorldPos(rgba, width, height) {
        const n = width * height;
        const R = new Float32Array(n);
        const G = new Float32Array(n);
        const B = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            R[i] = rgba[i * 4];
            G[i] = rgba[i * 4 + 1];
            B[i] = rgba[i * 4 + 2];
        }
        return encode([
            { name: 'B', src: B },
            { name: 'G', src: G },
            { name: 'R', src: R }
        ], width, height);
    }

    return { encode, encodeDepth, encodeWorldPos };
})();
