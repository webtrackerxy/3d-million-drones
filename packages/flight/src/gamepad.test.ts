import { test } from "node:test";
import assert from "node:assert/strict";
import { beginPilot, stepPilot, syncPilotInput } from "./manual.ts";
import { combinePilotInputs, idlePilotInput, newPadSession, padAxis, samplePad, STANDARD_PAD_PROFILE, stepPadSession, validatePadProfile, type PadSnapshot } from "./gamepad.ts";

const pad = (): PadSnapshot => ({ id: "Logitech fixture", index: 0, mapping: "standard", connected: true,
  axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
const press = (snapshot: PadSnapshot, index: number, value = 1): PadSnapshot => ({ ...snapshot,
  buttons: snapshot.buttons.map((b, i) => i === index ? { value, pressed: value > 0.5 } : b) });
const near = (a: number, b: number, epsilon = 1e-9) => assert(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const arm = (snapshot = pad()) => stepPadSession(newPadSession(), snapshot, true).state;

test("standard gamepad sticks and physical action buttons map to the single pilot input", () => {
  const snapshot = { ...press(pad(), 5), axes: [0.575, -0.575, -0.575, -0.575] };
  const sample = samplePad(snapshot);
  assert(sample.supported); near(sample.input.right, 0.5); near(sample.input.forward, 0.5);
  near(sample.input.turn, -0.5); near(sample.input.up, 0.5); assert(sample.input.boost);
  for (const [name, index] of [["take", 0], ["release", 1], ["follow", 2], ["pause", 9]] as const) {
    assert(samplePad(press(pad(), index)).actions[name]);
  }
  assert(!sample.neutral);
});

test("dead zone rejects drift, rescales analog strength and fails neutral on non-finite values", () => {
  for (const value of [0, 0.1, -0.149, 0.15, -0.15, NaN, Infinity]) assert.equal(padAxis(value), 0);
  near(padAxis(0.575), 0.5); near(padAxis(-0.575), -0.5);
  assert.equal(padAxis(2), 1); assert.equal(padAxis(-2), -1);
  assert(padAxis(0.151) > 0 && padAxis(0.151) < 0.002);
  for (const deadzone of [-1, 1, NaN]) assert.throws(() => padAxis(0.5, deadzone));
  const malformed = { ...pad(), axes: [NaN, Infinity, -Infinity, NaN] };
  assert.deepEqual(samplePad(malformed).input, idlePilotInput());
});

test("first connection waits for neutral and buttons fire once per press, not once per frame", () => {
  const first = stepPadSession(newPadSession(), press(pad(), 0), true);
  assert.equal(first.status, "neutral"); assert(!first.actions.take);
  const released = stepPadSession(first.state, pad(), true);
  assert.equal(released.status, "ready"); assert(!released.actions.take);
  const down = stepPadSession(released.state, press(pad(), 0), true);
  assert(down.actions.take);
  const held = stepPadSession(down.state, press(pad(), 0), true);
  assert(!held.actions.take);
  const up = stepPadSession(held.state, pad(), true);
  assert(stepPadSession(up.state, press(pad(), 0), true).actions.take);
});

test("disconnect, lost focus, page change and replaced devices neutralize input and require rearming", () => {
  const moving = { ...pad(), axes: [1, -1, 0, 0] };
  const active = stepPadSession(arm(), moving, true);
  assert(active.input.forward > 0);
  for (const lost of [stepPadSession(active.state, null, true), stepPadSession(active.state, { ...moving, connected: false }, true), stepPadSession(active.state, moving, false)]) {
    assert.deepEqual(lost.input, idlePilotInput()); assert(!lost.state.ready);
    const heldOnReturn = stepPadSession(lost.state, press(moving, 0), true);
    assert(!heldOnReturn.actions.take); assert.deepEqual(heldOnReturn.input, idlePilotInput());
    const centered = stepPadSession(heldOnReturn.state, pad(), true);
    assert(stepPadSession(centered.state, press(pad(), 0), true).actions.take);
  }
  const replaced = stepPadSession(active.state, { ...moving, id: "Different controller" }, true);
  assert.equal(replaced.status, "neutral"); assert.deepEqual(replaced.input, idlePilotInput());
});

test("raw controllers require explicit custom mapping and validated available indices", () => {
  const raw = { ...pad(), mapping: "", axes: [0.575, -0.575, -1, 1] };
  assert.equal(stepPadSession(newPadSession(), raw, true).status, "unsupported");
  const custom = { ...STANDARD_PAD_PROFILE, allowUnmapped: true, axes: { right: 2, forward: 3, turn: 0, up: 1 }, invertForward: false, invertUp: false,
    buttons: { take: 3, release: 2, follow: 1, pause: 8, boost: 4, pitch: 6, level: 5, brake: 10 } };
  const sample = samplePad(press(raw, 3), custom);
  assert(sample.supported); assert.equal(sample.input.right, -1); assert.equal(sample.input.forward, 1);
  near(sample.input.turn, 0.5); near(sample.input.up, -0.5); assert(sample.actions.take);
  assert(!samplePad({ ...pad(), axes: [0, 0] }).supported);
  assert(!samplePad({ ...pad(), buttons: pad().buttons.slice(0, 5) }).supported);
  for (const value of [-1, 1.5, NaN, 32]) assert.throws(() => validatePadProfile({ ...custom, axes: { ...custom.axes, right: value } }));
  assert.throws(() => validatePadProfile({ ...custom, axes: { ...custom.axes, right: custom.axes.up } }));
  assert.throws(() => validatePadProfile({ ...custom, buttons: { ...custom.buttons, take: 64 } }));
  assert.throws(() => validatePadProfile({ ...custom, buttons: { ...custom.buttons, take: custom.buttons.pause } }));
});

test("keyboard directions win without doubling speed while analog-only axes keep their strength", () => {
  const combined = combinePilotInputs({ forward: -1, right: 0, up: 0, turn: 1, pitch: 0, boost: false }, { forward: 1, right: 0.4, up: 0.2, turn: -1, pitch: 0, boost: true });
  assert.deepEqual(combined, { forward: -1, right: 0.4, up: 0.2, turn: 1, pitch: 0, boost: true });
  assert.deepEqual(combinePilotInputs(idlePilotInput(), idlePilotInput()), idlePilotInput());
  assert.equal(combinePilotInputs({ ...idlePilotInput(), right: NaN }, { ...idlePilotInput(), right: 0.7 }).right, 0.7);
});

test("pause is edge-triggered and holding Start through a focus change never toggles again", () => {
  const start = press(pad(), 9);
  const first = stepPadSession(arm(), start, true); assert(first.actions.pause);
  const held = stepPadSession(first.state, start, true); assert(!held.actions.pause);
  const blur = stepPadSession(held.state, start, false);
  const focus = stepPadSession(blur.state, start, true); assert(!focus.actions.pause);
  const released = stepPadSession(focus.state, pad(), true);
  assert(stepPadSession(released.state, start, true).actions.pause);
});

test("analog pilot acceleration agrees at 30/60/120 Hz and disconnect brakes without a pose jump", () => {
  const snapshot = { ...pad(), axes: [0, -0.575, 0, 0] };
  const run = (hz: number) => {
    let session = arm(), pilot = beginPilot(42, { position: [0, 200, 0], quaternion: [0, 0, 0, 1] });
    for (let i = 0; i < hz * 6; i++) {
      const result = stepPadSession(session, snapshot, true); session = result.state;
      pilot = stepPilot(syncPilotInput(pilot, result.input), result.input, 1 / hz);
    }
    return { session, pilot };
  };
  const a = run(30), b = run(60), c = run(120);
  for (const key of ["position", "velocity"] as const) a.pilot[key].forEach((v, i) => { near(v, b.pilot[key][i]); near(v, c.pilot[key][i]); });
  assert(Math.hypot(...a.pilot.velocity) <= 16); assert(Math.hypot(...a.pilot.velocity) > 15.9);
  const lost = stepPadSession(a.session, null, true), reset = syncPilotInput(a.pilot, lost.input);
  assert.deepEqual(reset.position, a.pilot.position); assert.equal(reset.held.forward, 0);
  let stopped = reset; for (let i = 0; i < 180; i++) stopped = stepPilot(stopped, lost.input, 1 / 60);
  assert(Math.hypot(...stopped.velocity) < 0.0001); assert.equal(stopped.id, 42);
});

test("LT redirects vertical stick to pitch and LB levels on a press edge without losing climb",()=>{
  const stick={...pad(),axes:[0,0,0,-0.575]};
  const climb=samplePad(stick);near(climb.input.up,0.5);assert.equal(climb.input.pitch,0);
  const pitch=samplePad(press(stick,6));near(pitch.input.pitch,0.5);assert.equal(pitch.input.up,0);
  const descend=samplePad({...stick,axes:[0,0,0,1]});assert.equal(descend.input.up,-1);
  assert(!samplePad(press(pad(),6)).neutral,"the pitch modifier must be released before arming");
  const level=stepPadSession(arm(),press(pad(),4),true);assert(level.actions.level);
  assert(!stepPadSession(level.state,press(pad(),4),true).actions.level);
  const blur=stepPadSession(level.state,press(stick,6),false);assert.equal(blur.input.pitch,0);
  const keyboard={...idlePilotInput(),pitch:-1};assert.equal(combinePilotInputs(keyboard,pitch.input).pitch,-1);
  const remapped={...STANDARD_PAD_PROFILE,buttons:{...STANDARD_PAD_PROFILE.buttons,pitch:7,level:10,brake:11}};
  near(samplePad(press(stick,7),remapped).input.pitch,0.5);
  assert(samplePad(press(pad(),10),remapped).actions.level);
});


test("left-stick brake is edge-triggered and cannot fire while arming",()=>{
  const held=press(pad(),10),first=stepPadSession(newPadSession(),held,true);
  assert(!first.actions.brake);assert.equal(first.status,"neutral");
  const ready=stepPadSession(first.state,pad(),true);
  const down=stepPadSession(ready.state,held,true);assert(down.actions.brake);
  assert(!stepPadSession(down.state,held,true).actions.brake);
});
