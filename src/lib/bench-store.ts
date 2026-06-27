// Cross-reload benchmark state.
//
// Each engine is measured in isolation: the page reloads between engines so each
// starts on a fresh V8 / clean JS heap and never competes with the other for the
// main thread. Surviving a reload requires persistence, so:
//   - the selected IFC bytes are stored in IndexedDB (too large for sessionStorage),
//   - the run phase + each engine's captured result live in sessionStorage
//     (small JSON, scoped to the tab, cleared when the tab closes),
//   - the chosen run order preference lives in localStorage (persists across tabs).

import type { ArtifactInfo, ViewerMetric } from '../types';

/** The engines compared (every id, regardless of run order). */
export type EngineId = 'ifclite' | 'thatopen';
export const ALL_ENGINES: EngineId[] = ['ifclite', 'thatopen'];

/** Selectable benchmark order (which engine runs / is shown first). */
export type OrderKey = 'ifclite-first' | 'thatopen-first';
export const ORDERS: Record<OrderKey, EngineId[]> = {
  'ifclite-first': ['ifclite', 'thatopen'],
  'thatopen-first': ['thatopen', 'ifclite'],
};

/** Phase = idle (no run), an engine id (that engine is being measured), or done. */
export type BenchPhase = 'idle' | EngineId | 'done';

export interface EngineResult {
  metrics: ViewerMetric[];
  artifacts: ArtifactInfo[];
  logs: string[];
  openMs?: number;
  error?: string;
}

const PHASE_KEY = 'bench.phase';
const NAME_KEY = 'bench.fileName';
const SIZE_KEY = 'bench.fileSize';
const ORDER_RUN_KEY = 'bench.order'; // sessionStorage: order snapshot for the active run
const ORDER_PREF_KEY = 'bench.orderPref'; // localStorage: persistent order preference
const RESULT_KEY = (engine: EngineId) => `bench.result.${engine}`;

const DB_NAME = 'ifc-compare-bench';
const STORE_NAME = 'files';
const FILE_KEY = 'current';

// ---------------------------------------------------------------------------
// Run order: preference (localStorage) + active-run snapshot (sessionStorage)
// ---------------------------------------------------------------------------
export function getOrderPref(): OrderKey {
  const value = localStorage.getItem(ORDER_PREF_KEY) as OrderKey | null;
  return value && value in ORDERS ? value : 'ifclite-first';
}

export function setOrderPref(key: OrderKey): void {
  localStorage.setItem(ORDER_PREF_KEY, key);
}

/** The engine order for the current run (snapshot), falling back to preference. */
export function getRunOrder(): EngineId[] {
  const key = (sessionStorage.getItem(ORDER_RUN_KEY) as OrderKey | null) ?? getOrderPref();
  return ORDERS[key] ?? ORDERS['ifclite-first'];
}

/** The engine that runs after `phase`, or null if `phase` is the last engine. */
export function nextEngine(phase: EngineId): EngineId | null {
  const order = getRunOrder();
  const index = order.indexOf(phase);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : null;
}

// ---------------------------------------------------------------------------
// sessionStorage: phase, file name, per-engine results
// ---------------------------------------------------------------------------
export function getBenchPhase(): BenchPhase {
  return (sessionStorage.getItem(PHASE_KEY) as BenchPhase | null) ?? 'idle';
}

export function setBenchPhase(phase: BenchPhase): void {
  sessionStorage.setItem(PHASE_KEY, phase);
}

export function getBenchFileName(): string | null {
  return sessionStorage.getItem(NAME_KEY);
}

export function getBenchFileSize(): number | null {
  const raw = sessionStorage.getItem(SIZE_KEY);
  return raw ? Number(raw) : null;
}

export function saveEngineResult(engine: EngineId, result: EngineResult): void {
  sessionStorage.setItem(RESULT_KEY(engine), JSON.stringify(result));
}

export function loadEngineResult(engine: EngineId): EngineResult | null {
  const raw = sessionStorage.getItem(RESULT_KEY(engine));
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as EngineResult;
  } catch {
    return null;
  }
}

export function clearBenchSession(): void {
  sessionStorage.removeItem(PHASE_KEY);
  sessionStorage.removeItem(NAME_KEY);
  sessionStorage.removeItem(SIZE_KEY);
  sessionStorage.removeItem(ORDER_RUN_KEY);
  ALL_ENGINES.forEach((id) => sessionStorage.removeItem(RESULT_KEY(id)));
}

// ---------------------------------------------------------------------------
// IndexedDB: the IFC bytes that must survive the reloads
// ---------------------------------------------------------------------------
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Persist the picked file, snapshot the order, and arm the first engine. */
export async function startBench(file: File): Promise<void> {
  const buffer = await file.arrayBuffer();
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ name: file.name, buffer }, FILE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  clearBenchSession();
  sessionStorage.setItem(NAME_KEY, file.name);
  sessionStorage.setItem(SIZE_KEY, String(file.size));
  sessionStorage.setItem(ORDER_RUN_KEY, getOrderPref());
  setBenchPhase(getRunOrder()[0]);
}

export async function loadBenchFile(): Promise<{ name: string; buffer: ArrayBuffer } | null> {
  const db = await openDb();
  try {
    return await new Promise<{ name: string; buffer: ArrayBuffer } | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(FILE_KEY);
      request.onsuccess = () => resolve((request.result as { name: string; buffer: ArrayBuffer } | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
