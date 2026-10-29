import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { hash32 } from "../../packages/core-types/src/index.ts";
import type { Vec3 } from "../../packages/core-types/src/index.ts";
import { buildRoute } from "../../packages/flight/src/index.ts";
import {
  cityScenario,
  OFFSET_BOUND_M,
  GPU_TOLERANCE_M,
  CLEARANCE_MARGIN_M,
} from "../../packages/city/src/index.ts";
import type {
  Mission,
  NavigationBundle,
  RoadData,
} from "../../packages/city/src/index.ts";
import { obstacleIndex } from "../../packages/city/src/obstacles.ts";
const folder = new URL("../../assets/city/canary-wharf/", import.meta.url);
const data = JSON.parse(
  await readFile(new URL("buildings.json", folder), "utf8"),
);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", folder), "utf8"),
);
const roadBytes = await readFile(new URL("roads.json", folder));
const roads: RoadData = JSON.parse(roadBytes.toString());
const index = obstacleIndex(data),
  radius = 1.027 + OFFSET_BOUND_M + GPU_TOLERANCE_M + CLEARANCE_MARGIN_M;
const bounds = manifest.localBoundsM;
const within = ([x, z]: number[]) =>
  x > bounds.minX + 12 &&
  x < bounds.maxX - 12 &&
  z > bounds.minZ + 12 &&
  z < bounds.maxZ - 12;
const distance = (a: number, b: number) =>
  Math.hypot(
    roads.nodes[a][0] - roads.nodes[b][0],
    roads.nodes[a][1] - roads.nodes[b][1],
  );
const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
const unique = new Map<string, number[]>();
for (const [a, b] of roads.edges)
  if (
    a !== b &&
    within(roads.nodes[a]) &&
    within(roads.nodes[b]) &&
    distance(a, b) > 0.1
  )
    unique.set(key(a, b), [a, b]);
type Link = { to: number; length: number };
function graph(height: number) {
  const adjacency: Link[][] = Array.from(
      { length: roads.nodes.length },
      () => [],
    ),
    edges: number[][] = [];
  for (const [a, b] of unique.values()) {
    const p = roads.nodes[a],
      q = roads.nodes[b];
    if (index.blocked([p[0], height, p[1]], [q[0], height, q[1]], radius + 1))
      continue;
    adjacency[a].push({ to: b, length: distance(a, b) });
    adjacency[b].push({ to: a, length: distance(a, b) });
    edges.push([a, b]);
  }
  return { adjacency, edges };
}
// Binary-heap A*. These airways use the source road geometry in both directions;
// car one-way restrictions do not establish drone permissions.
function path(
  adjacency: Link[][],
  start: number,
  goal: number,
  blockedEdge = "",
  blockedNodes = new Set<number>(),
) {
  const scores = new Float64Array(roads.nodes.length).fill(Infinity),
    previous = new Int32Array(roads.nodes.length).fill(-1);
  const heap: { id: number; score: number }[] = [];
  function push(id: number, score: number) {
    heap.push({ id, score });
    let i = heap.length - 1;
    while (i) {
      const p = (i - 1) >>> 1;
      if (heap[p].score <= score) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  }
  function pop() {
    const first = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      while (true) {
        let c = i * 2 + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1].score < heap[c].score) c++;
        if (heap[i].score <= heap[c].score) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return first;
  }
  scores[start] = 0;
  push(start, distance(start, goal));
  let iterations = 0;
  while (heap.length && iterations++ < 18000) {
    const item = pop(),
      id = item.id;
    if (item.score > scores[id] + distance(id, goal) + 1e-6) continue;
    if (id === goal) {
      const result = [id];
      while (result.at(-1) !== start) result.push(previous[result.at(-1)!]);
      return result.reverse();
    }
    for (const link of adjacency[id]) {
      if (blockedNodes.has(link.to) || key(id, link.to) === blockedEdge)
        continue;
      const score = scores[id] + link.length;
      if (score < scores[link.to] && score < 6500) {
        scores[link.to] = score;
        previous[link.to] = id;
        push(link.to, score + distance(link.to, goal));
      }
    }
  }
  return null;
}
function rounded(points: Vec3[]) {
  const output: Vec3[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[(i + points.length - 1) % points.length],
      c = points[i],
      n = points[(i + 1) % points.length];
    const before = Math.hypot(...c.map((v, k) => v - p[k])),
      after = Math.hypot(...n.map((v, k) => v - c[k]));
    if (before < 0.05 || after < 0.05) continue;
    const cut = Math.min(7, before * 0.28, after * 0.28);
    const a = c.map((v, k) => v + ((p[k] - v) * cut) / before),
      b = c.map((v, k) => v + ((n[k] - v) * cut) / after);
    for (let j = 0; j <= 6; j++) {
      const t = j / 6;
      output.push(
        a.map(
          (v, k) =>
            (1 - t) * (1 - t) * v + 2 * t * (1 - t) * c[k] + t * t * b[k],
        ) as Vec3,
      );
    }
  }
  return output
    .filter(
      (p, i) =>
        i === 0 || Math.hypot(...p.map((v, k) => v - output[i - 1][k])) > 0.01,
    )
    .map((p) => p.map((v) => Math.round(v * 1000) / 1000) as Vec3);
}
function valid(points: Vec3[], speed: number) {
  try {
    const route = buildRoute(points, true, 1.5, speed);
    for (let at = 12; at < route.samples.length; at += 12) {
      const a = Array.from(route.samples.slice(at - 12, at - 9)) as Vec3,
        b = Array.from(route.samples.slice(at, at + 3)) as Vec3;
      if (index.blocked(a, b, radius)) return false;
    }
    return route.length > 280;
  } catch {
    return false;
  }
}
const missions: Mission[] = [],
  identities = new Set<string>();
for (const band of [20, 34, 50, 68]) {
  const g = graph(band);
  let accepted = 0;
  for (
    let attempt = 0;
    attempt < g.edges.length * 2 && accepted < 24;
    attempt++
  ) {
    const [a, b] = g.edges[hash32(attempt + band * 7919) % g.edges.length];
    const alternate = path(g.adjacency, b, a, key(a, b));
    if (!alternate || alternate.length < 4) continue;
    const cycle = [a, ...alternate.slice(0, -1)],
      identity = `${band}:` + [...cycle].sort((a, b) => a - b).join(",");
    if (identities.has(identity)) continue;
    const points = rounded(
      cycle.map((n) => [roads.nodes[n][0], band, roads.nodes[n][1]]),
    );
    if (!valid(points, 9)) continue;
    identities.add(identity);
    missions.push({
      kind: "street",
      label: `Street ${band}m / ${accepted + 1}`,
      waypoints: points,
      speed: 7 + (accepted % 6),
    });
    accepted++;
  }
  console.log(
    `Street ${band}m: ${accepted} routes, ${g.edges.length} clear road edges`,
  );
}
// Link distinct street neighbourhoods through the air. A trip follows a local
// street loop while climbing, crosses the district, descends to another street
// loop, then returns by a higher corridor. The low street graph need not connect
// across every dock/cul-de-sac for the air network to connect neighbourhoods.
const streets=[...missions],pairs=new Set<string>();
function atLoop(points:Vec3[],height:(fraction:number)=>number,includeFirst=true) {
  const closed=[...points,points[0]],distances=[0];
  for(let i=1;i<closed.length;i++)distances.push(distances[i-1]+Math.hypot(...closed[i].map((v,k)=>v-closed[i-1][k])));
  const total=distances.at(-1)!;
  return closed.flatMap((p,i)=>!includeFirst&&i===0?[]:[[p[0],height(distances[i]/total),p[2]] as Vec3]);
}
const ease=(t:number)=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
for(let attempt=0,accepted=0;attempt<1200&&accepted<32;attempt++) {
  const ai=hash32(attempt+982451653)%streets.length,bi=hash32(attempt+32452843)%streets.length;
  if(ai===bi||pairs.has(key(ai,bi)))continue;
  const a=streets[ai].waypoints,b=streets[bi].waypoints;
  if(Math.hypot(a[0][0]-b[0][0],a[0][2]-b[0][2])<650)continue;
  for(const cruise of [120,160,200,240,270]) {
    const ah=a[0][1],bh=b[0][1],returnHeight=cruise+18;
    const depart=atLoop(a,t=>ah+(cruise-ah)*ease((t-0.18)/0.68));
    const visit=atLoop(b,t=>t<0.5?cruise+(bh-cruise)*ease(t/0.3):bh+(returnHeight-bh)*ease((t-0.55)/0.45));
    const arrive=atLoop(a,t=>returnHeight+(ah-returnHeight)*ease(t/0.55),false).slice(0,-1);
    const points=rounded([...depart,...visit,...arrive]);
    if(!valid(points,16))continue;
    missions.push({kind:'sky',label:`District link ${accepted+1} / ${cruise}m`,waypoints:points,speed:13+accepted%7});
    pairs.add(key(ai,bi));accepted++;break;
  }
}
assert(
  missions.filter((m) => m.kind === "street").length >= 40,
  "Too few street routes",
);
assert(
  missions.filter((m) => m.kind === "sky").length >= 12,
  "Too few district routes",
);
function simplify(points: Vec3[], tolerance = 0.05) {
  const input = [...points, points[0]],
    keep = new Set([0, input.length - 1]),
    stack = [[0, input.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!,
      a = input[first],
      b = input[last],
      delta = b.map((v, k) => v - a[k]),
      length = delta.reduce((s, v) => s + v * v, 0);
    let farthest = -1,
      max = tolerance;
    for (let i = first + 1; i < last; i++) {
      const p = input[i],
        t = length
          ? Math.max(
              0,
              Math.min(
                1,
                p.reduce((s, v, k) => s + (v - a[k]) * delta[k], 0) / length,
              ),
            )
          : 0;
      const d = Math.hypot(...p.map((v, k) => v - a[k] - t * delta[k]));
      if (d > max) {
        max = d;
        farthest = i;
      }
    }
    if (farthest !== -1) {
      keep.add(farthest);
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return [...keep]
    .sort((a, b) => a - b)
    .slice(0, -1)
    .map((i) => input[i]);
}
for (const mission of missions) {
  const compact = simplify(mission.waypoints);
  if (valid(compact, mission.speed)) mission.waypoints = compact;
}
const bundle: NavigationBundle = {
  schemaVersion: 1,
  obstacleSha256: manifest.data.sha256,
  roadsSha256: roads.source.sha256,
  sampleSpacingM: 1.5,
  missions,
};
const result = cityScenario(data, manifest, 1.027, bundle);
const output = {
  ...bundle,
  provenance: {
    roadsJsonSha256: createHash("sha256").update(roadBytes).digest("hex"),
    algorithm:
      "Deterministic road-graph A*, alternate street circuits, rounded corners; paired neighbourhood street loops connected by climb/cross/descend air corridors. Seeded per-drone phase, speed and route weights.",
    license: "ODbL-1.0",
  },
  validation: result.clearance,
};
await writeFile(new URL("navigation.json", folder), JSON.stringify(output));
console.log(
  JSON.stringify({
    routes: missions.length,
    ...result.clearance,
    bytes: JSON.stringify(output).length,
  }),
);
