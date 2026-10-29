import type { Vec3 } from "../../core-types/src/index.ts";
import type { Building, CityData } from "./types.ts";

type Obstacle = Building & {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};
const cross = (ax: number, az: number, bx: number, bz: number) =>
  ax * bz - az * bx;
function pointDistance(x: number, z: number, a: number[], b: number[]) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    l = dx * dx + dz * dz;
  const t = l
    ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l))
    : 0;
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}
function inside(x: number, z: number, ring: number[][]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > z !== b[1] > z &&
      x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]
    )
      hit = !hit;
  }
  return hit;
}
function intersects(a: number[], b: number[], c: number[], d: number[]) {
  const ab1 = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
  const ab2 = cross(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  const cd1 = cross(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]);
  const cd2 = cross(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
  return ab1 * ab2 < 0 && cd1 * cd2 < 0;
}

// Expand footprint and vertical slab independently. This encloses a swept sphere,
// conservatively rejecting diagonal corner/roof near misses as well as actual collisions.
export function prismBlocks(
  a: Vec3,
  b: Vec3,
  building: Building,
  radius: number,
  verticalRadius = radius,
) {
  const dy = b[1] - a[1];
  let first = 0,
    last = 1;
  if (Math.abs(dy) < 1e-9) {
    if (
      a[1] < building.base - verticalRadius ||
      a[1] > building.top + verticalRadius
    )
      return false;
  } else {
    const t0 = (building.base - verticalRadius - a[1]) / dy,
      t1 = (building.top + verticalRadius - a[1]) / dy;
    first = Math.max(0, Math.min(t0, t1));
    last = Math.min(1, Math.max(t0, t1));
    if (first > last) return false;
  }
  const p = [a[0] + (b[0] - a[0]) * first, a[2] + (b[2] - a[2]) * first];
  const q = [a[0] + (b[0] - a[0]) * last, a[2] + (b[2] - a[2]) * last];
  if (inside(p[0], p[1], building.ring) || inside(q[0], q[1], building.ring))
    return true;
  for (let i = 0; i < building.ring.length; i++) {
    const c = building.ring[i],
      d = building.ring[(i + 1) % building.ring.length];
    if (
      intersects(p, q, c, d) ||
      Math.min(
        pointDistance(p[0], p[1], c, d),
        pointDistance(q[0], q[1], c, d),
        pointDistance(c[0], c[1], p, q),
        pointDistance(d[0], d[1], p, q),
      ) <= radius
    )
      return true;
  }
  return false;
}

export function obstacleIndex(data: CityData) {
  const cell = 64,
    buckets = new Map<string, Obstacle[]>();
  for (const b of data.buildings) {
    const o = {
      ...b,
      minX: Math.min(...b.ring.map((p) => p[0])),
      maxX: Math.max(...b.ring.map((p) => p[0])),
      minZ: Math.min(...b.ring.map((p) => p[1])),
      maxZ: Math.max(...b.ring.map((p) => p[1])),
    };
    for (let x = Math.floor(o.minX / cell); x <= Math.floor(o.maxX / cell); x++)
      for (
        let z = Math.floor(o.minZ / cell);
        z <= Math.floor(o.maxZ / cell);
        z++
      ) {
        const key = `${x},${z}`,
          list = buckets.get(key) ?? [];
        list.push(o);
        buckets.set(key, list);
      }
  }
  return {
    blocked(
      a: Vec3,
      b: Vec3,
      radius: number,
      options: {
        allowSurfaceContact?: boolean;
        verticalRadiusM?: number;
        supportIds?: ReadonlySet<string>;
      } = {},
    ) {
      const verticalRadius = options.verticalRadiusM ?? radius;
      if (
        ![...a, ...b, radius, verticalRadius].every(Number.isFinite) ||
        radius < 0 ||
        verticalRadius < 0
      )
        throw new Error("Invalid clearance segment");
      if (
        !options.allowSurfaceContact &&
        Math.min(a[1], b[1]) <= verticalRadius
      )
        return true; // nominal ground plane
      const minX = Math.min(a[0], b[0]) - radius,
        maxX = Math.max(a[0], b[0]) + radius,
        minZ = Math.min(a[2], b[2]) - radius,
        maxZ = Math.max(a[2], b[2]) + radius;
      const seen = new Set<Obstacle>();
      for (let x = Math.floor(minX / cell); x <= Math.floor(maxX / cell); x++)
        for (let z = Math.floor(minZ / cell); z <= Math.floor(maxZ / cell); z++)
          for (const o of buckets.get(`${x},${z}`) ?? []) {
            if (seen.has(o)) continue;
            seen.add(o);
            if (options.supportIds?.has(o.osmId)) continue;
            if (
              o.maxX < minX ||
              o.minX > maxX ||
              o.maxZ < minZ ||
              o.minZ > maxZ ||
              o.top + verticalRadius < Math.min(a[1], b[1])
            )
              continue;
            if (prismBlocks(a, b, o, radius, verticalRadius)) return true;
          }
      return false;
    },
  };
}
