# IFClite vs ThatOpen

> Created by **GitHub Copilot** (Claude Sonnet 4.6).

A side-by-side runtime comparison of two fully client-side IFC pipelines, built with **React 19 + TypeScript + Vite 8**.

| Left | Right |
|------|-------|
| **IFClite** — WebGPU renderer | **ThatOpen** — Three.js / WebGL2 renderer |

## Features

- Single `.ifc` file selection triggers both viewers concurrently
- Live progress bars, timing metrics, and rolling logs per viewer
- Spatial tree and property panels in **both** viewers
- Floating overlay UI per viewer: spatial tree (left), properties (right), details panel (bottom)
- Overlay panels are draggable, resizable, and individually closable/toggleable
- Tree behavior: auto-expands path to selected node and scrolls selected node into view
- Tree filtering: `IFCANNOTATION*` entities are excluded from both trees
- Selection behavior: click-picking in viewport and tree selection are synchronized
- IFClite selected element is highlighted directly in the WebGPU renderer
- Artifacts (CSV, JSON, `.frag`) persisted to OPFS when available
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
| `three` | Three.js r182 — scene graph for the ThatOpen side |

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
- IFClite artifacts: `entities.csv`, `spatial-hierarchy.csv`, `metrics.json`, and `model.bos` (parquet/BOS geometry export, best-effort).
- ThatOpen artifacts: `<model>.frag` binary fragment buffer and `metrics.json`.
