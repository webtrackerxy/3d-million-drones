import { test } from "node:test";
import { obstacleIndex } from "./obstacles.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  cityScenario,
  cityDescriptors,
  gridToLocal,
  localToGrid,
  validateCity,
  OFFSET_BOUND_M,
} from "./index.ts";
import { evaluateRoute, poseAt } from "../../flight/src/index.ts";
const folder = new URL("../../../assets/city/canary-wharf/", import.meta.url);
const navigation = JSON.parse(
  await readFile(new URL("navigation.json", folder), "utf8"),
);
const roads = JSON.parse(await readFile(new URL("roads.json", folder), "utf8"));
const readRoadBytes = await readFile(new URL("roads.json", folder));
const bytes = await readFile(new URL("buildings.json", folder));
const data = JSON.parse(bytes.toString()),
  manifest = JSON.parse(
    await readFile(new URL("manifest.json", folder), "utf8"),
  );

test("city data matches licensed source manifest and landmark obstacle", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    manifest.data.sha256,
  );
  assert.equal(bytes.length, manifest.data.bytes);
  assert.equal(manifest.license, "ODbL-1.0");
  assert.equal(manifest.sources.length, 65);
  assert.equal(validateCity(data, manifest).obstacles, 2416);
  const tower = data.buildings.find(
    (b: { osmId: string }) => b.osmId === "432777466",
  );
  assert.equal(tower.top, 235); // tagged One Canada Square part in the source data
  assert.equal(tower.base, 0);
  assert(
    tower.ring.every(
      ([x, z]: number[]) => x > 250 && x < 305 && z > 20 && z < 70,
    ),
  );
});
test("British National Grid origin, metre axes and height round-trip", () => {
  assert.deepEqual(gridToLocal(537273, 180348, 0, manifest.origin), [0, 0, 0]);
  assert.deepEqual(
    gridToLocal(537373, 180548, 42, manifest.origin),
    [100, 42, -200],
  );
  assert.deepEqual(localToGrid([-350, 91, 270], manifest.origin), {
    easting: 536923,
    northing: 180078,
    height: 91,
  });
});

const scenario = cityScenario(data, manifest, 1.027, navigation);
test("road-derived mission bundle carries exact input provenance and both traffic layers", () => {
  assert.equal(navigation.obstacleSha256, manifest.data.sha256);
  assert.equal(navigation.roadsSha256, roads.source.sha256);
  assert.equal(roads.license, "ODbL-1.0");
  assert.equal(
    createHash("sha256").update(readRoadBytes).digest("hex"),
    navigation.provenance.roadsJsonSha256,
  );
  assert.equal(scenario.clearance.streetRoutes, 96);
  assert(scenario.clearance.skyRoutes >= 12);
  assert(scenario.clearance.validatedSegments > 50000);
  assert.equal(scenario.clearance.minimumRouteAltitudeM, 20);
  assert(scenario.clearance.maximumRouteAltitudeM >= 200);
  assert.equal(scenario.clearance.minimumModelGapM, 3);
});
test("irregular street trips and district routes close with continuous frames", () => {
  for (const route of scenario.table.routes) {
    const a = evaluateRoute(route, 0),
      b = evaluateRoute(route, route.length - 0.0001);
    assert(Math.hypot(...a.position.map((v, i) => v - b.position[i])) < 0.001);
    assert(
      Math.abs(
        a.quaternion.reduce((sum, v, i) => sum + v * b.quaternion[i], 0),
      ) > 0.9999,
    );
    for (let distance = 0; distance < route.length; distance += 25) {
      const pose = evaluateRoute(route, distance);
      assert(
        Math.abs(pose.quaternion[0]) < 1e-6 &&
          Math.abs(pose.quaternion[2]) < 1e-6,
        "City quadcopter body should stay level during climbs and turns",
      );
    }
  }
  const streets = scenario.missions.filter((m) => m.kind === "street");
  assert(new Set(streets.map((m) => m.waypoints[0][1])).size >= 4);
  for (const mission of scenario.missions.filter((m) => m.kind === "sky")) {
    const ys = mission.waypoints.map((p) => p[1]);
    assert(Math.min(...ys) <= 68 && Math.max(...ys) > 100);
  }
});
test("city fleet mixes layers, starts, speeds and bounded offsets reproducibly", () => {
  const words = cityDescriptors(10000, scenario, 7),
    floats = new Float32Array(words.buffer);
  assert.deepEqual(words, cityDescriptors(10000, scenario, 7));
  assert.deepEqual(words.slice(0, 800), cityDescriptors(100, scenario, 7));
  let street = 0;
  const speeds = new Set<number>();
  for (let id = 0; id < 10000; id++) {
    const at = id * 8;
    if (scenario.missions[words[at]].kind === "street") street++;
    speeds.add(floats[at + 4]);
    assert(Math.hypot(floats[at + 5], floats[at + 6]) <= OFFSET_BOUND_M + 1e-6);
    assert(
      floats[at + 2] >= 0 &&
        floats[at + 2] < scenario.table.routes[words[at]].length,
    );
    assert(floats[at + 4] >= 5 && floats[at + 4] <= 24);
  }
  assert(street > 6800 && street < 7200);
  assert(speeds.size > 9000);
});
test("actual fleet positions stay clear of the building model at multiple trip phases", () => {
  const index = obstacleIndex(data),
    words = cityDescriptors(10000, scenario, 7);
  for (let id = 0; id < 10000; id++)
    for (const time of [0, 10250, 600000]) {
      const p = poseAt(words, scenario.table, id, time).position;
      assert(
        !index.blocked(p, p, 1.027 + 3),
        `Drone ${id} at ${time} intersects model`,
      );
    }
});
test("missing/mismatched navigation, incorrect roof envelope and blocked routes fail closed", () => {
  assert.throws(
    () => cityScenario({ ...data, buildings: [] }, manifest, 1.027, navigation),
    /Missing city obstacles/,
  );
  assert.throws(
    () => validateCity(data, { ...manifest, maxRoofM: 100 }),
    /Invalid obstacle/,
  );
  assert.throws(
    () =>
      cityScenario(data, manifest, 1.027, {
        ...navigation,
        obstacleSha256: "wrong",
      }),
    /does not match/,
  );
  assert.throws(
    () => cityScenario(data, manifest, 30, navigation),
    /intersects|outside/,
  );
  assert.throws(
    () =>
      cityScenario(data, manifest, 1.027, {
        ...navigation,
        missions: [
          {
            kind: "street",
            label: "Cross tower",
            speed: 10,
            waypoints: [
              [245, 20, 40],
              [320, 20, 40],
              [320, 20, 90],
            ],
          },
        ],
      }),
    /intersects/,
  );
});
