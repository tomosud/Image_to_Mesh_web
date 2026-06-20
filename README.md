# Image to Mesh Web

Image to Mesh Web uses MoGe-2 to estimate depth and 3D geometry from a single image and displays the result as an interactive mesh in your browser.

Images and inference results are processed locally in the browser. The selected model is downloaded on first use and stored in the browser cache.

**[Open Image to Mesh Web](https://tomosud.github.io/Image_to_Mesh_web/)**

Model: [microsoft/MoGe](https://github.com/microsoft/moge)

## Requirements

- The latest version of Google Chrome or Microsoft Edge
- A WebGPU-capable GPU is recommended
- An internet connection for the initial model and library downloads
- A JPG or PNG image

Large models may fail to load if the device or browser does not have enough available memory.

## Usage

1. Drop a JPG or PNG image onto the page, or click the drop area to select a file.
2. Wait for the model to load and inference to finish. The first run may take longer because the model must be downloaded.
3. Inspect the mesh with the mouse:
   - Left drag: rotate
   - Mouse wheel: zoom
   - Right drag: pan
4. Change the settings as needed and click **Recompute**.
5. Download the depth map, world position map, OBJ mesh, or rendered image.

To process another image, click **Another Image** or drop a new image onto the page.

## Inference Settings

### Model

| Model | Description | Approximate size |
|---|---|---:|
| ViT-S | Fastest and uses the least memory | 150 MB |
| ViT-B | Balanced speed and quality; selected by default | 400 MB |
| ViT-L | Highest quality; WebGPU and ample memory recommended | 1.32 GB |

After changing the model, click **Recompute** to load it and run inference again.

The model used for a successful inference is saved in the browser and automatically selected on the next visit. The active execution provider, **WebGPU** or **WASM**, is shown in the upper-left information panel.

### Quality (`num_tokens`)

Higher values can preserve finer details but require more processing time and memory.

- Range: 1200–2500
- Default: 1800
- If inference fails, reduce this value or select a smaller model

### Scale

Changes the overall size of the generated 3D geometry. It does not change the relative shape or depth relationships.

### Apply Mask

Removes the background, sky, and uncertain regions from the mesh. Keep this enabled for most images.

Disabling it includes the full image but may create unwanted geometry around foreground boundaries.

## Display Settings

- Points Only: display the geometry as a point cloud
- Point Size: change the point size in point-cloud mode
- Unlit: display image colors without lighting
- No Color: hide the image texture
- Wireframe: show the mesh triangles
- Reset View: restore the estimated source-camera view from directly in front of the image
- Adjust Horizontal Grid: preview the current orbit plane, then click 3 points to define a new horizontal plane and center
- Show Capture Frame: show the area used for PNG export
- UI OFF / UI ON: hide or restore the interface panels

## Downloads

| Button | Output |
|---|---|
| Original | The source JPG or PNG file |
| Depth (EXR) | FLOAT depth data in the `Y` channel |
| Aligned WorldPos (EXR) | FLOAT world positions with `R=X`, `G=Y`, and `B=Z`, transformed to the committed horizontal grid |
| OBJ | Triangle mesh with UV coordinates; aligned to the committed horizontal grid when available |
| Scene GLB | Aligned textured mesh with `EstimatedSourceCamera` and `CurrentViewCamera` |
| PNG (2048) | The current view rendered at 2048×2048 |

Output file names are based on the source image name.

World Position and OBJ outputs use a Y-up coordinate system intended for Houdini.

When a horizontal grid has been committed, OBJ, Aligned WorldPos EXR, and Scene GLB place the selected three-point center at the origin and rotate the selected plane normal to `+Y`, making the selected grid plane `Y=0`. Scene GLB contains a compact valid-face mesh, the source image texture, the estimated source camera, and the current viewer camera. Depth EXR remains in the original camera-depth coordinate system.

## Current Implementation

The browser pipeline is:

1. Run the selected MoGe-2 ONNX model with WebGPU, falling back to WASM when necessary.
2. Recover focal length and depth shift from the predicted point map, then apply the model's metric scale.
3. Reproject the result into a camera-space point map and convert it to Y-up world positions.
4. Remove masked pixels and triangles that cross invalid pixels or large depth discontinuities.
5. Display the textured mesh or point cloud with three.js.

The initial view and **Reset View** use the focal length estimated during MoGe post-processing. The viewer places the camera at the estimated source-camera origin and looks along the image's +Z axis, so the mesh opens from the same front-facing composition as the input image. If valid camera parameters are unavailable, the viewer falls back to a front-facing bounds fit.

For tabletop or other tilted-camera images, click **Adjust Horizontal Grid**. The current orbit plane first appears as a grid and the three-point instructions become visible. Select three well-spaced points on one surface to preview a new grid, then click **Use This Grid** to commit it or **Cancel** to discard it. The centroid becomes the orbit center and the plane normal becomes the up axis; point order does not matter. The committed grid disappears, but its center and up axis remain active. **Reset View** keeps this calibration and rebuilds the view from the estimated source-camera position.

## Run Locally

Use a local HTTP server instead of opening the page directly through `file://`.

On Windows, if Python is installed, run `run.bat` to start the server and open `http://localhost:8000/`.

To start it manually:

```powershell
cd Image_to_Mesh_web
python -m http.server 8000
```

Then open the following URL in Chrome or Edge:

```text
http://localhost:8000/
```

Press `Ctrl+C` in the server terminal to stop it.

## Troubleshooting

### The model fails to load

- Update Chrome or Edge to the latest version.
- Close other tabs and applications to free memory.
- Select ViT-S or ViT-B.
- If the browser cache was cleared, the model must be downloaded again.

### Inference stops or fails

- Reduce `num_tokens`.
- Select a smaller model.
- Reduce the source image resolution.

### Unwanted faces appear in the background

- Enable **Apply Mask**.
- Use an image with a clear boundary between the subject and background.

### Shape or distance is inaccurate

Single-image 3D estimation is inherently ambiguous. Transparent objects, mirrors, thin structures, textureless surfaces, strong blur, and extreme wide-angle images may produce larger errors.

## License

This tool is released under the [MIT License](LICENSE).

Inference uses MoGe-2 from [microsoft/MoGe](https://github.com/microsoft/moge). MoGe code is licensed under the MIT License, while the DINOv2 code included in MoGe is licensed under the Apache License 2.0. Use the models and related components in accordance with their respective licenses.
