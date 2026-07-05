// colorpatch.js — エッジ混色帯のテクスチャ色パッチ（docs/archive/PLAN_EDGE_COLOR_HISTORY.md A案）
// 深度エッジ周辺のテクスチャ画素は手前/奥の混色（撮像時のボケ・AA）を含む。
// UV は元のまま（連続）とし、**元画像解像度**で混色帯だけを「自分側の台地の色」
// で埋め直した表示/エクスポート用の画像を作る。
// - 帯の定義はモデル解像度: EdgeSnap のランプ画素（srcRoot>=0）+ 深度段差対の両側
// - 各画像画素の side ラベルは「スナップ後深度」そのもの。色の伝播は
//   相対深度差 <= SIDE_TOL の隣接画素からのみ受け取る → シームを色が越えない
// - 元画像(currentImageData)は変更しない。戻り値は新しい ImageData 相当
// - Original ダウンロードは原本ファイルのまま（main.js は表示/backfill にのみ使用）
const ColorPatch = (function () {

    const JUMP_TOL = 0.10;  // 帯に含める深度段差（シーム分割と同じ 0.10 固定・非連動）
    const SIDE_TOL = 0.10;  // 「同じ側」とみなす相対深度差
    const MAX_PASSES = 512; // 安全上限（通常は帯幅の画像px数で収束）

    // input: {
    //   image: ImageData | {data,width,height}  元画像（RGBA、元解像度）
    //   depth: Float32Array(W*H)  スナップ後のメトリック深度
    //   validMask: Uint8Array(W*H)  1=有効
    //   srcRoot: Int32Array(W*H)  EdgeSnap の吸着元（>=0 がランプ画素）
    //   width, height: モデル解像度 W,H
    // }
    // 戻り値: { data: Uint8ClampedArray RGBA, width, height } | null（パッチ対象なし）
    function apply(input) {
        const { image, depth, validMask, srcRoot, width: W, height: H } = input;
        const N = W * H;

        // 1. モデル解像度の混色帯: ランプ画素 + 深度段差対の両側1px
        const band = new Uint8Array(N);
        let bandCount = 0;
        for (let i = 0; i < N; i++) {
            if (srcRoot && srcRoot[i] >= 0) { band[i] = 1; bandCount++; }
        }
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!validMask[i]) continue;
                for (let k = 0; k < 2; k++) {
                    const j = k === 0 ? (x + 1 < W ? i + 1 : -1) : (y + 1 < H ? i + W : -1);
                    if (j < 0 || !validMask[j]) continue;
                    const minD = Math.max(Math.min(depth[i], depth[j]), 1e-6);
                    if (Math.abs(depth[i] - depth[j]) / minD > JUMP_TOL) {
                        if (!band[i]) { band[i] = 1; bandCount++; }
                        if (!band[j]) { band[j] = 1; bandCount++; }
                    }
                }
            }
        }
        if (bandCount === 0) return null;

        // 2. 画像解像度へ展開。各画像画素 → 最近傍モデル画素の band/depth を参照
        const imgW = image.width, imgH = image.height;
        const src = image.data;
        const out = new Uint8ClampedArray(src);

        // 画像画素ごとのモデル index（最近傍、画素中心基準）
        const mapX = new Int32Array(imgW);
        for (let x = 0; x < imgW; x++) {
            mapX[x] = Math.min(W - 1, Math.floor((x + 0.5) * W / imgW));
        }
        const mapY = new Int32Array(imgH);
        for (let y = 0; y < imgH; y++) {
            mapY[y] = Math.min(H - 1, Math.floor((y + 0.5) * H / imgH));
        }

        // pending = 帯内の画像画素（色を作り直す）。それ以外は確定（元の色）。
        const state = new Uint8Array(imgW * imgH); // 0=確定 1=未確定
        let pending = [];
        for (let y = 0; y < imgH; y++) {
            const rowM = mapY[y] * W;
            for (let x = 0; x < imgW; x++) {
                if (band[rowM + mapX[x]]) {
                    const p = y * imgW + x;
                    state[p] = 1;
                    pending.push(p);
                }
            }
        }
        if (!pending.length) return null;

        // 3. 同じ側（相対深度差 <= SIDE_TOL）の確定隣接画素の平均色で内側へ伝播。
        //    更新はパス末尾で一括適用（両側のフロントが対等に進む）。
        const pxDepth = (p) => depth[mapY[(p / imgW) | 0] * W + mapX[p % imgW]];
        let patched = 0;
        for (let pass = 0; pass < MAX_PASSES && pending.length; pass++) {
            const updates = [];
            const rest = [];
            for (const p of pending) {
                const x = p % imgW;
                const d = pxDepth(p);
                let r = 0, g = 0, b = 0, cnt = 0;
                for (let k = 0; k < 4; k++) {
                    let q = -1;
                    if (k === 0 && x + 1 < imgW) q = p + 1;
                    else if (k === 1 && x > 0) q = p - 1;
                    else if (k === 2 && p + imgW < imgW * imgH) q = p + imgW;
                    else if (k === 3 && p - imgW >= 0) q = p - imgW;
                    if (q < 0 || state[q] !== 0) continue;
                    const dq = pxDepth(q);
                    const minD = Math.max(Math.min(d, dq), 1e-6);
                    if (Math.abs(d - dq) / minD > SIDE_TOL) continue; // シームは越えない
                    r += out[q * 4]; g += out[q * 4 + 1]; b += out[q * 4 + 2];
                    cnt++;
                }
                if (cnt > 0) updates.push(p, r / cnt, g / cnt, b / cnt);
                else rest.push(p);
            }
            if (!updates.length) break;
            for (let u = 0; u < updates.length; u += 4) {
                const p = updates[u];
                out[p * 4] = updates[u + 1];
                out[p * 4 + 1] = updates[u + 2];
                out[p * 4 + 2] = updates[u + 3];
                state[p] = 0;
                patched++;
            }
            pending = rest;
        }
        // 未解決画素（同じ側の確定画素に届かない孤立帯）は元の色のまま

        console.log('[ColorPatch]', {
            bandModelPx: bandCount, patchedImagePx: patched, unresolved: pending.length,
            size: `${imgW}x${imgH}`
        });
        return { data: out, width: imgW, height: imgH };
    }

    return { apply };
})();
