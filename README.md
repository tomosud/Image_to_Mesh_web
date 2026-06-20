# Image to Mesh Web

Image to Mesh Web converts a single JPG or PNG image into an interactive 3D mesh using MoGe-2. Inference, geometry processing, viewing, and export run locally in your browser.

**[Open Image to Mesh Web](https://tomosud.github.io/Image_to_Mesh_web/)**

## Features

- Single-image depth and 3D geometry estimation with MoGe-2
- ViT-S, ViT-B, and ViT-L model choices
- WebGPU inference with automatic WASM fallback
- Textured mesh, point-cloud, wireframe, and unlit display modes
- Estimated source-camera view
- Three-point horizontal-plane and orbit-center adjustment
- Adjustable masking and depth-edge cleanup
- Depth EXR, aligned World Position EXR, OBJ, GLB, and PNG export
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

4. Adjust the model, quality, scale, mask, or edge settings as needed.
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

The order of the three points does not matter. Their center becomes the orbit center, and the plane normal becomes the new up axis. After confirmation, the grid disappears but the calibration remains active.

**Reset View** restores the estimated source-camera position and original image-center target while retaining the adjusted horizontal rotation axis.

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

### Scale

Changes the overall size of the generated geometry without changing its relative shape. Click **Recompute** after changing Scale. Model inference is not repeated.

### Edge Threshold

Controls removal of vertices and faces around sharp depth discontinuities.

- Range: `0.005`–`1.000`
- Default: `0.970`
- Lower values remove more depth-edge geometry
- Higher values preserve more geometry but may leave stretched surfaces
- `1.000` displays as `Off` and disables all depth-edge cleanup

The setting is applied automatically when the slider is released. Model inference is not repeated.

If geometry is missing around object boundaries, raise the value. If long stretched surfaces appear between foreground and background, lower it.

### Apply Mask

Uses MoGe-2's validity mask to remove background, sky, and uncertain regions. Changes are applied immediately without rerunning inference.

To preserve as much geometry as possible, set **Edge Threshold** to `Off` and disable **Apply Mask**. Invalid or non-positive depth values still cannot form geometry.

## Display Controls

- **Points Only**: switch between triangle mesh and point cloud
- **Point Size**: set point size in screen pixels
- **Unlit**: show image colors without scene lighting
- **No Color**: hide the source-image color
- **Wireframe**: show mesh triangle edges
- **Reset View**: restore the estimated source-camera view
- **Adjust Horizontal Grid**: set the scene's horizontal axis and orbit center from three points
- **Show Capture Frame**: preview the square PNG export region
- **UI OFF / UI ON**: hide or restore interface panels

## Downloads

| Button | Output |
|---|---|
| Original | Original JPG or PNG file |
| Depth (EXR) | 32-bit FLOAT camera depth in the `Y` channel |
| Aligned WorldPos (EXR) | 32-bit FLOAT positions with `R=X`, `G=Y`, and `B=Z` |
| OBJ | Triangle mesh with UV coordinates |
| Scene GLB | Textured mesh with estimated source and current viewer cameras |
| PNG (2048) | Current view rendered to a transparent 2048×2048 PNG |

When a horizontal grid is confirmed, Aligned WorldPos EXR, OBJ, and Scene GLB use that coordinate system:

- Three-point center: origin
- Selected plane: `Y=0`
- Selected up direction: `+Y`

Scene GLB contains:

- `AlignedMesh`
- `EstimatedSourceCamera`
- `CurrentViewCamera`
- Source-image texture

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
- Enable **Apply Mask**.
- Increase Quality if memory permits.

### Too much geometry is missing

- Raise **Edge Threshold**.
- Set Edge Threshold to `Off` for no depth-edge cleanup.
- Disable **Apply Mask** if the predicted validity mask removes useful areas.

### Rotation feels tilted or uses the wrong axis

Use **Adjust Horizontal Grid** and select three points on a real horizontal surface such as a floor, table, or plate.

### Shape or distance is inaccurate

Single-image geometry is inherently ambiguous. Transparent objects, mirrors, thin structures, textureless surfaces, strong blur, and extreme wide-angle images may produce inaccurate results.

## Run Locally

Use a local HTTP server instead of opening `index.html` through `file://`.

On Windows, run `run.bat`, then open:

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
