import * as OBC from '@thatopen/components';
import * as OBF from '@thatopen/components-front';
import * as WEBIFC from 'web-ifc';
import { Box3, Vector3 } from 'three';
import type { ViewerAdapter, ViewerLoadContext, ViewerMetric } from '../types';
import { persistArtifacts, textBytes } from './file-system';

const THATOPEN_LOAD_TIMEOUT_MS = 120_000;
let webIfcInitPatched = false;

function forceWebIfcSingleThreadInit() {
  if (webIfcInitPatched) {
    return;
  }

  const prototype = WEBIFC.IfcAPI.prototype as any;
  const originalInit = prototype.Init;
  prototype.Init = function patchedInit(customLocateFileHandler?: any) {
    // Force single-thread mode to avoid web-ifc pthread worker URL resolving to /undefined in Vite.
    return originalInit.call(this, customLocateFileHandler, true);
  };

  webIfcInitPatched = true;
}

async function waitForCameraControls(
  world: OBC.World,
  attempts = 6,
) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const controls = world.camera.controls;
      if (controls) {
        return controls;
      }
    } catch {
      // Camera can be unavailable very early in init; retry on the next frame.
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return undefined;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function frameObject(world: OBC.World, object: any) {
  const bounds = new Box3().setFromObject(object);
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) || 10;
  if (!world.camera.controls) {
    return;
  }
  void world.camera.controls.setLookAt(
    center.x + radius * 1.5,
    center.y + radius,
    center.z + radius * 1.5,
    center.x,
    center.y,
    center.z,
    true,
  );
}

export function createThatOpenAdapter(
  container: HTMLDivElement,
  options?: { circleSegments?: number },
): ViewerAdapter {
  forceWebIfcSingleThreadInit();

  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBF.PostproductionRenderer>();
  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBF.PostproductionRenderer(components, container);
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  const fragments = components.get(OBC.FragmentsManager);
  const ifcLoader = components.get(OBC.IfcLoader);
  const grid = components.get(OBC.Grids);
  let currentModel: any = null;
  let currentModelId: string | null = null;
  let activeLoadModelId: string | null = null;
  let onSelectedCallback: ViewerLoadContext['onSelected'] | null = null;
  // Fragment buffer from the cold load — the warm-open cache (reopen() loads
  // these pre-meshed fragments directly, skipping IFC parse + web-ifc geometry).
  let cachedFragBuffer: ArrayBuffer | null = null;

  // Re-aim the camera's orbit pivot at the bounding-box centre of the selected
  // element so dragging rotates the view around that object.
  const orbitAroundLocalId = async (localId: number) => {
    if (!currentModel || typeof currentModel.getBoxes !== 'function') {
      return;
    }
    try {
      const boxes: Box3[] = await currentModel.getBoxes([localId]);
      const box = boxes?.[0];
      if (!box) {
        return;
      }
      const center = box.getCenter(new Vector3());
      world.camera.controls?.setOrbitPoint(center.x, center.y, center.z);
    } catch (error) {
      console.warn('[ThatOpen] Failed to set orbit point:', error);
    }
  };

  const clearCurrentModel = async () => {
    if (activeLoadModelId) {
      fragments.core.abort(activeLoadModelId);
      activeLoadModelId = null;
    }

    if (currentModelId) {
      try {
        await fragments.core.disposeModel(currentModelId);
      } catch (error) {
        console.warn('[ThatOpen] Failed to dispose previous model:', error);
      }
      currentModelId = null;
    }

    if (currentModel?.object) {
      world.scene.three.remove(currentModel.object);
    }
    currentModel = null;
    fragments.core.update(true);
  };

  return {
    async init() {
      components.init();
      world.scene.setup();
      world.scene.three.background = null;
      grid.create(world);
      const controls = await waitForCameraControls(world);
      if (!controls) {
        throw new Error('ThatOpen camera controls were not initialized.');
      }
      // Middle (wheel) button drags → pan, matching the ifc-lite viewer and the
      // CAD convention. camera-controls default for `middle` is DOLLY (16);
      // ACTION.TRUCK = 2 is screen-space pan. (Wheel scroll stays dolly/zoom.)
      (controls as any).mouseButtons.middle = 2;
      // Use the locally-served worker (copied to public/ by vite.config.ts) so
      // it is same-origin and never blocked by COEP or network issues.
      fragments.init('/thatopen-worker.mjs');
      controls.addEventListener('update', () => fragments.core.update());
      fragments.list.onItemSet.add(({ value: model }) => {
        currentModel = model;
        try {
          model.useCamera(world.camera.three);
        } catch (error) {
          console.warn('[ThatOpen] Model camera binding skipped:', error);
        }
        world.scene.three.add(model.object);
        fragments.core.update(true);
      });
      // Use web-ifc WASM served locally from public/wasm/ (also copied by vite.config.ts)
      await ifcLoader.setup({
        autoSetWasm: false,
        wasm: {
          path: '/wasm/',
          absolute: true,
        },
      });
      // Detail control: web-ifc CIRCLE_SEGMENTS = number of segments used to
      // approximate circles/curves (the ThatOpen analogue of ifc-lite's
      // tessellation quality). Mapped from the chosen detail tier.
      if (options?.circleSegments !== undefined && ifcLoader.settings.webIfc) {
        ifcLoader.settings.webIfc.CIRCLE_SEGMENTS = options.circleSegments;
      }

      // Use ThatOpen's Highlighter for click-picking on the viewport.
      const highlighter = components.get(OBF.Highlighter);
      highlighter.setup({
        world,
        selectName: 'select',
        selectEnabled: true,
        autoHighlightOnClick: true,
      });
      highlighter.events.select.onHighlight.add((selection) => {
        const firstModelSelection = Object.values(selection)[0];
        const firstLocalId = firstModelSelection?.values().next().value;
        if (typeof firstLocalId !== 'number') {
          onSelectedCallback?.(undefined);
          return;
        }

        // Re-aim the orbit pivot at the clicked element (works without the parser store).
        void orbitAroundLocalId(firstLocalId);
        onSelectedCallback?.({ expressId: firstLocalId, type: 'IFCOBJECT', name: `#${firstLocalId}`, propertyGroups: [] });
      });

      await controls.setLookAt(24, 18, 24, 0, 0, 0, true);
    },
    dispose() {
      fragments.dispose();
      components.dispose();
    },
    reset() {
      if (currentModel?.object) {
        frameObject(world as unknown as OBC.World, currentModel.object);
      } else {
        void world.camera.controls?.setLookAt(24, 18, 24, 0, 0, 0, true);
      }
    },
    async load(context: ViewerLoadContext) {
      onSelectedCallback = context.onSelected;
      await clearCurrentModel();
      context.onProgress({ phase: 'Converting IFC to Fragments', percent: 5 });
      context.onLog('Running ThatOpen IFC conversion...');
      const start = performance.now();

      let lastProgress = 0;
      const bytes = new Uint8Array(context.buffer);
      const baseModelName = context.file.name.replace(/\.ifc$/i, '');
      const loadWithTimeout = async (minimalMode: boolean, modelId: string) => {
        activeLoadModelId = modelId;
        const options = {
          processData: {
            progressCallback: (progress: number) => {
              lastProgress = progress;
              context.onProgress({ phase: 'Converting IFC to Fragments', percent: Math.min(92, 5 + progress * 0.87) });
            },
          },
          ...(minimalMode
            ? {}
            : {
                instanceCallback: (importer: any) => {
                  importer.addAllAttributes();
                  importer.addAllRelations();
                },
              }),
        };

        return await Promise.race([
          ifcLoader.load(bytes, false, modelId, options),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`ThatOpen conversion timed out after ${THATOPEN_LOAD_TIMEOUT_MS}ms`)), THATOPEN_LOAD_TIMEOUT_MS);
          }),
        ]);
      };

      let model: any;
      const primaryModelId = `${baseModelName}-${Date.now()}`;
      try {
        model = await loadWithTimeout(false, primaryModelId);
      } catch (error) {
        context.onLog(
          `ThatOpen primary conversion failed, retrying minimal mode: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (activeLoadModelId) {
          fragments.core.abort(activeLoadModelId);
        }
        const retryModelId = `${primaryModelId}-retry`;
        model = await loadWithTimeout(true, retryModelId);
      }
      const conversionEnd = performance.now();

      activeLoadModelId = null;

      currentModel = model;
      currentModelId = model.modelId ?? null;
      frameObject(world as unknown as OBC.World, model.object);
      fragments.core.update(true);
      const renderReadyAt = await new Promise<number>((resolve) => {
        requestAnimationFrame(() => resolve(performance.now()));
      });
      // Model is on screen — stop the open-timer here, symmetric with ifc-lite,
      // so the fragment-buffer dump + persist below don't inflate "Open time".
      context.onReady?.();

      const fragBufferStart = performance.now();
      const fragBuffer = await model.getBuffer(false);
      const fragBufferEnd = performance.now();
      cachedFragBuffer = fragBuffer.slice(0); // keep a copy for the warm re-open
      
      const artifactsPersistStart = performance.now();
      const artifactList = await persistArtifacts('thatopen', context.file.name, [
        { name: `${context.file.name.replace(/\.ifc$/i, '')}.frag`, bytes: new Uint8Array(fragBuffer) },
        {
          name: 'metrics.json',
          bytes: textBytes(JSON.stringify({ progress: lastProgress }, null, 2)),
        },
      ]);
      const artifactsPersistEnd = performance.now();
      const totalEnd = performance.now();

      const metrics: ViewerMetric[] = [
        { label: 'Fragments', value: `${fragments.list.size}` },
        { label: 'IFC conversion time', value: `${(conversionEnd - start).toFixed(0)} ms` },
        { label: 'Render ready time', value: `${(renderReadyAt - start).toFixed(0)} ms` },
        { label: 'Fragment buffer encode time', value: `${(fragBufferEnd - fragBufferStart).toFixed(0)} ms` },
        { label: 'Artifact save time', value: `${(artifactsPersistEnd - artifactsPersistStart).toFixed(0)} ms` },
        { label: 'End-to-end time', value: `${(totalEnd - start).toFixed(0)} ms` },
        { label: 'Artifact size', value: formatBytes(fragBuffer.byteLength) },
      ];
      context.onMetrics(metrics);
      context.onArtifacts(artifactList);

      context.onProgress({ phase: 'Complete', percent: 100 });

      // Ensure the view is zoomed to default after loading completes
      frameObject(world as unknown as OBC.World, currentModel?.object);
    },
    async reopen(context: ViewerLoadContext, cachedBuffer?: ArrayBuffer) {
      // In-memory .frag for the warm-open metric; an external buffer (persisted
      // `.frag` artifact) for the end-of-run "show all models" reopen.
      const fragBytes = cachedBuffer ?? cachedFragBuffer;
      if (!fragBytes) {
        throw new Error('ThatOpen re-open: no fragment cache (load() must run first)');
      }
      context.onProgress({ phase: 'Re-opening from fragments', percent: 10 });
      await clearCurrentModel();
      // Load the pre-meshed .frag directly — no IFC parse, no web-ifc geometry.
      const modelId = `reopen-${Date.now()}`;
      activeLoadModelId = modelId;
      const model = await fragments.core.load(new Uint8Array(fragBytes), { modelId, raw: false });
      activeLoadModelId = null;
      currentModel = model;
      currentModelId = model.modelId ?? modelId;
      frameObject(world as unknown as OBC.World, model.object);
      fragments.core.update(true);
      await new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now())));
      context.onProgress({ phase: 'Complete', percent: 100 });
      context.onLog('ThatOpen re-opened from fragments (.frag)');
    },
    select() {
      // Selection highlight is handled by ThatOpen's Highlighter interaction pipeline.
    },
  };
}
