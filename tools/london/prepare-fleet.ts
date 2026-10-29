import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hash32 } from "../../packages/core-types/src/index.ts";
import type { Vec3 } from "../../packages/core-types/src/index.ts";
import {
  compileFleetMission,
  ROAM_OFFSET_BOUND_M,
} from "../../packages/city/src/fleet.ts";
import type {
  FleetMission,
  LaunchSite,
  LaunchMission,
  RoamMission,
} from "../../packages/city/src/fleet.ts";
import {
  obstacleIndex,
  prismBlocks,
} from "../../packages/city/src/obstacles.ts";
import type { CityData } from "../../packages/city/src/types.ts";
import type { LondonManifest } from "../../packages/city/src/london.ts";

const root = "assets/city/london",
  publicRoot = "apps/sky/public/london";
const manifest: LondonManifest = JSON.parse(
  fs.readFileSync(`${root}/manifest.json`, "utf8"),
);
const candidates = JSON.parse(
  fs.readFileSync(`${root}/launch-candidates.json`, "utf8"),
);
assert.equal(candidates.dataSha256, manifest.dataSha256);
const overview = JSON.parse(fs.readFileSync(`${root}/overview.json`, "utf8"));
const catalog = new Map(manifest.tiles.map((t) => [t.key, t]));
type Tile = {
  x: number;
  z: number;
  b: [string, number, number, number, number[][][]][];
  a: [string, number[][][]][];
};
function load(key: string): Tile | null {
  const t = catalog.get(key);
  if (!t) return null;
  const text = fs.readFileSync(`${publicRoot}/${t.file}`, "utf8");
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    t.sha256,
    `Changed tile ${key}`,
  );
  return JSON.parse(text.slice(text.indexOf(",") + 1, -2));
}
const inside = (p: number[], ring: number[][]) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      hit = !hit;
  }
  return hit;
};
function edgeDistance(p: number[], rings: number[][][]) {
  let best = Infinity;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        t = Math.max(
          0,
          Math.min(
            1,
            ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) /
              (dx * dx + dz * dz || 1),
          ),
        );
      best = Math.min(
        best,
        Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz),
      );
    }
  return best;
}
const inRings = (p: number[], rings: number[][][]) =>
  inside(p, rings[0]) && !rings.slice(1).some((r) => inside(p, r));
function model(x: number, z: number) {
  const tx = Math.floor(x / 1024),
    tz = Math.floor(z / 1024),
    buildings: CityData["buildings"] = [],
    water: number[][][][] = [];
  for (let a = tx - 1; a <= tx + 1; a++)
    for (let b = tz - 1; b <= tz + 1; b++) {
      const t = load(`${a}_${b}`);
      if (!t) continue;
      for (const v of t.b)
        buildings.push({
          osmId: v[0],
          tile: `${a}_${b}`,
          base: v[1],
          top: v[2],
          flags: v[3],
          ring: v[4][0].map((p) => [p[0] + a * 1024, p[1] + b * 1024]),
        });
      for (const [kind, rings] of t.a)
        if (kind === "water")
          water.push(
            rings.map((r) => r.map((p) => [p[0] + a * 1024, p[1] + b * 1024])),
          );
    }
  const data = { schemaVersion: 1, region: "london-fleet", buildings };
  return {
    data,
    index: obstacleIndex(data),
    water,
    bounds: {
      minX: (tx - 1) * 1024,
      maxX: (tx + 2) * 1024,
      minZ: (tz - 1) * 1024,
      maxZ: (tz + 2) * 1024,
    },
  };
}
const bodyCentreAboveSurface = 0.37; // full mesh lowest vertex -0.35m: landing gear is 0.02m above modeled support.
const baseRadius = 1.027 + 0.1 + 3;
function checkPad(site: LaunchSite, context: ReturnType<typeof model>) {
  const a = site.position,
    b: [number, number, number] = [a[0], manifest.maxRoofM + 50, a[2]];
  return (
    !context.index.blocked(a, b, site.radiusM + baseRadius, {
      allowSurfaceContact: true,
      verticalRadiusM: baseRadius,
      supportIds: new Set(site.supportIds),
    }) &&
    (site.kind === "roof" ||
      context.water.every(
        (r) =>
          !inRings([a[0], a[2]], r) &&
          edgeDistance([a[0], a[2]], r) > site.radiusM + 2,
      ))
  );
}
const sites: LaunchSite[] = [];
for (const park of candidates.sites) {
  for (const c of park.candidates) {
    const site: LaunchSite = {
      id: `ground-${sites.length}`,
      name: park.name,
      kind: "ground",
      position: [c.position[0], bodyCentreAboveSurface, c.position[1]],
      surfaceHeightM: 0,
      radiusM: c.radiusM,
      sourceIds: [c.park.sourceId, c.patch.sourceId],
      supportIds: [],
    };
    if (checkPad(site, model(site.position[0], site.position[2]))) {
      sites.push(site);
      break;
    }
  }
}
assert(sites.length >= 4, "Insufficient obstruction-free grass launch pads");
console.log({ groundSites: sites.map((s) => [s.name, s.radiusM]) });
// Large modeled roof surfaces. Retain a disk wholly inside one footprint, including rotor/edge allowance.
const roofCandidates: {
  sourceId: string;
  position: Vec3;
  radiusM: number;
  surfaceHeightM: number;
}[] = [];
for (const tile of manifest.tiles) {
  if (!tile.buildings) continue;
  const data = load(tile.key)!;
  for (const [id, , top, , localRings] of data.b) {
    if (top < 6 || top > 45) continue;
    const rings = localRings.map((r) =>
        r.map((p) => [p[0] + tile.x * 1024, p[1] + tile.z * 1024]),
      ),
      xs = rings[0].map((p) => p[0]),
      zs = rings[0].map((p) => p[1]);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minZ = Math.min(...zs),
      maxZ = Math.max(...zs);
    if (
      maxX - minX < 100 ||
      maxZ - minZ < 100 ||
      minX < manifest.bounds.minX + 2000 ||
      maxX > manifest.bounds.maxX - 2000
    )
      continue;
    let best = 0,
      point = [0, 0];
    for (let x = minX + 30; x < maxX - 30; x += 30)
      for (let z = minZ + 30; z < maxZ - 30; z += 30) {
        const p = [x, z];
        if (!inRings(p, rings)) continue;
        const distance = edgeDistance(p, rings);
        if (distance > best) {
          best = distance;
          point = p;
        }
      }
    if (best > 36)
      roofCandidates.push({
        sourceId: id,
        position: [point[0], top + bodyCentreAboveSurface, point[1]],
        radiusM: Math.floor(Math.min(110, best - 6)),
        surfaceHeightM: top,
      });
  }
}
roofCandidates.sort(
  (a, b) => b.radiusM - a.radiusM || a.sourceId.localeCompare(b.sourceId),
);
for (const c of roofCandidates) {
  if (
    sites.some(
      (s) =>
        s.kind === "roof" &&
        Math.hypot(
          s.position[0] - c.position[0],
          s.position[2] - c.position[2],
        ) < 6000,
    )
  )
    continue;
  const context = model(c.position[0], c.position[2]);
  const supports = context.data.buildings
    .filter(
      (b) =>
        b.top <= c.surfaceHeightM + 0.001 &&
        prismBlocks(
          c.position,
          c.position,
          b,
          c.radiusM + baseRadius,
          baseRadius,
        ),
    )
    .map((b) => b.osmId);
  const nearest = [...overview.places]
    .filter((p) => ["town", "suburb", "city"].includes(p.kind))
    .sort(
      (a, b) =>
        Math.hypot(a.x - c.position[0], a.z - c.position[2]) -
        Math.hypot(b.x - c.position[0], b.z - c.position[2]),
    )[0];
  const site: LaunchSite = {
    id: `roof-${sites.filter((s) => s.kind === "roof").length}`,
    name: `${nearest?.name ?? "London"} roof hub`,
    kind: "roof",
    position: c.position,
    surfaceHeightM: c.surfaceHeightM,
    radiusM: c.radiusM,
    sourceIds: [c.sourceId],
    supportIds: [...new Set(supports)],
  };
  if (checkPad(site, context)) {
    sites.push(site);
    console.log({
      roof: site.name,
      radius: site.radiusM,
      height: site.surfaceHeightM,
    });
  }
  if (sites.filter((s) => s.kind === "roof").length === 6) break;
}
assert(
  sites.filter((s) => s.kind === "roof").length >= 4,
  "Insufficient checked roof launch pads",
);
const missions: FleetMission[] = [],
  proofs: {
    group: string;
    routes: number;
    segments: number;
    bounds: ReturnType<typeof model>["bounds"];
  }[] = [];
const sectors = new Map<string, (typeof manifest.tiles)[number]>();
for (const t of manifest.tiles) {
  if (t.roads < 40 || t.buildings < 10) continue;
  const key = `${Math.floor(t.x / 4)},${Math.floor(t.z / 4)}`,
    old = sectors.get(key);
  if (!old || old.roads < t.roads) sectors.set(key, t);
}
const random = (seed: number) => hash32(seed) / 4294967296;
const spline = (points: Vec3[]) => {
  const out: Vec3[] = [];
  for (let i = 0; i < points.length; i++)
    for (let s = 0; s < 24; s++) {
      const a = points[(i + points.length - 1) % points.length],
        b = points[i],
        c = points[(i + 1) % points.length],
        d = points[(i + 2) % points.length],
        t = s / 24;
      const position = b.map(
        (v, k) =>
          0.5 *
          (2 * v +
            (-a[k] + c[k]) * t +
            (2 * a[k] - 5 * v + 4 * c[k] - d[k]) * t * t +
            (-a[k] + 3 * v - 3 * c[k] + d[k]) * t * t * t),
      ) as Vec3;
      const eased = t * t * t * (t * (t * 6 - 15) + 10);
      position[1] = b[1] + (c[1] - b[1]) * eased;
      if (Math.hypot(b[0] - c[0], b[2] - c[2]) < 0.001) {
        position[0] = b[0];
        position[2] = b[2];
      }
      out.push(position);
    }
  return out;
};
let groupId = 0,
  roamSegments = 0;
for (const [sector, tile] of sectors) {
  const group = String(groupId++),
    cx = (tile.x + 0.5) * 1024,
    cz = (tile.z + 0.5) * 1024,
    context = model(cx, cz);
  const highest = Math.max(0, ...context.data.buildings.map((b) => b.top));
  const altitude =
    Math.max(90, highest + ROAM_OFFSET_BOUND_M + 3 + 45) +
    random(groupId + 872) * 80;
  const vertical = groupId % 3 === 0,
    high = altitude + 260 + random(groupId + 83) * 180;
  const base: Vec3[] = vertical
    ? [
        [cx - 260, altitude, cz - 240],
        [cx - 260, high, cz - 240],
        [cx + 260, high + 35, cz + 240],
        [cx + 260, altitude + 20, cz + 240],
        [cx + 60, altitude + 10, cz - 200],
        [cx + 60, high - 40, cz - 200],
        [cx - 270, high + 20, cz + 200],
        [cx - 270, altitude, cz + 200],
      ]
    : Array.from({ length: 7 + (groupId % 3) }, (_, i) => [
        cx + (random(groupId * 137 + i * 71) - 0.5) * 1200,
        altitude +
          (i % 2
            ? 140 + random(groupId * 981 + i * 231) * 180
            : random(groupId * 981 + i * 231) * 60),
        cz + (random(groupId * 381 + i * 173) - 0.5) * 1200,
      ]);
  const groupMissions: RoamMission[] = [],
    routes: ReturnType<typeof compileFleetMission>[] = [];
  for (let variant = 0; variant < 4; variant++) {
    const points = base.map(
      (p, i) =>
        [
          p[0] +
            (random(
              groupId * 719 +
                (vertical ? Math.floor(i / 2) : i) * 37 +
                variant * 931,
            ) -
              0.5) *
              80,
          p[1] + (random(groupId * 119 + i * 51 + variant * 411) - 0.5) * 20,
          p[2] +
            (random(
              groupId * 991 +
                (vertical ? Math.floor(i / 2) : i) * 73 +
                variant * 711,
            ) -
              0.5) *
              80,
        ] as Vec3,
    );
    const mission: RoamMission = {
      kind: "roam",
      movement: vertical ? "vertical" : "wandering",
      group,
      label: `Roaming group ${groupId} / ${variant + 1} · ${sector}`,
      waypoints: spline(points),
      spacing: 5,
      speed: 14,
    };
    const route = compileFleetMission(mission),
      radius = 1.027 + ROAM_OFFSET_BOUND_M + 0.1 + 3;
    let segments = 0;
    for (let at = 12; at < route.samples.length; at += 12) {
      const a = Array.from(route.samples.slice(at - 12, at - 9)) as Vec3,
        b = Array.from(route.samples.slice(at, at + 3)) as Vec3,
        bounds = context.bounds;
      assert(
        a[0] - radius > bounds.minX &&
          a[0] + radius < bounds.maxX &&
          a[2] - radius > bounds.minZ &&
          a[2] + radius < bounds.maxZ,
        "Roaming proof outside loaded sector",
      );
      assert(
        !context.index.blocked(a, b, radius),
        `Blocked roaming group ${group}`,
      );
      segments++;
    }
    groupMissions.push(mission);
    routes.push(route);
    roamSegments += segments;
  }
  // Similar cycle time keeps each group together across its four varied 3D paths.
  const period =
    Math.max(...routes.map((r) => r.length)) /
    (vertical ? 6 + random(groupId + 17) * 4 : 12 + random(groupId + 17) * 8);
  groupMissions.forEach((m, i) => (m.speed = routes[i].length / period));
  missions.push(...groupMissions);
  proofs.push({
    group,
    routes: groupMissions.length,
    segments: routes.reduce((s, r) => s + r.samples.length / 12 - 1, 0),
    bounds: context.bounds,
  });
}
assert(proofs.length >= 100, "Insufficient citywide roaming groups");
const launchProofs: object[] = [];
let launchSegments = 0;
for (let i = 0; i < sites.length; i++) {
  const from = sites[i],
    to = sites
      .filter((s) => s.kind !== from.kind)
      .sort(
        (a, b) =>
          Math.hypot(
            a.position[0] - from.position[0],
            a.position[2] - from.position[2],
          ) -
            Math.hypot(
              b.position[0] - from.position[0],
              b.position[2] - from.position[2],
            ) || a.id.localeCompare(b.id),
      )[0];
  const m: LaunchMission = {
    kind: "launch",
    label: `${from.name} → ${to.name}`,
    from,
    to,
    cruiseAltitudeM:
      Math.ceil((manifest.maxRoofM + baseRadius + 20) / 25) * 25 + (i % 3) * 25,
    cruiseSpeedMps: 18 + (i % 5),
    climbSpeedMps: 7,
    groundHoldS: 16,
    repeat: true,
  };
  const route = compileFleetMission(m),
    contexts = [
      model(from.position[0], from.position[2]),
      model(to.position[0], to.position[2]),
    ],
    scatter = Math.min(from.radiusM, to.radiusM),
    radius = scatter + baseRadius;
  let segments = 0;
  for (let at = 12; at < route.samples.length; at += 12) {
    const a = Array.from(route.samples.slice(at - 12, at - 9)) as Vec3,
      b = Array.from(route.samples.slice(at, at + 3)) as Vec3;
    if (Math.min(a[1], b[1]) > manifest.maxRoofM + baseRadius) {
      segments++;
      continue;
    }
    const which = [from, to].findIndex(
      (s) =>
        Math.hypot(a[0] - s.position[0], a[2] - s.position[2]) < 0.1 &&
        Math.hypot(b[0] - s.position[0], b[2] - s.position[2]) < 0.1,
    );
    assert(
      which >= 0,
      "Low launch segment outside checked ascent/descent column",
    );
    const site = [from, to][which],
      context = contexts[which];
    assert(
      Math.min(a[1], b[1]) >= site.position[1] - 0.001,
      "Below launch surface",
    );
    assert(
      !context.index.blocked(a, b, radius, {
        allowSurfaceContact: true,
        verticalRadiusM: baseRadius,
        supportIds: new Set(site.supportIds),
      }),
      `Blocked launch: ${site.name}`,
    );
    segments++;
  }
  missions.push(m);
  launchSegments += segments;
  launchProofs.push({
    from: from.id,
    to: to.id,
    segments,
    scatterRadiusM: scatter,
    sourceIds: [...from.sourceIds, ...to.sourceIds],
  });
}
const validation = {
  passed: true,
  validatedSegments: roamSegments + launchSegments,
  roamingGroups: proofs.length,
  roamingRoutes: missions.filter((m) => m.kind === "roam").length,
  launchRoutes: sites.length,
  minimumModelGapM: 3,
  requiredMarginM: 3,
  gpuToleranceM: 0.1,
  sourceTileCount: manifest.tiles.length,
  surfaceContact:
    "Intentional gear contact at nominal ground or selected modeled roof top; 0.02m mesh clearance, ±0.1m GPU tolerance. The 3m building gap excludes supporting surface contact.",
  bodyCentreAboveSurfaceM: bodyCentreAboveSurface,
  roamingOffsetBoundM: ROAM_OFFSET_BOUND_M,
  groundSites: sites.filter((s) => s.kind === "ground").length,
  roofSites: sites.filter((s) => s.kind === "roof").length,
  proofs,
  launchProofs,
};
const output = {
  schemaVersion: 1,
  dataSha256: manifest.dataSha256,
  contentSha256: createHash("sha256")
    .update(JSON.stringify({ missions, sites, validation }))
    .digest("hex"),
  missions,
  sites,
  validation,
  license: "ODbL-1.0",
  scope:
    "30% scheduled launch/target/return trips; 70% seeded roaming groups. Shared preplanned kinematic flight, no live avoidance or drone separation.",
};
const bytes = JSON.stringify(output);
fs.writeFileSync(`${root}/fleet.json`, bytes);
fs.writeFileSync(`${publicRoot}/fleet.json`, bytes);
console.log(
  JSON.stringify({
    ...validation,
    proofs: proofs.length,
    launchProofs: launchProofs.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }),
);
