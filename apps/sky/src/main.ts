import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  skyRoutes,
  descriptors,
  poseAt,
  SimulationClock,
  buildRoute,
  routeTable,
  evaluateRoute,
} from "../../../packages/flight/src/index.ts";
import { createDroneRenderer } from "../../../packages/render/src/index.ts";
import { summary } from "../../../packages/metrics/src/index.ts";
import type { Vec3 } from "../../../packages/core-types/src/index.ts";
import {
  cityScenario,
  cityDescriptors,
  type NavigationBundle,
} from "../../../packages/city/src/index.ts";
import { createLondonScene, type LondonOverview } from "./london-scene.ts";
import { type LondonManifest } from "../../../packages/city/src/london.ts";
import {
  londonFleet,
  londonDescriptors,
  launchStages,
  type FleetBundle,
} from "../../../packages/city/src/fleet.ts";
import londonManifest from "../../../assets/city/london/manifest.json";
import londonOverview from "../../../assets/city/london/overview.json";
import fleetData from "../../../assets/city/london/fleet.json";
import { createCityScene } from "./city-scene.ts";
import cityData from "../../../assets/city/canary-wharf/buildings.json";
import navigation from "../../../assets/city/canary-wharf/navigation.json";
import roads from "../../../assets/city/canary-wharf/roads.json";
import cityManifest from "../../../assets/city/canary-wharf/manifest.json";
import prepared from "../../../assets/drones/prepared/scifi-drone.json";
import { createDroneTracker } from "./drone-tracker.ts";
import { setupGuidePages } from "./guide-pages.ts";
import { createGamepadController } from "./gamepad-controller.ts";
import { combinePilotInputs, idlePilotInput } from "../../../packages/flight/src/gamepad.ts";
import { DRONE_TYPES, droneType, droneTypeCounts } from "../../../packages/core-types/src/drone-types.ts";
import { createMapGeography } from "./map-geography.ts";
import { createGoogleCity, type GoogleMapState } from "./google-city.ts";
import googleLogo from "../../../assets/maps/google/logo.json";
import {
  createCollisionMonitor,
  type CollisionStats,
  type CollisionScope,
} from "../../../packages/render/src/collisions.ts";
import {
  COLLISION_FIXTURE,
  referenceContacts,
} from "../../../packages/flight/src/collision-reference.ts";
import {
  beginPilot, stepPilot, pilotInput, syncPilotInput, levelPilot, brakePilot, beginReturn, stepReturn,
  type PilotState, type ReturnState, type FlightPose,
} from "../../../packages/flight/src/manual.ts";

const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const status = (text: string) => {
  el("status").textContent = text;
};
const errors: string[] = [];
window.addEventListener("error", (event) => {
  errors.push(event.message);
  status(event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  errors.push(String(event.reason));
  status(String(event.reason));
});
const clock = new SimulationClock(),
  scene = new THREE.Scene();
let table = skyRoutes();
type SceneId = "city" | "sky" | "london";
let sceneId: SceneId = "sky";
let london: ReturnType<typeof londonFleet> | undefined;
let londonMap: ReturnType<typeof createLondonScene> | undefined;
let city: ReturnType<typeof cityScenario> | undefined;
let cityVisual: ReturnType<typeof createCityScene> | undefined;
let tracker: ReturnType<typeof createDroneTracker> | undefined;
let gamepadController: ReturnType<typeof createGamepadController> | undefined;
let googleCity: ReturnType<typeof createGoogleCity> | undefined;
let googleState: GoogleMapState = "local";
let collisionMonitor: ReturnType<typeof createCollisionMonitor> | undefined,
  collisionBusy = false,
  lastCollisionTime = -Infinity;
let collisionStats: CollisionStats | null = null;
let trackedId = 42,
  picking = false;
let pilot: PilotState | undefined,
  returning: ReturnState | undefined,
  poseOverride: ({ id: number } & FlightPose) | null = null;
const followPoint = new THREE.Vector3(),
  followShift = new THREE.Vector3();
const pickRay = new THREE.Raycaster();
const skyVisual = new THREE.Group();
scene.background = new THREE.Color("#e4eceb");
scene.fog = new THREE.FogExp2("#e4eceb", 0.00022);
const camera = new THREE.PerspectiveCamera(
  50,
  innerWidth / innerHeight,
  0.1,
  15000,
);
let renderer: THREE.WebGPURenderer,
  device: GPUDevice,
  controls: OrbitControls,
  gpu: ReturnType<typeof createDroneRenderer>;
let count = 10000,
  words = descriptors(count, table, 7),
  mode = "orbit",
  testing = false,
  reading = false,
  last = 0,
  lastStats = 0,
  lastPitchUi = -Infinity;
let report: Record<string, unknown> | null = null;
let frameTimes: number[] = [],
  encodingTimes: number[] = [],
  adapterInfo: Record<string, unknown> = {};
let lastCounts = new Uint32Array(5);
let cancelBenchmark = false;
const keys = new Set<string>(),
  pointer = { down: false, x: 0, y: 0, startX: 0, startY: 0, dragged: false };
const eye = new THREE.Euler(0, 0, 0, "YXZ");
const options = new URLSearchParams(location.search);
// Public browser token, configured like Million Robots; never read another checkout's env.
const configuredIonToken = (import.meta.env.VITE_CESIUM_ION_TOKEN ?? "").trim();

function setPanelOpen(value: boolean) {
  el("panel-body").hidden = !value;
  const toggle = el<HTMLButtonElement>("panel-toggle");
  toggle.setAttribute("aria-expanded", String(value));
  toggle.setAttribute("aria-label", value ? "Collapse panel" : "Expand panel");
}
function setupPanel() {
  const compact = window.matchMedia("(max-width: 640px)"),
    toggle = el<HTMLButtonElement>("panel-toggle"),
    body = el("panel-body");
  setPanelOpen(!compact.matches);
  toggle.addEventListener("click", () => setPanelOpen(Boolean(body.hidden)));
  compact.addEventListener("change", () => setPanelOpen(!compact.matches));

}

function viewport() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
function configureOrbit(follow = false) {
  controls.enablePan = !follow;
  controls.minDistance = 2;
  controls.maxDistance = follow ? 200 : sceneId === "london" ? 120000 : 5000;
  setMapDrag(false);
}
function setMapDrag(pan: boolean) {
  controls.mouseButtons.LEFT = pan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  renderer.domElement.style.cursor = pan ? "grab" : "";
  el("pan").setAttribute("aria-pressed", String(pan));
  el("orbit-drag").setAttribute("aria-pressed", String(!pan));
}
function leaveFreeCamera() {
  if (mode !== "free") return;
  // OrbitControls' old target can be behind the free camera's current heading.
  const distance = Math.max(2, camera.position.distanceTo(controls.target));
  camera.getWorldDirection(followPoint);
  controls.target.copy(camera.position).addScaledVector(followPoint, distance);
  mode = "orbit";
}
function selectedPose() {
  return poseOverride?.id === trackedId
    ? poseOverride
    : poseAt(words, table, trackedId, Math.floor(clock.timeMs));
}
function selectedVelocityMps(): Vec3 {
  if (pilot?.id === trackedId) return [...pilot.velocity];
  const time = Math.floor(clock.timeMs), seconds = 0.05;
  const current = selectedPose().position;
  const route = poseAt(words, table, trackedId, time + seconds * 1000);
  const next = returning?.id === trackedId ? stepReturn(returning, route, seconds).pose.position : route.position;
  return next.map((v, i) => (v - current[i]) / seconds) as Vec3;
}
function selectedSpeedMps() {
  return Math.hypot(...selectedVelocityMps());
}
function closeDroneMenu() {
  el("drone-context-menu").hidden = true;
}
function clearKeys() {
  keys.clear();
  gamepadController?.reset();
  if (pilot) pilot = brakePilot(syncPilotInput(pilot, pilotInput(keys)));
}
function currentPilotInput() {
  return combinePilotInputs(pilotInput(keys), gamepadController?.input() ?? idlePilotInput());
}
function syncPitchUi() {
  const q = poseOverride?.quaternion;
  const degrees = q ? Math.asin(Math.max(-1, Math.min(1, 2 * (q[3] * q[0] - q[1] * q[2])))) * 180 / Math.PI : 0;
  el("manual-pitch").textContent = `${degrees > 0 ? "+" : ""}${degrees.toFixed(1)}°`;
}
function levelPitch() {
  if (!pilot || testing) return;
  pilot = levelPilot(pilot);
}
function brakeControl() {
  if (!pilot || testing) return;
  clearKeys();
  renderer.domElement.focus({ preventScroll: true });
}
function syncPilotUi() {
  const active = poseOverride !== null;
  el("manual-controls").hidden = !active;
  el("manual-status").textContent = returning
    ? `Drone #${returning.id} · returning to its planned route`
    : pilot ? `Drone #${pilot.id} · manual control` : "Autopilot";
  el<HTMLButtonElement>("release-control").disabled = testing || !pilot;
  el<HTMLButtonElement>("brake-control").disabled = testing || !pilot;
  const anotherReturning = returning !== undefined && returning.id !== trackedId;
  el<HTMLButtonElement>("context-control").disabled = testing || anotherReturning;
  el("context-control").title = anotherReturning ? `Drone #${returning!.id} is returning. Control becomes available when it reaches its route.` : "Control this drone";
  el<HTMLButtonElement>("free").disabled = testing || active;
  el("context-control").textContent = pilot ? "Return to route" : "Take control";
  tracker?.setFlightMode(pilot?.id === trackedId ? "manual control" : returning?.id === trackedId ? "returning to route" : null);
  syncPitchUi();
}
function clearPilot() {
  pilot = undefined;
  returning = undefined;
  poseOverride = null;
  gpu?.setPoseOverride(null);
  clearKeys();
  closeDroneMenu();
  syncPilotUi();
}
function takeControl() {
  if (testing || pilot || (returning && returning.id !== trackedId)) return;
  const pose = selectedPose(), velocity = selectedVelocityMps();
  clearKeys();
  pilot = beginPilot(trackedId, pose, velocity);
  returning = undefined;
  poseOverride = { id: trackedId, position: pilot.position, quaternion: pilot.quaternion };
  gpu.setPoseOverride(poseOverride);
  closeDroneMenu();
  view("follow");
  syncPilotUi();
  setPanelOpen(true);
  el("control-panel").scrollTop = 0;
  renderer.domElement.focus({ preventScroll: true });
  status(`Controlling drone #${trackedId} · WASD move · E/Space up · Q/C down · Esc return`);
}
function returnToRoute() {
  if (!pilot) return;
  returning = beginReturn(pilot, poseAt(words, table, pilot.id, Math.floor(clock.timeMs)));
  pilot = undefined;
  clearKeys();
  closeDroneMenu();
  syncPilotUi();
  renderer.domElement.focus({ preventScroll: true });
  status(`Drone #${returning.id} returning smoothly to its planned route`);
}
function advancePilot(seconds: number) {
  if (pilot) {
    const input = currentPilotInput();
    pilot = stepPilot(syncPilotInput(pilot, input), input, seconds);
    poseOverride = { id: pilot.id, position: pilot.position, quaternion: pilot.quaternion };
  } else if (returning) {
    const result = stepReturn(returning, poseAt(words, table, returning.id, Math.floor(clock.timeMs)), seconds);
    returning = result.state;
    poseOverride = { id: returning.id, ...result.pose };
    if (result.done) {
      const id = returning.id;
      clearPilot();
      status(`Drone #${id} back on autopilot`);
    }
  }
}
function syncGoogleControls() {
  const connected = googleCity?.isConnected() ?? false,
    web = ["http:", "https:"].includes(location.protocol);
  el("google-config-note").textContent = !web
    ? "Photo needs an HTTP/HTTPS preview. Local London works offline."
    : configuredIonToken
      ? "Google photorealistic 3D, like Million Robots."
      : "Photo is unavailable in this build. Local London is ready.";
  el("google-connect").setAttribute("aria-pressed", String(connected));
  el("google-local").setAttribute("aria-pressed", String(!connected));
  el<HTMLButtonElement>("google-connect").disabled =
    testing || connected || !web || !configuredIonToken;
  el<HTMLButtonElement>("google-local").disabled = testing || !connected;
  if (!testing) {
    el<HTMLInputElement>("buildings").disabled = sceneId === "sky" || connected;
    el<HTMLInputElement>("basemap").disabled =
      sceneId !== "london" || connected;
    for (const id of ["check", "city-bench", "bench", "capture"])
      el<HTMLButtonElement>(id).disabled = connected;
    el<HTMLButtonElement>("export").disabled = connected || report === null;
  }
}
function view(preset: string) {
  camera.far = sceneId === "london" ? 180000 : 15000;
  camera.near = sceneId === "london" && preset === "overview" ? 30 : 0.2;
  camera.fov = sceneId !== "sky" && preset === "among" ? 65 : 50;
  camera.updateProjectionMatrix();
  mode = "orbit";
  controls.enabled = true;
  configureOrbit();
  if (preset === "overview") {
    camera.position.set(
      ...((sceneId === "london"
        ? [-4000, 46000, 50000]
        : sceneId === "city"
          ? [1350, 1150, 1650]
          : [0, 1000, 1600]) as Vec3),
    );
    controls.target.set(
      sceneId === "london" ? -4000 : 0,
      sceneId === "london" ? 0 : sceneId === "city" ? 140 : 210,
      0,
    );
  } else if (preset === "among") {
    if (sceneId !== "sky" && (sceneId === "london" ? london : city)) {
      const flights = (sceneId === "london" ? london : city)!;
      const district =
        sceneId === "london" ? currentDistrict() : { x: -120, z: 0 };
      // Find a low route beside the central towers, then place the camera on that route.
      let chosen = 0,
        sample = 0,
        best = Infinity;
      flights.table.routes.forEach((route, id) => {
        if (
          flights.missions[id].kind !==
            (sceneId === "london" ? "roam" : "street") ||
          (sceneId !== "london" && route.samples[1] > 21)
        )
          return;
        for (let at = 0; at < route.samples.length; at += 12) {
          const score =
            Math.hypot(
              route.samples[at] - district.x,
              route.samples[at + 2] - district.z,
            ) +
            (route.samples[at + 1] - (sceneId === "london" ? 24 : 20)) * 2;
          if (score < best) {
            best = score;
            chosen = id;
            sample = route.samples[at + 3];
          }
        }
      });
      const route = flights.table.routes[chosen];
      const p = evaluateRoute(route, sample - 25).position,
        target = evaluateRoute(route, sample + 35).position;
      camera.position.set(p[0], p[1] + 12, p[2]);
      controls.target.set(target[0], target[1] + 1, target[2]);
    } else {
      camera.position.set(280, 190, 335);
      controls.target.set(0, 180, 0);
    }
  } else {
    mode = "follow";
    configureOrbit(true);
    const p = selectedPose().position;
    controls.target.set(...p);
    camera.position.set(p[0] - 5, p[1] + 2.5, p[2] + 8);
  }
  el("camera-help").textContent =
    mode === "follow"
      ? `Following red drone #${trackedId} · drag to orbit · scroll to zoom`
      : "Drag to orbit · Shift-drag or middle-drag to pan · scroll to zoom";
  document.body.classList.toggle(
    "immersed",
    mode === "follow" || (sceneId !== "sky" && preset === "among"),
  );
  controls.update();
}
async function population(next: number) {
  const allowed = [10000, 100000, 250000, 500000, 1000000];
  if (!allowed.includes(next)) throw new Error("Unsupported population");
  await device.queue.onSubmittedWorkDone();
  clearPilot();
  collisionMonitor?.dispose();
  collisionMonitor = undefined;
  collisionStats = null;
  lastCollisionTime = -Infinity;
  tracker?.setCollisions(null);
  gpu?.dispose();
  count = next;
  words =
    sceneId === "london"
      ? londonDescriptors(count, london!, 7)
      : sceneId === "city"
        ? cityDescriptors(count, city!, 7)
        : descriptors(count, table, 7);
  gpu = createDroneRenderer(renderer, scene, words, table);
  if (trackedId >= count) trackedId = 42;
  refreshSelection();
  clock.reset();
  frameTimes = [];
  encodingTimes = [];
  el("population-label").textContent = count.toLocaleString();
  droneTypeCounts(count).forEach((value, type) => {
    el(`type-count-${type}`).textContent = value.toLocaleString();
  });
  el<HTMLSelectElement>("population").value = String(count);
  el("visible").textContent = "—";
  el("lods").textContent = "—";
  el("memory").textContent = "—";
  if (sceneId === "london")
    el("scenario-detail").textContent =
      `30% (${(count * 0.3).toLocaleString()}) ground/roof launch trips · 70% (${(count * 0.7).toLocaleString()}) in ${london!.clearance.roamingGroups} roaming groups. Building clearance checked; separation unvalidated.`;
  status(
    `${count.toLocaleString()} individual drones · ${sceneId === "london" ? "Greater London · model-checked planned traffic" : sceneId === "city" ? "Canary Wharf · model clearance checked" : "open sky"} · separation unvalidated`,
  );
}
function refreshSelection() {
  lastCollisionTime = -Infinity;
  tracker?.setCollisions(null);
  gpu.select(trackedId);
  el("selected-path-id").textContent = `#${trackedId}`;
  el("selected-path-type").textContent = DRONE_TYPES[droneType(trackedId)].name;
  tracker?.setRoute(
    words,
    table,
    trackedId,
    sceneId === "london" ? london!.missions[words[trackedId * 8]] : undefined,
    sceneId === "london",
    sceneId !== "sky",
  );
  el("follow").textContent = `Follow #${trackedId}`;
}
async function pickDrone(clientX: number, clientY: number, action: "follow" | "context" = "follow") {
  if (testing || picking) return;
  const inset = el("drone-route").getBoundingClientRect();
  if (
    clientX >= inset.left &&
    clientX <= inset.right &&
    clientY >= inset.top &&
    clientY <= inset.bottom
  )
    return;
  picking = true;
  const current = gpu;
  try {
    const rect = renderer.domElement.getBoundingClientRect();
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    pickRay.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        (-(clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    pickRay.near = camera.near;
    pickRay.far = camera.far;
    const blockers =
      sceneId === "london"
        ? googleCity?.isReady()
          ? googleCity.pickOccluders()
          : londonMap!.pickOccluders()
        : sceneId === "city" && cityVisual!.group.visible
          ? cityVisual!.group.children.filter(
              (m) => m.visible && m instanceof THREE.Mesh,
            )
          : [];
    const obstruction =
      pickRay.intersectObjects(blockers, false)[0]?.distance ?? camera.far;
    const ground =
      pickRay.ray.direction.y < 0
        ? -pickRay.ray.origin.y / pickRay.ray.direction.y
        : camera.far;
    const limit = Math.min(
      obstruction,
      ground > 0 ? ground : camera.far,
      camera.far,
    );
    current.setPoseOverride(poseOverride);
    current.update(camera, renderer.domElement.height, clock.timeMs);
    const id = await current.pick(
      pickRay.ray.origin,
      pickRay.ray.direction,
      limit,
      (4 * renderer.domElement.height) / rect.height,
    );
    if (current !== gpu || testing) return;
    if (id === null) {
      closeDroneMenu();
      status("No drone under the pointer · click a drone to follow");
      return;
    }
    if (pilot && id !== pilot.id) {
      status("Return the controlled drone to its route before selecting another drone.");
      return;
    }
    trackedId = id;
    refreshSelection();
    syncPilotUi();
    if (action === "context") {
      clearKeys();
      const menu = el("drone-context-menu");
      el("context-drone").textContent = `Drone #${trackedId}`;
      menu.style.left = `${Math.max(8, Math.min(clientX, innerWidth - 224))}px`;
      menu.style.top = `${Math.max(44, Math.min(clientY, innerHeight - 116))}px`;
      menu.hidden = false;
      el<HTMLButtonElement>("context-control").focus({ preventScroll: true });
      return;
    }
    view("follow");
    status(`Following drone #${trackedId} · drag to orbit · scroll to zoom`);
  } catch (error) {
    status(`Could not select drone: ${String(error)}`);
  } finally {
    picking = false;
  }
}
async function changeScene(next: SceneId, nextCount = count) {
  if (next !== "london" && googleCity?.isConnected()) googleCity.disconnect();
  if (next === "city" && !city)
    throw new Error("City obstacle validation unavailable");
  if (next === "london" && !london) throw new Error("London data unavailable");
  sceneId = next;
  table =
    next === "london"
      ? london!.table
      : next === "city"
        ? city!.table
        : skyRoutes();
  scene.fog = new THREE.FogExp2(
    "#e4eceb",
    next === "london" ? 0.000006 : 0.00022,
  );
  if (next === "london" && googleCity?.isConnected()) scene.fog = null;
  controls.maxDistance = next === "london" ? 120000 : 5000;
  londonMap?.update(camera, controls.target, next === "london");
  el("london-controls").hidden = next !== "london";
  el<HTMLInputElement>("basemap").disabled = testing || next !== "london";
  skyVisual.visible = next === "sky";
  if (cityVisual)
    cityVisual.group.visible =
      next === "city" && el<HTMLInputElement>("buildings").checked;
  el<HTMLSelectElement>("scenario").value = next;
  el<HTMLInputElement>("buildings").disabled = testing || next === "sky";
  el("city-attribution").hidden = next === "sky";
  el("scenario-detail").textContent =
    next === "london"
      ? "Greater London · ground and roof departures with grouped roaming flights."
      : next === "city"
        ? "70% street flights at 20–68 m · 30% climb, cross the district and descend. Model clearance checked; flat ground."
        : "32 synthetic routes in an abstract sky.";
  el("buildings-label").textContent =
    next === "london" ? "3D buildings" : "Show city backdrop";
  el("among").textContent =
    next === "london"
      ? "Among groups"
      : next === "city"
        ? "Street level"
        : "Among drones";
  el("follow").textContent =
    next === "london" ? "Follow launch #42" : "Follow #42";
  el("route-label").textContent =
    `${table.routes.length} ROUTES · GPU FLIGHT · INDIVIDUAL IDS`;
  document.title = `${options.get("qa") ? "QA · " : ""}Million Drones — ${next === "london" ? "Greater London" : next === "city" ? "Canary Wharf" : "Open Sky"}`;
  await population(nextCount);
  view(next === "sky" ? "among" : "overview");
  syncGoogleControls();
}
function watchLaunch() {
  if (!london || testing || sceneId !== "london") return;
  const site = london.sites.find(
    (s) => s.id === el<HTMLSelectElement>("launch-site").value,
  )!;
  const mission = london.missions.find(
    (m) => m.kind === "launch" && m.from.id === site.id,
  )!;
  if (mission.kind !== "launch") return;
  clearPilot();
  clock.reset();
  clock.paused = false;
  el("pause").textContent = "Pause";
  el("play-state").textContent = "LIVE";
  mode = "orbit";
  controls.enabled = true;
  configureOrbit();
  document.body.classList.add("immersed");
  camera.near = 0.2;
  camera.far = 180000;
  camera.fov = 60;
  camera.updateProjectionMatrix();
  const distance = Math.max(140, site.radiusM * 1.8);
  camera.position.set(
    site.position[0] + distance * 0.7,
    site.position[1] + distance * 0.55,
    site.position[2] + distance,
  );
  controls.target.set(
    site.position[0],
    site.position[1] + 18,
    site.position[2],
  );
  controls.update();
  el("launch-target").textContent =
    `${site.kind === "roof" ? "Roof" : "Ground"} at ${site.surfaceHeightM.toFixed(0)} m → ${mission.to.name}. Staggered takeoff, travel, landing and ground stop.`;
  el("camera-help").textContent =
    "Watching departures · drag to orbit · restart resets all trips";
}
function freezeInputs(busy: boolean) {
  if (busy) gamepadController?.reset();
  googleCity?.setPaused(busy);
  londonMap?.setPaused(busy);
  for (const node of document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >("button,input,select")) {
    if (["about", "close-info", "bench"].includes(node.id)) continue;
    node.disabled = busy;
  }
  if (!busy) {
    el<HTMLButtonElement>("export").disabled = report === null;
    el<HTMLInputElement>("buildings").disabled = sceneId === "sky";
    el<HTMLInputElement>("basemap").disabled = sceneId !== "london";
    el<HTMLSelectElement>("scenario").querySelector<HTMLOptionElement>(
      'option[value="city"]',
    )!.disabled = !city;
  }
  syncGoogleControls();
  syncPilotUi();
  if (!busy) guideNavigation.refresh();
}
function currentDistrict() {
  const value = el<HTMLSelectElement>("district").value;
  return (
    londonOverview.places.find((p) => p.name === value) ?? {
      name: "Canary Wharf",
      x: 0,
      z: 0,
    }
  );
}
function goDistrict() {
  if (sceneId !== "london") return;
  const place = currentDistrict();
  mode = "orbit";
  controls.enabled = true;
  configureOrbit();
  document.body.classList.add("immersed");
  camera.near = 1;
  camera.far = 180000;
  camera.fov = 50;
  camera.updateProjectionMatrix();
  camera.position.set(place.x + 1300, 1000, place.z + 1600);
  controls.target.set(place.x, 40, place.z);
  controls.update();
  el("camera-help").textContent =
    `${place.name} · drag to explore · Street level enters nearby airways`;
}
function renderStep(forceAll = false) {
  tracker?.update(
    camera,
    selectedPose(),
    Math.floor(clock.timeMs),
    performance.now(),
    selectedSpeedMps(),
  );
  gpu.setPoseOverride(poseOverride);
  gpu.update(camera, renderer.domElement.height, clock.timeMs, forceAll);
  renderer.render(scene, camera);
}
async function stats() {
  if (reading || testing) return;
  reading = true;
  const current = gpu;
  try {
    const counts = await current.counts();
    if (current !== gpu) return;
    lastCounts = counts;
    el("visible").textContent = counts[3].toLocaleString();
    el("lods").textContent =
      `${counts[0].toLocaleString()} / ${counts[1].toLocaleString()} / ${counts[2].toLocaleString()}`;
    el("memory").textContent =
      `${(renderer.info.memory.total / 1048576).toFixed(1)} MiB`;
    const s = summary(frameTimes.slice(-120));
    el("fps").textContent =
      `${s.fps.toFixed(0)} fps · ${s.meanMs.toFixed(1)} ms`;
    if (counts[4]) status(`GPU append overflow: ${counts[4]}`);
  } catch (error) {
    status(String(error));
  } finally {
    reading = false;
  }
}
function advanceCamera(dt: number) {
  if (mode === "follow") {
    const p = selectedPose().position;
    followPoint.set(...p);
    followShift.copy(followPoint).sub(controls.target);
    camera.position.add(followShift);
    controls.target.copy(followPoint);
    controls.update();
    // Remove any residual pan damping from the previous view, keeping orbit/zoom
    // relative to the moving drone rather than a fixed world-space target.
    followShift.copy(followPoint).sub(controls.target);
    camera.position.add(followShift);
    controls.target.copy(followPoint);
  } else if (mode === "free") {
    const speed =
      ((keys.has("Shift") ? 180 : 50) *
        (sceneId === "london"
          ? Math.max(1, Math.min(45, camera.position.y / 120))
          : 1) *
        dt) /
      1000;
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    direction.y = 0;
    direction.normalize();
    const right = new THREE.Vector3()
      .crossVectors(direction, camera.up)
      .normalize();
    if (keys.has("w")) camera.position.addScaledVector(direction, speed);
    if (keys.has("s")) camera.position.addScaledVector(direction, -speed);
    if (keys.has("d")) camera.position.addScaledVector(right, speed);
    if (keys.has("a")) camera.position.addScaledVector(right, -speed);
    if (keys.has("e")) camera.position.y += speed;
    if (keys.has("q")) camera.position.y -= speed;
  } else controls.update();
}
function frame(now: number) {
  const dt = last ? now - last : 16.7;
  last = now;
  if (testing) return;
  gamepadController?.poll(now);
  const previousTime = clock.timeMs;
  clock.advance(dt);
  advancePilot((clock.timeMs - previousTime) / 1000);
  if (poseOverride && now - lastPitchUi >= 100) { syncPitchUi(); lastPitchUi = now; }
  advanceCamera(dt);
  googleCity?.update(
    renderer.domElement.width,
    renderer.domElement.height,
    sceneId === "london",
  );
  if (londonMap)
    londonMap.update(
      camera,
      mode === "orbit" ? controls.target : camera.position,
      sceneId === "london" && !googleCity?.isReady(),
    );
  const begin = performance.now();
  renderStep();
  if (
    el<HTMLInputElement>("collision-enabled").checked &&
    !collisionBusy &&
    (clock.timeMs < lastCollisionTime ||
      clock.timeMs - lastCollisionTime >= 200)
  )
    void sampleCollisions();
  encodingTimes.push(performance.now() - begin);
  frameTimes.push(dt);
  if (frameTimes.length > 3000) {
    frameTimes.shift();
    encodingTimes.shift();
  }
  if (now - lastStats > 500) {
    lastStats = now;
    void stats();
  }
}
async function sampleCollisions() {
  if (testing || collisionBusy) return;
  collisionBusy = true;
  lastCollisionTime = clock.timeMs;
  const selected = trackedId;
  const scope = el<HTMLSelectElement>("collision-scope")
    .value as CollisionScope;
  try {
    const current = (collisionMonitor ??= createCollisionMonitor(
      renderer,
      gpu.poses,
      count,
    ));
    const result = await current.sample(selected, scope);
    if (
      current !== collisionMonitor ||
      testing ||
      selected !== trackedId ||
      scope !== el<HTMLSelectElement>("collision-scope").value ||
      !el<HTMLInputElement>("collision-enabled").checked
    ) {
      lastCollisionTime = -Infinity;
      return;
    }
    collisionStats = result;
    const prefix = result.complete ? "" : "Partial · ",
      fleet =
        scope === "fleet"
          ? `${prefix}${result.contactPairs.toLocaleString()} contact pairs · ${result.nearPairs.toLocaleString()} near pairs. `
          : "";
    el("collision-status").textContent =
      `${fleet}#${selected}: ${result.selectedContacts} contacts · ${result.selectedNear} near.${result.truncatedQueries ? ` ${result.truncatedQueries.toLocaleString()} queries reached the work limit; counts are lower bounds.` : ""}`;
    tracker?.setCollisions({
      contacts: result.selectedContacts,
      near: result.selectedNear,
      complete: result.selectedComplete,
    });
  } catch {
    el("collision-status").textContent =
      "Collision monitor could not sample; turn it off and on to retry.";
  } finally {
    collisionBusy = false;
  }
}
function imageDataUrl() {
  if (googleCity?.isConnected())
    throw new Error("Switch to Local London before saving a view or audit.");
  renderer.render(scene, camera);
  const copy = document.createElement("canvas");
  copy.width = renderer.domElement.width;
  copy.height = renderer.domElement.height;
  const context = copy.getContext("2d")!;
  context.drawImage(renderer.domElement, 0, 0);
  tracker?.capture(context, copy.width, copy.height);
  if (sceneId !== "sky") {
    const fontSize = Math.max(10, Math.round(copy.width / 160));
    const credit =
      "Map data © OpenStreetMap contributors · ODbL · openstreetmap.org/copyright";
    context.font = `${fontSize}px sans-serif`;
    context.fillStyle = "#121820";
    context.fillRect(
      12,
      copy.height - fontSize * 3,
      context.measureText(credit).width + 20,
      fontSize * 2,
    );
    context.fillStyle = "#e8edf2";
    context.fillText(credit, 22, copy.height - fontSize * 1.65);
  }
  return copy.toDataURL("image/png");
}
async function comparePose(
  buffer: Float32Array,
  records: Uint32Array,
  routes: ReturnType<typeof routeTable>,
  time: number,
  n: number,
  positionToleranceM = 0.02,
) {
  let maxPositionError = 0,
    maxOrientationDegrees = 0,
    invalid = 0;
  for (let id = 0; id < n; id++) {
    const expected = poseAt(records, routes, id, time),
      at = id * 8;
    const actual = Array.from(buffer.subarray(at, at + 8));
    if (!actual.every(Number.isFinite)) {
      invalid++;
      continue;
    }
    maxPositionError = Math.max(
      maxPositionError,
      Math.hypot(
        actual[0] - expected.position[0],
        actual[1] - expected.position[1],
        actual[2] - expected.position[2],
      ),
    );
    const q = actual.slice(4, 8),
      dot =
        Math.abs(
          q.reduce((sum, value, i) => sum + value * expected.quaternion[i], 0),
        ) / Math.hypot(...q);
    maxOrientationDegrees = Math.max(
      maxOrientationDegrees,
      (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI,
    );
  }
  return {
    samples: n,
    positionToleranceM,
    maxPositionError,
    maxOrientationDegrees,
    invalid,
    passed:
      maxPositionError <= positionToleranceM &&
      maxOrientationDegrees <= 0.5 &&
      invalid === 0,
  };
}
async function check() {
  if (googleCity?.isConnected()) {
    status("Switch to Local London before running GPU checks.");
    return;
  }
  if (testing) return;
  clearPilot();
  testing = true;
  londonMap?.setPaused(true);
  freezeInputs(true);
  el<HTMLButtonElement>("bench").disabled = true;
  el("test-status").textContent =
    "Checking packed routes, GPU poses, counters, pause and allocation lifetime…";
  const savedTime = clock.timeMs;
  let fixture: ReturnType<typeof createDroneRenderer> | undefined;
  let diagnosticFixture: ReturnType<typeof createCollisionMonitor> | undefined;
  try {
    view("overview");
    clock.timeMs = 10250;
    gpu.update(camera, 1080, clock.timeMs, true);
    const n = Math.min(4096, count),
      positions = await gpu.readPoses(n),
      normal = await comparePose(
        positions,
        words,
        table,
        10250,
        n,
        sceneId === "london" ? 0.1 : 0.02,
      );
    const counts = Array.from(await gpu.counts());
    const drawAudit = await gpu.auditDraws(true);
    const mixedCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
    mixedCamera.position.set(0, 20, 0); mixedCamera.lookAt(0, 20, -1);
    const mixedTable = routeTable(Array.from({ length: 9 }, (_, id) => {
      const z = [-15, -300, -3000][Math.floor(id / 3)];
      return buildRoute([[id % 3 - 1, 20, z], [id % 3 - 1, 20, z - 1]], false);
    }));
    const mixedWords = descriptors(9, mixedTable, 7), mixedFloats = new Float32Array(mixedWords.buffer);
    for (let id = 0; id < 9; id++) {
      mixedFloats[id * 8 + 2] = 0; mixedFloats[id * 8 + 4] = 0;
      mixedFloats[id * 8 + 5] = 0; mixedFloats[id * 8 + 6] = 0;
    }
    const mixedScene = new THREE.Scene();
    fixture = createDroneRenderer(renderer, mixedScene, mixedWords, mixedTable);
    fixture.update(mixedCamera, 1080, 0, true);
    renderer.render(mixedScene, mixedCamera);
    const mixedAudit = await fixture.auditDraws(true), mixedCounts = Array.from(await fixture.counts());
    fixture.dispose(); fixture = undefined;
    const capTable = routeTable([buildRoute([[0, 20, -15], [0, 20, -16]], false)]);
    const capWords = descriptors(4100, capTable, 7), capFloats = new Float32Array(capWords.buffer);
    for (let id = 0; id < 4100; id++) for (const field of [2, 4, 5, 6]) capFloats[id * 8 + field] = 0;
    fixture = createDroneRenderer(renderer, new THREE.Scene(), capWords, capTable);
    fixture.update(mixedCamera, 1080, 0, true);
    const capAudit = await fixture.auditDraws(true), capCounts = Array.from(await fixture.counts());
    fixture.dispose(); fixture = undefined;
    const mixedTypesResult = {
      mixedAudit, mixedCounts, capAudit, capCounts,
      passed: mixedAudit.passed && mixedCounts.join(",") === "3,3,3,9,0" &&
        mixedAudit.drawCounts.join(",") === "1,1,1,1,1,1,3" &&
        capAudit.passed && capCounts.join(",") === "4096,0,4,4100,0",
    };
    const fleetPhases = [];
    if (sceneId === "london") {
      const first = london!.missions.find((m) => m.kind === "launch")!;
      if (first.kind === "launch") {
        const stages = launchStages(first),
          target = stages.find((s) => s.name === "destination stop")!;
        for (const time of [
          0,
          120000,
          300000,
          words[3] + Math.floor((target.startS + target.endS) * 500),
          words[3] + Math.floor(stages.at(-1)!.endS * 1000 + 2000),
        ]) {
          gpu.update(camera, 1080, time, true);
          fleetPhases.push({
            timeMs: time,
            ...(await comparePose(
              await gpu.readPoses(96),
              words,
              table,
              time,
              96,
              0.1,
            )),
          });
        }
      }
    }
    const circle: Vec3[] = Array.from({ length: 2048 }, (_, i) => [
      20 * Math.cos((i / 2048) * Math.PI * 2),
      10,
      20 * Math.sin((i / 2048) * Math.PI * 2),
    ]);
    const fixtureTable = routeTable([
      buildRoute(
        [
          [0, 0, 0],
          [0, 0, -100],
        ],
        false,
      ),
      buildRoute(
        [
          [0, 0, 0],
          [0, 100, 0],
        ],
        false,
      ),
      buildRoute(circle, true, 0.25),
    ]);
    const fixtureWords = descriptors(96, fixtureTable, 11),
      floats = new Float32Array(fixtureWords.buffer);
    for (let id = 0; id < 96; id++) {
      floats[id * 8 + 2] = ((id % 8) / 8) * fixtureTable.routes[id % 3].length;
      floats[id * 8 + 5] = 0;
      floats[id * 8 + 6] = 0;
    }
    fixture = createDroneRenderer(renderer, scene, fixtureWords, fixtureTable);
    fixture.update(camera, 1080, 10250, true);
    const fixtureResult = await comparePose(
      await fixture.readPoses(96),
      fixtureWords,
      fixtureTable,
      10250,
      96,
    );
    fixture.dispose();
    fixture = undefined;
    const pickTable = routeTable([
        buildRoute(
          [
            [0, 10, 0],
            [0, 10, -2],
          ],
          false,
          1,
          0,
        ),
        buildRoute(
          [
            [0, 10, -20],
            [0, 10, -22],
          ],
          false,
          1,
          0,
        ),
        buildRoute(
          [
            [20, 10, 0],
            [20, 10, -2],
          ],
          false,
          1,
          0,
        ),
      ]),
      pickWords = descriptors(4, pickTable),
      pickFloats = new Float32Array(pickWords.buffer);
    for (let id = 0; id < 4; id++) {
      for (const field of [2, 4, 5, 6]) pickFloats[id * 8 + field] = 0;
    }
    fixture = createDroneRenderer(renderer, scene, pickWords, pickTable);
    fixture.update(camera, 1080, 0, true);
    const pickCases = [
      {
        name: "nearest and coincident-ID tie",
        origin: [0, 10, 10],
        direction: [0, 0, -1],
        limit: 100,
        expected: 0,
      },
      {
        name: "different drone",
        origin: [20, 10, 10],
        direction: [0, 0, -1],
        limit: 100,
        expected: 2,
      },
      {
        name: "empty sky",
        origin: [50, 10, 10],
        direction: [0, 0, -1],
        limit: 100,
        expected: null,
      },
      {
        name: "occlusion limit",
        origin: [0, 10, 10],
        direction: [0, 0, -1],
        limit: 5,
        expected: null,
      },
      {
        name: "behind camera",
        origin: [0, 10, 10],
        direction: [0, 0, 1],
        limit: 100,
        expected: null,
      },
    ];
    const pickResults = [];
    for (const test of pickCases)
      pickResults.push({
        ...test,
        actual: await fixture.pick(
          new THREE.Vector3(...(test.origin as Vec3)),
          new THREE.Vector3(...(test.direction as Vec3)),
          test.limit,
          1,
        ),
      });
    const pickingResult = {
      passed: pickResults.every((t) => t.actual === t.expected),
      cases: pickResults,
    };
    const manualFixture = { id: 2, position: [20, 30, 40] as Vec3, quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 6, Math.PI / 2, 0, "YXZ")).toArray() as [number, number, number, number] };
    fixture.setPoseOverride(manualFixture);
    fixture.update(camera, 1080, 0, true);
    const manualPoses = await fixture.readPoses(4),
      manualCounts = Array.from(await fixture.counts()),
      manualPicked = await fixture.pick(new THREE.Vector3(20, 30, 60), new THREE.Vector3(0, 0, -1), 100, 1);
    let manualPositionError = 0, otherDroneError = 0;
    for (let id = 0; id < 4; id++) {
      const expected = id === manualFixture.id ? manualFixture.position : poseAt(pickWords, pickTable, id, 0).position;
      const error = Math.hypot(...expected.map((v, k) => v - manualPoses[id * 8 + k]));
      if (id === manualFixture.id) manualPositionError = error;
      else otherDroneError = Math.max(otherDroneError, error);
    }
    const manualQuaternionDot = Math.abs(manualFixture.quaternion.reduce((s, v, k) => s + v * manualPoses[manualFixture.id * 8 + 4 + k], 0));
    fixture.setPoseOverride(null);
    fixture.update(camera, 1080, 0, true);
    const restoredRoute = await comparePose(await fixture.readPoses(4), pickWords, pickTable, 0, 4);
    const manualControlResult = {
      poseComparisons: 8, manualPositionError, otherDroneError, manualQuaternionDot, expectedQuaternion: manualFixture.quaternion, pickedId: manualPicked,
      counts: manualCounts, restoredRoute,
      passed: manualPositionError < 0.001 && otherDroneError < 0.001 && manualQuaternionDot > 0.99999 && manualPicked === 2 && manualCounts[3] === 4 && manualCounts.slice(0, 3).reduce((s, n) => s + n, 0) === 4 && manualCounts[4] === 0 && restoredRoute.passed,
    };
    fixture.dispose();
    fixture = undefined;
    const contactTable = routeTable(
      COLLISION_FIXTURE.map((p) =>
        buildRoute([p, [p[0], p[1], p[2] - 1]], false, 1, 0),
      ),
    );
    const contactWords = descriptors(COLLISION_FIXTURE.length, contactTable),
      contactFloats = new Float32Array(contactWords.buffer);
    for (let id = 0; id < COLLISION_FIXTURE.length; id++)
      for (const field of [2, 4, 5, 6]) contactFloats[id * 8 + field] = 0;
    fixture = createDroneRenderer(renderer, scene, contactWords, contactTable);
    fixture.update(camera, 1080, 0, true);
    diagnosticFixture = createCollisionMonitor(
      renderer,
      fixture.poses,
      COLLISION_FIXTURE.length,
      { bucketCount: 8 },
    );
    const expectedContacts = referenceContacts(COLLISION_FIXTURE, 0),
      contactFleet = await diagnosticFixture.sample(0, "fleet"),
      contactSelected = await diagnosticFixture.sample(0, "selected");
    diagnosticFixture.dispose();
    diagnosticFixture = undefined;
    fixture.dispose();
    fixture = undefined;
    const crowdedWords = descriptors(64, contactTable),
      crowdedFloats = new Float32Array(crowdedWords.buffer);
    for (let id = 0; id < 64; id++) {
      crowdedWords[id * 8] = 0;
      for (const field of [2, 4, 5, 6]) crowdedFloats[id * 8 + field] = 0;
    }
    fixture = createDroneRenderer(renderer, scene, crowdedWords, contactTable);
    fixture.update(camera, 1080, 0, true);
    diagnosticFixture = createCollisionMonitor(renderer, fixture.poses, 64, {
      bucketCount: 2,
      maxVisits: 2,
    });
    const crowdedResult = await diagnosticFixture.sample(0, "fleet");
    diagnosticFixture.dispose();
    diagnosticFixture = undefined;
    fixture.dispose();
    fixture = undefined;
    const collisionResult = {
      expected: expectedContacts,
      fleet: contactFleet,
      selected: contactSelected,
      crowded: crowdedResult,
      passed:
        contactFleet.complete &&
        Object.entries(expectedContacts).every(
          ([key, value]) => contactFleet[key as keyof CollisionStats] === value,
        ) &&
        contactSelected.complete &&
        contactSelected.selectedContacts ===
          expectedContacts.selectedContacts &&
        contactSelected.selectedNear === expectedContacts.selectedNear &&
        !crowdedResult.complete &&
        crowdedResult.truncatedQueries > 0,
    };
    const paused = new SimulationClock();
    paused.advance(17);
    paused.paused = true;
    paused.advance(2000);
    const pausePassed = paused.timeMs === 17;
    const allocationSamples: number[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      await population(count);
      view("overview");
      controls.enabled = false;
      clock.timeMs = savedTime;
      renderStep();
      await gpu.pick(
        new THREE.Vector3(0, -1000, 0),
        new THREE.Vector3(0, -1, 0),
      );
      const warmCollision = createCollisionMonitor(renderer, gpu.poses, count);
      try {
        await warmCollision.sample(trackedId, "selected");
      } finally {
        warmCollision.dispose();
      }
      await device.queue.onSubmittedWorkDone();
      allocationSamples.push(renderer.info.memory.total);
    }
    const lifecycleDriftBytes =
        Math.max(...allocationSamples) - Math.min(...allocationSamples),
      lifecyclePassed = lifecycleDriftBytes < 1048576;
    clock.timeMs = savedTime;
    renderStep();
    await device.queue.onSubmittedWorkDone();
    const passed =
      normal.passed &&
      fixtureResult.passed &&
      pickingResult.passed &&
      manualControlResult.passed &&
      collisionResult.passed &&
      fleetPhases.every((p) => p.passed) &&
      counts.slice(0, 3).reduce((a, b) => a + b, 0) === count &&
      counts[3] === count &&
      counts[4] === 0 &&
      drawAudit.passed &&
      mixedTypesResult.passed &&
      pausePassed &&
      lifecyclePassed &&
      errors.length === 0;
    report = {
      schemaVersion: 1,
      testedAt: new Date().toISOString(),
      type: "flight-correctness",
      scenario: sceneId,
      city:
        sceneId === "london"
          ? {
              clearance: london!.clearance,
              geometry: {
                sourceBuildingRecords:
                  londonManifest.statistics.uniqueBuildings,
                sourceTiles: londonManifest.tiles.length,
                residency: londonMap!.statistics(),
              },
              verticalDatum: londonManifest.verticalDatum,
            }
          : sceneId === "city"
            ? {
                clearance: city!.clearance,
                geometry: {
                  tiles: cityVisual!.tiles,
                  triangles: cityVisual!.triangles,
                },
                verticalDatum: cityManifest.verticalDatum,
              }
            : null,
      passed,
      environment: {
        userAgent: navigator.userAgent,
        adapter: adapterInfo,
        three: THREE.REVISION,
      },
      population: count,
      sourceSha256: prepared.sourceSha256,
      models: gpu.models,
      normal,
      fixtures: fixtureResult,
      picking: pickingResult,
      manualControl: manualControlResult,
      collisionDiagnostics: collisionResult,
      fleetPhases,
      counts,
      drawAudit,
      mixedTypes: mixedTypesResult,
      pausePassed,
      allocationSamples,
      lifecycleDriftBytes,
      lifecyclePassed,
      errors: [...errors],
      screenshot: imageDataUrl(),
      scope:
        "GPU pose, count and allocation-lifetime correctness. No collision-separation or performance guarantee.",
    };
    finishReport(
      `${passed ? "PASS" : "FAIL"} · ${n + 96 + fleetPhases.reduce((s, p) => s + p.samples, 0)} GPU poses · picking ${pickingResult.passed ? "PASS" : "FAIL"} · manual ${manualControlResult.passed ? "PASS" : "FAIL"} · contacts ${collisionResult.passed ? "PASS" : "FAIL"} · max ${Math.max(normal.maxPositionError, fixtureResult.maxPositionError, ...fleetPhases.map((p) => p.maxPositionError)).toFixed(6)} m`,
    );
  } catch (error) {
    report = {
      type: "flight-correctness",
      passed: false,
      error: String(error),
      errors: [...errors],
    };
    finishReport(`FAIL · ${String(error)}`);
  } finally {
    diagnosticFixture?.dispose();
    fixture?.dispose();
    clock.timeMs = savedTime;
    testing = false;
    londonMap?.setPaused(false);
    last = 0;
    controls.enabled = true;
    freezeInputs(false);
    el<HTMLButtonElement>("bench").disabled = false;
  }
}
function finishReport(message: string) {
  el("test-status").textContent = message;
  const { screenshot: _, ...text } = report ?? {};
  el("results").textContent = JSON.stringify(text, null, 2);
  el<HTMLButtonElement>("export").disabled = false;
  status(message);
}
async function cityBenchmark() {
  if (testing || !city || !cityVisual) return;
  clearPilot();
  testing = true;
  cancelBenchmark = false;
  freezeInputs(true);
  el("bench").textContent = "Cancel benchmark";
  const saved = {
    scene: sceneId,
    count,
    time: clock.timeMs,
    speed: clock.speed,
    paused: clock.paused,
    buildings: el<HTMLInputElement>("buildings").checked,
  };
  const entries: Record<string, unknown>[] = [];
  try {
    await changeScene("city", 10000);
    renderer.setPixelRatio(1);
    renderer.setSize(1920, 1080, false);
    camera.aspect = 1920 / 1080;
    camera.updateProjectionMatrix();
    clock.speed = 1;
    clock.paused = false;
    for (let repeat = 1; repeat <= 3; repeat++)
      for (const visible of [false, true]) {
        cityVisual.group.visible = visible;
        el<HTMLInputElement>("buildings").checked = visible;
        clock.timeMs = 10250;
        view("overview");
        controls.enabled = false;
        renderStep();
        const reference = await comparePose(
          await gpu.readPoses(64),
          words,
          table,
          10250,
          64,
        );
        const intervals: number[] = [];
        let previous = 0;
        const begin = performance.now();
        el("test-status").textContent =
          `City ${visible ? "on" : "off"} · repeat ${repeat}/3 · 2s warm-up + 5s measurement`;
        await new Promise<void>((resolve, reject) => {
          const tick = (now: number) => {
            if (cancelBenchmark) {
              reject(new Error("Cancelled by user"));
              return;
            }
            if (document.hidden) {
              reject(new Error("Tab hidden during city comparison"));
              return;
            }
            try {
              const dt = previous ? now - previous : 16.7;
              previous = now;
              clock.advance(dt);
              renderStep();
              if (now - begin >= 2000) intervals.push(dt);
              if (now - begin >= 7000) resolve();
              else requestAnimationFrame(tick);
            } catch (error) {
              reject(error);
            }
          };
          requestAnimationFrame(tick);
        });
        const counts = Array.from(await gpu.counts());
        entries.push({
          repeat,
          cityVisible: visible,
          population: count,
          physicalPixels: [1920, 1080],
          cameraPosition: camera.position.toArray(),
          cameraTarget: controls.target.toArray(),
          timing: summary(intervals),
          counts,
          trackedGpuBytes: renderer.info.memory.total,
          reference,
          countPassed:
            counts[3] === count &&
            counts.slice(0, 3).reduce((s, v) => s + v, 0) === count &&
            counts[4] === 0,
        });
      }
    report = {
      schemaVersion: 1,
      type: "city-backdrop",
      testedAt: new Date().toISOString(),
      scenario: "city",
      passed:
        entries.length === 6 &&
        entries.every(
          (e) => e.countPassed && (e.reference as { passed: boolean }).passed,
        ) &&
        errors.length === 0,
      environment: {
        userAgent: navigator.userAgent,
        adapter: adapterInfo,
        three: THREE.REVISION,
        pacing: "headed browser requestAnimationFrame",
      },
      seed: 7,
      obstacleSha256: cityManifest.data.sha256,
      sourceSha256: prepared.sourceSha256,
      models: gpu.models,
      clearance: city.clearance,
      geometry: { tiles: cityVisual.tiles, triangles: cityVisual.triangles },
      entries,
      errors: [...errors],
      screenshot: imageDataUrl(),
      scope:
        "Short 10k fixed-overview city backdrop comparison, 3 interleaved off/on pairs, 2s warm-up + 5s measured each. Geometry stays resident. Not full M2 or million-drone city acceptance.",
    };
    finishReport(
      `${report.passed ? "PASS" : "FAIL"} · six city backdrop comparisons · export results`,
    );
  } catch (error) {
    report = {
      type: "city-backdrop",
      passed: false,
      error: String(error),
      entries,
      errors: [...errors],
    };
    finishReport(`City comparison stopped · ${String(error)}`);
  } finally {
    el<HTMLInputElement>("buildings").checked = saved.buildings;
    await changeScene(saved.scene, saved.count);
    clock.timeMs = saved.time;
    clock.speed = saved.speed;
    clock.paused = saved.paused;
    viewport();
    testing = false;
    londonMap?.setPaused(false);
    last = 0;
    freezeInputs(false);
    el("bench").textContent = "Benchmark 10k → 1M";
  }
}
async function benchmark() {
  if (testing) {
    cancelBenchmark = true;
    return;
  }
  clearPilot();
  testing = true;
  cancelBenchmark = false;
  freezeInputs(true);
  el("bench").textContent = "Cancel benchmark";
  const savedScene = sceneId,
    savedCount = count;
  const savedSpeed = clock.speed,
    savedPause = clock.paused;
  clock.speed = 1;
  clock.paused = false;
  const entries: unknown[] = [];
  try {
    await changeScene("sky");
    renderer.setPixelRatio(1);
    renderer.setSize(1920, 1080, false);
    camera.aspect = 1920 / 1080;
    camera.updateProjectionMatrix();
    view("overview");
    for (let repeat = 0; repeat < 3; repeat++)
      for (const n of [10000, 100000, 1000000]) {
        if (cancelBenchmark) throw new Error("Cancelled by user");
        await population(n);
        view("overview");
        controls.enabled = false;
        const intervals: number[] = [],
          host: number[] = [];
        let previous = 0;
        const start = performance.now();
        el("test-status").textContent =
          `Benchmark · ${n.toLocaleString()} drones · repeat ${repeat + 1}/3 · 5s warm-up + 20s measurement`;
        await new Promise<void>((resolve, reject) => {
          const tick = (now: number) => {
            if (cancelBenchmark) {
              resolve();
              return;
            }
            if (document.visibilityState !== "visible") {
              reject(
                new Error(
                  "Benchmark tab became hidden; this attempt is invalid",
                ),
              );
              return;
            }
            const dt = previous ? now - previous : 16.7;
            previous = now;
            clock.advance(dt);
            const t = performance.now();
            renderStep();
            const spent = performance.now() - t;
            if (now - start >= 5000) {
              intervals.push(dt);
              host.push(spent);
            }
            if (now - start >= 25000) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        if (cancelBenchmark) throw new Error("Cancelled by user");
        const counts = Array.from(await gpu.counts()),
          timing = summary(intervals);
        const result = {
          population: n,
          repeat: repeat + 1,
          view: "overview",
          cameraPosition: camera.position.toArray(),
          cameraTarget: controls.target.toArray(),
          timeScale: 1,
          physicalPixels: [1920, 1080],
          timing,
          host: summary(host),
          counts,
          trackedGpuBytes: renderer.info.memory.total,
          populationAllocationBytes: gpu.populationBytes,
          countPassed:
            counts[3] === n &&
            counts.slice(0, 3).reduce((a, b) => a + b, 0) === n &&
            counts[4] === 0,
          targetMet: timing.meanMs <= 33.3 && timing.p95Ms <= 40,
        };
        entries.push(result);
        el("test-status").textContent =
          `${n.toLocaleString()} · ${timing.fps.toFixed(1)} fps · p95 ${timing.p95Ms.toFixed(1)} ms`;
      }
    report = {
      schemaVersion: 1,
      testedAt: new Date().toISOString(),
      type: "overview-scaling",
      scenario: "sky",
      cityBackdrop: false,
      cityGeometryResident: true,
      environment: {
        userAgent: navigator.userAgent,
        adapter: adapterInfo,
        three: THREE.REVISION,
        pacing: "headed browser requestAnimationFrame",
      },
      sourceSha256: prepared.sourceSha256,
      models: gpu.models,
      entries,
      errors: [...errors],
      screenshot: imageDataUrl(),
      scope:
        "Three interleaved repetitions, overview only. Dense/close/sweep acceptance and separation validation remain pending.",
    };
    finishReport("Benchmark complete · 9 runs · export results");
  } catch (error) {
    report = {
      type: "overview-scaling",
      entries,
      error: String(error),
      errors: [...errors],
    };
    finishReport(`Benchmark stopped · ${String(error)}`);
  } finally {
    testing = false;
    londonMap?.setPaused(false);
    last = 0;
    viewport();
    await changeScene(savedScene, savedCount);
    clock.speed = savedSpeed;
    clock.paused = savedPause;
    controls.enabled = true;
    freezeInputs(false);
    el("bench").textContent = "Benchmark 10k → 1M";
  }
}
async function exportReport() {
  if (!report) return;
  const handle = await window.showSaveFilePicker({
    suggestedName:
      report.type === "city-backdrop"
        ? "city-backdrop.json"
        : report.type === "overview-scaling"
          ? "overview-scaling.json"
          : "flight-correctness.json",
    types: [
      {
        description: "Drone flight report",
        accept: { "application/json": [".json"] },
      },
    ],
  });
  const writer = await handle.createWritable();
  await writer.write(JSON.stringify(report, null, 2));
  await writer.close();
  status("Report saved");
}
async function start() {
  if (!navigator.gpu)
    throw new Error(
      "WebGPU is required. Open this page in a WebGPU-capable browser.",
    );
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("No WebGPU adapter available");
  adapterInfo = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
    limits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxStorageBuffersPerShaderStage:
        adapter.limits.maxStorageBuffersPerShaderStage,
    },
  };
  renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  await renderer.init();
  const backend = renderer.backend as unknown as {
    isWebGPUBackend: boolean;
    device: GPUDevice;
  };
  if (!backend.isWebGPUBackend)
    throw new Error("This demo requires the WebGPU backend.");
  device = backend.device;
  device.addEventListener("uncapturederror", (event) => {
    errors.push(event.error.message);
    status(`GPU error: ${event.error.message}`);
  });
  device.lost.then((info) => {
    errors.push(`Device lost: ${info.message}`);
    renderer.setAnimationLoop(null);
    status("GPU device lost. Reload to restore this scene.");
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  el("canvas").append(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  camera.coordinateSystem = renderer.coordinateSystem;
  viewport();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.mouseButtons.RIGHT = null;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
  controls.screenSpacePanning = false;
  controls.enableDamping = true;
  controls.maxDistance = 5000;
  controls.minDistance = 2;
  scene.add(new THREE.HemisphereLight("#f0f7ff", "#b8b89c", 2.6));
  const sun = new THREE.DirectionalLight("#fff0c4", 3);
  sun.position.set(-600, 1200, 400);
  scene.add(sun);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(50000, 50000),
    new THREE.MeshBasicMaterial({ color: "#c3cbbd" }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  skyVisual.add(ground);
  const grid = new THREE.GridHelper(2400, 48, "#a0b5aa", "#b9c7bb");
  grid.position.y = 0.1;
  skyVisual.add(grid);
  scene.add(skyVisual);
  try {
    city = cityScenario(
      cityData,
      cityManifest,
      prepared.boundingRadius,
      navigation as unknown as NavigationBundle,
    );
    if (navigation.roadsSha256 !== roads.source.sha256)
      throw new Error("Road visual/navigation source mismatch");
    cityVisual = createCityScene(cityData, roads);
    scene.add(cityVisual.group);
    const cityGround = new THREE.Mesh(
      new THREE.PlaneGeometry(2048, 2048),
      new THREE.MeshBasicMaterial({ color: "#c3cbbd" }),
    );
    cityGround.rotation.x = -Math.PI / 2;
    cityGround.position.set(
      (cityManifest.localBoundsM.minX + cityManifest.localBoundsM.maxX) / 2,
      -0.1,
      (cityManifest.localBoundsM.minZ + cityManifest.localBoundsM.maxZ) / 2,
    );
    cityVisual.group.add(cityGround);
  } catch (error) {
    console.warn("City disabled", error);
    el<HTMLSelectElement>("scenario").querySelector<HTMLOptionElement>(
      'option[value="city"]',
    )!.disabled = true;
  }
  try {
    london = londonFleet(
      londonManifest as unknown as LondonManifest,
      fleetData as unknown as FleetBundle,
    );
    londonMap = createLondonScene(
      londonManifest as unknown as LondonManifest,
      londonOverview as unknown as LondonOverview,
      (text) => {
        el("map-status").textContent = text;
      },
      london.sites,
    );
    scene.add(londonMap.group);
    for (const site of london.sites) {
      const option = document.createElement("option");
      option.value = site.id;
      option.textContent = `${site.name} · ${site.kind}`;
      el("launch-site").append(option);
    }
    el("watch-launch").addEventListener("click", watchLaunch);
    const district = el<HTMLSelectElement>("district");
    const names = [
      ...new Set([
        "Canary Wharf",
        ...londonOverview.places
          .filter(
            (p) =>
              p.kind !== "suburb" ||
              /Westminster|Canary Wharf|Stratford|Greenwich|Camden|Woolwich|Barking|Bexley|Dagenham|Hammersmith|Hackney|Tottenham|Lewisham|Richmond|Kingston|Sutton|Bromley|Croydon|Ealing|Harrow|Enfield|Romford|Uxbridge|Ilford|Wembley|Hounslow|Barnet|Orpington/.test(
                p.name,
              ),
          )
          .map((p) => p.name),
      ]),
    ].sort();
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      district.append(option);
    }
    district.value = "Canary Wharf";
    district.addEventListener("change", goDistrict);
    el("go-district").addEventListener("click", goDistrict);
    el<HTMLInputElement>("basemap").addEventListener("change", () =>
      londonMap!.basemapVisible(el<HTMLInputElement>("basemap").checked),
    );
  } catch (error) {
    console.warn("London unavailable", error);
    el<HTMLSelectElement>("scenario").querySelector<HTMLOptionElement>(
      'option[value="london"]',
    )!.disabled = true;
  }
  el<HTMLImageElement>("google-logo").src = googleLogo.dataUrl;
  googleCity = createGoogleCity({
    scene,
    camera,
    anisotropy: renderer.getMaxAnisotropy(),
    geography: createMapGeography(londonManifest),
    onState: (state, message) => {
      // Match Million Robots' clear blue map sky in Photo; retain local audit visuals.
      const photo = state === "loading" || state === "ready",
        wasPhoto = googleState === "loading" || googleState === "ready";
      if (photo !== wasPhoto) {
        scene.background = new THREE.Color(photo ? "#9fb7cc" : "#e4eceb");
        scene.fog = photo ? null : new THREE.FogExp2(
          "#e4eceb", sceneId === "london" ? 0.000006 : 0.00022,
        );
      }
      googleState = state;
      el("google-status").textContent = message;
      el("google-attribution").hidden = state !== "ready";
      el("city-attribution").querySelector("a")!.textContent =
        state === "ready"
          ? "Route map / flight model © OpenStreetMap contributors · ODbL"
          : "Map data © OpenStreetMap contributors · ODbL";
      syncGoogleControls();
    },
    onCredits: (credits) => {
      el("google-data-credit").textContent = credits;
    },
  });
  if (!["http:", "https:"].includes(location.protocol))
    el("google-status").textContent =
      "Local London active. Google 3D needs HTTP/HTTPS: run yarn dev, then open http://localhost:5175.";
  el("google-connect").addEventListener("click", () => {
    if (testing) return;
    try {
      googleCity!.setGroundHeight(
        Number(el<HTMLInputElement>("google-ground").value),
      );
      googleCity!.connect(configuredIonToken, location.protocol, location.href, "ion");
    } catch {
      googleCity!.disconnect(
        "Photo could not connect. Check the preview connection and map alignment. Local London restored.",
        "error",
      );
    } finally {
      syncGoogleControls();
    }
  });
  el("google-local").addEventListener("click", () => googleCity!.disconnect());
  el("google-ground").addEventListener("change", () => {
    try {
      googleCity!.setGroundHeight(
        Number(el<HTMLInputElement>("google-ground").value),
      );
    } catch {
      el("google-status").textContent =
        "Ground alignment must be between -100 and 500 metres.";
    }
  });
  tracker = createDroneTracker(
    scene,
    londonOverview as unknown as LondonOverview,
    londonManifest,
  );
  const allowed = [10000, 100000, 250000, 500000, 1000000],
    requested = Number(
      options.get("agents") ?? (options.get("scene") ? 10000 : 1000000),
    );
  await changeScene(
    options.get("scene") === "sky"
      ? "sky"
      : options.get("scene") === "city" && city
        ? "city"
        : london
          ? "london"
          : city
            ? "city"
            : "sky",
    allowed.includes(requested) ? requested : 10000,
  );
  el<HTMLSelectElement>("scenario").addEventListener("change", async () => {
    if (testing) return;
    testing = true;
    freezeInputs(true);
    try {
      await changeScene(el<HTMLSelectElement>("scenario").value as SceneId);
    } catch (error) {
      status(String(error));
    } finally {
      testing = false;
      last = 0;
      freezeInputs(false);
    }
  });
  el<HTMLInputElement>("buildings").addEventListener("change", () => {
    londonMap?.buildingsVisible(el<HTMLInputElement>("buildings").checked);
    if (cityVisual)
      cityVisual.group.visible =
        sceneId === "city" && el<HTMLInputElement>("buildings").checked;
  });
  el("backend").textContent = "WEBGPU";
  el<HTMLSelectElement>("population").addEventListener("change", async () => {
    if (testing) return;
    testing = true;
    try {
      await population(Number(el<HTMLSelectElement>("population").value));
    } finally {
      testing = false;
      last = 0;
    }
  });
  el("pause").addEventListener("click", () => {
    clock.paused = !clock.paused;
    el("pause").textContent = clock.paused ? "Resume" : "Pause";
    el("play-state").textContent = clock.paused ? "PAUSED" : "LIVE";
  });
  el("reset").addEventListener("click", () => { clearPilot(); clock.reset(); });
  el("context-control").addEventListener("click", () => pilot ? returnToRoute() : takeControl());
  el("release-control").addEventListener("click", returnToRoute);
  el("brake-control").addEventListener("click", brakeControl);
  el("collision-enabled").addEventListener("change", async () => {
    lastCollisionTime = -Infinity;
    if (el<HTMLInputElement>("collision-enabled").checked) {
      el("collision-status").textContent = "Sampling rotor bounds on the GPU…";
      return;
    }
    const old = collisionMonitor;
    collisionMonitor = undefined;
    collisionStats = null;
    tracker?.setCollisions(null);
    el("collision-status").textContent =
      "Off · flight paths continue unchanged.";
    await device.queue.onSubmittedWorkDone().catch(() => {});
    old?.dispose();
  });
  el("collision-scope").addEventListener("change", () => {
    lastCollisionTime = -Infinity;
    tracker?.setCollisions(null);
  });
  el<HTMLInputElement>("speed").addEventListener("input", () => {
    clock.speed = Number(el<HTMLInputElement>("speed").value);
    el("speed-label").textContent = `${clock.speed}×`;
  });
  for (const preset of ["overview", "among", "follow"])
    el(preset).addEventListener("click", () => view(preset));
  el("pan").addEventListener("click", () => {
    if (testing) return;
    // Leave Follow at its current pose/target so panning is not pulled back to the drone.
    leaveFreeCamera();
    mode = "orbit";
    controls.enabled = true;
    configureOrbit();
    setMapDrag(true);
    closeDroneMenu();
    el("camera-help").textContent = "Drag to pan the map · Shift-drag to orbit · scroll to zoom";
    renderer.domElement.focus({ preventScroll: true });
  });
  el("orbit-drag").addEventListener("click", () => {
    if (testing) return;
    leaveFreeCamera();
    controls.enabled = true;
    configureOrbit(mode === "follow");
    el("camera-help").textContent = mode === "follow"
      ? `Following red drone #${trackedId} · drag to orbit · scroll to zoom`
      : "Drag to orbit · Shift-drag or middle-drag to pan · scroll to zoom";
    renderer.domElement.focus({ preventScroll: true });
  });
  el("free").addEventListener("click", () => {
    setMapDrag(false);
    mode = "free";
    document.body.classList.add("immersed");
    controls.enabled = false;
    eye.setFromQuaternion(camera.quaternion, "YXZ");
    el("camera-help").textContent =
      "Drag to look · W/A/S/D move · Q/E altitude · Shift faster";
  });
  window.addEventListener("keydown", (event) => {
    if (document.body.dataset.page !== "flights") return;
    if (event.key === "Escape" && !el("drone-context-menu").hidden) {
      event.preventDefault(); closeDroneMenu(); renderer.domElement.focus(); return;
    }
    if (
      ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "SUMMARY", "A"].includes(
        (event.target as HTMLElement).tagName,
      )
    )
      return;
    keys.add(event.key.length === 1 ? event.key.toLowerCase() : event.key);
    if (pilot) {
      pilot = syncPilotInput(pilot, currentPilotInput());
      if (event.key.toLowerCase() === "r" && !event.repeat) { event.preventDefault(); levelPitch(); }
      if (event.key.toLowerCase() === "z" && !event.repeat) { event.preventDefault(); brakeControl(); }
      if ([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) event.preventDefault();
      if (event.key === "Escape") { event.preventDefault(); returnToRoute(); }
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      el("pause").click();
    }
    if (event.key === "Escape") view("among");
  });
  window.addEventListener("keyup", (event) => {
    keys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
    if (pilot) pilot = syncPilotInput(pilot, currentPilotInput());
  });
  window.addEventListener("blur", () => { clearKeys(); closeDroneMenu(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearKeys(); });
  window.addEventListener("pointerdown", (event) => {
    if (!el("drone-context-menu").contains(event.target as Node)) closeDroneMenu();
    if (event.target !== renderer.domElement) clearKeys();
  }, true);
  renderer.domElement.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    pointer.down = false;
    void pickDrone(event.clientX, event.clientY, "context");
  });
  renderer.domElement.addEventListener("pointerdown", (event) => {
    renderer.domElement.focus({ preventScroll: true });
    pointer.down = event.button === 0;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.startX = event.clientX;
    pointer.startY = event.clientY;
    pointer.dragged = false;
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    const click = pointer.down && !pointer.dragged && event.button === 0;
    pointer.down = false;
    if (click) void pickDrone(event.clientX, event.clientY);
  });
  renderer.domElement.addEventListener("pointercancel", () => {
    pointer.down = false;
  });
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (
      pointer.down &&
      Math.hypot(
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
      ) > 5
    )
      pointer.dragged = true;
    if (mode === "free" && pointer.down) {
      eye.y -= (event.clientX - pointer.x) * 0.004;
      eye.x = Math.max(
        -1.5,
        Math.min(1.5, eye.x - (event.clientY - pointer.y) * 0.004),
      );
      camera.quaternion.setFromEuler(eye);
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  });
  el("check").addEventListener("click", () => void check());
  el("city-bench").addEventListener("click", () => void cityBenchmark());
  el("bench").addEventListener("click", () => void benchmark());
  el("export").addEventListener(
    "click",
    () =>
      void exportReport().catch((error) => {
        if (error.name !== "AbortError") status(String(error));
      }),
  );
  el("capture").addEventListener("click", async () => {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: "flight-view.png",
        types: [
          {
            description: "Drone flight view",
            accept: { "image/png": [".png"] },
          },
        ],
      });
      const bytes = Uint8Array.from(
        atob(imageDataUrl().split(",")[1]),
        (value) => value.charCodeAt(0),
      );
      const writer = await handle.createWritable();
      await writer.write(new Blob([bytes], { type: "image/png" }));
      await writer.close();
      status("View saved");
    } catch (error) {
      if ((error as Error).name !== "AbortError") status(String(error));
    }
  });
  el("about").addEventListener("click", () =>
    el<HTMLDialogElement>("info").showModal(),
  );
  el("close-info").addEventListener("click", () =>
    el<HTMLDialogElement>("info").close(),
  );
  window.addEventListener("resize", () => {
    if (!testing) viewport();
  });
  gamepadController = createGamepadController({
    eligible: () => !testing && !document.hidden && document.hasFocus() && document.body.dataset.page === "flights" && document.activeElement === renderer.domElement && !el<HTMLDialogElement>("info").open,
    focusCanvas: () => renderer.domElement.focus({ preventScroll: true }),
    take: takeControl, release: returnToRoute, follow: () => view("follow"),
    pause: () => el<HTMLButtonElement>("pause").click(),
    level: levelPitch,
    brake: brakeControl,
    inputLost: () => { if (pilot) pilot = brakePilot(pilot); },
  });
  renderer.setAnimationLoop(frame);
  guideNavigation.refresh();
  Object.assign(window, {
    __droneDemo: {
      check,
      benchmark,
      report: () => report,
      counts: () => lastCounts,
      population: () => count,
      scenario: () => sceneId,
      clearance: () =>
        sceneId === "london" ? london?.clearance : city?.clearance,
      map: () => londonMap?.statistics(),
      collisions: () => collisionStats,
      manualControl: () => ({ state: pilot ? "piloting" : returning ? "returning" : "autopilot", id: poseOverride?.id ?? null, pose: poseOverride ? structuredClone(poseOverride) : null }),
      mapProvider: () => ({
        state: googleState,
        connected: googleCity?.isConnected() ?? false,
        provider: "ion",
      }),
      selection: () => ({
        id: trackedId,
        mode,
        position: selectedPose().position,
        target: controls.target.toArray(),
        camera: camera.position.toArray(),
      }),
    },
  });
  if (options.get("test") === "1") await check();
}
setupPanel();
const guideNavigation = setupGuidePages(() => !testing, () => { clearKeys(); closeDroneMenu(); });
start().catch((error) => {
  status(`Cannot start: ${String(error)}`);
  el("backend").textContent = "UNAVAILABLE";
  console.error(error);
});
