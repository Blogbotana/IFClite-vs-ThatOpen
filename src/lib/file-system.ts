import type { ArtifactInfo } from '../types';

type StorageWithDirectory = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

async function getRootDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const storage = navigator.storage as StorageWithDirectory;
  if (!storage.getDirectory) {
    return null;
  }
  return storage.getDirectory();
}

async function ensureDirectory(
  root: FileSystemDirectoryHandle,
  pathSegments: string[],
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of pathSegments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

export async function persistArtifacts(
  library: string,
  fileName: string,
  files: Array<{ name: string; bytes: Uint8Array; mimeType?: string }>,
): Promise<ArtifactInfo[]> {
  const root = await getRootDirectory();
  if (!root) {
    return files.map((file) => ({
      name: file.name,
      size: file.bytes.byteLength,
      path: 'browser-memory',
    }));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = await ensureDirectory(root, ['ifc-compare', stamp, library, safeFileName]);

  const artifacts: ArtifactInfo[] = [];
  for (const file of files) {
    const handle = await dir.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    const exactBuffer = file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength,
    ) as ArrayBuffer;
    await writable.write(exactBuffer);
    await writable.close();
    artifacts.push({
      name: file.name,
      size: file.bytes.byteLength,
      path: ['ifc-compare', stamp, library, safeFileName, file.name].join('/'),
    });
  }

  return artifacts;
}

export function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Read a persisted artifact's raw bytes by its stored `path`. Used by the
 *  end-of-run "show all models" step to reopen earlier engines from the
 *  geometry cache (ifc-lite `.cache`, ThatOpen `.frag`) without re-running. */
export async function readPersistedArtifactBytes(path: string): Promise<ArrayBuffer | null> {
  if (!path || path === 'browser-memory') {
    return null;
  }
  const root = await getRootDirectory();
  if (!root) {
    return null;
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  try {
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = await current.getDirectoryHandle(segment);
    }
    const fileHandle = await current.getFileHandle(segments[segments.length - 1]);
    const file = await fileHandle.getFile();
    return file.arrayBuffer();
  } catch {
    return null;
  }
}

export async function getPersistedArtifactUrl(path: string): Promise<string | null> {
  if (!path || path === 'browser-memory') {
    return null;
  }

  const root = await getRootDirectory();
  if (!root) {
    return null;
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = await current.getDirectoryHandle(segment);
  }

  const fileHandle = await current.getFileHandle(segments[segments.length - 1]);
  const file = await fileHandle.getFile();
  return URL.createObjectURL(file);
}
