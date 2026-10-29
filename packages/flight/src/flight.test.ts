import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRoute,
  evaluateRoute,
  routeTable,
  descriptors,
  poseAt,
  SimulationClock,
  skyRoutes,
} from "./index.ts";
import type { Vec3 } from "../../core-types/src/index.ts";
const close = (a: number, b: number, eps = 1e-5) =>
  assert(Math.abs(a - b) < eps, `${a} != ${b}`);
test("straight constant-speed reference and endpoint clamp", () => {
  const route = buildRoute(
    [
      [0, 0, 0],
      [0, 0, -100],
    ],
    false,
    3,
    10,
  );
  const table = routeTable([route]),
    words = descriptors(1, table),
    f = new Float32Array(words.buffer);
  f[2] = 0;
  const p = poseAt(words, table, 0, 2000);
  close(p.position[2], -20);
  close(p.quaternion[3], 1);
  close(evaluateRoute(route, 200).position[2], -100);
});
test("vertical frame remains finite and orthonormal", () => {
  const p = evaluateRoute(
    buildRoute(
      [
        [0, 0, 0],
        [0, 100, 0],
      ],
      false,
    ),
    50,
    2,
    3,
  );
  assert(p.position.every(Number.isFinite));
  close(Math.hypot(...p.quaternion), 1);
  close(p.position[1], 50);
});
test("circle length, closure and approximation against analytic fixture", () => {
  const radius = 20,
    points: Vec3[] = Array.from({ length: 2048 }, (_, i) => [
      radius * Math.cos((i / 2048) * Math.PI * 2),
      0,
      radius * Math.sin((i / 2048) * Math.PI * 2),
    ]);
  const route = buildRoute(points, true, 0.25);
  close(route.length, Math.PI * 2 * radius, 0.002);
  for (const fraction of [0.125, 0.25, 0.5, 0.875]) {
    const p = evaluateRoute(route, route.length * fraction).position;
    close(p[0], radius * Math.cos(fraction * Math.PI * 2), 0.002);
    close(p[2], radius * Math.sin(fraction * Math.PI * 2), 0.002);
  }
  const a = evaluateRoute(route, -0.001),
    b = evaluateRoute(route, route.length - 0.001);
  a.position.forEach((value, i) => close(value, b.position[i]));
});
test("seeded IDs and packed descriptor layout are reproducible", () => {
  const table = skyRoutes(),
    a = descriptors(1024, table, 12),
    b = descriptors(1024, table, 12);
  assert.deepEqual(a, b);
  assert.equal(a.byteLength, 1024 * 32);
  assert.notDeepEqual(a, descriptors(1024, table, 13));
  for (const id of [0, 31, 1023])
    assert(poseAt(a, table, id, 12000).position.every(Number.isFinite));
});
test("clock freezes on pause and clamps tab wakeup instead of jumping", () => {
  const clock = new SimulationClock();
  clock.advance(16);
  clock.paused = true;
  clock.advance(10000);
  close(clock.timeMs, 16);
  clock.paused = false;
  clock.speed = 4;
  clock.advance(1000);
  close(clock.timeMs, 416);
  clock.reset();
  close(clock.timeMs, 0);
});
test("invalid routes rejected", () => {
  assert.throws(() =>
    buildRoute(
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
      false,
    ),
  );
  assert.throws(() =>
    buildRoute(
      [
        [0, 0, 0],
        [NaN, 1, 2],
      ],
      false,
    ),
  );
});
