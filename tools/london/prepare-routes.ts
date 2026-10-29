import fs from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { authorStreetTrips } from "../../packages/city/src/route-authoring.ts";
import {
  cityScenario,
  compileCityRoute,
  OFFSET_BOUND_M,
} from "../../packages/city/src/index.ts";
import type { RoadData } from "../../packages/city/src/index.ts";
import type { Vec3 } from "../../packages/core-types/src/index.ts";
import { hash32 } from "../../packages/core-types/src/index.ts";
import { obstacleIndex } from "../../packages/city/src/obstacles.ts";
import type { CityData, CityManifest } from "../../packages/city/src/types.ts";
import type {
  LondonManifest,
  LondonMission,
} from "../../packages/city/src/london.ts";
const root = "assets/city/london",
  publicRoot = "apps/sky/public/london";
const manifest: LondonManifest = JSON.parse(
  fs.readFileSync(`${root}/manifest.json`, "utf8"),
);
const catalog = new Map(manifest.tiles.map((t) => [t.key, t]));
function load(key: string) {
  const t = catalog.get(key);
  if (!t) return null;
  const text = fs.readFileSync(`${publicRoot}/${t.file}`, "utf8");
  return JSON.parse(text.slice(text.indexOf(",") + 1, -2));
}
const sectors = new Map<string, (typeof manifest.tiles)[number]>();
for (const t of manifest.tiles) {
  if (t.roads < 40 || t.buildings < 10) continue;
  const sector = `${Math.floor(t.x / 4)},${Math.floor(t.z / 4)}`,
    old = sectors.get(sector);
  if (!old || old.roads < t.roads) sectors.set(sector, t);
}
type Sector = {
  key: string;
  data: CityData;
  manifest: CityManifest;
  roads: RoadData;
  index: ReturnType<typeof obstacleIndex>;
};
const cache = new Map<string, Sector>();
function sectorData(sector: string): Sector {
  const cached = cache.get(sector);
  if (cached) {
    cache.delete(sector);
    cache.set(sector, cached);
    return cached;
  }
  const centre = sectors.get(sector)!,
    nodes: number[][] = [],
    edges: number[][] = [],
    buildings: CityData["buildings"] = [],
    lookup = new Map<string, number>();
  function node(x: number, z: number) {
    const key = `${x.toFixed(1)},${z.toFixed(1)}`;
    let id = lookup.get(key);
    if (id === undefined) {
      id = nodes.length;
      nodes.push([x, z]);
      lookup.set(key, id);
    }
    return id;
  }
  for (let x = centre.x - 1; x <= centre.x + 1; x++)
    for (let z = centre.z - 1; z <= centre.z + 1; z++) {
      const tile = load(`${x}_${z}`);
      if (!tile) continue;
      for (const b of tile.b)
        buildings.push({
          osmId: `${b[0]}:${x},${z}:${buildings.length}`,
          tile: `${x},${z}`,
          base: b[1],
          top: b[2],
          flags: b[3],
          ring: b[4][0].map((p: number[]) => [
            p[0] + x * 1024,
            p[1] + z * 1024,
          ]),
        });
      for (const r of tile.r) {
        if (r[0] > 13) continue;
        const [a, b] = r[1];
        edges.push([
          node(a[0] + x * 1024, a[1] + z * 1024),
          node(b[0] + x * 1024, b[1] + z * 1024),
          r[0],
        ]);
      }
    }
  const data = { schemaVersion: 1, region: sector, buildings },
    local: CityManifest = {
      schemaVersion: 1,
      region: sector,
      origin: manifest.origin,
      buildings: buildings.length,
      maxRoofM: manifest.maxRoofM,
      verticalDatum: "Nominal flat ground",
      localBoundsM: {
        minX: (centre.x - 1) * 1024,
        maxX: (centre.x + 2) * 1024,
        minZ: (centre.z - 1) * 1024,
        maxZ: (centre.z + 2) * 1024,
      },
      data: { sha256: manifest.dataSha256, bytes: 0 },
    };
  const result = {
    key: sector,
    data,
    manifest: local,
    roads: { nodes, edges, source: { sha256: manifest.dataSha256 } },
    index: obstacleIndex(data),
  };
  cache.set(sector, result);
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
  return result;
}
const missions: LondonMission[] = [],
  proofs: { sector: string; segments: number; routes: number }[] = [];
let sectorCount = 0;
for (const [key] of sectors) {
  const sector = sectorData(key);
  if (!sector.data.buildings.length || sector.roads.edges.length < 8) continue;
  const trips = authorStreetTrips(sector.data, sector.manifest, sector.roads, {
    bands: [24, 48],
    perBand: 2,
    seed: hash32(sectorCount++),
    extraPaddingM: 0.08,
  });
  if (!trips.length) continue;
  // 0.08m extra swept radius plus the normal 0.02m tolerance is equivalent to
  // the 0.10m allowance declared for larger London coordinates.
  const result = cityScenario(sector.data, sector.manifest, 1.107, {
    schemaVersion: 1,
    obstacleSha256: manifest.dataSha256,
    roadsSha256: manifest.dataSha256,
    sampleSpacingM: 1.5,
    missions: [...trips, { ...trips[0], kind: "sky" }],
  });
  missions.push(
    ...trips.map((m) => ({
      ...m,
      spacing: 1.5,
      sector: key,
      label: `London ${key} / ${m.label}`,
    })),
  );
  proofs.push({
    sector: key,
    segments: result.clearance.validatedSegments - (result.table.routes.at(-1)!.samples.length/12 - 1),
    routes: trips.length,
  });
  if (proofs.length % 10 === 0)
    console.log(
      JSON.stringify({ sectors: proofs.length, streetRoutes: missions.length }),
    );
}
assert(proofs.length >= 50, "Insufficient Greater London coverage");
const street = [...missions],
  skyRadius = 1.027 + OFFSET_BOUND_M + 0.1 + 3,
  skyFloor = Math.ceil((manifest.maxRoofM + skyRadius + 15) / 25) * 25;
const pairs = new Set<string>(),
  ease = (t: number) => {
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  };
function loop(
  points: Vec3[],
  height: (f: number) => number,
  skipFirst = false,
) {
  const closed = [...points, points[0]],
    distances = [0];
  for (let i = 1; i < closed.length; i++)
    distances.push(
      distances[i - 1] +
        Math.hypot(...closed[i].map((v, k) => v - closed[i - 1][k])),
    );
  const total = distances.at(-1)!;
  return closed.flatMap((p, i) =>
    skipFirst && i === 0
      ? []
      : [[p[0], height(distances[i] / total), p[2]] as Vec3],
  );
}
let skySegments = 0;
for (
  let attempt = 0, accepted = 0;
  attempt < 1800 && accepted < 64;
  attempt++
) {
  const ai = hash32(attempt + 7321) % street.length,
    bi = hash32(attempt + 947) % street.length,
    a = street[ai],
    b = street[bi],
    pair = [ai, bi].sort((x, y) => x - y).join(",");
  if (
    a.sector === b.sector ||
    pairs.has(pair) ||
    Math.hypot(
      a.waypoints[0][0] - b.waypoints[0][0],
      a.waypoints[0][2] - b.waypoints[0][2],
    ) < 5000
  )
    continue;
  const h = skyFloor + (accepted % 3) * 25,
    ah = a.waypoints[0][1],
    bh = b.waypoints[0][1];
  const points = [
    ...loop(a.waypoints, (t) => ah + (h - ah) * ease((t - 0.18) / 0.68)),
    ...loop(b.waypoints, (t) =>
      t < 0.5
        ? h + (bh - h) * ease(t / 0.3)
        : bh + (h + 18 - bh) * ease((t - 0.55) / 0.45),
    ),
    ...loop(
      a.waypoints,
      (t) => h + 18 + (ah - h - 18) * ease(t / 0.55),
      true,
    ).slice(0, -1),
  ];
  const mission: LondonMission = {
    kind: "sky",
    waypoints: points,
    speed: 15 + (accepted % 5),
    label: `London district link ${accepted + 1}`,
    spacing: 6,
    sector: a.sector,
  };
  let route;
  try {
    route = compileCityRoute(mission, 6);
  } catch {
    continue;
  }
  const models = [sectorData(a.sector), sectorData(b.sector)];
  let valid = true;
  for (let at = 12; at < route.samples.length; at += 12) {
    const p = Array.from(route.samples.slice(at - 12, at - 9)) as Vec3,
      q = Array.from(route.samples.slice(at, at + 3)) as Vec3;
    if (Math.min(p[1], q[1]) > manifest.maxRoofM + skyRadius) continue;
    const sector = models.find((s) => {
      const b = s.manifest.localBoundsM;
      return (
        p[0] - skyRadius > b.minX &&
        p[0] + skyRadius < b.maxX &&
        q[0] - skyRadius > b.minX &&
        q[0] + skyRadius < b.maxX &&
        p[2] - skyRadius > b.minZ &&
        p[2] + skyRadius < b.maxZ &&
        q[2] - skyRadius > b.minZ &&
        q[2] + skyRadius < b.maxZ
      );
    });
    if (!sector || sector.index.blocked(p, q, skyRadius)) {
      valid = false;
      break;
    }
  }
  if (valid) {
    missions.push(mission);
    skySegments += route.samples.length / 12 - 1;
    pairs.add(pair);
    accepted++;
  }
}
assert(
  missions.filter((m) => m.kind === "sky").length >= 24,
  "Insufficient London sky links",
);
const validation = {
  passed: true,
  sectors: proofs.length,
  streetRoutes: street.length,
  skyRoutes: missions.length - street.length,
  validatedSegments: proofs.reduce((s, p) => s + p.segments, 0) + skySegments,
  minimumModelGapM: 3,
  requiredMarginM: 3,
  gpuToleranceM: 0.1,
  sourceTileCount: manifest.tiles.length,
  proofs,
  skyEnvelopeFloorM: skyFloor,
};
const output = {
  schemaVersion: 1,
  region: "greater-london",
  dataSha256: manifest.dataSha256,
  missions,
  validation,
  license: "ODbL-1.0",
  source:
    "Derived from full Greater London road/building tiles; independent A* compiler; immutable offline obstacle proof, unaffected by render tile eviction.",
};
const bytes = JSON.stringify(output);
fs.writeFileSync(`${root}/navigation.json`, bytes);
console.log(
  JSON.stringify({
    complete: true,
    ...validation,
    proofs: proofs.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }),
);
