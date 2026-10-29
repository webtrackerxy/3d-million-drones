import type { Vec3 } from "../../core-types/src/index.ts";
import { buildRoute, routeTable } from "../../flight/src/index.ts";

import type { CityData, CityManifest } from "./types.ts";
export type { Building, CityData, CityManifest } from "./types.ts";
import { obstacleIndex } from "./obstacles.ts";
import {
  hash32,
  RECORD_WORDS,
  SAMPLE_FLOATS,
} from "../../core-types/src/index.ts";
export const LATERAL_OFFSET_M = 1.2;
export const VERTICAL_OFFSET_M = 0.6;
export const OFFSET_BOUND_M = Math.hypot(LATERAL_OFFSET_M, VERTICAL_OFFSET_M);
export const GPU_TOLERANCE_M = 0.02;
export const CLEARANCE_MARGIN_M = 3;
export function gridToLocal(
  easting: number,
  northing: number,
  height: number,
  origin: CityManifest["origin"],
): Vec3 {
  return [easting - origin.easting, height, origin.northing - northing];
}
export function localToGrid([x, y, z]: Vec3, origin: CityManifest["origin"]) {
  return {
    easting: origin.easting + x,
    northing: origin.northing - z,
    height: y,
  };
}
export function validateCity(data: CityData, manifest: CityManifest) {
  if (
    data.schemaVersion !== 1 ||
    manifest.schemaVersion !== 1 ||
    data.region !== manifest.region ||
    manifest.origin.crs !== "EPSG:27700"
  )
    throw new Error("Unsupported city frame");
  if (!data.buildings.length || data.buildings.length !== manifest.buildings)
    throw new Error("Missing city obstacles");
  const bounds = manifest.localBoundsM;
  if (
    ![
      ...Object.values(bounds),
      manifest.maxRoofM,
      manifest.origin.easting,
      manifest.origin.northing,
    ].every(Number.isFinite)
  )
    throw new Error("Invalid city extent");
  if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ)
    throw new Error("Empty city extent");
  for (const b of data.buildings) {
    if (
      ![b.base, b.top].every(Number.isFinite) ||
      b.base > b.top ||
      b.top > manifest.maxRoofM ||
      b.ring.length < 3 ||
      b.ring.some((p) => p.length !== 2 || !p.every(Number.isFinite))
    )
      throw new Error(`Invalid obstacle ${b.osmId}`);
  }
  return {
    obstacles: data.buildings.length,
    maxRoofM: manifest.maxRoofM,
    obstacleSha256: manifest.data.sha256,
  };
}

export interface RoadData {
  nodes: number[][];
  edges: number[][];
  source: { sha256: string };
}
export interface Mission {
  kind: "street" | "sky";
  waypoints: Vec3[];
  speed: number;
  label: string;
}
export interface NavigationBundle {
  schemaVersion: number;
  obstacleSha256: string;
  roadsSha256: string;
  sampleSpacingM: number;
  missions: Mission[];
}
export function compileCityRoute(
  mission: Mission,
  spacing = 1.5,
  allowVerticalLegs = false,
) {
  const route = buildRoute(mission.waypoints, true, spacing, mission.speed);
  let heading: [number, number] | undefined;
  if (allowVerticalLegs)
    for (let at = 0; at < route.samples.length; at += SAMPLE_FLOATS) {
      const x = route.samples[at + 4],
        z = route.samples[at + 6],
        length = Math.hypot(x, z);
      if (length >= 1e-5) {
        heading = [x / length, z / length];
        break;
      }
    }
  // A quadcopter climbs by translating vertically while its body keeps a level
  // heading. Reusing the transported 3D route frame here would roll the aircraft
  // through the low parts of a climb/cross/descend loop.
  for (let at = 0; at < route.samples.length; at += SAMPLE_FLOATS) {
    const x = route.samples[at + 4],
      z = route.samples[at + 6],
      length = Math.hypot(x, z);
    if (length >= 1e-5) heading = [x / length, z / length];
    else if (!allowVerticalLegs || !heading)
      throw new Error("City trip needs a horizontal heading");
    route.samples.set([heading![0], 0, heading![1]], at + 4);
    route.samples.set([-heading![1], 0, heading![0]], at + 8);
  }
  return route;
}

export function cityScenario(
  data: CityData,
  manifest: CityManifest,
  droneRadius: number,
  navigation: NavigationBundle,
) {
  const obstacles = validateCity(data, manifest);
  if (!(droneRadius > 0) || !Number.isFinite(droneRadius))
    throw new Error("Invalid swept drone radius");
  if (
    navigation.schemaVersion !== 1 ||
    navigation.obstacleSha256 !== manifest.data.sha256 ||
    navigation.sampleSpacingM !== 1.5 ||
    !navigation.missions.length
  )
    throw new Error("Navigation data does not match obstacles");
  const index = obstacleIndex(data),
    radius =
      droneRadius + OFFSET_BOUND_M + GPU_TOLERANCE_M + CLEARANCE_MARGIN_M;
  let minimumY = Infinity,
    maximumY = -Infinity,
    segments = 0;
  const bounds = manifest.localBoundsM;
  const routes = navigation.missions.map((mission) => {
    if (
      !["street", "sky"].includes(mission.kind) ||
      typeof mission.speed !== "number" ||
      !(mission.speed >= 4 && mission.speed <= 24) ||
      !Array.isArray(mission.waypoints) ||
      mission.waypoints.some(
        (p) => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite),
      )
    )
      throw new Error("Invalid city mission");
    const route = compileCityRoute(mission, navigation.sampleSpacingM);
    for (let at = 0; at < route.samples.length; at += SAMPLE_FLOATS) {
      const p = Array.from(route.samples.slice(at, at + 3)) as Vec3;
      minimumY = Math.min(minimumY, p[1]);
      maximumY = Math.max(maximumY, p[1]);
      if (
        p[0] - radius < bounds.minX ||
        p[0] + radius > bounds.maxX ||
        p[2] - radius < bounds.minZ ||
        p[2] + radius > bounds.maxZ
      )
        throw new Error("City route outside validated region");
      if (at) {
        const previous = Array.from(
          route.samples.slice(at - SAMPLE_FLOATS, at - SAMPLE_FLOATS + 3),
        ) as Vec3;
        if (index.blocked(previous, p, radius))
          throw new Error(
            `City route intersects expanded obstacle: ${mission.label}`,
          );
        segments++;
      }
    }
    return route;
  });
  if (
    !navigation.missions.some((m) => m.kind === "street") ||
    !navigation.missions.some((m) => m.kind === "sky")
  )
    throw new Error("Missing city traffic layer");
  return {
    table: routeTable(routes),
    missions: navigation.missions,
    clearance: {
      ...obstacles,
      roadsSha256: navigation.roadsSha256,
      method:
        "Every packed route segment checked against footprint prisms expanded by swept drone radius, descriptor offset sphere, GPU tolerance and margin; nominal ground and region bounds checked",
      minimumRouteAltitudeM: minimumY,
      maximumRouteAltitudeM: maximumY,
      offsetBoundM: OFFSET_BOUND_M,
      droneRadiusM: droneRadius,
      gpuToleranceM: GPU_TOLERANCE_M,
      minimumModelGapM: CLEARANCE_MARGIN_M,
      requiredMarginM: CLEARANCE_MARGIN_M,
      minimumIsCertifiedLowerBound: true,
      validatedSegments: segments,
      streetRoutes: navigation.missions.filter((m) => m.kind === "street")
        .length,
      skyRoutes: navigation.missions.filter((m) => m.kind === "sky").length,
      withinRegion: true,
      passed: true,
      scope:
        "Model-only swept obstacle clearance. Road-guided prerecorded trips, not live avoidance. Terrain, drone separation and real airspace unvalidated.",
    },
  };
}

// Identity, phase and cruise speed vary independently. Offsets stay inside the certified tube.
// Route selection is length weighted within each layer: 70% street, 30% climb/sky/descend trips.
export function cityDescriptors(
  count: number,
  scenario: { table: ReturnType<typeof routeTable>; missions: Mission[] },
  seed = 7,
) {
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000)
    throw new Error("Invalid population");
  const groups = ["street", "sky"].map((kind) => {
    let total = 0;
    const entries = scenario.missions.flatMap((m, i) =>
      m.kind === kind
        ? [{ id: i, end: (total += scenario.table.routes[i].length) }]
        : [],
    );
    return { entries, total };
  });
  const words = new Uint32Array(count * RECORD_WORDS),
    floats = new Float32Array(words.buffer);
  for (let id = 0; id < count; id++) {
    const random = hash32(id ^ seed),
      phase = hash32(random ^ 0x19d357ab),
      speed = hash32(random ^ 0x5a17ec9b);
    const group = groups[random % 10 < 7 ? 0 : 1],
      distance = (hash32(random ^ 0x748e2a3d) / 4294967296) * group.total;
    let low = 0,
      high = group.entries.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (distance < group.entries[mid].end) high = mid;
      else low = mid + 1;
    }
    const route = group.entries[low].id,
      at = id * RECORD_WORDS;
    words[at] = route;
    words[at + 1] = random;
    floats[at + 2] = (phase / 4294967296) * scenario.table.routes[route].length;
    floats[at + 4] =
      scenario.table.routes[route].speed * (0.82 + 0.36 * (speed / 4294967296));
    floats[at + 5] = ((((phase >>> 8) % 21) - 10) * LATERAL_OFFSET_M) / 10;
    floats[at + 6] = ((((phase >>> 16) % 11) - 5) * VERTICAL_OFFSET_M) / 5;
  }
  return words;
}
