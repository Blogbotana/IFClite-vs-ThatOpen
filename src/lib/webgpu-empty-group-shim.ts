/**
 * Workaround for @ifc-lite/renderer >= 6.5.0.
 *
 * Its mesh pipelines are built with `withSectionExclusions()`, which pads the
 * pipeline layout with an EMPTY bind group layout at index 2 and puts the
 * section-exclusion buffer at index 3. The perspective draw path only calls
 * `setBindGroup(1, …)` and `setBindGroup(3, …)` and never binds group 2, so
 * every draw fails WebGPU validation ("No bind group set at group index 2"),
 * every command buffer is rejected, and the canvas stays black / frozen.
 *
 * Fix: whenever a render pass binds group 3 before anything was bound at 2,
 * first bind an empty bind group at 2. Empty layouts created from identical
 * descriptors are group-equivalent, so this satisfies the padded layout. The
 * orthographic path (which binds a real group 2 later) simply overrides it.
 *
 * Remove once the renderer binds group 2 itself.
 */
const SHIM_FLAG = '__ifcliteEmptyGroup2Shim';

export function installEmptyGroup2Shim(): void {
  if (typeof GPUDevice === 'undefined' || typeof GPURenderPassEncoder === 'undefined') return;
  const g = globalThis as Record<string, unknown>;
  if (g[SHIM_FLAG]) return;
  g[SHIM_FLAG] = true;

  const encoderDevice = new WeakMap<GPUCommandEncoder, GPUDevice>();
  const passDevice = new WeakMap<GPURenderPassEncoder, GPUDevice>();
  const passHasGroup2 = new WeakSet<GPURenderPassEncoder>();
  const emptyGroups = new WeakMap<GPUDevice, GPUBindGroup>();

  const emptyGroupFor = (device: GPUDevice): GPUBindGroup => {
    let group = emptyGroups.get(device);
    if (!group) {
      const layout = device.createBindGroupLayout({ label: 'ifclite-empty-group-2', entries: [] });
      group = device.createBindGroup({ label: 'ifclite-empty-group-2', layout, entries: [] });
      emptyGroups.set(device, group);
    }
    return group;
  };

  const createCommandEncoder = GPUDevice.prototype.createCommandEncoder;
  GPUDevice.prototype.createCommandEncoder = function (this: GPUDevice, ...args) {
    const encoder = createCommandEncoder.apply(this, args);
    encoderDevice.set(encoder, this);
    return encoder;
  };

  const beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (this: GPUCommandEncoder, ...args) {
    const pass = beginRenderPass.apply(this, args);
    const device = encoderDevice.get(this);
    if (device) passDevice.set(pass, device);
    return pass;
  };

  const setBindGroup = GPURenderPassEncoder.prototype.setBindGroup as (
    this: GPURenderPassEncoder,
    ...args: unknown[]
  ) => void;
  GPURenderPassEncoder.prototype.setBindGroup = function (this: GPURenderPassEncoder, ...args: unknown[]) {
    const index = args[0] as number;
    if (index === 2) {
      passHasGroup2.add(this);
    } else if (index === 3 && !passHasGroup2.has(this)) {
      const device = passDevice.get(this);
      if (device) {
        setBindGroup.call(this, 2, emptyGroupFor(device));
        passHasGroup2.add(this);
      }
    }
    return setBindGroup.apply(this, args);
  } as GPURenderPassEncoder['setBindGroup'];
}
