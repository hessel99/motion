// tiny figma-style shader modules written for motion's tests (figma's own shaders are never
// committed: see .figma-cache/ and scripts/shader-check.mjs). they follow the same contract:
// setup/render on a webgpu device, defineProperties schema, premultiplied rgba8 output.

export const TEST_FILL_MAIN = `import { defineProperties } from 'figma:shaders'
export default function Effect() {}

const WGSL = \`
struct U { color: vec4f, dims: vec4f, xf: vec4f, }
@group(0) @binding(0) var<uniform> u: U;
struct VsOut { @builtin(position) p: vec4f, @location(0) uv: vec2f, }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let q = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut; o.p = vec4f(q[i], 0.0, 1.0); o.uv = vec2f(q[i].x * 0.5 + 0.5, 0.5 - q[i].y * 0.5); return o;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let px = in.uv * u.dims.xy / u.dims.z;            // design units
  let c = u.xf.xy * u.dims.xy / u.dims.z / 100.0;    // center (percent of the box)
  let a = radians(u.xf.w);
  let d = dot(px - c, vec2f(cos(a), sin(a)));
  let s = step(0.5, fract(d / max(u.xf.z, 1.0) + u.dims.w));
  return vec4f(u.color.rgb * u.color.a, u.color.a) * s;
}\`

export function setup(device: GPUDevice, frame: any) {
  frame.state.module = device.createShaderModule({ code: WGSL })
  frame.state.ubuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  frame.state.data = new Float32Array(12)
}

export function render(device: GPUDevice, frame: any) {
  const s = frame.state, p = frame.params
  if (s.format !== frame.output.format) {
    s.pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: s.module, entryPoint: 'vs' }, fragment: { module: s.module, entryPoint: 'fs', targets: [{ format: frame.output.format }] }, primitive: { topology: 'triangle-list' } })
    s.bind = device.createBindGroup({ layout: s.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: s.ubuf } }] })
    s.format = frame.output.format
  }
  const d = s.data as Float32Array
  d.set([p.color.r, p.color.g, p.color.b, p.color.a, frame.output.width, frame.output.height, frame.renderScale, (frame.time / 1000) * p.speed, p.transform.x, p.transform.y, p.transform.radius, p.transform.angle])
  device.queue.writeBuffer(s.ubuf, 0, d)
  const enc = device.createCommandEncoder()
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: frame.output.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] })
  pass.setPipeline(s.pipeline); pass.setBindGroup(0, s.bind); pass.draw(3); pass.end()
  device.queue.submit([enc.finish()])
}

defineProperties(Effect, {
  color: { type: 'color', label: 'Color', defaultValue: { r: 1, g: 0.4, b: 0.1, a: 1 } },
  speed: { type: 'number', label: 'Speed', defaultValue: 0, control: 'slider', min: 0, max: 4, step: 0.01 },
  transform: { type: 'point-angle-radius', label: 'Stripes', defaultValue: { x: 50, y: 50, radius: 20, angle: 0 }, positionUnit: '%' },
})
`;

export const TEST_FILL_FEATURES = JSON.stringify({ name: 'Test stripes', version: 3, isAnimated: true, usesMouse: false, renderScaleAware: true });

export const TEST_EFFECT_MAIN = `import { defineProperties } from "figma:shaders";
export default function Effect() {}
// inverts the layer (premultiplied), mixed by "amount"; a select picks the channel mode
export function setup(device, frame) {
  frame.state.module = device.createShaderModule({ code: \`
@group(0) @binding(0) var<uniform> u: vec4f;
@group(0) @binding(1) var src: texture_2d<f32>;
struct VsOut { @builtin(position) p: vec4f, }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let q = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut; o.p = vec4f(q[i], 0.0, 1.0); return o;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let c = textureLoad(src, vec2i(in.p.xy), 0);
  var inv = vec4f(vec3f(c.a) - c.rgb, c.a);
  if (u.y > 0.5) { inv = vec4f(c.r, c.a - c.g, c.b, c.a); }
  return mix(c, inv, u.x);
}\` });
  frame.state.ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
}
export function render(device, frame) {
  if (frame.input == null) return;
  const s = frame.state;
  if (!s.pipeline) s.pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module: s.module, entryPoint: "vs" }, fragment: { module: s.module, entryPoint: "fs", targets: [{ format: frame.output.format }] }, primitive: { topology: "triangle-list" } });
  device.queue.writeBuffer(s.ubuf, 0, new Float32Array([frame.params.amount / 100, frame.params.mode === "green" ? 1 : 0, 0, 0]));
  const bind = device.createBindGroup({ layout: s.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: s.ubuf } }, { binding: 1, resource: frame.input.createView() }] });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: frame.output.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
  pass.setPipeline(s.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
  device.queue.submit([enc.finish()]);
}
defineProperties(Effect, {
  amount: { type: "number", label: "Amount", defaultValue: 100, control: "slider", min: 0, max: 100, step: 1, unit: "%" },
  mode: { type: "string", label: "Mode", defaultValue: "all", control: "select", options: [{ value: "all", label: "All channels" }, { value: "green", label: "Green only" }] },
  enabledFlag: { type: "boolean", label: "Flag", defaultValue: true },
});
`;

export const TEST_EFFECT_FEATURES = JSON.stringify({ name: 'Test invert', version: 3, isAnimated: false, usesMouse: false, renderScaleAware: true });

/** a mouse-driven fill: opaque black, a white disc (radius 12 device px) at frame.mousePosition */
export const TEST_MOUSE_MAIN = `import { defineProperties } from "figma:shaders";
export default function Effect() {}
export function setup(device, frame) {
  frame.state.module = device.createShaderModule({ code: \`
@group(0) @binding(0) var<uniform> u: vec4f;
struct VsOut { @builtin(position) p: vec4f, }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let q = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut; o.p = vec4f(q[i], 0.0, 1.0); return o;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let d = distance(in.p.xy, u.xy);
  if (u.z > 0.5 && d < 12.0) { return vec4f(1.0); }
  return vec4f(0.0, 0.0, 0.0, 1.0);
}\` });
  frame.state.ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
}
export function render(device, frame) {
  const s = frame.state, m = frame.mousePosition;
  if (!s.pipeline) s.pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module: s.module, entryPoint: "vs" }, fragment: { module: s.module, entryPoint: "fs", targets: [{ format: frame.output.format }] }, primitive: { topology: "triangle-list" } });
  device.queue.writeBuffer(s.ubuf, 0, new Float32Array([m ? m.x : 0, m ? m.y : 0, m ? 1 : 0, 0]));
  const bind = device.createBindGroup({ layout: s.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: s.ubuf } }] });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: frame.output.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
  pass.setPipeline(s.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
  device.queue.submit([enc.finish()]);
}
defineProperties(Effect, {
  size: { type: "number", label: "Size", defaultValue: 1, control: "slider", min: 0, max: 4, step: 0.1 },
});
`;
export const TEST_MOUSE_FEATURES = JSON.stringify({ name: 'Test mouse', version: 3, isAnimated: false, usesMouse: true, renderScaleAware: true });

/** a direction-dependent effect: the left half of its input (output px) turns green. under a
 *  rotated layer it shows whether the effect ran in the layer's local space */
export const TEST_HALF_MAIN = `import { defineProperties } from "figma:shaders";
export default function Effect() {}
export function setup(device, frame) {
  frame.state.module = device.createShaderModule({ code: \`
@group(0) @binding(0) var<uniform> u: vec4f;
@group(0) @binding(1) var src: texture_2d<f32>;
struct VsOut { @builtin(position) p: vec4f, }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let q = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut; o.p = vec4f(q[i], 0.0, 1.0); return o;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let c = textureLoad(src, vec2i(in.p.xy), 0);
  if (in.p.x < u.x * 0.5) { return vec4f(0.0, c.a, 0.0, c.a); }
  return c;
}\` });
  frame.state.ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
}
export function render(device, frame) {
  if (frame.input == null) return;
  const s = frame.state;
  if (!s.pipeline) s.pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module: s.module, entryPoint: "vs" }, fragment: { module: s.module, entryPoint: "fs", targets: [{ format: frame.output.format }] }, primitive: { topology: "triangle-list" } });
  device.queue.writeBuffer(s.ubuf, 0, new Float32Array([frame.output.width, frame.output.height, 0, 0]));
  const bind = device.createBindGroup({ layout: s.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: s.ubuf } }, { binding: 1, resource: frame.input.createView() }] });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: frame.output.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
  pass.setPipeline(s.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
  device.queue.submit([enc.finish()]);
}
defineProperties(Effect, {
  strength: { type: "number", label: "Strength", defaultValue: 1, control: "slider", min: 0, max: 1, step: 0.01 },
});
`;
export const TEST_HALF_FEATURES = JSON.stringify({ name: 'Test half', version: 3, isAnimated: false, usesMouse: false, renderScaleAware: true });
