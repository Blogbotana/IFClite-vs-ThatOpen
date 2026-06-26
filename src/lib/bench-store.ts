// Cross-reload benchmark state.
//
// To measure each engine in isolation, the app reloads the page between runs so
// each engine starts on a fresh V8 / clean JS heap (this also makes
// `performance.memory` a genuine per-engine figure). That requires surviving a
// full reload, so:
//   - the selected IFC bytes are stored in IndexedDB (too large for sessionStorage),
//   - the run phase + each engine's captured result live in sessionStorage
//     (small JSON, scoped to the tab, cleared when the tab closes).

import type { ArtifactInfo, ViewerMetric } from '../types';

export type BenchPhase = 'idle' | 'ifclite' | 'thatopen' | 'done';

export interface EngineResult {
  metrics: ViewerMetric[];
  artifacts: ArtifactInfo[];
  logs: string[];
  openMs?: number;
  error?: string;
  fps?: number;
  heapUsedBytes?: number;
}

const PHASE_KEY = 'bench.phase';
const NAME_KEY = 'bench.fileName';
const SIZE_KEY = 'bench.fileSize';
const RESULT_KEY = (engine: 'ifclite' | 'thatopen') => `bench.result.${engine}`;

const DB_NAME = 'ifc-compare-bench';
const STORE_NAME = 'files';
const FILE_KEY = 'current';

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

export function saveEngineResult(engine: 'ifclite' | 'thatopen', result: EngineResult): void {
  sessionStorage.setItem(RESULT_KEY(engine), JSON.stringify(result));
}

export function loadEngineResult(engine: 'ifclite' | 'thatopen'): EngineResult | null {
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
  sessionStorage.removeItem(RESULT_KEY('ifclite'));
  sessionStorage.removeItem(RESULT_KEY('thatopen'));
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

/** Persist the picked file and arm the benchmark (phase = ifclite). */
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
  setBenchPhase('ifclite');
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
