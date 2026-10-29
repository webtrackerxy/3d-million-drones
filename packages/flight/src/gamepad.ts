import type { PilotInput } from "./manual.ts";

export interface PadSnapshot {
  id: string;
  index: number;
  mapping: string;
  connected: boolean;
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}
export interface PadProfile {
  axes: { right: number; forward: number; turn: number; up: number };
  invertForward: boolean;
  invertUp: boolean;
  buttons: { take: number; release: number; follow: number; pause: number; boost: number; pitch: number; level: number; brake: number };
  allowUnmapped: boolean;
}
export const STANDARD_PAD_PROFILE: PadProfile = {
  axes: { right: 0, forward: 1, turn: 2, up: 3 }, invertForward: true, invertUp: true,
  buttons: { take: 0, release: 1, follow: 2, pause: 9, boost: 5, pitch: 6, level: 4, brake: 10 }, allowUnmapped: false,
};
const ACTIONS = ["take", "release", "follow", "pause", "level", "brake"] as const;
type PadActions = Record<typeof ACTIONS[number], boolean>;
const noActions = (): PadActions => ({ take: false, release: false, follow: false, pause: false, level: false, brake: false });
export const idlePilotInput = (): PilotInput => ({ forward: 0, right: 0, up: 0, turn: 0, pitch: 0, boost: false });
export interface PadSession { device: string | null; ready: boolean; previous: PadActions }
export const newPadSession = (): PadSession => ({ device: null, ready: false, previous: noActions() });

export function padAxis(value: number, deadzone = 0.15) {
  if (!Number.isFinite(deadzone) || deadzone < 0 || deadzone >= 1) throw new Error("Invalid gamepad dead zone");
  if (!Number.isFinite(value)) return 0;
  const v = Math.max(-1, Math.min(1, value));
  return Math.abs(v) <= deadzone ? 0 : Math.sign(v) * (Math.abs(v) - deadzone) / (1 - deadzone);
}
export function validatePadProfile(profile: PadProfile) {
  if (!Object.values(profile.axes).every(v => Number.isInteger(v) && v >= 0 && v < 32) ||
      !Object.values(profile.buttons).every(v => Number.isInteger(v) && v >= 0 && v < 64))
    throw new Error("Invalid gamepad axis/button index");
  if (new Set(Object.values(profile.axes)).size !== 4 || new Set(Object.values(profile.buttons)).size !== 8)
    throw new Error("Gamepad bindings must use distinct axes and buttons");
}
export function samplePad(pad: PadSnapshot, profile: PadProfile = STANDARD_PAD_PROFILE) {
  validatePadProfile(profile);
  const supported = (pad.mapping === "standard" || profile.allowUnmapped) &&
    Object.values(profile.axes).every(i => i < pad.axes.length) &&
    Object.values(profile.buttons).every(i => i < pad.buttons.length);
  if (!supported) return { supported, input: idlePilotInput(), actions: noActions(), neutral: false };
  const button = (index: number) => {
    const b = pad.buttons[index];
    return b.pressed || (Number.isFinite(b.value) && b.value >= 0.5);
  };
  const actions = Object.fromEntries(ACTIONS.map(action => [action, button(profile.buttons[action])])) as PadActions;
  const vertical = padAxis(pad.axes[profile.axes.up]) * (profile.invertUp ? -1 : 1) || 0;
  const pitching = button(profile.buttons.pitch);
  const input: PilotInput = {
    right: padAxis(pad.axes[profile.axes.right]),
    forward: padAxis(pad.axes[profile.axes.forward]) * (profile.invertForward ? -1 : 1) || 0,
    turn: padAxis(pad.axes[profile.axes.turn]),
    up: pitching ? 0 : vertical,
    pitch: pitching ? vertical : 0,
    boost: button(profile.buttons.boost),
  };
  return { supported, input, actions,
    neutral: !input.forward && !input.right && !input.up && !input.turn && !input.pitch && !pitching && !input.boost && !Object.values(actions).some(Boolean) };
}

// One controller snapshot per animation frame. No DOM, device APIs or real-time clock here.
export function stepPadSession(session: PadSession, pad: PadSnapshot | null, eligible: boolean, profile: PadProfile = STANDARD_PAD_PROFILE) {
  const inactive = { state: newPadSession(), input: idlePilotInput(), actions: noActions(), status: "inactive" as const };
  if (!eligible) return inactive;
  if (!pad?.connected) return { ...inactive, status: "disconnected" as const };
  const sample = samplePad(pad, profile), device = `${pad.index}:${pad.id}:${pad.mapping}`;
  if (!sample.supported) return { ...inactive, status: "unsupported" as const };
  const current = session.device === device ? session : { ...newPadSession(), device };
  if (!current.ready) {
    return { state: { ...current, ready: sample.neutral, previous: sample.actions }, input: idlePilotInput(),
      actions: noActions(), status: sample.neutral ? "ready" as const : "neutral" as const };
  }
  const actions = Object.fromEntries(ACTIONS.map(action => [action, sample.actions[action] && !current.previous[action]])) as PadActions;
  return { state: { device, ready: true, previous: sample.actions }, input: sample.input, actions, status: "ready" as const };
}

// A pressed keyboard direction wins that axis; neutral keys leave analog input intact.
// Never add two input sources into an unintended speed multiplier.
export function combinePilotInputs(keyboard: PilotInput, pad: PilotInput): PilotInput {
  const input = idlePilotInput();
  for (const key of ["forward", "right", "up", "turn", "pitch"] as const) {
    const k = Number.isFinite(keyboard[key]) ? keyboard[key] : 0;
    const p = Number.isFinite(pad[key]) ? pad[key] : 0;
    input[key] = Math.max(-1, Math.min(1, k || p));
  }
  input.boost = keyboard.boost || pad.boost;
  return input;
}
