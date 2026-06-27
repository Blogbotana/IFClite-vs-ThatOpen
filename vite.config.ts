import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Some @ifc-lite packages publish sourceMappingURL comments that point to
// source files not shipped in npm, which spams dev logs with warnings.
// Strip only those comments during Vite transforms.
function stripIfcLiteBrokenSourceMapComments() {
  return {
    name: 'strip-ifclite-broken-sourcemaps',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.includes('/node_modules/@ifc-lite/') || !id.endsWith('.js')) {
        return null;
      }

      if (!code.includes('sourceMappingURL=')) {
        return null;
      }

      const stripped = code
        .replace(/^\s*\/\/\# sourceMappingURL=.*$/gm, '')
        .replace(/^\s*\/\*\# sourceMappingURL=[\s\S]*?\*\/\s*$/gm, '');

      return {
        code: stripped,
        map: null,
      };
    },
  };
}

// Copy ThatOpen worker and web-ifc WASM files into public/ so they are served
// same-origin and never blocked by COEP headers.
function copyThatOpenAssets() {
  const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const pub = resolve(root, 'public');
  const wasmDest = resolve(pub, 'wasm');
  mkdirSync(wasmDest, { recursive: true });
  for (const file of ['web-ifc.wasm', 'web-ifc-mt.wasm']) {
    copyFileSync(resolve(root, 'node_modules/web-ifc', file), resolve(wasmDest, file));
  }
  copyFileSync(
    resolve(root, 'node_modules/@thatopen/fragments/dist/Worker/worker.mjs'),
    resolve(pub, 'thatopen-worker.mjs'),
  );
}
try {
  copyThatOpenAssets();
} catch (e) {
  console.warn('[vite] Failed to copy ThatOpen assets:', (e as Error).message);
}

export default defineConfig({
  plugins: [stripIfcLiteBrokenSourceMapComments(), react(), wasm()],
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: [
      '@ifc-lite/export',
      '@ifc-lite/geometry',
      '@ifc-lite/parser',
      '@ifc-lite/renderer',
      '@ifc-lite/wasm',
    ],
    include: ['jszip'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
