# Image to Mesh Web

単眼画像をブラウザにドロップするだけで、**クライアントサイドでデプス推定 → ワールドポジション化 → メッシュ表示**まで行う単体Webアプリです。サーバー不要・ビルド不要で、GitHub Pages にそのまま置けます。

元のデスクトップツール (`Image_to_Mesh`) の `run.bat` 経路（画像→ワールドポジション）の機能のみを、ブラウザ完結で再実装したものです。

## 機能

- 画像 (JPG / PNG) をドラッグ＆ドロップ → 自動でメッシュ化
- ブラウザ内 ONNX 推論（[Depth Anything V3 / DA3METRIC-LARGE](https://huggingface.co/TillBeemelmanns/Depth-Anything-V3-ONNX)）
- メトリックデプス → ワールドポジション (Houdini 座標系, Y-up) を計算
- three.js でメッシュ表示
  - ソリッド / ワイヤーフレーム / 頂点（ポイント）表示
  - ライティング ON/OFF、カラー ON/OFF、点サイズ調整
  - 視点リセット、OrbitControls（回転 / ズーム / パン）
- パラメータ調整
  - FOV（視野角）→ カメラ内部パラメータの推定に使用
  - スケール（ワールド座標倍率）
  - 焦点メトリックスケール (`focal/300`) ON/OFF
  - 「再計算」で即時反映
- ダウンロード
  - 元画像
  - **Depth (EXR)** — `{name}_depth.exr`（FLOAT, `Y` チャンネル）
  - **World Position (EXR)** — `{name}_worldposition.exr`（FLOAT, `R`=X, `G`=Y, `B`=Z）
  - OBJ メッシュ（UV付き）
  - PNG ビューキャプチャ（2048×2048）

## 使い方（ローカル）

ローカルでも単純な静的サーバーで動きます（`file://` だと一部 API が制限されるため簡易サーバー推奨）。

```powershell
# 例: Python の簡易サーバー
cd Image_to_Mesh_web
python -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

ブラウザは WebGPU 対応（Chrome / Edge 最新）だと高速です。非対応時は WASM にフォールバックします。

## モデルについて

- 実行時に HuggingFace CDN からモデル（`DA3METRIC-LARGE.onnx`）を取得し、ブラウザの Cache Storage に保存します。**初回のみダウンロードが発生**し、2回目以降はキャッシュから高速に読み込みます。
- モデルは intrinsics（カメラ内部パラメータ）を出力しないため、FOV を仮定して `fx=fy=0.5·max(W,H)/tan(FOV/2)`, `cx=W/2`, `cy=H/2` を推定します。実寸が必要な場合は FOV スライダーで補正してください。

## 座標系・出力仕様

- ワールドポジションは参照元ツールと同じく **Houdini 座標系（右手・Y-up）**。カメラ座標から X, Y を反転して生成します。
- 逆投影: `X=(u-cx)·Z/fx`, `Y=(v-cy)·Z/fy`, `Z=depth`（`Z` には任意で `focal/300` スケールを適用）。
- EXR は FLOAT・無圧縮スキャンライン。World Position は `R=X, G=Y, B=Z`、Depth は `Y` チャンネル。

## GitHub Pages へのデプロイ

このリポジトリには `.github/workflows/deploy.yml` が含まれています。

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定。
2. `main` ブランチに push すると自動でビルド（静的アップロード）＆デプロイされます。
3. 公開 URL は Actions の `deploy` ジョブ、または Pages 設定から確認できます。

> アプリ一式をサブフォルダに置く場合は、`deploy.yml` の `upload-pages-artifact` の `path` を該当フォルダに変更してください。

### cross-origin isolation について
onnxruntime-web のマルチスレッド WASM は cross-origin isolation を必要とします。GitHub Pages では COOP/COEP ヘッダを付与できないため、本アプリは **WebGPU 優先＋シングルスレッド WASM フォールバック**で動作するようにしています。

## ファイル構成

```
Image_to_Mesh_web/
├── index.html              # UI
├── css/style.css           # スタイル
├── js/
│   ├── main.js             # 全体配線（ドロップ→推論→表示, UI）
│   ├── inference.js        # onnxruntime-web 推論（モデル取得/前処理/推論）
│   ├── worldpos.js         # depth → world position
│   ├── viewer.js           # three.js メッシュビューア
│   ├── exr.js              # EXR エンコーダ（FLOAT 無圧縮）
│   └── download.js         # ダウンロードヘルパ
├── .github/workflows/deploy.yml  # Pages 自動デプロイ
├── .nojekyll
├── PLAN.md                 # 実装計画
└── PROGRESS.md             # 実装進行ログ
```

## ライセンス / クレジット

- モデル: [TillBeemelmanns/Depth-Anything-V3-ONNX](https://huggingface.co/TillBeemelmanns/Depth-Anything-V3-ONNX)（Apache-2.0, 元: ByteDance-Seed/Depth-Anything-3）
- three.js, onnxruntime-web を CDN 経由で利用
