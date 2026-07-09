# TASK C: エクスポート時ポリゴンリダクションの技術調査（コード変更なし）

## 背景（このファイルだけで完結）

このリポジトリはブラウザ内で単一画像からメッシュを生成し OBJ / GLB でエクスポートする
静的 Web アプリ（GitHub Pages ホスト、ビルド工程なし、サーバサイドなし）。
エクスポート時に数百万トライアングルになるため、**高速な**ポリゴンリダクションを
エクスポート直前に入れたい。第一候補は meshoptimizer の simplifier。
このタスクは**調査のみ**で、リポジトリの既存コードは一切変更しない。

対象リポジトリ: `C:\work\script\Image_to_Mesh_web`（参照のみ）

## 絶対条件

1. 既存ファイルの変更・追加は禁止。成果物はこのファイルと同じフォルダの
   `TASK_C_REPORT.md` 1本のみ。
2. git commit / push はしない。
3. ライセンスは一次情報（リポジトリの LICENSE ファイル）で確認する。

## 調査項目

### C-1. meshoptimizer JS/WASM 配布物

- ライセンスが MIT であることを LICENSE 原文で確認（商用利用可能が必須条件）
- ブラウザで使える配布形態を特定する:
  - `meshopt_simplifier.module.js`（WASM を base64 内包した単一 ES module）が
    存在するか、CDN / npm パッケージ内のどのパスか、ファイルサイズ
  - **ビルド工程なしで `js/vendor/` に置くだけで動くか**（GitHub Pages 静的ホスト条件）
  - ES module 形式の場合、現行の非モジュール `<script>` 構成（グローバル IIFE 群）から
    どう読み込むか（`<script type="module">` との共存方法）

### C-2. API の適用可否

対象ジオメトリの特性: indexed BufferGeometry、attributes は position + uv のみ、
深度段差で意図的に切り離した多数の連結成分と境界エッジを持つ。normal はエクスポート時に
再計算するので保持不要。

- `simplify()` と `simplifyWithAttributes()` の引数仕様（index 型、stride、error の意味、
  `LockBorder` 等のフラグ）を整理する
- 境界エッジ保持（切り離しシームの輪郭が縮まない）に必要なフラグ/設定
- UV を破綻させないための方法（simplifyWithAttributes で uv に重みを与える場合の推奨値、
  もしくは position のみ + error 上限を保守的にする場合の目安）
- target index count / error 上限の指定方法と、「削減率スライダー（例 100%〜10%）」への
  マッピング案
- 実行時間の目安（公表ベンチや issue から。800万面クラスで秒未満〜数秒か）

### C-3. 代替案の簡易比較（各3行以内）

- three.js SimplifyModifier（速度・品質で恐らく不適。理由を確認）
- 自前の頂点クラスタリング（グリッド量子化マージ）
- その他 MIT 互換で有力なものがあれば1つ

### C-4. レポート `TASK_C_REPORT.md` に書くこと

1. 推奨構成（vendor に置くファイル名・取得元 URL・バージョン・サイズ・ライセンス）
2. README に追記すべきライセンス文面の案
3. 統合コードのスケッチ（実装はしない）:
   `createCompactExportGeometry` の出力（position/uv/index）に対して
   simplify を呼び、新しい index（+必要なら再 weld）を返す関数の擬似コード
4. リスクと未確認事項（例: 非モジュール構成との共存、Uint16/Uint32 index の扱い）
5. 判断: 「meshoptimizer で進めてよい / 代替案が良い」の結論と理由
