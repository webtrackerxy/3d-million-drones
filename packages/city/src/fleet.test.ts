import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  londonFleet,
  londonDescriptors,
  launchStages,
  compileLaunchRoute,
} from "./fleet.ts";
import type { FleetBundle, LaunchMission } from "./fleet.ts";
import { poseAt, evaluateRoute, routeTable } from "../../flight/src/index.ts";
import {
  SCHEDULED_START,
  WORLD_XZ_OFFSETS,
} from "../../core-types/src/index.ts";
import type { LondonManifest } from "./london.ts";
import { obstacleIndex } from "./obstacles.ts";
import type { CityData } from "./types.ts";
const root = new URL("../../../", import.meta.url);
const read = (p: string) =>
  JSON.parse(fs.readFileSync(new URL(p, root), "utf8"));
const manifest: LondonManifest = read("assets/city/london/manifest.json"),
  bundle: FleetBundle = read("assets/city/london/fleet.json"),
  scenario = londonFleet(manifest, bundle);
const close = (a: number, b: number, e = 0.02) =>
  assert(Math.abs(a - b) < e, `${a} != ${b}`);
test("one million IDs contain exactly 30% launch trips and 70% grouped roaming with stable prefixes", () => {
  const words = londonDescriptors(1_000_000, scenario),
    small = londonDescriptors(10_000, scenario);
  assert.equal(words.byteLength, 32_000_000);
  assert.deepEqual(words.subarray(0, small.length), small);
  let launch = 0;
  const groups = new Set<string>(),
    sites = new Set<string>();
  for (let id = 0; id < 1_000_000; id++) {
    const m = scenario.missions[words[id * 8]];
    if (m.kind === "launch") {
      launch++;
      sites.add(m.from.id);
    } else groups.add(m.group);
  }
  assert.equal(launch, 300000);
  assert.equal(groups.size, 120);
  assert.equal(sites.size, 11);
  assert.deepEqual(londonDescriptors(100, scenario), words.slice(0, 800));
});
test("launch drones begin on their own surface, stay within pads and do not wrap future departure timestamps", () => {
  const words = londonDescriptors(10000, scenario),
    floats = new Float32Array(words.buffer);
  for (let id = 0; id < 10000; id++) {
    const at = id * 8,
      m = scenario.missions[words[at]];
    if (m.kind !== "launch") continue;
    const p = poseAt(words, scenario.table, id, 0).position;
    close(p[1], m.from.surfaceHeightM + 0.37, 0.001);
    assert(
      Math.hypot(p[0] - m.from.position[0], p[2] - m.from.position[2]) <=
        m.from.radiusM + 0.002,
    );
    assert.equal(words[at + 7], SCHEDULED_START | WORLD_XZ_OFFSETS);
    assert(words[at + 3] < 120000 && floats[at + 4] === 1);
    const waiting = poseAt(words, scenario.table, id, words[at + 3]).position;
    assert.deepEqual(p, waiting);
  }
});
test("all ground and roof trips climb, reach their targets, stop, return and join without teleporting or body roll", () => {
  for (const m of bundle.missions) {
    if (m.kind !== "launch") continue;
    const route = compileLaunchRoute(m),
      stages = launchStages(m);
    const launch = stages.find((s) => s.name === "takeoff")!,
      stop = stages.find((s) => s.name === "destination stop")!;
    const up = evaluateRoute(route, (launch.startS + launch.endS) / 2);
    assert(up.position[1] > m.from.position[1] + 50);
    close(up.position[0], m.from.position[0]);
    close(up.position[2], m.from.position[2]);
    const arrived = evaluateRoute(route, (stop.startS + stop.endS) / 2);
    arrived.position.forEach((v, i) => close(v, m.to.position[i], 0.003));
    const before = evaluateRoute(route, route.length - 0.001),
      after = evaluateRoute(route, 0.001);
    assert(
      Math.hypot(...before.position.map((v, i) => v - after.position[i])) <
        0.001,
    );
    for (let at = 0; at < route.samples.length; at += 12) {
      assert(Number.isFinite(route.samples[at]));
      close(route.samples[at + 5], 0, 0.00001);
      close(route.samples[at + 9], 0, 0.00001);
      if (at) {
        const dt = route.samples[at + 3] - route.samples[at - 9];
        assert(
          Math.abs(route.samples[at + 1] - route.samples[at - 11]) / dt <=
            m.climbSpeedMps + 0.03,
        );
        assert(
          Math.hypot(
            route.samples[at] - route.samples[at - 12],
            route.samples[at + 2] - route.samples[at - 10],
          ) /
            dt <=
            m.cruiseSpeedMps + 0.03,
        );
      }
    }
    const table = routeTable([route]),
      words = new Uint32Array(8),
      floats = new Float32Array(words.buffer);
    words[3] = 120000;
    words[7] = SCHEDULED_START | WORLD_XZ_OFFSETS;
    floats[4] = 1;
    floats[5] = 7;
    floats[6] = -5;
    const target = poseAt(
      words,
      table,
      0,
      120000 + (stop.startS + stop.endS) * 500,
    ).position;
    close(target[0], m.to.position[0] + 7);
    close(target[1], m.to.position[1]);
    close(target[2], m.to.position[2] - 5);
  }
});
test("roaming groups cover London with distinct irregular 3D paths and finite long-running poses", () => {
  const roaming = bundle.missions.filter((m) => m.kind === "roam");
  assert.equal(roaming.length, 480);
  const centres: number[][] = [];
  for (let i = 0; i < roaming.length; i += 4) {
    const m = roaming[i],
      xs = m.waypoints.map((p) => p[0]),
      ys = m.waypoints.map((p) => p[1]),
      zs = m.waypoints.map((p) => p[2]);
    assert(
      Math.max(...xs) - Math.min(...xs) > 400 &&
        Math.max(...zs) - Math.min(...zs) > 400,
    );
    assert(Math.max(...ys) - Math.min(...ys) > 100);
    if (m.movement === "vertical") {
      const route = scenario.table.routes[bundle.missions.indexOf(m)];
      let up = 0,
        down = 0;
      for (let at = 12; at < route.samples.length; at += 12) {
        if (
          Math.hypot(
            route.samples[at] - route.samples[at - 12],
            route.samples[at + 2] - route.samples[at - 10],
          ) < 0.01
        ) {
          const dy = route.samples[at + 1] - route.samples[at - 11];
          if (dy > 0) up += dy;
          else down -= dy;
        }
      }
      assert(
        up > 200 && down > 200,
        "Vertical groups must have sustained ascent AND descent, not just small altitude noise",
      );
    }
    centres.push([
      xs.reduce((s, v) => s + v, 0) / xs.length,
      zs.reduce((s, v) => s + v, 0) / zs.length,
    ]);
    assert.notDeepEqual(m.waypoints, roaming[i + 1].waypoints);
  }
  assert(
    Math.max(...centres.map((p) => p[0])) -
      Math.min(...centres.map((p) => p[0])) >
      45000,
  );
  assert.equal(
    new Set(
      roaming.filter((m) => m.movement === "vertical").map((m) => m.group),
    ).size,
    40,
  );
  assert(
    Math.max(...centres.map((p) => p[1])) -
      Math.min(...centres.map((p) => p[1])) >
      37000,
  );
  const words = londonDescriptors(1000, scenario);
  for (let id = 0; id < 1000; id++)
    for (const t of [0, 300000, 1800000, 86400000]) {
      const pose = poseAt(words, scenario.table, id, t);
      assert([...pose.position, ...pose.quaternion].every(Number.isFinite));
      assert(
        pose.position[0] > manifest.bounds.minX &&
          pose.position[0] < manifest.bounds.maxX &&
          pose.position[2] > manifest.bounds.minZ &&
          pose.position[2] < manifest.bounds.maxZ,
      );
    }
});
test("selected ground/roof columns independently clear nearby building prisms and roofs preserve contact support", () => {
  assert.equal(bundle.dataSha256, manifest.dataSha256);
  assert(
    bundle.validation.passed && bundle.validation.validatedSegments > 500000,
  );
  for (const site of bundle.sites) {
    const x = Math.floor(site.position[0] / 1024),
      z = Math.floor(site.position[2] / 1024),
      buildings: CityData["buildings"] = [];
    for (let tx = x - 1; tx <= x + 1; tx++)
      for (let tz = z - 1; tz <= z + 1; tz++) {
        const f = new URL(`apps/sky/public/london/tiles/${tx}_${tz}.js`, root);
        if (!fs.existsSync(f)) continue;
        const text = fs.readFileSync(f, "utf8"),
          tile = JSON.parse(text.slice(text.indexOf(",") + 1, -2));
        for (const b of tile.b)
          buildings.push({
            osmId: b[0],
            tile: `${tx}_${tz}`,
            base: b[1],
            top: b[2],
            flags: b[3],
            ring: b[4][0].map((p: number[]) => [
              p[0] + tx * 1024,
              p[1] + tz * 1024,
            ]),
          });
      }
    const radius = site.radiusM + 1.027 + 0.1 + 3,
      index = obstacleIndex({ schemaVersion: 1, region: "test", buildings });
    assert(
      !index.blocked(
        site.position,
        [site.position[0], manifest.maxRoofM + 50, site.position[2]],
        radius,
        {
          allowSurfaceContact: true,
          verticalRadiusM: 4.127,
          supportIds: new Set(site.supportIds),
        },
      ),
      site.name,
    );
    if (site.kind === "roof") {
      const support = buildings.find((b) => b.osmId === site.sourceIds[0]);
      assert(support);
      close(support.top, site.surfaceHeightM, 0.001);
      assert(
        index.blocked(site.position, site.position, radius, {
          allowSurfaceContact: true,
          verticalRadiusM: 4.127,
        }),
        `Missing roof contact ${site.name}`,
      );
    } else {
      assert.equal(site.surfaceHeightM, 0);
      assert.equal(site.supportIds.length, 0);
    }
  }
});
test("invalid or mismatched fleet inputs fail; one-way launch missions can stay at their destination", () => {
  assert.throws(
    () => londonFleet(manifest, { ...bundle, dataSha256: "changed" }),
    /mismatch/,
  );
  assert.throws(
    () =>
      londonFleet(manifest, {
        ...bundle,
        validation: { ...bundle.validation, passed: false },
      }),
    /mismatch/,
  );
  assert.throws(() => londonDescriptors(0, scenario), /population/);
  const m = bundle.missions.find((m) => m.kind === "launch") as LaunchMission;
  assert.throws(
    () => compileLaunchRoute({ ...m, cruiseAltitudeM: -2 }),
    /Invalid/,
  );
  const route = compileLaunchRoute({ ...m, repeat: false });
  assert(!route.closed);
  const position = evaluateRoute(route, route.length + 10000).position;
  position.forEach((v, i) => close(v, m.to.position[i], 0.003));
});
