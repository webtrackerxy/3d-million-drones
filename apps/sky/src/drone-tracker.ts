import * as THREE from "three/webgpu";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { createSelectedRouteLine, SELECTED_ROUTE_COLOR } from "./selected-route.ts";
import { evaluateRoute } from "../../../packages/flight/src/index.ts";
import type { RouteTable, poseAt } from "../../../packages/flight/src/index.ts";
import {
  WORLD_XZ_OFFSETS,
  SCHEDULED_START,
} from "../../../packages/core-types/src/index.ts";
import type { FleetMission } from "../../../packages/city/src/fleet.ts";
import { launchStages } from "../../../packages/city/src/fleet.ts";
import type { LondonOverview } from "./london-scene.ts";
import type { Vec3, Quat } from "../../../packages/core-types/src/index.ts";
import {
  createMapGeography,
  formatDronePosition,
  type MapReference,
} from "./map-geography.ts";

// One selected-ID guide. It never joins the population draw lists or changes simulation.
export function createDroneTracker(
  scene: THREE.Scene,
  overview: LondonOverview,
  reference: MapReference,
) {
  const canvas = document.getElementById("drone-route") as HTMLCanvasElement,
    summary = document.getElementById("drone-route-summary")!,
    context = canvas.getContext("2d")!;
  canvas.width = 640;
  canvas.height = 560;
  const background = document.createElement("canvas");
  background.width = 640;
  background.height = 560;
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = 640;
  labelCanvas.height = 340;
  const labelQuaternion = new THREE.Quaternion(),
    labelEuler = new THREE.Euler(0, 0, 0, "YXZ");
  const geography = createMapGeography(reference);
  const style = getComputedStyle(document.documentElement),
    ink = style.getPropertyValue("--ink").trim() || "#e8edf2",
    muted = style.getPropertyValue("--muted").trim() || "#9aa8b6";
  let flightMode: string | null = null;
  let hasGeography = true,
    labelKey = "";
  let collisionBadge: {
    contacts: number;
    near: number;
    complete: boolean;
  } | null = null;
  const labelContext = labelCanvas.getContext("2d")!;
  function paintLabel(selected: number, position?: Vec3, speedMps = 0, quaternion?: Quat) {
    const line = position
      ? formatDronePosition(position, hasGeography ? geography : undefined)
      : "Position updating…";
    const height = position
      ? `Height ${position[1].toFixed(1)} m (model)`
      : "Height updating…";
    const speed = `Speed ${(Math.max(0, speedMps) * 3.6).toFixed(1)} km/h`;
    let bank = "Roll — · Pitch —", heading = "Yaw —";
    if (quaternion) {
      labelQuaternion.fromArray(quaternion).normalize();
      labelEuler.setFromQuaternion(labelQuaternion, "YXZ");
      const degrees = (radians: number) => {
        const value = THREE.MathUtils.radToDeg(radians);
        return `${(Math.abs(value) < 0.05 ? 0 : value).toFixed(1)}°`;
      };
      bank = `Roll ${degrees(labelEuler.z)} · Pitch ${degrees(labelEuler.x)}`;
      heading = `Yaw ${degrees(labelEuler.y)}`;
    }
    const key = `${selected}|${line}|${height}|${speed}|${bank}|${heading}`;
    if (key === labelKey) return;
    labelKey = key;
    labelContext.clearRect(0, 0, 640, 340);
    labelContext.fillStyle = "#121820";
    labelContext.strokeStyle = "#ef4c43";
    labelContext.lineWidth = 4;
    labelContext.beginPath();
    labelContext.roundRect(3, 3, 634, 334, 14);
    labelContext.fill();
    labelContext.stroke();
    const text = `DRONE #${selected}`;
    let fontSize = 45;
    labelContext.font = `bold ${fontSize}px sans-serif`;
    while (labelContext.measureText(text).width > 590) {
      fontSize--;
      labelContext.font = `bold ${fontSize}px sans-serif`;
    }
    labelContext.textAlign = "center";
    labelContext.fillStyle = ink;
    labelContext.fillText(text, 320, 53);
    labelContext.font = "31px sans-serif";
    labelContext.fillText(line, 320, 108);
    labelContext.font = "32px sans-serif";
    labelContext.fillText(height, 320, 158);
    labelContext.fillText(speed, 320, 210);
    labelContext.font = "30px sans-serif";
    labelContext.fillText(bank, 320, 262);
    labelContext.font = "32px sans-serif";
    labelContext.fillText(heading, 320, 314);
  }
  paintLabel(42);
  const texture = new THREE.CanvasTexture(labelCanvas),
    label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
  label.renderOrder = 1001;
  scene.add(label);
  const routeLine = createSelectedRouteLine();
  const markerGeometry = new THREE.BufferGeometry();
  const markerPosition = new THREE.Float32BufferAttribute([0, 0, 0], 3);
  markerGeometry.setAttribute("position", markerPosition);
  const marker = new THREE.Points(
    markerGeometry,
    new THREE.PointsMaterial({
      color: "#ff493d",
      size: 6,
      sizeAttenuation: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }),
  );
  marker.frustumCulled = false;
  marker.name = "Selected drone path position";
  scene.add(routeLine, marker);
  const point = new THREE.Vector3(),
    up = new THREE.Vector3(),
    forward = new THREE.Vector3();
  let records: Uint32Array,
    table: RouteTable,
    id = 42,
    mission: FleetMission | undefined;
  let project = (x: number, z: number) => [x, z],
    minimumY = 0,
    maximumY = 1,
    lastDraw = -Infinity;
  const trunc = (c: CanvasRenderingContext2D, text: string, width: number) => {
    while (c.measureText(text).width > width && text.length > 3)
      text = text.slice(0, -2) + "…";
    return text;
  };
  function setRoute(
    words: Uint32Array,
    routes: RouteTable,
    selected = 42,
    trip?: FleetMission,
    london = true,
    geographic = london,
  ) {
    records = words;
    table = routes;
    id = selected;
    hasGeography = geographic;
    paintLabel(id);
    texture.needsUpdate = true;
    canvas.setAttribute(
      "aria-label",
      `Drone ${id} route, position and altitude profile`,
    );
    canvas.parentElement!.setAttribute("aria-label", `Drone ${id} route map`);
    mission = trip;
    lastDraw = -Infinity;
    const at = id * 8,
      floats = new Float32Array(words.buffer),
      route = table.routes[words[at]],
      world = Boolean(words[at + 7] & WORLD_XZ_OFFSETS);
    const sampleCount = route.samples.length / 12;
    const routePoints = Array.from({ length: sampleCount }, (_, i) => {
      const s = route.samples[i * 12 + 3],
        p = evaluateRoute(
          route,
          s,
          world ? 0 : floats[at + 5],
          world ? 0 : floats[at + 6],
        ).position;
      if (world) {
        p[0] += floats[at + 5];
        p[2] += floats[at + 6];
      }
      return p;
    });
    routeLine.geometry.dispose();
    routeLine.geometry = new LineGeometry().setPositions(routePoints.flat());
    // Cache a small outline for the inset; the 3D scene uses every packed sample.
    const points = Array.from(
      { length: 513 },
      (_, i) => routePoints[Math.round((i / 512) * (sampleCount - 1))],
    );
    // Closed route endpoint evaluation wraps; preserve the actual final position for open trips.
    const xs = points.map((p) => p[0]),
      zs = points.map((p) => p[2]);
    minimumY = Math.min(...points.map((p) => p[1]));
    maximumY = Math.max(minimumY + 1, ...points.map((p) => p[1]));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
      cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const scale = Math.min(
      252 / Math.max(200, Math.max(...xs) - Math.min(...xs)),
      112 / Math.max(200, Math.max(...zs) - Math.min(...zs)),
    );
    project = (x, z) => [160 + (x - cx) * scale, 108 + (z - cz) * scale];
    const c = background.getContext("2d")!;
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.clearRect(0, 0, 320, 280);
    c.fillStyle = "#121820";
    c.fillRect(0, 0, 320, 280);
    c.fillStyle = ink;
    c.font = "bold 12px sans-serif";
    c.fillText(`DRONE #${id} · ROUTE`, 14, 20);
    c.font = "10px sans-serif";
    c.fillStyle = muted;
    c.fillText(
      trunc(
        c,
        mission?.kind === "launch"
          ? `${mission.from.name} → ${mission.to.name}`
          : mission?.kind === "roam"
            ? `Roaming group ${Number(mission.group) + 1} · ${mission.movement}`
            : "Flight route",
        292,
      ),
      14,
      35,
    );
    c.save();
    c.beginPath();
    c.rect(10, 43, 300, 134);
    c.clip();
    c.fillStyle = "#17212b";
    c.fillRect(10, 43, 300, 134);
    const visible = (x: number, z: number) => {
      const p = project(x, z);
      return p[0] > -20 && p[0] < 340 && p[1] > 20 && p[1] < 200;
    };
    if (london) {
      for (const [kind, rings] of overview.areas) {
        const bounds = rings[0].map((p) => project(p[0], p[1]));
        if (
          Math.max(...bounds.map((p) => p[0])) < 10 ||
          Math.min(...bounds.map((p) => p[0])) > 310 ||
          Math.max(...bounds.map((p) => p[1])) < 43 ||
          Math.min(...bounds.map((p) => p[1])) > 177
        )
          continue;
        c.beginPath();
        for (const r of rings) {
          r.forEach((p, i) => {
            const q = project(p[0], p[1]);
            if (!i) c.moveTo(q[0], q[1]);
            else c.lineTo(q[0], q[1]);
          });
          c.closePath();
        }
        c.fillStyle = kind === "water" ? "#193440" : "#243c34";
        c.fill("evenodd");
      }
      c.lineWidth = 0.65;
      c.strokeStyle = "#465363";
      c.beginPath();
      for (const [, a, b] of overview.roads) {
        if (!visible(a[0], a[1]) && !visible(b[0], b[1])) continue;
        const p = project(a[0], a[1]),
          q = project(b[0], b[1]);
        c.moveTo(p[0], p[1]);
        c.lineTo(q[0], q[1]);
      }
      c.stroke();
    }
    c.beginPath();
    points.forEach((p, i) => {
      const q = project(p[0], p[2]);
      if (i) c.lineTo(q[0], q[1]);
      else c.moveTo(q[0], q[1]);
    });
    c.strokeStyle = "#0b1016";
    c.lineWidth = 8;
    c.stroke();
    c.strokeStyle = SELECTED_ROUTE_COLOR;
    c.lineWidth = 4;
    c.stroke();
    if (mission?.kind === "launch") {
      for (const [site, letter] of [
        [mission.from, "A"],
        [mission.to, "B"],
      ] as const) {
        const q = project(
          site.position[0] + floats[at + 5],
          site.position[2] + floats[at + 6],
        );
        c.fillStyle = letter === "A" ? "#275c6b" : "#34725d";
        c.beginPath();
        c.arc(q[0], q[1], 8, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "white";
        c.font = "bold 9px sans-serif";
        c.textAlign = "center";
        c.fillText(letter, q[0], q[1] + 3);
        c.textAlign = "left";
      }
    }
    c.restore();
    c.font = "bold 9px sans-serif";
    c.fillStyle = ink;
    c.fillText("N ↑", 281, 57);
    c.font = "9px sans-serif";
    c.fillStyle = muted;
    c.fillText("ALTITUDE PROFILE", 14, 195);
    c.fillText(`${maximumY.toFixed(0)} m`, 266, 195);
    c.strokeStyle = "#465363";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(14, 243);
    c.lineTo(306, 243);
    c.stroke();
    c.strokeStyle = SELECTED_ROUTE_COLOR;
    c.lineWidth = 6;
    c.beginPath();
    points.forEach((p, i) => {
      const x = 14 + (i / 512) * 292,
        y = 241 - ((p[1] - minimumY) / (maximumY - minimumY)) * 37;
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.stroke();
    c.font = "8px sans-serif";
    c.fillStyle = muted;
    c.fillText(
      london
        ? "Map © OpenStreetMap contributors · ODbL"
        : "Route plan · north up",
      14,
      274,
    );
  }
  function update(
    camera: THREE.PerspectiveCamera,
    pose: ReturnType<typeof poseAt>,
    timeMs: number,
    now: number,
    speedMps = 0,
  ) {
    point.set(...pose.position);
    markerPosition.setXYZ(0, point.x, point.y, point.z);
    markerPosition.needsUpdate = true;
    const units =
      (2 *
        camera.position.distanceTo(point) *
        Math.tan((camera.fov * Math.PI) / 360)) /
      Math.max(1, innerHeight);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    label.position
      .copy(point)
      .addScaledVector(
        up,
        Math.min(
          Math.max(1.1, units * 15) + units * 73,
          units * innerHeight * 0.32,
        ),
      );
    label.scale.set(units * 230, units * 122, 1);
    if (!records || now - lastDraw < 100) return;
    lastDraw = now;
    const priorKey = labelKey;
    paintLabel(id, pose.position, speedMps, pose.quaternion);
    if (priorKey !== labelKey) texture.needsUpdate = true;
    const at = id * 8,
      floats = new Float32Array(records.buffer),
      route = table.routes[records[at]],
      elapsed =
        records[at + 7] & SCHEDULED_START
          ? Math.max(0, timeMs - records[at + 3]) / 1000
          : ((timeMs - records[at + 3]) >>> 0) / 1000;
    const raw = floats[at + 2] + floats[at + 4] * elapsed,
      s = route.closed
        ? raw % route.length
        : Math.max(0, Math.min(route.length, raw));
    const state = flightMode ?? (
      mission?.kind === "launch"
        ? timeMs < records[at + 3]
          ? "waiting"
          : (launchStages(mission).find((stage) => s <= stage.endS)?.name ??
            "landed")
        : mission?.kind === "roam"
          ? mission.movement + " roaming"
          : "flying");
    context.setTransform(2, 0, 0, 2, 0, 0);
    context.clearRect(0, 0, 320, 280);
    context.drawImage(background, 0, 0, 320, 280);
    if (flightMode) {
      context.fillStyle = "#121820";
      context.fillRect(10, 26, 300, 15);
      context.fillStyle = muted;
      context.font = "10px sans-serif";
      context.fillText(`Planned route · ${flightMode}`, 14, 36);
    }
    if (collisionBadge) {
      context.fillStyle = collisionBadge.contacts ? "#452322" : "#173338";
      context.fillRect(210, 7, 98, 18);
      context.fillStyle = collisionBadge.contacts ? "#ff9388" : ink;
      context.font = "bold 9px sans-serif";
      context.fillText(
        !collisionBadge.complete
          ? "PARTIAL CHECK"
          : collisionBadge.contacts
            ? `${collisionBadge.contacts} CONTACTS`
            : collisionBadge.near
              ? `${collisionBadge.near} NEAR`
              : "NO CONTACTS",
        215,
        20,
      );
    }
    const q = project(point.x, point.z);
    context.strokeStyle = ink;
    context.fillStyle = "#e33d35";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(q[0], q[1], 5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    forward
      .set(0, 0, -1)
      .applyQuaternion(new THREE.Quaternion(...pose.quaternion));
    const direction = Math.atan2(forward.z, forward.x);
    context.beginPath();
    context.moveTo(
      q[0] + Math.cos(direction) * 13,
      q[1] + Math.sin(direction) * 13,
    );
    context.lineTo(
      q[0] + Math.cos(direction + 2.5) * 7,
      q[1] + Math.sin(direction + 2.5) * 7,
    );
    context.lineTo(
      q[0] + Math.cos(direction - 2.5) * 7,
      q[1] + Math.sin(direction - 2.5) * 7,
    );
    context.closePath();
    context.fill();
    context.stroke();
    const px = 14 + (s / route.length) * 292,
      py = 241 - ((point.y - minimumY) / (maximumY - minimumY)) * 37;
    context.beginPath();
    context.arc(px, py, 3, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = ink;
    context.font = "bold 10px sans-serif";
    context.fillText(
      trunc(context, `${state.toUpperCase()} · ${point.y.toFixed(1)} m`, 292),
      14,
      260,
    );
    summary.textContent = `Drone #${id}: ${state}, altitude ${point.y.toFixed(1)} metres. ${mission?.label ?? "Flight route"}. Red drone and label identify #${id}; red map arrow shows its position and heading.`;
  }
  return {
    setRoute,
    update,
    setFlightMode(value: string | null) {
      flightMode = value;
      lastDraw = -Infinity;
    },
    setCollisions(value: typeof collisionBadge) {
      collisionBadge = value;
      lastDraw = -Infinity;
    },
    capture(target: CanvasRenderingContext2D, width: number, height: number) {
      if (canvas.parentElement!.hidden) return;
      const rect = canvas.getBoundingClientRect();
      target.drawImage(
        canvas,
        (rect.left / innerWidth) * width,
        (rect.top / innerHeight) * height,
        (rect.width / innerWidth) * width,
        (rect.height / innerHeight) * height,
      );
    },
  };
}
