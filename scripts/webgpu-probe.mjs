// probes whether the playwright chromium can run webgpu headless (with which flags), in a page and
// in a worker with an OffscreenCanvas webgpu context (what the shader host uses).
// usage: node scripts/webgpu-probe.mjs
import { chromium } from './pw.mjs';
import http from 'node:http';

/** a localhost page (secure context: navigator.gpu only exists there) */
export async function localPage() {
  const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>probe</title>'); });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() };
}

export const WEBGPU_FLAGSETS = [
  ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'],
  ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'],
  ['--enable-unsafe-webgpu'],
];

async function probe(args) {
  const b = await chromium.launch({ headless: true, args });
  try {
    const p = await b.newPage();
    const lp = await localPage();
    await p.goto(lp.url);
    lp.close();
    return await p.evaluate(async () => {
      if (!navigator.gpu) return 'no navigator.gpu';
      try {
        const a = await navigator.gpu.requestAdapter();
        if (!a) return 'no adapter';
        const info = a.info || {};
        await a.requestDevice();
        const src = `onmessage=async()=>{try{const a=await navigator.gpu.requestAdapter();const d=await a.requestDevice();const c=new OffscreenCanvas(4,4);const x=c.getContext('webgpu');x.configure({device:d,format:'rgba8unorm',alphaMode:'premultiplied'});const e=d.createCommandEncoder();const pass=e.beginRenderPass({colorAttachments:[{view:x.getCurrentTexture().createView(),loadOp:'clear',clearValue:{r:1,g:0,b:0,a:1},storeOp:'store'}]});pass.end();d.queue.submit([e.finish()]);const bm=c.transferToImageBitmap();postMessage({ok:true,w:bm.width},[bm])}catch(err){postMessage({ok:false,e:String(err)})}}`;
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        const wr = await new Promise(res => { w.onmessage = e => res(e.data); w.postMessage(0); setTimeout(() => res('timeout'), 5000); });
        return JSON.stringify({ vendor: info.vendor, arch: info.architecture, desc: info.description, worker: wr });
      } catch (e) { return 'err ' + e; }
    });
  } finally { await b.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const args of WEBGPU_FLAGSETS) console.log(args.join(' '), '=>', await probe(args));
}
