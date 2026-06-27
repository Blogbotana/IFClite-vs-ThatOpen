// IFClite adapter driving the SAME current geometry engine as ./ifclite, but
// with GPU instancing DISABLED. Pairs with the default adapter (instancing on)
// to isolate exactly what instancing buys: with it off, every repeated part
// (e.g. thousands of byte-identical Tekla steel members) is meshed individually
// instead of once-and-instanced. Same kernel, same version — the only variable
// is `enableInstancing`.
//
// No shards are emitted in this mode, so `materializeInstancedShards` in
// ./ifclite is a no-op; all geometry streams as flat MeshData.
import { GeometryProcessor } from '@ifc-lite/geometry';
import { createIfcLiteAdapter, type IfcLiteGeometryEngine } from './ifclite';
import type { ViewerAdapter } from '../types';

export function createIfcLiteNoInstancingAdapter(canvas: HTMLCanvasElement): ViewerAdapter {
  const geometry = new GeometryProcessor({ enableInstancing: false }) as unknown as IfcLiteGeometryEngine;
  return createIfcLiteAdapter(canvas, geometry);
}
