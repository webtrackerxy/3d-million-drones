import type { Vec3, Quat } from "../../core-types/src/index.ts";
import { DRONE_ENVELOPE_RADIUS_M } from "../../core-types/src/drone-types.ts";

export interface FlightPose { position: Vec3; quaternion: Quat }
export interface PilotInput { forward: number; right: number; up: number; turn: number; pitch: number; boost: boolean }
type PilotAxes = Omit<PilotInput, "boost">;
const AXES = ["forward", "right", "up", "turn", "pitch"] as const;
export interface PilotState extends FlightPose {
  id: number;
  yaw: number;
  pitch: number;
  coasting: boolean;
  attitudeHeld: boolean;
  velocity: Vec3;
  remainder: number;
  // Signed simulation seconds held in each direction, capped at the full-speed ramp.
  held: PilotAxes;
}
export interface ReturnState {
  id: number;
  offset: Vec3;
  quaternion: Quat;
  elapsed: number;
  duration: number;
}
export const MANUAL_FLOOR_M = 0.37;
export const MANUAL_CEILING_M = 1200;
export const MANUAL_PITCH_LIMIT = Math.PI / 4;
const TICK = 1 / 60;
const RAMP_SECONDS = 4;
const axis = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));

function slerp(a: Quat, b: Quat, amount: number): Quat {
  let d = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const target = d < 0 ? b.map(v => -v) as Quat : b;
  d = Math.max(-1, Math.min(1, Math.abs(d)));
  const angle = Math.acos(d), sin = Math.sin(angle);
  const x = sin > 1e-6 ? Math.sin((1 - amount) * angle) / sin : 1 - amount,
    y = sin > 1e-6 ? Math.sin(amount * angle) / sin : amount;
  const q = a.map((v, i) => v * x + target[i] * y) as Quat;
  const n = Math.hypot(...q);
  return q.map(v => v / n) as Quat;
}
export function beginPilot(id: number, pose: FlightPose, velocity: Vec3 = [0, 0, 0]): PilotState {
  if (!Number.isInteger(id) || id < 0 || ![...pose.position, ...pose.quaternion, ...velocity].every(Number.isFinite) || Math.hypot(...pose.quaternion) < 1e-8)
    throw new Error("Invalid manual flight handoff");
  const norm = Math.hypot(...pose.quaternion),
    q = pose.quaternion.map(v => v / norm) as Quat;
  // Extract heading/pitch from local -Z, preserving the exact initial attitude at handoff.
  const fx = -2 * (q[0] * q[2] + q[3] * q[1]),
    fy = 2 * (q[3] * q[0] - q[1] * q[2]),
    fz = -(1 - 2 * (q[0] ** 2 + q[1] ** 2));
  return { id, position: [...pose.position], quaternion: q, yaw: Math.atan2(-fx, -fz), pitch: Math.asin(Math.max(-1, Math.min(1, fy))), velocity: [...velocity], coasting: Math.hypot(...velocity) > 0, attitudeHeld: true, remainder: 0, held: { forward: 0, right: 0, up: 0, turn: 0, pitch: 0 } };
}
export function levelPilot(state: PilotState): PilotState {
  return { ...state, pitch: 0, attitudeHeld: false, held: { ...state.held, pitch: 0 } };
}
export function brakePilot(state: PilotState): PilotState {
  return { ...state, coasting: false, held: { forward: 0, right: 0, up: 0, turn: 0, pitch: 0 } };
}
// Prepared models have Y >= -0.35 m and lie in the common swept sphere. Use the
// effective orientation (including easing/roll) so leveling cannot clip the ground.
export function manualFloorM(q: Quat) {
  const upright = Math.max(-1, Math.min(1, 1 - 2 * (q[0] ** 2 + q[2] ** 2)));
  const side = Math.sqrt(Math.max(0, 1 - upright * upright));
  return 0.02 + Math.min(DRONE_ENVELOPE_RADIUS_M,
    0.35 * Math.max(0, upright) + DRONE_ENVELOPE_RADIUS_M * (side + Math.max(0, -upright)));
}
// Release/reversal also resets the ramp while paused or between simulation ticks.
// Repeated keydown events and equivalent key aliases do not restart a held direction.
export function syncPilotInput(state: PilotState, input: PilotInput): PilotState {
  const held = { ...state.held };
  let changed = false;
  for (const key of AXES) {
    if (held[key] && Math.sign(held[key]) !== Math.sign(axis(input[key]))) {
      held[key] = 0;
      changed = true;
    }
  }
  return changed ? { ...state, held } : state;
}
export function pilotInput(keys: ReadonlySet<string>): PilotInput {
  return {
    forward: Number(keys.has("w") || keys.has("ArrowUp")) - Number(keys.has("s") || keys.has("ArrowDown")),
    right: Number(keys.has("d")) - Number(keys.has("a")),
    up: Number(keys.has("e") || keys.has(" ")) - Number(keys.has("q") || keys.has("c")),
    turn: Number(keys.has("ArrowRight")) - Number(keys.has("ArrowLeft")),
    pitch: Number(keys.has("i")) - Number(keys.has("k")),
    boost: keys.has("Shift"),
  };
}
// Only the one piloted drone is integrated on CPU. Fixed ticks do not depend on camera/visibility.
// Callers use the simulation clock delta (maximum 0.4 s: 100 ms real clamp × 4 speed).
export function stepPilot(state: PilotState, input: PilotInput, seconds: number): PilotState {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 0.400001)
    throw new Error("Manual step outside bounded simulation delta");
  if (seconds === 0) return state;
  const next: PilotState = { ...state, position: [...state.position], quaternion: [...state.quaternion], velocity: [...state.velocity], held: { ...state.held }, remainder: state.remainder + seconds };
  const forward = axis(input.forward), right = axis(input.right), up = axis(input.up),
    normal = Math.max(1, Math.hypot(forward, right, up));
  while (next.remainder + 1e-10 >= TICK) {
    next.remainder = Math.max(0, next.remainder - TICK);
    for (const key of AXES) {
      const direction = Math.sign(axis(input[key]));
      const elapsed = Math.sign(next.held[key]) === direction ? Math.abs(next.held[key]) : 0;
      next.held[key] = direction * Math.min(RAMP_SECONDS, elapsed + TICK);
    }
    const speed = (key: keyof PilotAxes, base: number, maximum: number) =>
      base + (maximum - base) * Math.abs(next.held[key]) / RAMP_SECONDS;
    const forwardSpeed = speed("forward", input.boost ? 28 : 12, input.boost ? 60 : 32),
      rightSpeed = speed("right", input.boost ? 28 : 12, input.boost ? 60 : 32),
      verticalSpeed = speed("up", input.boost ? 10 : 6, input.boost ? 24 : 14);
    next.yaw -= axis(input.turn) * speed("turn", 1.5, 2.4) * TICK;
    if (axis(input.pitch)) next.pitch = Math.max(-MANUAL_PITCH_LIMIT, Math.min(MANUAL_PITCH_LIMIT,
      next.pitch + axis(input.pitch) * speed("pitch", 0.6, 1.2) * TICK));
    if (axis(input.pitch) || axis(input.turn)) next.attitudeHeld = false;
    if (forward || right || up) next.coasting = false;
    const s = Math.sin(next.yaw), c = Math.cos(next.yaw),
      cp = Math.cos(next.pitch), sp = Math.sin(next.pitch),
      target: Vec3 = [(right * rightSpeed * c - forward * forwardSpeed * cp * s) / normal, (up * verticalSpeed + forward * forwardSpeed * sp) / normal, (-forward * forwardSpeed * cp * c - right * rightSpeed * s) / normal];
    for (let k = 0; k < 3; k++) {
      const old = next.velocity[k];
      if (!next.coasting) next.velocity[k] += (target[k] - old) * (1 - Math.exp(-5 * TICK));
      next.position[k] += (old + next.velocity[k]) * 0.5 * TICK;
    }
    const sy = Math.sin(next.yaw / 2), cy = Math.cos(next.yaw / 2), sx = Math.sin(next.pitch / 2), cx = Math.cos(next.pitch / 2);
    if (!next.attitudeHeld) next.quaternion = slerp(next.quaternion, [cy * sx, sy * cx, -sy * sx, cy * cx], 1 - Math.exp(-8 * TICK));
    const floor = manualFloorM(next.quaternion);
    next.position[1] = Math.max(floor, Math.min(MANUAL_CEILING_M, next.position[1]));
    if ((next.position[1] === floor && next.velocity[1] < 0) || (next.position[1] === MANUAL_CEILING_M && next.velocity[1] > 0)) next.velocity[1] = 0;
  }
  return next;
}
export function beginReturn(state: PilotState, routePose: FlightPose): ReturnState {
  const offset = state.position.map((v, i) => v - routePose.position[i]) as Vec3;
  return { id: state.id, offset, quaternion: [...state.quaternion], elapsed: 0, duration: Math.max(3, Math.hypot(...offset) / 8) };
}
export function stepReturn(state: ReturnState, routePose: FlightPose, seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 0.400001)
    throw new Error("Return step outside bounded simulation delta");
  const elapsed = Math.min(state.duration, state.elapsed + seconds), t = elapsed / state.duration,
    blend = t * t * t * (10 + t * (-15 + t * 6));
  const position = routePose.position.map((v, i) => v + state.offset[i] * (1 - blend)) as Vec3;
  const quaternion = slerp(state.quaternion, routePose.quaternion, blend);
  // The route may descend before the offset has decayed. Keep the body above flat ground.
  if (elapsed < state.duration) position[1] = Math.max(manualFloorM(quaternion), position[1]);
  return {
    state: { ...state, elapsed },
    pose: { position, quaternion },
    done: elapsed >= state.duration,
  };
}
