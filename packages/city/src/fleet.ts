import {
  hash32,
  RECORD_WORDS,
  SAMPLE_FLOATS,
  SCHEDULED_START,
  WORLD_XZ_OFFSETS,
} from "../../core-types/src/index.ts";
import type { Vec3 } from "../../core-types/src/index.ts";
import { routeTable } from "../../flight/src/index.ts";
import type { Route } from "../../flight/src/index.ts";
import { compileCityRoute } from "./index.ts";
import type { LondonManifest } from "./london.ts";

export const ROAM_LATERAL_M = 18;
export const ROAM_VERTICAL_M = 10;
export const ROAM_OFFSET_BOUND_M = Math.hypot(ROAM_LATERAL_M, ROAM_VERTICAL_M);
export interface LaunchSite {
  id: string;
  name: string;
  kind: "ground" | "roof";
  position: Vec3;
  radiusM: number;
  sourceIds: string[];
  surfaceHeightM: number;
  supportIds: string[];
}
export interface RoamMission {
  kind: "roam";
  movement: "vertical" | "wandering";
  label: string;
  group: string;
  waypoints: Vec3[];
  spacing: number;
  speed: number;
}
export interface LaunchMission {
  kind: "launch";
  label: string;
  from: LaunchSite;
  to: LaunchSite;
  cruiseAltitudeM: number;
  cruiseSpeedMps: number;
  climbSpeedMps: number;
  groundHoldS: number;
  repeat: boolean;
}
export type FleetMission = RoamMission | LaunchMission;
export interface FleetBundle {
  schemaVersion: number;
  dataSha256: string;
  contentSha256: string;
  missions: FleetMission[];
  sites: LaunchSite[];
  validation: {
    passed: boolean;
    validatedSegments: number;
    roamingGroups: number;
    roamingRoutes: number;
    launchRoutes: number;
    minimumModelGapM: number;
    requiredMarginM: number;
    gpuToleranceM: number;
    surfaceContact: string;
    sourceTileCount: number;
    [key: string]: unknown;
  };
}
const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export interface LaunchStage {
  name: string;
  startS: number;
  endS: number;
  a: Vec3;
  b: Vec3;
  headingA: number;
  headingB: number;
}
export function launchStages(m: LaunchMission): LaunchStage[] {
  const stages: LaunchStage[] = [],
    angle = Math.atan2(
      m.to.position[0] - m.from.position[0],
      m.to.position[2] - m.from.position[2],
    );
  const leg = (
    name: string,
    a: Vec3,
    b: Vec3,
    seconds: number,
    headingA: number,
    headingB = headingA,
  ) => {
    const startS = stages.at(-1)?.endS ?? 0;
    stages.push({
      name,
      startS,
      endS: startS + seconds,
      a,
      b,
      headingA,
      headingB,
    });
  };
  const trip = (
    a: LaunchSite,
    b: LaunchSite,
    height: number,
    heading: number,
  ) => {
    const highA: [number, number, number] = [
        a.position[0],
        height,
        a.position[2],
      ],
      highB: [number, number, number] = [b.position[0], height, b.position[2]];
    leg(
      "takeoff",
      a.position,
      highA,
      (1.875 * (height - a.position[1])) / m.climbSpeedMps,
      heading,
    );
    leg(
      "travel",
      highA,
      highB,
      (1.875 *
        Math.hypot(
          b.position[0] - a.position[0],
          b.position[2] - a.position[2],
        )) /
        m.cruiseSpeedMps,
      heading,
    );
    leg(
      "landing",
      highB,
      b.position,
      (1.875 * (height - b.position[1])) / m.climbSpeedMps,
      heading,
    );
  };
  leg("waiting", m.from.position, m.from.position, m.groundHoldS, angle);
  trip(m.from, m.to, m.cruiseAltitudeM, angle);
  if (m.repeat) {
    leg(
      "destination stop",
      m.to.position,
      m.to.position,
      m.groundHoldS,
      angle,
      angle + Math.PI,
    );
    trip(m.to, m.from, m.cruiseAltitudeM + 25, angle + Math.PI);
    leg(
      "home stop",
      m.from.position,
      m.from.position,
      m.groundHoldS,
      angle + Math.PI,
      angle + Math.PI * 2,
    );
  }
  return stages;
}
// Uniform timetable samples use one virtual metre per second, preserving the existing
// constant-time sample lookup and 48-byte sample format. Holds and vertical moves have
// an explicit horizontal attitude; no zero tangent or one-frame landing teleport.
export function compileLaunchRoute(m: LaunchMission): Route {
  if (
    ![
      ...m.from.position,
      ...m.to.position,
      m.cruiseAltitudeM,
      m.cruiseSpeedMps,
      m.climbSpeedMps,
      m.groundHoldS,
    ].every(Number.isFinite) ||
    m.cruiseSpeedMps < 4 ||
    m.cruiseSpeedMps > 24 ||
    m.climbSpeedMps < 1 ||
    m.climbSpeedMps > 10 ||
    m.groundHoldS < 1 ||
    m.cruiseAltitudeM <= Math.max(m.from.position[1], m.to.position[1]) + 10 ||
    Math.hypot(
      m.from.position[0] - m.to.position[0],
      m.from.position[2] - m.to.position[2],
    ) < 100
  )
    throw new Error("Invalid launch mission");
  const stages = launchStages(m),
    duration = stages.at(-1)!.endS,
    intervals = Math.ceil(duration / 0.5),
    spacing = duration / intervals,
    samples = new Float32Array((intervals + 1) * SAMPLE_FLOATS);
  let stage = 0;
  for (let i = 0; i <= intervals; i++) {
    const time = i * spacing;
    while (stage < stages.length - 1 && time > stages[stage].endS) stage++;
    const s = stages[stage],
      t = smooth((time - s.startS) / (s.endS - s.startS)),
      heading = s.headingA + (s.headingB - s.headingA) * t,
      fx = Math.sin(heading),
      fz = Math.cos(heading);
    samples.set(
      [
        s.a[0] + (s.b[0] - s.a[0]) * t,
        s.a[1] + (s.b[1] - s.a[1]) * t,
        s.a[2] + (s.b[2] - s.a[2]) * t,
        time,
        fx,
        0,
        fz,
        1,
        -fz,
        0,
        fx,
        -1,
      ],
      i * SAMPLE_FLOATS,
    );
  }
  if (m.repeat) {
    samples.set(samples.subarray(0, 3), intervals * SAMPLE_FLOATS);
    samples.set(samples.subarray(4, 7), intervals * SAMPLE_FLOATS + 4);
    samples.set(samples.subarray(8, 11), intervals * SAMPLE_FLOATS + 8);
  }
  return {
    samples,
    length: samples[intervals * SAMPLE_FLOATS + 3],
    spacing: Math.fround(spacing),
    closed: m.repeat,
    speed: 1,
  };
}
export function compileFleetMission(m: FleetMission) {
  if (m.kind === "launch") return compileLaunchRoute(m);
  if (
    m.kind !== "roam" ||
    !Number.isFinite(m.speed) ||
    m.speed < 4 ||
    m.speed > 24 ||
    !Number.isFinite(m.spacing) ||
    m.spacing < 1 ||
    m.spacing > 8
  )
    throw new Error("Invalid roaming mission");
  return compileCityRoute({ ...m, kind: "sky" }, m.spacing, true);
}
export function londonFleet(manifest: LondonManifest, bundle: FleetBundle) {
  if (
    manifest.region !== "greater-london" ||
    bundle.schemaVersion !== 1 ||
    bundle.dataSha256 !== manifest.dataSha256 ||
    !bundle.validation.passed ||
    !/^[a-f0-9]{64}$/.test(bundle.contentSha256) ||
    !bundle.missions.some((m) => m.kind === "launch") ||
    !bundle.missions.some((m) => m.kind === "roam")
  )
    throw new Error("London fleet/model mismatch");
  const table = routeTable(bundle.missions.map(compileFleetMission));
  if (
    bundle.validation.validatedSegments !==
    table.routes.reduce((s, r) => s + r.samples.length / 12 - 1, 0)
  )
    throw new Error("London fleet proof/sample mismatch");
  let minY = Infinity,
    maxY = -Infinity;
  for (let at = 0; at < table.samples.length; at += 12) {
    minY = Math.min(minY, table.samples[at + 1]);
    maxY = Math.max(maxY, table.samples[at + 1]);
  }
  return {
    table,
    missions: bundle.missions,
    sites: bundle.sites,
    clearance: {
      ...bundle.validation,
      obstacleSha256: manifest.dataSha256,
      fleetSha256: bundle.contentSha256,
      minimumRouteAltitudeM: minY,
      maximumRouteAltitudeM: maxY,
      maxRoofM: manifest.maxRoofM,
      method:
        "Offline swept building-prism checks, source surface containment and high cruise above the complete modeled roof envelope; independent of visual tile residency.",
      scope:
        "Model-only building clearance with intentional ground/roof contact at validated demo pads. No terrain, tree/crowd survey, traffic separation, live avoidance or real flight-site permission.",
    },
  };
}
export function londonDescriptors(
  count: number,
  scenario: ReturnType<typeof londonFleet>,
  seed = 7,
) {
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000)
    throw new Error("Invalid population");
  const launches: number[] = [],
    roaming: number[] = [];
  scenario.missions.forEach((m, i) =>
    (m.kind === "launch" ? launches : roaming).push(i),
  );
  if (!launches.length || !roaming.length)
    throw new Error("Missing fleet cohort");
  const words = new Uint32Array(count * RECORD_WORDS),
    floats = new Float32Array(words.buffer);
  for (let id = 0; id < count; id++) {
    const at = id * RECORD_WORDS,
      random = hash32(id ^ seed),
      phase = hash32(random ^ 0x19d357ab),
      launch = id % 10 < 3;
    const route = launch
        ? launches[(Math.floor(id / 10) * 3 + (id % 10)) % launches.length]
        : roaming[random % roaming.length],
      m = scenario.missions[route];
    words[at] = route;
    words[at + 1] = random;
    if (m.kind === "launch") {
      const angle = (phase / 4294967296) * Math.PI * 2,
        r =
          Math.sqrt(hash32(random ^ 0x7721) / 4294967296) *
          Math.min(m.from.radiusM, m.to.radiusM);
      floats[at + 4] = 1;
      floats[at + 5] = Math.cos(angle) * r;
      floats[at + 6] = Math.sin(angle) * r;
      words[at + 3] = Math.floor(
        (hash32(random ^ 0x5a17ec9b) / 4294967296) * 120000,
      );
      words[at + 7] = WORLD_XZ_OFFSETS | SCHEDULED_START;
    } else {
      const groupPhase = hash32(Number(m.group) ^ seed) / 4294967296;
      floats[at + 2] =
        ((groupPhase + (phase / 4294967296 - 0.5) * 0.16 + 1) % 1) *
        scenario.table.routes[route].length;
      floats[at + 4] =
        scenario.table.routes[route].speed *
        (0.985 + 0.03 * (hash32(random ^ 0x5a17ec9b) / 4294967296));
      floats[at + 5] = (((phase >>> 8) % 2001) / 1000 - 1) * ROAM_LATERAL_M;
      floats[at + 6] = (((phase >>> 18) % 1001) / 500 - 1) * ROAM_VERTICAL_M;
    }
  }
  return words;
}
