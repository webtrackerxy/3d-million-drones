import {
  META_WORDS,
  RECORD_WORDS,
  SAMPLE_FLOATS,
  TAU,
  hash32,
  WORLD_XZ_OFFSETS,
  SCHEDULED_START,
} from "../../core-types/src/index.ts";
import type { Quat, Vec3 } from "../../core-types/src/index.ts";

export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a);
  if (length < 1e-10) throw new Error("Degenerate direction");
  return mul(a, 1 / length);
};
const mix = (a: Vec3, b: Vec3, t: number): Vec3 =>
  add(mul(a, 1 - t), mul(b, t));

export interface Route {
  samples: Float32Array;
  length: number;
  spacing: number;
  closed: boolean;
  speed: number;
}
export interface RouteTable {
  samples: Float32Array;
  metadata: Uint32Array;
  routes: Route[];
}

// Compile a polyline to uniform distance samples. Curved authoring inputs must be dense enough
// to meet their own approximation bound; route evaluation below uses the represented polyline.
export function buildRoute(
  input: Vec3[],
  closed: boolean,
  step = 2,
  speed = 12,
): Route {
  if (input.length < 2 || !(step > 0) || !Number.isFinite(step))
    throw new Error("Invalid route");
  const points = input.map((p) => {
    if (!p.every(Number.isFinite)) throw new Error("Non-finite point");
    return [...p] as Vec3;
  });
  if (closed && Math.hypot(...sub(points[0], points.at(-1)!)) > 1e-8)
    points.push([...points[0]]);
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(...sub(points[i], points[i - 1]));
    if (d < 1e-8) throw new Error("Coincident route points");
    distances.push(distances[i - 1] + d);
  }
  const length = distances.at(-1)!;
  const intervals = Math.max(1, Math.ceil(length / step)),
    spacing = length / intervals;
  const sampled: Vec3[] = [];
  let segment = 0;
  for (let i = 0; i <= intervals; i++) {
    const s = i * spacing;
    while (segment < points.length - 2 && distances[segment + 1] < s) segment++;
    sampled.push(
      mix(
        points[segment],
        points[segment + 1],
        (s - distances[segment]) /
          (distances[segment + 1] - distances[segment]),
      ),
    );
  }
  const samples = new Float32Array((intervals + 1) * SAMPLE_FLOATS);
  let previousRight: Vec3 | undefined;
  for (let i = 0; i <= intervals; i++) {
    const before = sampled[i === 0 ? (closed ? intervals - 1 : 0) : i - 1],
      after = sampled[i === intervals ? (closed ? 1 : intervals) : i + 1];
    const tangent = unit(sub(after, before));
    let right: Vec3;
    if (previousRight) {
      const projected = sub(
        previousRight,
        mul(tangent, dot(previousRight, tangent)),
      );
      right =
        Math.hypot(...projected) > 1e-7
          ? unit(projected)
          : unit(
              cross(
                tangent,
                Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0],
              ),
            );
    } else
      right = unit(
        cross(tangent, Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]),
      );
    previousRight = right;
    samples.set(
      [...sampled[i], i * spacing, ...tangent, speed, ...right, -1],
      i * SAMPLE_FLOATS,
    );
  }
  if (closed) {
    // Remove accumulated transported-frame twist continuously and join the endpoint exactly.
    const firstRight = Array.from(samples.slice(8, 11)) as Vec3;
    const tangent = Array.from(samples.slice(4, 7)) as Vec3;
    const lastRight = Array.from(
      samples.slice(
        intervals * SAMPLE_FLOATS + 8,
        intervals * SAMPLE_FLOATS + 11,
      ),
    ) as Vec3;
    const angle = Math.atan2(
      dot(cross(lastRight, firstRight), tangent),
      dot(lastRight, firstRight),
    );
    for (let i = 0; i <= intervals; i++) {
      const at = i * SAMPLE_FLOATS,
        t = Array.from(samples.slice(at + 4, at + 7)) as Vec3,
        r = Array.from(samples.slice(at + 8, at + 11)) as Vec3;
      const a = (angle * i) / intervals;
      const corrected = add(
        add(mul(r, Math.cos(a)), mul(cross(t, r), Math.sin(a))),
        mul(t, dot(t, r) * (1 - Math.cos(a))),
      );
      samples.set(corrected, at + 8);
    }
    samples.set(samples.subarray(0, 3), intervals * SAMPLE_FLOATS);
    samples.set(samples.subarray(4, 7), intervals * SAMPLE_FLOATS + 4);
    samples.set(samples.subarray(8, 11), intervals * SAMPLE_FLOATS + 8);
  }
  return {
    samples,
    length: samples[intervals * SAMPLE_FLOATS + 3],
    spacing: Math.fround(spacing),
    closed,
    speed,
  };
}

export function routeTable(routes: Route[]): RouteTable {
  const samples = new Float32Array(
    routes.reduce((sum, r) => sum + r.samples.length, 0),
  );
  const metadata = new Uint32Array(routes.length * META_WORDS),
    floats = new Float32Array(metadata.buffer);
  let offset = 0;
  routes.forEach((route, i) => {
    const at = i * META_WORDS;
    metadata[at] = offset / SAMPLE_FLOATS;
    metadata[at + 1] = route.samples.length / SAMPLE_FLOATS;
    floats[at + 2] = route.length;
    floats[at + 3] = route.spacing;
    metadata[at + 4] = route.closed ? 1 : 0;
    floats[at + 5] = route.speed;
    floats[at + 6] = -1;
    samples.set(route.samples, offset);
    offset += route.samples.length;
  });
  return { routes, samples, metadata };
}

export function skyRoutes(): RouteTable {
  const routes: Route[] = [];
  for (let band = 0; band < 32; band++) {
    const ring = band % 8,
      tier = Math.floor(band / 8),
      radius = 100 + ring * 45;
    const points: Vec3[] = Array.from({ length: 512 }, (_, i) => {
      const a = (i / 512) * TAU;
      return [
        Math.cos(a) * radius,
        100 + tier * 75 + Math.sin(a * 2 + tier * 0.5) * 18,
        Math.sin(a) * radius * 0.82,
      ];
    });
    routes.push(buildRoute(points, true, 3, 10 + ring * 0.6));
  }
  return routeTable(routes);
}

export function quaternionFromFrame(
  right: Vec3,
  up: Vec3,
  forward: Vec3,
): Quat {
  const [m00, m10, m20] = right,
    [m01, m11, m21] = up,
    [m02, m12, m22] = mul(forward, -1),
    trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const length = Math.hypot(...q);
  return q.map((x) => x / length) as Quat;
}
export function evaluateRoute(
  route: Route,
  distance: number,
  lateral = 0,
  vertical = 0,
): { position: Vec3; quaternion: Quat } {
  const s = route.closed
    ? ((distance % route.length) + route.length) % route.length
    : Math.max(0, Math.min(route.length, distance));
  const count = route.samples.length / SAMPLE_FLOATS,
    index = Math.min(count - 2, Math.floor(s / route.spacing));
  const a = index * SAMPLE_FLOATS,
    b = (index + 1) * SAMPLE_FLOATS,
    t =
      (s - route.samples[a + 3]) /
      (route.samples[b + 3] - route.samples[a + 3]);
  const read = (at: number, field: number) =>
    Array.from(route.samples.slice(at + field, at + field + 3)) as Vec3;
  const position = mix(read(a, 0), read(b, 0), t),
    forward = unit(mix(read(a, 4), read(b, 4), t));
  const candidate = mix(read(a, 8), read(b, 8), t),
    right = unit(sub(candidate, mul(forward, dot(candidate, forward)))),
    up = unit(cross(right, forward));
  return {
    position: add(add(position, mul(right, lateral)), mul(up, vertical)),
    quaternion: quaternionFromFrame(right, up, forward),
  };
}
export function descriptors(
  count: number,
  table: RouteTable,
  seed = 1,
): Uint32Array {
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000)
    throw new Error("Invalid population");
  const words = new Uint32Array(count * RECORD_WORDS),
    floats = new Float32Array(words.buffer);
  for (let id = 0; id < count; id++) {
    const at = id * RECORD_WORDS,
      route = id % table.routes.length,
      random = hash32(id ^ seed);
    words[at] = route;
    words[at + 1] = random;
    floats[at + 2] = (random / 4294967296) * table.routes[route].length;
    words[at + 3] = 0;
    floats[at + 4] = table.routes[route].speed;
    floats[at + 5] = (((random >>> 8) % 21) - 10) * 1.8;
    floats[at + 6] = (((random >>> 16) % 11) - 5) * 1.8;
  }
  return words;
}
export function poseAt(
  words: Uint32Array,
  table: RouteTable,
  id: number,
  timeMs: number,
) {
  const at = id * RECORD_WORDS,
    floats = new Float32Array(words.buffer, words.byteOffset, words.length),
    elapsed =
      words[at + 7] & SCHEDULED_START
        ? Math.max(0, timeMs - words[at + 3]) / 1000
        : ((timeMs - words[at + 3]) >>> 0) / 1000,
    worldOffsets = Boolean(words[at + 7] & WORLD_XZ_OFFSETS);
  const pose = evaluateRoute(
    table.routes[words[at]],
    floats[at + 2] + floats[at + 4] * elapsed,
    worldOffsets ? 0 : floats[at + 5],
    worldOffsets ? 0 : floats[at + 6],
  );
  if (worldOffsets) {
    pose.position[0] += floats[at + 5];
    pose.position[2] += floats[at + 6];
  }
  return pose;
}
export class SimulationClock {
  timeMs = 0;
  speed = 1;
  paused = false;
  advance(realDeltaMs: number): number {
    if (!this.paused)
      this.timeMs += Math.max(0, Math.min(100, realDeltaMs)) * this.speed;
    return this.timeMs;
  }
  reset() {
    this.timeMs = 0;
  }
}
