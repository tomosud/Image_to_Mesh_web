# Depth Upsampling Plan

Last updated: 2026-07-05

## Goal

Raise the metric depth resolution after MoGe post-processing and before geometry/backfill/export steps. The target resolution follows the input image aspect ratio, with the long edge capped at 2048 px.

## Integration Decision

- Insert the upsampling step immediately after `MogePost.process()`.
- Reproject the filtered high-resolution depth back to camera-space points using normalized intrinsics, then pass the result into the existing mask cleanup, EdgeSnap, WorldPos, NormalMap, Backfill, Viewer, and EXR download flow.
- Keep depth in float32 meters for computation and EXR output. No 8-bit conversion is used except for RGB guide input and display textures.
- Use WebGPU compute for the RGB-guided joint bilateral filter. If WebGPU is unavailable, fall back to initial nearest/bilinear depth resize only so the current tool remains usable on WASM/non-WebGPU browsers.
- Add a debug EXR download for the pre-filter high-resolution depth.

## Implementation Steps

- [x] Inspect existing MoGe depth, points, mask, world-position, viewer, and download flow.
- [x] Review the sample bilateral upsampling implementation and extract the joint bilateral concept rather than porting OpenCV/C++ code.
- [x] Add a browser-side `DepthUpsampler` module with:
  - target size calculation capped at 2048 px
  - nearest/bilinear initial depth resize
  - RGB guide resize
  - WebGPU compute shader joint bilateral filter
  - CPU-safe fallback to the initial resize
  - point reprojection and normal resampling
- [x] Wire the module into `main.js` before downstream processing.
- [x] Add UI controls for enable/mode/radius/sigma parameters and invalid-zero handling.
- [x] Add debug download for the initial high-resolution depth EXR.
- [x] Update `index.html` cache-busting and script loading.
- [x] Run syntax checks.
- [x] Update progress notes.

## 2026-07-05 Implementation Log

- Added `js/depth_upsample.js`.
- WebGPU path uses a WGSL compute shader over high-resolution RGB and initial resized metric depth.
- Fallback path returns the initial resized depth when WebGPU is unavailable or device setup fails.
- `main.js` now awaits depth upsampling before mask cleanup, sky backdrop, EdgeSnap, WorldPos, NormalMap, Backfill, Viewer, and exports.
- Added UI controls for enable, initial resize mode, radius, sigma values, zero-as-invalid, and custom invalid value.
- Added `Initial Depth (EXR)` debug download for the pre-filter high-resolution depth.
- Verified JavaScript syntax with:
  - `node --check js/depth_upsample.js`
  - `node --check js/main.js`
  - `node --check js/download.js`

## Remaining Verification

Browser verification is intentionally left to the user per `CLAUDE.md`. Key checks:

- WebGPU browser: status should show `WebGPU`, and final depth/mesh resolution should match the image aspect ratio with max long edge 2048.
- Non-WebGPU browser: status should show `initial resize`, and the tool should still produce output.
- Compare `Initial Depth (EXR)` against `Depth (EXR)` to confirm the joint bilateral filter changes only the final depth.

## Notes

The separate depth visualization canvas and false-color display requested in the draft instruction are not added in this pass because this tool's primary display is the 3D world-position viewer. The important integration point is the depth/points data entering the later geometry pipeline, plus debug EXR output.
