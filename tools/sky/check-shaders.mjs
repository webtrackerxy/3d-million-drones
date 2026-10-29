// Code-generation check only: no WebGPU device, shader validation or execution.
import { build } from 'esbuild';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, process.argv[2] ?? 'reports/shader-checks');
const scratch = await mkdtemp(join(tmpdir(), 'million-drones-shaders-'));
await mkdir(output, { recursive: true });
const source = (p) => JSON.stringify(resolve(root, p));
try {
  const entry = join(scratch, 'entry.mjs');
  await writeFile(entry, `
import fs from 'node:fs';
import { WebGPURenderer, Scene, Vector3, PerspectiveCamera } from ${source('node_modules/three/src/Three.WebGPU.js')};
import WGSLNodeBuilder from ${source('node_modules/three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js')};
import { createDroneRenderer } from ${source('packages/render/src/index.ts')};
import { createCollisionMonitor } from ${source('packages/render/src/collisions.ts')};
import { buildRoute, routeTable, descriptors } from ${source('packages/flight/src/index.ts')};
import { createSelectedRouteLine } from ${source('apps/sky/src/selected-route.ts')};
const output = ${JSON.stringify(output)};
const renderer = new WebGPURenderer({canvas:{width:1,height:1,style:{},addEventListener(){},removeEventListener(){}}});
renderer.hasFeature = () => false;
let index = 0, phase = 'picking';
renderer.compute = nodes => {
  for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
    const builder = new WGSLNodeBuilder(null, renderer);
    builder.compute = node;
    builder.build();
    fs.writeFileSync(output + '/' + phase + '-' + index++ + '.wgsl', builder.computeShader);
  }
};
// Permit the picking wrapper to finish after building its passes. No readback is tested.
renderer.getArrayBufferAsync = async () => new Uint32Array([0xffffffff,0xffffffff]).buffer;
const table = routeTable([buildRoute([[0,10,0],[0,10,-10]],false)]);
const scene = new Scene(), runtime = createDroneRenderer(renderer,scene,descriptors(4,table),table);
await runtime.pick(new Vector3(0,10,10),new Vector3(0,0,-1));
if (index !== 3) throw Error('Missing picking passes');
if (scene.children.length !== 7) throw Error('Expected six typed model draws and one shared marker draw');
for (const [i,mesh] of scene.children.entries()) {
  const builder = new WGSLNodeBuilder(mesh,renderer);
  builder.scene=scene; builder.camera=new PerspectiveCamera(); builder.build();
  fs.writeFileSync(output+'/selected-'+i+'.vert.wgsl',builder.vertexShader);
  fs.writeFileSync(output+'/selected-'+i+'.frag.wgsl',builder.fragmentShader);
}
const routeLine = createSelectedRouteLine();
routeLine.geometry.setPositions([0,10,0,0,10,-10]);
const routeBuilder = new WGSLNodeBuilder(routeLine,renderer);
routeBuilder.scene=scene; routeBuilder.camera=new PerspectiveCamera(); routeBuilder.build();
fs.writeFileSync(output+'/selected-route.vert.wgsl',routeBuilder.vertexShader);
fs.writeFileSync(output+'/selected-route.frag.wgsl',routeBuilder.fragmentShader);
routeLine.geometry.dispose(); routeLine.material.dispose();
phase='flight'; index=0;
runtime.setPoseOverride({id:2,position:[20,30,40],quaternion:[0,Math.SQRT1_2,0,Math.SQRT1_2]});
renderer.compute(runtime.passes);
if (index !== 3) throw Error('Missing flight passes');
phase='collision'; index=0;
const monitor=createCollisionMonitor(renderer,runtime.poses,4,{bucketCount:8});
renderer.compute(monitor.passes);
if (index !== 5) throw Error('Missing collision passes');
`);
  const bundle = join(scratch, 'bundle.mjs');
  await build({entryPoints:[entry], outfile:bundle, bundle:true, platform:'node', format:'esm',
    plugins:[{name:'pinned-three-source',setup(b){
      b.onResolve({filter:/^three(?:\/webgpu|\/tsl)?$/},a=>({
        path:resolve(root,'node_modules/three/src',a.path==='three/tsl'?'Three.TSL.js':'Three.WebGPU.js')
      }));
    }}]});
  const result=spawnSync(process.execPath,[fileURLToPath(pathToFileURL(bundle))],{encoding:'utf8'});
  if (result.status !== 0) throw Error(result.stderr || result.stdout || 'WGSL generation failed');
  assert((await readFile(join(output,'collision-2.wgsl'),'utf8')).includes('atomicExchange('));
  assert((await readFile(join(output,'collision-3.wgsl'),'utf8')).includes('i < 256'));
  console.log('PASS: generated 3 flight + 3 picking + 5 collision compute shaders, 7 selected-color vertex/fragment pairs and the selected wide-route pair. Code generation only; no GPU compilation, readback correctness or browser execution.');
} finally {
  await rm(scratch,{recursive:true,force:true});
}
