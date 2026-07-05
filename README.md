# Image to Mesh Web

Image to Mesh Web converts a single JPG or PNG image into an interactive 3D mesh using MoGe-2. Inference, geometry processing, viewing, and export run locally in your browser.

**[Open Image to Mesh Web](https://tomosud.github.io/Image_to_Mesh_web/)**



https://github.com/user-attachments/assets/9ee06a21-c0db-4ef7-a144-4e5478724f1f



## Features

- Single-image depth and 3D geometry estimation with MoGe-2
- ViT-S, ViT-B, and ViT-L model choices
- WebGPU inference with automatic WASM fallback
- RGB-guided high-resolution depth upsampling, capped at 2048 px on the long edge
- Textured mesh, point-cloud, wireframe, and unlit display modes
- Estimated source-camera view
- Three-point horizontal-plane direction adjustment
- Adjustable masking and depth-edge cleanup
- Depth EXR, tangent-space normal map PNG, aligned World Position EXR, OBJ ZIP, GLB, and PNG export
- Local browser processing; input images are not uploaded

## Requirements

- Current Google Chrome or Microsoft Edge
- A WebGPU-capable GPU is recommended
- Internet access for the first model and library download
- A JPG or PNG input image

ViT-L requires substantial GPU and system memory. Use ViT-B or ViT-S if loading or inference fails.

## Quick Start

1. Drop a JPG or PNG onto the page, or click the drop area.
2. Wait for the model download and inference to finish.
3. Inspect the geometry:

   - Left drag: rotate
   - Mouse wheel: zoom
   - Right drag: pan

4. Adjust the model, quality, mask, or edge settings as needed.
5. Use the download buttons to export geometry or maps.

The first run is slower because the selected model must be downloaded. Model files are stored in the browser cache for later sessions.

To process a different image, click **Another Image**. The page reloads to release ONNX, WebGPU, mesh, and image memory. The selected model and cached model file are retained.

## Horizontal Grid and Camera Rotation

The initial camera uses the focal length estimated by MoGe-2 and opens from the input image's front-facing composition.

For tabletop scenes or images shot from above, the default image-up axis may not match the scene's real horizontal plane. Use **Adjust Horizontal Grid** to define it manually:

1. Click **Adjust Horizontal Grid**. The current horizontal grid appears.
2. Select three well-spaced points on the same horizontal surface.
3. Check the preview grid and yellow up/front arrow.
4. Click **Use This Grid** to apply it, or **Cancel** to discard it.

The order of the three points does not matter. The selected points define the horizontal direction only. The scene origin, grid display position, and Maya-style orbit pivot stay at the initial source-camera target.

**Reset View** restores the estimated source-camera position, source-camera up axis, and initial target. If a horizontal grid is active, only the aligned export normal changes; the camera target and orbit pivot stay at the initial target.

Camera navigation follows Maya-style mouse chords:

- `Alt + Left drag`: orbit/tumble around the current pivot
- `Alt + Middle drag`: pan/track
- `Alt + Right drag`: slow dolly
- Mouse wheel: slow dolly
- `W/A/S/D`: parallel move relative to the current view
- `Shift` / `Ctrl`: parallel move up / down

## Inference and Geometry Settings

### Model

| Model | Recommended use | Approximate size |
|---|---|---:|
| ViT-S | Lowest memory use and fastest loading | 150 MB |
| ViT-B | Balanced quality and memory use; default | 400 MB |
| ViT-L | Highest quality; WebGPU and ample memory recommended | 1.32 GB |

Changing the model requires **Recompute** and runs inference again. The last successfully used model is restored on the next visit.

### Quality (`num_tokens`)

Controls the internal inference resolution.

- Range: `1200`–`2500`
- Default: `1800`
- Higher values can preserve more detail but need more time and memory
- Changing this setting requires **Recompute** and runs inference again

### High-Res Depth

Upsamples the metric depth after MoGe-2 inference and before geometry, edge snapping, world-position generation, backfill, and exports.

- Target resolution follows the input image aspect ratio
- Long edge is capped at `2048` px
- WebGPU applies an RGB-guided joint bilateral filter
- If WebGPU is unavailable, the status line clearly reports the fallback and the tool uses the internal initial resize mode
- Depth stays as float32 meters during processing

Advanced high-resolution depth parameters are kept as internal defaults and are not shown in the main UI.

### Edge Threshold

Controls EdgeSnap detection of sharp depth discontinuities. The implementation compares horizontal and vertical neighboring depth samples; if their relative depth jump is above this value, both pixels are marked for snapping.

Marked pixels are not deleted. Stable neighboring depth areas propagate into the marked pixels, so in-between ramp values are replaced by the nearest near/far surface in log-depth space. The viewer also enables mesh seam splitting while Edge Threshold is not `Off`; the actual face-splitting test uses a fixed `0.10` relative depth jump.

- Range: `0.005`–`1.000`
- Default: `0.010`
- Lower values detect and split more edges
- Higher values keep more surfaces connected but may leave stretched geometry
- `1.000` displays as `Off` and disables edge snapping and splitting

The setting is applied automatically when the slider is released. Model inference is not repeated.

If surfaces that belong together get split apart, raise the value. If long stretched surfaces appear between foreground and background, lower it.

### Snap Width

Maximum number of EdgeSnap propagation passes from stable depth areas into marked edge pixels.

- Range: `1`–`32`
- Default: `8`
- Increase if thick detected ramps still leave in-between depth values
- Pixels not reached within this limit keep their original depth

### Sky / Masked Area

MoGe-2 marks sky, transparent/reflective surfaces, and uncertain regions as invalid. This selector decides what happens to those pixels. Changes are applied immediately without rerunning inference.

- **Sky Backdrop** (default): keeps the masked pixels and places them on a flat plane far behind the scene, at `max(2 × deepest valid depth, 100 m)`. The original image colors are used, so the sky becomes a natural matte-painting backdrop. The boundary against foreground geometry is handled by the normal edge snapping and splitting.
- **Apply Mask OFF**: keeps the model's raw predicted depth for masked pixels. The sky may appear at an arbitrary distance (the model has no supervision there).
- **Apply Mask ON**: removes the masked regions entirely, leaving holes.

Invalid or non-positive depth values still cannot form geometry in the OFF mode.

### Fill Occlusion

Backfill creates a second background layer behind depth-edge silhouettes.

- **Fill Margin** is measured as a percentage of the original image long edge
- Range: `0.5%` to `50%`
- Default: `25%`
- The UI also shows the equivalent processing-grid pixel distance in parentheses after an image is loaded
- Increasing the value extends both the backfill mesh area and its generated texture farther behind foreground silhouettes
- **Backfill Parallax Cut** controls only the backfill mesh face cut. It is a multiplier of scene median disparity, default `0.50x`
- Higher values keep more backfill connected; lower values cut foreground-facing smears more aggressively
- **Backfill Front Clamp** limits generated disparity relative to the assigned background edge, default `1.00x`
- **Backfill Far Clamp** limits generated depth relative to the assigned background edge, default `4.0x`
- **Backfill Hole Preclaim** pre-claims black hole pixels from edge seeds with deeper labels winning collisions, default `3px`; set `0` to disable
- **Backfill Far Priority** lets deeper labels locally override nearer labels after BFS, default `12px`; set `0` to disable

### Small Component Faces

Removes isolated connected face islands after depth-edge cutting.

- Default: `64` faces
- Applies to both the main mesh and the backfill mesh
- Set `0` to keep all isolated islands
- Higher values remove larger detached fragments

## Display Controls

- **Points Only**: switch between triangle mesh and point cloud
- **Point Size**: set point size in screen pixels
- **Unlit**: show image colors without scene lighting
- **No Color**: hide the source-image color
- **Wireframe**: show mesh triangle edges
- **Reset View**: restore the estimated source-camera view
- **Set Orbit Center** or `F`: click a visible mesh point to make it the orbit target while preserving the current viewing angle
- **W/A/S/D** and **Shift/Ctrl**: keyboard parallel movement
- **Adjust Horizontal Grid**: set the aligned export plane direction from three points while keeping the initial orbit pivot
- **Show Capture Frame**: preview the square PNG export region
- **UI OFF / UI ON**: hide or restore interface panels

## Downloads

| Button | Output |
|---|---|
| Original | Original JPG or PNG file |
| Depth (EXR) | 32-bit FLOAT camera depth in the `Y` channel |
| Initial Depth (EXR) | Debug 32-bit FLOAT depth after initial high-resolution resize and before RGB-guided filtering |
| Normal Map (PNG) | RGB tangent-space normal map generated from MoGe-2 normals |
| Aligned WorldPos (EXR) | 32-bit FLOAT positions with `R=X`, `G=Y`, and `B=Z` |
| OBJ + Textures (ZIP) | ZIP containing OBJ, MTL, source-image texture PNG, tangent-space normal map PNG, and Backfill texture PNG when Backfill exists |
| Scene GLB | Textured mesh with estimated source and current viewer cameras |
| PNG (2048) | Current view rendered to a transparent 2048×2048 PNG |

When a horizontal grid is confirmed, Aligned WorldPos EXR, OBJ ZIP, and Scene GLB use that coordinate system:

- Initial source-camera target: origin
- Selected horizontal direction: `Y=0`
- Selected up/normal direction: `+Y`

Scene GLB contains:

- `AlignedMesh`
- `EstimatedSourceCamera`
- `CurrentViewCamera`
- Source-image texture and tangent-space normal map
- GLB materials use the source/backfill color textures as emissive maps, with black base color and metallic set to `1.0`

OBJ ZIP uses the same source-image texture and tangent-space normal map as the GLB. When Backfill exists, the OBJ also contains a `BackfillMesh` object and the ZIP includes its Backfill texture PNG.

Depth EXR remains in the original camera-depth coordinate system.

## Troubleshooting

### The model does not load

- Update Chrome or Edge.
- Close other GPU-heavy tabs and applications.
- Select ViT-S or ViT-B.
- Reload the page and try again.

### Inference stops or does not return

- Reduce Quality (`num_tokens`).
- Select a smaller model.
- Reduce the source-image resolution.
- Click **Another Image** between images so the page can release GPU and inference memory.

### Long surfaces stretch across depth boundaries

- Lower **Edge Threshold**.
- Raise **Snap Width** for wide or blurred edges.
- Set **Sky / Masked Area** to Sky Backdrop or Apply Mask ON.
- Increase Quality if memory permits.

### Too much geometry is missing or split apart

- Raise **Edge Threshold**.
- Set Edge Threshold to `Off` for no edge snapping and splitting.
- Set **Sky / Masked Area** to Apply Mask OFF if the validity mask removes useful areas.

### Rotation feels tilted or uses the wrong axis

Use **Adjust Horizontal Grid** and select three points on a real horizontal surface such as a floor, table, or plate.

### Shape or distance is inaccurate

Single-image geometry is inherently ambiguous. Transparent objects, mirrors, thin structures, textureless surfaces, strong blur, and extreme wide-angle images may produce inaccurate results.

## Run Locally

Use a local HTTP server instead of opening `index.html` through `file://`.

On Windows, run `run.bat`. It opens the server in your browser and automatically
uses the next available port if `8000` is busy. The default URL is:

```text
http://localhost:8000/
```

Or start a server manually:

```powershell
cd Image_to_Mesh_web
python -m http.server 8000
```

Press `Ctrl+C` in the server terminal to stop it.

## Privacy

Input images and generated geometry remain in the browser. Network access is used to load application libraries and download the selected model. Exported files are generated locally.

## License

This tool is released under the [MIT License](LICENSE).

Inference uses MoGe-2 from [microsoft/MoGe](https://github.com/microsoft/moge). MoGe code is licensed under the MIT License, while the DINOv2 code included in MoGe is licensed under the Apache License 2.0. Use the models and related components in accordance with their respective licenses.
