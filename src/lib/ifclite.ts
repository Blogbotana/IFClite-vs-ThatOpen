import { IfcParser, extractRelationshipsOnDemand } from '@ifc-lite/parser';
import { type IfcDataStore } from '@ifc-lite/parser';
import { buildEntitySummary } from './ifc-tree';
import { GeometryProcessor, decodeInstancedShard, type MeshData } from '@ifc-lite/geometry';
import { ParquetExporter } from '@ifc-lite/export';
import { Renderer, type RenderOptions } from '@ifc-lite/renderer';
import type { EntitySummary, ViewerAdapter, ViewerLoadContext, ViewerMetric } from '../types';
import { persistArtifacts, textBytes } from './file-system';

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

/** Alpha cutoff matching @ifc-lite/renderer's opaque/transparent instanced split. */
const OPAQUE_ALPHA_CUTOFF = 0.99;

/**
 * Expand GPU-instancing shards (IFNS) into flat `MeshData` the renderer's
 * `addMeshes` path can upload. With `enableInstancing: true` the WASM kernel
 * meshes each repeated template ONCE (it skips re-running CSG on thousands of
 * byte-identical parts) and emits the repeated OPAQUE occurrences as instanced
 * shards instead of flat meshes. This app's `Renderer` wrapper has no public
 * instanced-upload path, so we materialise each occurrence on the JS side:
 * cheap per-vertex matrix-transform copies, not WASM geometry work. We
 * reproduce the renderer's instance frame `SWAP · transform · T(origin)`
 * (worldVertex = transform·(origin+position), then IFC Z-up→Y-up swap
 * (x,y,z)→(x,z,-y), identical to the flat path).
 *
 * No-op for the injected Manifold engine, which predates instancing and emits
 * no shards. Transparent occurrences are skipped — the processor still emits
 * those as flat meshes, so materialising them would double-draw.
 */
function materializeInstancedShards(shards: ArrayBuffer[]): MeshData[] {
  const out: MeshData[] = [];
  for (const shard of shards) {
    let decoded;
    try {
      decoded = decodeInstancedShard(shard);
    } catch {
      continue;
    }
    for (const inst of decoded.instances) {
      if (inst.color[3] < OPAQUE_ALPHA_CUTOFF) continue; // transparent → flat path
      const tpl = decoded.templates[inst.templateIndex];
      if (!tpl) continue;
      const m = inst.transform; // row-major mat4
      const [ox, oy, oz] = tpl.origin;
      const src = tpl.positions;
      const srcN = tpl.normals;
      const vertexCount = src.length / 3;
      const positions = new Float32Array(src.length);
      const normals = new Float32Array(src.length);
      for (let i = 0; i < vertexCount; i++) {
        const j = i * 3;
        // worldVertex = transform · (origin + localPosition)
        const ax = src[j] + ox;
        const ay = src[j + 1] + oy;
        const az = src[j + 2] + oz;
        const bx = m[0] * ax + m[1] * ay + m[2] * az + m[3];
        const by = m[4] * ax + m[5] * ay + m[6] * az + m[7];
        const bz = m[8] * ax + m[9] * ay + m[10] * az + m[11];
        // IFC Z-up → WebGL Y-up swap (matches the flat MeshData frame)
        positions[j] = bx;
        positions[j + 1] = bz;
        positions[j + 2] = -by;
        // normals: linear part only (no translation, no origin)
        const nx = srcN[j];
        const ny = srcN[j + 1];
        const nz = srcN[j + 2];
        const nbx = m[0] * nx + m[1] * ny + m[2] * nz;
        const nby = m[4] * nx + m[5] * ny + m[6] * nz;
        const nbz = m[8] * nx + m[9] * ny + m[10] * nz;
        const yx = nbx;
        const yy = nbz;
        const yz = -nby;
        const len = Math.hypot(yx, yy, yz) || 1;
        normals[j] = yx / len;
        normals[j + 1] = yy / len;
        normals[j + 2] = yz / len;
      }
      out.push({
        expressId: inst.entityId,
        positions,
        normals,
        indices: tpl.indices.slice(),
        color: inst.color,
      });
    }
  }
  return out;
}

function screenSpacePan(
  camera: ReturnType<Renderer['getCamera']>,
  canvas: HTMLCanvasElement,
  deltaX: number,
  deltaY: number,
) {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);

  const pos = camera.getPosition();
  const target = camera.getTarget();
  const up = camera.getUp();

  const forward = {
    x: target.x - pos.x,
    y: target.y - pos.y,
    z: target.z - pos.z,
  };
  const distance = Math.hypot(forward.x, forward.y, forward.z);
  if (distance < 1e-6) {
    return;
  }

  const fwd = { x: forward.x / distance, y: forward.y / distance, z: forward.z / distance };

  // right = normalize(forward x up)
  const rightRaw = {
    x: fwd.y * up.z - fwd.z * up.y,
    y: fwd.z * up.x - fwd.x * up.z,
    z: fwd.x * up.y - fwd.y * up.x,
  };
  const rightLen = Math.hypot(rightRaw.x, rightRaw.y, rightRaw.z);
  if (rightLen < 1e-8) {
    return;
  }
  const right = { x: rightRaw.x / rightLen, y: rightRaw.y / rightLen, z: rightRaw.z / rightLen };

  // trueUp = normalize(right x forward)
  const upRaw = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  const upLen = Math.hypot(upRaw.x, upRaw.y, upRaw.z);
  if (upLen < 1e-8) {
    return;
  }
  const trueUp = { x: upRaw.x / upLen, y: upRaw.y / upLen, z: upRaw.z / upLen };

  // World-units per pixel at the target depth: this makes pan feel like
  // dragging a 2D snapshot of the viewport.
  const worldPerPixelY = (2 * distance * Math.tan(camera.getFOV() / 2)) / height;
  const worldPerPixelX = worldPerPixelY * (width / height);

  const offset = {
    x: -deltaX * worldPerPixelX * right.x + deltaY * worldPerPixelY * trueUp.x,
    y: -deltaX * worldPerPixelX * right.y + deltaY * worldPerPixelY * trueUp.y,
    z: -deltaX * worldPerPixelX * right.z + deltaY * worldPerPixelY * trueUp.z,
  };

  camera.setPosition(pos.x + offset.x, pos.y + offset.y, pos.z + offset.z);
  camera.setTarget(target.x + offset.x, target.y + offset.y, target.z + offset.z);
}

function getRelatedEntityCandidates(store: IfcDataStore, expressId: number): number[] {
  const getRelated = (id: number, relType: number, direction: 'forward' | 'inverse') => {
    try {
      return store.relationships?.getRelated(id, relType as any, direction) ?? [];
    } catch {
      return [];
    }
  };

  // RelationshipType constants from @ifc-lite/data
  const REL_FILLS_ELEMENT = 41;
  const REL_VOIDS_ELEMENT = 42;

  try {
    const rel = extractRelationshipsOnDemand(store, expressId);

    // Prioritize opening<->filling connections first so clicking an
    // IfcOpeningElement maps to its door/window when available.
    const ids = [
      ...getRelated(expressId, REL_FILLS_ELEMENT, 'forward'),
      ...getRelated(expressId, REL_FILLS_ELEMENT, 'inverse'),
      ...getRelated(expressId, REL_VOIDS_ELEMENT, 'inverse'),
      ...getRelated(expressId, REL_VOIDS_ELEMENT, 'forward'),
      ...rel.fills.map((item) => item.id),
      ...rel.voids.map((item) => item.id),
      ...rel.groups.map((item) => item.id),
      ...rel.connections.map((item) => item.id),
    ];

    return Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0 && id !== expressId)));
  } catch {
    return [];
  }
}

function resolveTreeSelectionExpressId(
  store: IfcDataStore,
  pickedExpressId: number,
  entityIndex: Record<number, EntitySummary>,
): number {
  if (entityIndex[pickedExpressId]) {
    return pickedExpressId;
  }

  // Walk relationship neighbors (fills/voids/groups/connections) to map
  // renderer-pick IDs to a user-visible entity that exists in the tree.
  const visited = new Set<number>([pickedExpressId]);
  const queue: Array<{ id: number; depth: number }> = [{ id: pickedExpressId, depth: 0 }];
  const maxDepth = 2;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    const neighbors = getRelatedEntityCandidates(store, current.id);
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) {
        continue;
      }
      visited.add(neighbor);

      if (entityIndex[neighbor]) {
        return neighbor;
      }

      if (current.depth < maxDepth) {
        queue.push({ id: neighbor, depth: current.depth + 1 });
      }
    }
  }

  const pickedType = (store.entities.getTypeName(pickedExpressId) || '').toUpperCase();
  if (pickedType.startsWith('IFCOPENINGELEMENT')) {
    const pickedName = (store.entities.getName(pickedExpressId) || '').trim();
    if (pickedName && pickedName !== '$') {
      for (const candidate of Object.values(entityIndex)) {
        const candidateType = candidate.type.toUpperCase();
        if (!candidateType.startsWith('IFCWINDOW') && !candidateType.startsWith('IFCDOOR')) {
          continue;
        }
        if (candidate.name.trim() === pickedName) {
          return candidate.expressId;
        }
      }
    }
  }

  const hierarchy = (store as any).spatialHierarchy;
  if (hierarchy && typeof hierarchy.getPath === 'function') {
    try {
      const path = hierarchy.getPath(pickedExpressId) as Array<{ expressId?: number }>;
      // Prefer the closest visible parent spatial node if picked entity isn't
      // represented in the tree directly.
      for (let index = path.length - 1; index >= 0; index -= 1) {
        const pathId = Number(path[index]?.expressId ?? 0);
        if (pathId > 0 && entityIndex[pathId]) {
          return pathId;
        }
      }
    } catch {
      // Ignore path lookup errors and fall through.
    }
  }

  return pickedExpressId;
}

// Minimal surface of @ifc-lite/geometry's GeometryProcessor the adapter needs.
// Declared structurally so a different geometry-engine version (e.g. the old
// Manifold-kernel build, aliased as @ifc-lite/geometry-manifold) can be injected.
export interface IfcLiteGeometryEngine {
  init(): Promise<void>;
  processStreaming(buffer: Uint8Array): AsyncIterable<unknown>;
}

export function createIfcLiteAdapter(
  canvas: HTMLCanvasElement,
  geometryEngine?: IfcLiteGeometryEngine,
): ViewerAdapter {
  const renderer = new Renderer(canvas);
  // Instancing ON (the @ifc-lite/geometry v2 default, matching ThatOpen, which
  // instances repeated parts by design). Repeated OPAQUE occurrences arrive as
  // packed `instancedShards` instead of flat meshes — the kernel meshes each
  // template ONCE instead of re-running CSG per duplicate. The Renderer wrapper
  // exposes no instanced upload, so the streaming loop materialises shards into
  // flat MeshData via `materializeInstancedShards`.
  // NOTE: only the default (current exact) engine instances. The injected
  // Manifold build (geometry@2.4.0) predates instancing and stays flat — so in
  // this three-way comparison the exact kernel gets the instancing win and the
  // Manifold engine does not. Keep that in mind when reading kernel-vs-kernel
  // numbers here.
  const geometry: IfcLiteGeometryEngine =
    geometryEngine ?? new GeometryProcessor({ enableInstancing: true });
  let animationFrame = 0;
  let latestStore: IfcDataStore | null = null;
  let latestEntityIndex: Record<number, EntitySummary> = {};
  let latestMeshes: MeshData[] = [];
  let onSelectedCallback: ViewerLoadContext['onSelected'] | null = null;
  let selectedExpressId: number | null = null;
  let lastInteractionAt = 0;

  const INTERACTION_DECAY_MS = 140;
  const MAX_PIXEL_RATIO = 2;
  const BASE_VISUAL_ENHANCEMENT: NonNullable<RenderOptions['visualEnhancement']> = {
    enabled: true,
    edgeContrast: {
      enabled: true,
      intensity: 0.55,
    },
    contactShading: {
      quality: 'high',
      intensity: 0.25,
      radius: 1.2,
    },
    separationLines: {
      enabled: true,
      quality: 'high',
      intensity: 0.45,
      radius: 1.15,
    },
  };

  // Tuned to feel closer to ThatOpen interaction speed.
  const ORBIT_SENSITIVITY_FACTOR = 0.45;
  const WHEEL_SENSITIVITY_FACTOR = 0.35;
  const MAX_WHEEL_DELTA = 80;

  // --- Camera interaction state ---
  let isDragging = false;
  let didDrag = false;
  let dragButton = 0;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    isDragging = true;
    didDrag = false;
    dragButton = e.button;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!isDragging) return;
    lastInteractionAt = performance.now();
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      didDrag = true;
    }
    lastX = e.clientX;
    lastY = e.clientY;
    const cam = renderer.getCamera();
    if (dragButton === 2 || (dragButton === 0 && e.shiftKey)) {
      screenSpacePan(cam, canvas, dx, dy);
    } else {
      cam.orbit(dx * ORBIT_SENSITIVITY_FACTOR, dy * ORBIT_SENSITIVITY_FACTOR, false);
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    const wasDragging = isDragging;
    isDragging = false;

    // Click without camera movement selects IFC elements.
    if (!wasDragging || didDrag || !latestStore || !onSelectedCallback) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const storeAtPick = latestStore;
    if (!storeAtPick) {
      return;
    }

    // Orbit-around-selection: aim future orbits at the precise surface point
    // under the cursor so the camera rotates about the clicked object.
    try {
      const hit = renderer.raycastScene(x, y);
      if (hit?.intersection?.point) {
        renderer.getCamera().setOrbitCenter(hit.intersection.point);
      }
    } catch {
      // Raycast is best-effort; ignore failures and keep the default pivot.
    }

    void renderer.pick(x, y).then((result) => {
      if (!result || result.expressId <= 0) {
        selectedExpressId = null;
        renderer.getCamera().setOrbitCenter(null);
        renderer.requestRender();
        onSelectedCallback?.(undefined);
        return;
      }

      const pickedExpressId = result.expressId;
      const expressId = resolveTreeSelectionExpressId(storeAtPick, pickedExpressId, latestEntityIndex);
      selectedExpressId = expressId;
      renderer.requestRender();
      const existing = latestEntityIndex[expressId];
      if (existing) {
        onSelectedCallback?.(existing);
        return;
      }

      const type = storeAtPick.entities.getTypeName(expressId);
      const summary = buildEntitySummary(storeAtPick, expressId, type && type !== 'UNKNOWN' ? type : 'IFCOBJECT');
      latestEntityIndex[expressId] = summary;
      onSelectedCallback?.(summary);
    });
  };
  const onWheel = (e: WheelEvent) => {
    lastInteractionAt = performance.now();
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const modeScale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1;
    const wheelDelta = Math.max(
      -MAX_WHEEL_DELTA,
      Math.min(MAX_WHEEL_DELTA, e.deltaY * modeScale * WHEEL_SENSITIVITY_FACTOR),
    );
    renderer
      .getCamera()
      .zoom(wheelDelta, false, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
  };
  const onContextMenu = (e: MouseEvent) => e.preventDefault();

  // --- Render loop with resize handling ---
  let lastTimestamp = performance.now();
  const renderLoop = () => {
    const now = performance.now();
    const dt = Math.min((now - lastTimestamp) / 1000, 0.05);
    lastTimestamp = now;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const targetW = Math.max(1, Math.round(w * pixelRatio));
    const targetH = Math.max(1, Math.round(h * pixelRatio));
    if (w > 0 && h > 0 && (canvas.width !== targetW || canvas.height !== targetH)) {
      renderer.resize(targetW, targetH);
    }
    renderer.getCamera().update(dt);
    renderer.render({
      isInteracting: now - lastInteractionAt < INTERACTION_DECAY_MS,
      visualEnhancement: BASE_VISUAL_ENHANCEMENT,
      selectedId: selectedExpressId,
    });
    animationFrame = window.requestAnimationFrame(renderLoop);
  };

  const clearCurrentModel = () => {
    renderer.getScene().clear();
    renderer.clearCaches();
    latestStore = null;
    latestEntityIndex = {};
    latestMeshes = [];
    selectedExpressId = null;
    onSelectedCallback = null;
    renderer.requestRender();
  };

  return {
    async init() {
      await renderer.init();
      await geometry.init();
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', onContextMenu);
      renderLoop();
    },
    dispose() {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
    reset() {
      renderer.getCamera().setOrbitCenter(null);
      if (latestMeshes.length > 0) {
        renderer.fitToView();
      } else {
        renderer.getCamera().reset();
      }
      renderer.requestRender();
    },
    async load(context: ViewerLoadContext) {
      clearCurrentModel();
      onSelectedCallback = context.onSelected;
      const parser = new IfcParser();
      const start = performance.now();
      const fileBytes = new Uint8Array(context.buffer);

      const storePromise = parser.parseColumnar(context.buffer.slice(0), {
        onProgress: ({ phase, percent }) => {
          context.onProgress({ phase: `Parsing metadata: ${phase}`, percent: Math.min(45, percent * 0.45) });
        },
      });

      context.onLog('Streaming IFClite geometry...');

      let meshCount = 0;
      let firstBatchAt: number | null = null;
      for await (const rawEvent of geometry.processStreaming(fileBytes)) {
        const event = rawEvent as {
          type: string;
          meshes: MeshData[];
          totalSoFar?: number;
          totalMeshes?: number;
          instancedShards?: ArrayBuffer[];
        };
        switch (event.type) {
          case 'start':
            context.onProgress({ phase: 'Preparing geometry stream', percent: 10 });
            break;
          case 'batch': {
            if (firstBatchAt === null) {
              firstBatchAt = performance.now();
            }
            // Flat (unique + transparent) meshes upload directly; repeated opaque
            // occurrences arrive as instanced shards (default engine only) and are
            // materialised so the flat renderer can draw them.
            const batchMeshes = event.meshes.slice();
            if (event.instancedShards?.length) {
              batchMeshes.push(...materializeInstancedShards(event.instancedShards));
            }
            latestMeshes.push(...batchMeshes);
            meshCount += batchMeshes.length;
            renderer.addMeshes(batchMeshes, true);
            context.onProgress({
              phase: `Rendering geometry (${meshCount.toLocaleString()} meshes)`,
              percent: Math.min(90, 45 + Math.log10(Math.max(10, event.totalSoFar || meshCount)) * 12),
            });
            context.onLog(`IFClite batch: +${batchMeshes.length} meshes, total ${meshCount.toLocaleString()}`);
            break;
          }
          case 'complete':
            renderer.fitToView();
            context.onLog(`IFClite geometry complete: ${(event.totalMeshes ?? meshCount).toLocaleString()} meshes`);
            break;
        }
      }

      latestStore = await storePromise;
      const completedAt = performance.now();
      const renderReadyAt = await new Promise<number>((resolve) => {
        requestAnimationFrame(() => resolve(performance.now()));
      });

      const artifactsPersistStart = performance.now();
      const artifactFiles: Array<{ name: string; bytes: Uint8Array }> = [];
      try {
        const parquet = new ParquetExporter(latestStore, { meshes: latestMeshes } as any);
        artifactFiles.push({ name: 'model.bos', bytes: await parquet.exportBOS({ includeGeometry: true }) });
      } catch (error) {
        context.onLog(`IFClite parquet export skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      artifactFiles.push({
        name: 'metrics.json',
        bytes: textBytes(JSON.stringify({ meshCount }, null, 2)),
      });
      const artifacts = await persistArtifacts('ifclite', context.file.name, artifactFiles);
      const artifactsPersistEnd = performance.now();
      const totalEnd = performance.now();
      const artifactSizeBytes = artifacts.reduce((sum, a) => sum + a.size, 0);

      const metrics: ViewerMetric[] = [
        { label: 'Schema', value: latestStore.schemaVersion },
        { label: 'Entities', value: latestStore.entityCount.toLocaleString() },
        { label: 'Meshes', value: meshCount.toLocaleString() },
        { label: 'IFC parsing time', value: `${(completedAt - start).toFixed(0)} ms` },
        { label: 'First geometry frame', value: `${((firstBatchAt ?? completedAt) - start).toFixed(0)} ms` },
        { label: 'Render ready time', value: `${(renderReadyAt - start).toFixed(0)} ms` },
        { label: 'Artifact save time', value: `${(artifactsPersistEnd - artifactsPersistStart).toFixed(0)} ms` },
        { label: 'End-to-end time', value: `${(totalEnd - start).toFixed(0)} ms` },
        { label: 'Artifact size', value: formatBytes(artifactSizeBytes) },
      ];
      context.onMetrics(metrics);
      context.onArtifacts(artifacts);
      context.onProgress({ phase: 'Complete', percent: 100 });

      // Ensure the view is zoomed to default after loading completes
      renderer.fitToView();
    },
    select(expressId?: number) {
      selectedExpressId = expressId ?? null;
      if (expressId === undefined) {
        renderer.getCamera().setOrbitCenter(null);
      }
      renderer.requestRender();
    },
  };
}
