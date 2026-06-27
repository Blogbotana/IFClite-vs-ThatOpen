// IFClite adapter driving the OLD Manifold-kernel geometry engine.
//
// `@ifc-lite/geometry-manifold` is an npm alias of `@ifc-lite/geometry@2.4.0`
// (the last Manifold-default release, pre-#1024). A package.json `overrides`
// entry pins its nested `@ifc-lite/wasm@2.4.0`, so it loads the Manifold C++ CSG
// kernel — not the new exact-arithmetic Rust kernel. This lets us A/B the
// geometry/CSG regression (ifc-lite issues #1109 / #1286) against the current
// `@ifc-lite/geometry@2.12.0` engine in `./ifclite`.
//
// The 2.4.0 GeometryProcessor predates instancing emit-both, so all geometry
// already streams as flat MeshData — no `enableInstancing` option needed.
import { GeometryProcessor } from '@ifc-lite/geometry-manifold';
import { createIfcLiteAdapter, type IfcLiteGeometryEngine } from './ifclite';
import type { ViewerAdapter } from '../types';

export function createIfcLiteManifoldAdapter(canvas: HTMLCanvasElement): ViewerAdapter {
  const geometry = new GeometryProcessor() as unknown as IfcLiteGeometryEngine;
  return createIfcLiteAdapter(canvas, geometry);
}
