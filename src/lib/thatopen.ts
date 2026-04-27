import * as OBC from '@thatopen/components';
import * as OBF from '@thatopen/components-front';
import * as WEBIFC from 'web-ifc';
import { Box3, Vector3 } from 'three';
import { IfcParser } from '@ifc-lite/parser';
import { buildSpatialTree, buildEntityIndex, buildEntitySummary } from './ifc-tree';
import type { EntitySummary, ViewerAdapter, ViewerLoadContext, ViewerMetric } from '../types';
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

export function createThatOpenAdapter(container: HTMLDivElement): ViewerAdapter {
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
  let latestStore: Awaited<ReturnType<IfcParser['parseColumnar']>> | null = null;
  let latestEntityIndex: Record<number, EntitySummary> = {};
  let onSelectedCallback: ViewerLoadContext['onSelected'] | null = null;

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
    latestStore = null;
    latestEntityIndex = {};
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

      // Use ThatOpen's Highlighter for click-picking on the viewport.
      const highlighter = components.get(OBF.Highlighter);
      highlighter.setup({
        world,
        selectName: 'select',
        selectEnabled: true,
        autoHighlightOnClick: true,
      });
      highlighter.events.select.onHighlight.add((selection) => {
        if (!onSelectedCallback || !latestStore) {
          return;
        }

        const firstModelSelection = Object.values(selection)[0];
        const firstLocalId = firstModelSelection?.values().next().value;
        if (typeof firstLocalId !== 'number') {
          onSelectedCallback(undefined);
          return;
        }

        const existing = latestEntityIndex[firstLocalId];
        if (existing) {
          onSelectedCallback(existing);
          return;
        }

        const type = latestStore.entities.getTypeName(firstLocalId);
        const summary = buildEntitySummary(latestStore, firstLocalId, type && type !== 'UNKNOWN' ? type : 'IFCOBJECT');
        latestEntityIndex[firstLocalId] = summary;
        onSelectedCallback(summary);
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

      const fragBufferStart = performance.now();
      const [fragBuffer, parserStore] = await Promise.all([
        model.getBuffer(false),
        (async () => {
          const parser = new IfcParser();
          return parser.parseColumnar(context.buffer.slice(0));
        })(),
      ]);
      const fragBufferEnd = performance.now();
      
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

      // Build and emit spatial tree from the parsed store
      const tree = buildSpatialTree(parserStore);
      const entityIndex = buildEntityIndex(parserStore, tree);
      latestStore = parserStore;
      latestEntityIndex = entityIndex;
      context.onTree(tree);
      context.onEntityIndex(entityIndex);
      const firstNode = tree[0];
      if (firstNode) {
        context.onSelected(entityIndex[firstNode.expressId]);
      }

      context.onProgress({ phase: 'Complete', percent: 100 });

      // Ensure the view is zoomed to default after loading completes
      frameObject(world as unknown as OBC.World, currentModel?.object);
    },
    select() {
      // Selection highlight is handled by ThatOpen's Highlighter interaction pipeline.
    },
  };
}
