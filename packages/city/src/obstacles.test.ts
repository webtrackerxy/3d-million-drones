import { test } from "node:test";
import assert from "node:assert/strict";
import { prismBlocks, obstacleIndex } from "./obstacles.ts";
const building = {
  osmId: "fixture",
  tile: "0,0",
  base: 0,
  top: 40,
  flags: 4,
  ring: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
};
test("continuous swept check catches walls even when both endpoints are outside", () => {
  assert(prismBlocks([-20, 15, 5], [30, 15, 5], building, 2));
  assert(prismBlocks([-20, 15, -1], [30, 15, -1], building, 2));
  assert(!prismBlocks([-20, 15, -3], [30, 15, -3], building, 2));
  assert(prismBlocks([-20, 15, 0], [30, 15, 0], building, 0));
});
test("roof grazing, ascent through roofs and high overflight are distinguished", () => {
  assert(prismBlocks([-20, 42, 5], [30, 42, 5], building, 3));
  assert(!prismBlocks([-20, 44, 5], [30, 44, 5], building, 3));
  assert(prismBlocks([-10, 0, 5], [20, 60, 5], building, 2));
  assert(!prismBlocks([-100, 0, 5], [100, 1000, 5], building, 2));
  // Horizontal launch scatter must not inflate vertical extent. Contact with a
  // declared support never exempts a higher rooftop obstacle.
  assert(!prismBlocks([5, 50, 5], [5, 60, 5], building, 100, 4.127));
  const support = { ...building, osmId: "support", top: 10 },
    higher = { ...building, osmId: "higher", top: 16 };
  const options = {
    allowSurfaceContact: true,
    verticalRadiusM: 4.127,
    supportIds: new Set(["support"]),
  };
  assert(
    !obstacleIndex({
      schemaVersion: 1,
      region: "roof",
      buildings: [support],
    }).blocked([5, 10.37, 5], [5, 100, 5], 2, options),
  );
  assert(
    obstacleIndex({
      schemaVersion: 1,
      region: "roof",
      buildings: [support, higher],
    }).blocked([5, 10.37, 5], [5, 100, 5], 2, options),
  );
});
test("spatial index finds long segments across buckets, point collisions and ground", () => {
  const index = obstacleIndex({
    schemaVersion: 1,
    region: "fixture",
    buildings: [building],
  });
  assert(index.blocked([-500, 20, 5], [500, 20, 5], 1));
  assert(index.blocked([5, 20, 5], [5, 20, 5], 1));
  assert(index.blocked([100, 1, 100], [200, 1, 100], 2));
  assert(!index.blocked([-500, 50, 5], [500, 50, 5], 1));
  assert.throws(
    () => index.blocked([NaN, 20, 5], [5, 20, 5], 1),
    /Invalid clearance/,
  );
});
