# IFClite vs ThatOpen

> Created by **GitHub Copilot** (Claude Sonnet 4.6).

A side-by-side runtime comparison of two fully client-side IFC pipelines, built with **React 19 + TypeScript + Vite 8**.

| Left | Right |
|------|-------|
| **IFClite** — WebGPU renderer | **ThatOpen** — Three.js / WebGL2 renderer |

## Features

- Single `.ifc` file selection runs an **isolated benchmark with a page reload between engines**: IFClite is measured on a fresh page, the page reloads, then ThatOpen is measured on a fresh page. Each engine starts on a clean V8 heap, so timings, FPS and `performance.memory` are honest per-engine figures (IFClite does most of its work on the main thread, so a shared/concurrent run would skew them). The file is stashed in IndexedDB and the run phase + results in `sessionStorage` to survive the reload. Final screen shows ThatOpen's live 3D plus both engines' isolated metrics (IFClite's panel is hydrated from its stored result).
- Live progress bars, timing metrics, and rolling logs per viewer
- Per-viewer runtime HUD: live **model-open timer**, **frame rate (FPS)**, and **JS heap memory**
- Click an element in either viewer to **orbit the camera around the selected object**
- IFClite selected element is highlighted directly in the WebGPU renderer
- Floating, draggable details panel (stats / logs) per viewer
- Artifacts (`.bos`, JSON, `.frag`) persisted to OPFS when available
- Reset view button per viewer

## Stack

### IFClite pipeline

| Package | Role |
|---------|------|
| `@ifc-lite/parser` | STEP tokenisation, columnar entity index, spatial hierarchy, property/quantity extraction |
| `@ifc-lite/geometry` | WASM geometry processor — streams `MeshData` typed arrays |
| `@ifc-lite/renderer` | WebGPU renderer with 4× MSAA, ACES tone mapping, contact shading, separation lines |
| `@ifc-lite/export` | CSV, parquet/BOS, and JSON artifact export |

### ThatOpen pipeline

| Package | Role |
|---------|------|
| `@thatopen/components` | Core ECS world, scene, camera, fragment manager, IFC loader |
| `@thatopen/components-front` | `PostproductionRenderer` (Three.js + post-processing) |
| `@thatopen/fragments` | Fragment streaming worker and `.frag` binary format |
| `web-ifc` | WASM IFC parser used internally by ThatOpen |
| `three` | Three.js r185 — scene graph for the ThatOpen side |

### Dev/build tooling

| Package | Role |
|---------|------|
| Vite 8 + `vite-plugin-wasm` | Dev server and production bundler; WASM asset handling |
| TypeScript 5.8 | Type checking across all source |
| `@vitejs/plugin-react` | React fast-refresh in development |

## Getting started

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # production build to dist/
npm run preview   # preview production build locally
```

> **Browser requirements:** WebGPU (for the IFClite side) is available in Chrome 113+, Edge 113+, and Safari 18+. Firefox does not yet support WebGPU. Both sides require `SharedArrayBuffer`, which needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` — the dev server and preview server set these automatically.

## Project structure

```
src/
  App.tsx              # Application shell, split layout, shared file input, per-viewer state
  types.ts             # Shared TypeScript interfaces (ViewerAdapter, ViewerState, etc.)
  lib/
    ifc-tree.ts        # Shared spatial-tree/entity-index helpers for IFClite + ThatOpen
    ifclite.ts         # IFClite ViewerAdapter — geometry streaming, renderer init, quality/select/pan controls
    thatopen.ts        # ThatOpen ViewerAdapter — world setup, IFC→fragments pipeline + selection bridge
    file-system.ts     # OPFS persistence helpers
public/
  thatopen-worker.mjs  # Copied from @thatopen/fragments at build time
  wasm/                # web-ifc WASM binaries (web-ifc.wasm, web-ifc-mt.wasm), copied at build time
```

## Implementation notes

- `vite-plugin-wasm` is required because `@ifc-lite/export` pulls in `parquet-wasm` assets.
- A Vite pre-transform plugin strips `sourceMappingURL` comments from `@ifc-lite/*` runtime JS to reduce noisy missing-source sourcemap warnings in dev logs.
- The dev and preview servers set `COOP: same-origin` + `COEP: credentialless` for WASM `SharedArrayBuffer` support.
- The ThatOpen worker and `web-ifc` WASM files are copied into `public/` by a Vite plugin hook in `vite.config.ts` so they are served same-origin and not blocked by COEP.
- IFClite render quality is tuned via `visualEnhancement` options on each frame: contact shading (`high`), separation lines (`high`), and edge contrast enabled. The canvas is sized at device pixel ratio (capped at 2×) for sharp edges on HiDPI displays.
- IFClite panning uses screen-space translation ("dragging a 2D snapshot" feel) rather than distance-scaled pan behavior.
- IFClite viewport picking uses `renderer.pick(...)` and passes `selectedId` into `renderer.render(...)` for in-view highlight.
- ThatOpen viewport picking uses `@thatopen/components-front` `Highlighter` and maps selected IDs to shared entity summaries.
- Spatial trees are built from a shared helper (`src/lib/ifc-tree.ts`) for consistent output across both viewers.
- Both viewer adapters are loaded via dynamic `import()` inside the React init effect, so Vite emits them as separate async chunks. The app shell loads first; viewer chunks are fetched in parallel once the canvas elements are mounted.
- IFClite artifacts: `metrics.json` and `model.bos` (parquet/BOS geometry export, best-effort). CSV export was dropped when `@ifc-lite/export` removed `CSVExporter` in v2.
- ThatOpen artifacts: `<model>.frag` binary fragment buffer and `metrics.json`.
- Orbit-around-selection: IFClite raycasts the clicked surface point and calls `camera.setOrbitCenter(...)`; ThatOpen reads the selected element's bounding box (`model.getBoxes`) and calls `controls.setOrbitPoint(...)`.
- The runtime HUD reads frame rate from each adapter's render loop (`getStats()`) and JS heap usage from the non-standard, Chromium-only `performance.memory` (a page-level figure shared by both viewers).
