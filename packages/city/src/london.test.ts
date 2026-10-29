import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {londonScenario,planLondonTiles} from './london.ts';
import {cityDescriptors} from './index.ts';
import {poseAt,evaluateRoute} from '../../flight/src/index.ts';
const folder=new URL('../../../assets/city/london/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',folder),'utf8'));
const nav=JSON.parse(await readFile(new URL('navigation.json',folder),'utf8'));
const overview=JSON.parse(await readFile(new URL('overview.json',folder),'utf8'));
const scenario=londonScenario(manifest,nav);
test('full London catalog, roads and base map have broad extent and exact provenance',()=>{
  assert(manifest.statistics.uniqueBuildings>=1_000_000);
  assert(manifest.statistics.roadWays>500_000);
  assert(manifest.tiles.length>=1800);
  assert(manifest.bounds.maxX-manifest.bounds.minX>59000);
  assert(manifest.bounds.maxZ-manifest.bounds.minZ>46000);
  assert.equal(createHash('sha256').update(JSON.stringify(manifest.tiles.map((t:{key:string;sha256:string})=>[t.key,t.sha256]))).digest('hex'),manifest.dataSha256);
  assert.equal(nav.dataSha256,manifest.dataSha256);
  assert(overview.areas.some((a:string[])=>a[0]==='water'));
  assert(overview.areas.some((a:string[])=>a[0]==='green'));
  assert(overview.roads.length>100000);
  for(const place of ['Croydon','Harrow','Uxbridge','Romford','Bromley','Enfield'])assert(overview.places.some((p:{name:string})=>p.name===place),place);
});
test('London trips and independent offline model proof span the city',()=>{
  assert(nav.validation.passed&&nav.validation.sectors>100);
  assert(nav.validation.streetRoutes>400&&nav.validation.skyRoutes>=60);
  assert(nav.validation.validatedSegments>800000);
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(const m of nav.missions)for(const p of m.waypoints){minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);minZ=Math.min(minZ,p[2]);maxZ=Math.max(maxZ,p[2]);}
  assert(maxX-minX>45000 && maxZ-minZ>37000);
  for(const route of scenario.table.routes){const a=evaluateRoute(route,0),b=evaluateRoute(route,route.length-0.001);assert(Math.hypot(...a.position.map((v,i)=>v-b.position[i]))<0.01);}
});
test('London IDs, layer mix and positions survive population and camera-independent sampling',()=>{
  const words=cityDescriptors(10000,scenario,7);
  assert.deepEqual(words.slice(0,800),cityDescriptors(100,scenario,7));
  const assigned=new Set<number>();let low=0;
  for(let id=0;id<10000;id++){assigned.add(words[id*8]);if(scenario.missions[words[id*8]].kind==='street')low++;}
  assert(assigned.size>450 && low>6800&&low<7200);
  for(let id=0;id<1000;id++)for(const time of [0,10250,3600000]){const p=poseAt(words,scenario.table,id,time).position;assert(p.every(Number.isFinite));assert(p[0]>manifest.bounds.minX&&p[0]<manifest.bounds.maxX&&p[2]>manifest.bounds.minZ&&p[2]<manifest.bounds.maxZ);}
});
test('tile detail is bounded and follows distant London districts',()=>{
  const a=planLondonTiles(manifest.tiles,[0,1000,0],32),b=planLondonTiles(manifest.tiles,[-20000,1000,15000],32);
  assert(a.length>0&&a.length<=32&&b.length>0&&b.length<=32);
  assert.equal(new Set(a).size,a.length);
  assert(!a.some(key=>b.includes(key)));
  assert(planLondonTiles(manifest.tiles,[0,1000,0],4).length<=4);
  assert.throws(()=>londonScenario(manifest,{...nav,dataSha256:'wrong'}),/mismatch/);
  assert.throws(()=>londonScenario(manifest,{...nav,validation:{...nav.validation,passed:false}}),/mismatch/);
});
