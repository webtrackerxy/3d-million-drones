import type { Vec3 } from "../../core-types/src/index.ts";
import { routeTable } from "../../flight/src/index.ts";
import { compileCityRoute, OFFSET_BOUND_M } from "./index.ts";
import type { Mission } from "./index.ts";
export interface LondonTile {
  key: string;
  x: number;
  z: number;
  file: string;
  bytes: number;
  sha256: string;
  buildings: number;
  roads: number;
  areas: number;
}
export interface LondonManifest {
  schemaVersion: number;
  region: string;
  origin: { crs: string; easting: number; northing: number };
  tileSizeM: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  tiles: LondonTile[];
  dataSha256: string;
  maxRoofM: number;
  statistics: { uniqueBuildings: number; roadWays: number };
}
export interface LondonMission extends Mission {
  spacing: number;
  sector: string;
}
export interface LondonNavigation {
  schemaVersion: number;
  dataSha256: string;
  missions: LondonMission[];
  validation: {
    passed: boolean;
    validatedSegments: number;
    streetRoutes: number;
    skyRoutes: number;
    sectors: number;
    gpuToleranceM: number;
    minimumModelGapM: number;
    requiredMarginM: number;
  };
}
export function londonScenario(
  manifest: LondonManifest,
  nav: LondonNavigation,
) {
  if (
    manifest.region !== "greater-london" ||
    manifest.schemaVersion !== 1 ||
    nav.schemaVersion !== 1 ||
    nav.dataSha256 !== manifest.dataSha256 ||
    !nav.validation.passed ||
    !nav.missions.length
  )
    throw new Error("London navigation/model mismatch");
  const routes = nav.missions.map((m) => {
    if (
      !["street", "sky"].includes(m.kind) ||
      !Number.isFinite(m.speed) ||
      m.speed < 4 ||
      m.speed > 24 ||
      !m.waypoints.every((p) => p.length === 3 && p.every(Number.isFinite)) ||
      !(m.spacing >= 1 && m.spacing <= 8)
    )
      throw new Error("Invalid London trip");
    return compileCityRoute(m, m.spacing);
  });
  let minimum = Infinity,
    maximum = -Infinity;
  for (const route of routes)
    for (let at = 0; at < route.samples.length; at += 12) {
      minimum = Math.min(minimum, route.samples[at + 1]);
      maximum = Math.max(maximum, route.samples[at + 1]);
    }
  return {
    table: routeTable(routes),
    missions: nav.missions,
    clearance: {
      ...nav.validation,
      obstacleSha256: manifest.dataSha256,
      method:
        "Offline swept-prism validation against hashed sector tiles; inter-district sky links above the complete model roof envelope. Obstacle validation independent of render residency.",
      maxRoofM: manifest.maxRoofM,
      minimumRouteAltitudeM: minimum,
      maximumRouteAltitudeM: maximum,
      offsetBoundM: OFFSET_BOUND_M,
      droneRadiusM: 1.027,
      minimumIsCertifiedLowerBound: true,
      withinRegion: true,
      scope:
        "Mapped flat-ground model only; no terrain survey, live avoidance, traffic separation or real-world airspace claim.",
    },
  };
}

// Bounded deterministic selection, independent of simulation ownership and active IDs.
export function planLondonTiles(
  tiles: LondonTile[],
  focus: Vec3,
  maxResident = 32,
) {
  return tiles
    .map((t) => ({
      key: t.key,
      distance: Math.hypot(
        (t.x + 0.5) * 1024 - focus[0],
        (t.z + 0.5) * 1024 - focus[2],
      ),
    }))
    .filter(
      (t) => t.distance < Math.max(1700, Math.min(4500, focus[1] * 2 + 1800)),
    )
    .sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key))
    .slice(0, maxResident)
    .map((t) => t.key);
}
