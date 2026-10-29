import type { Vec3 } from "../../core-types/src/index.ts";
import { hash32 } from "../../core-types/src/index.ts";
import { buildRoute } from "../../flight/src/index.ts";
import { obstacleIndex } from "./obstacles.ts";
import type { CityData, CityManifest } from "./types.ts";
import {
  OFFSET_BOUND_M,
  GPU_TOLERANCE_M,
  CLEARANCE_MARGIN_M,
} from "./index.ts";
import type { RoadData, Mission } from "./index.ts";

export function authorStreetTrips(
  data: CityData,
  manifest: CityManifest,
  roads: RoadData,
  options: {
    bands: number[];
    perBand: number;
    seed: number;
    extraPaddingM?: number;
  },
): Mission[] {
  const index = obstacleIndex(data),
    radius =
      1.027 +
      OFFSET_BOUND_M +
      GPU_TOLERANCE_M +
      CLEARANCE_MARGIN_M +
      (options.extraPaddingM ?? 0);
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
          i === 0 ||
          Math.hypot(...p.map((v, k) => v - output[i - 1][k])) > 0.01,
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
  for (const band of options.bands) {
    const g = graph(band);
    let accepted = 0;
    for (
      let attempt = 0;
      attempt < Math.min(g.edges.length * 2, 300) && accepted < options.perBand;
      attempt++
    ) {
      const [a, b] =
        g.edges[hash32(attempt + band * 7919 + options.seed) % g.edges.length];
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
  }

  return missions;
}
