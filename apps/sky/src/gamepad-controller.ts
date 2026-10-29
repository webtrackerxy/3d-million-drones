import { idlePilotInput, newPadSession, stepPadSession, STANDARD_PAD_PROFILE, validatePadProfile, type PadProfile, type PadSnapshot } from "../../../packages/flight/src/gamepad.ts";

export function createGamepadController(options: {
  eligible: () => boolean; focusCanvas: () => void; take: () => void;
  release: () => void; follow: () => void; pause: () => void; level: () => void;
  brake: () => void; inputLost: () => void;
}) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const enabled = get<HTMLInputElement>("gamepad-enabled"), selector = get<HTMLSelectElement>("gamepad-device"),
    layout = get<HTMLSelectElement>("gamepad-layout"), message = get<HTMLElement>("gamepad-status");
  let session = newPadSession(), input = idlePilotInput(), profile = STANDARD_PAD_PROFILE;
  let selectedIndex: number | null = null, deviceList: string | null = null, profileError = "", lastUi = -Infinity;
  function reset() { options.inputLost(); session = newPadSession(); input = idlePilotInput(); lastUi = -Infinity; }
  function configure() {
    profileError = "";
    const custom = layout.value === "custom";
    get<HTMLElement>("gamepad-custom").hidden = !custom;
    try {
      const index = (name: string) => {
        const value = get<HTMLInputElement>(`pad-${name}`).value.trim();
        return value ? Number(value) : NaN;
      };
      const candidate: PadProfile = custom ? {
        axes: { right: index("right"), forward: index("forward"), turn: index("turn"), up: index("up") },
        invertForward: get<HTMLInputElement>("pad-invert-forward").checked,
        invertUp: get<HTMLInputElement>("pad-invert-up").checked,
        buttons: { take: index("take"), release: index("release"), follow: index("follow"), pause: index("pause"), boost: index("boost"), pitch: index("pitch"), level: index("level"), brake: index("brake") },
        allowUnmapped: true,
      } : STANDARD_PAD_PROFILE;
      validatePadProfile(candidate); profile = candidate;
    } catch { profileError = "Custom indices must be distinct non-negative integers: axes 0–31, buttons 0–63."; }
    reset();
  }
  enabled.addEventListener("change", () => { reset(); options.focusCanvas(); });
  selector.addEventListener("change", () => { selectedIndex = Number(selector.value); reset(); options.focusCanvas(); });
  layout.addEventListener("change", () => { configure(); options.focusCanvas(); });
  for (const field of get<HTMLElement>("gamepad-custom").querySelectorAll("input")) field.addEventListener("change", configure);
  window.addEventListener("gamepaddisconnected", event => { if (event.gamepad.index === selectedIndex) reset(); deviceList = null; });
  window.addEventListener("gamepadconnected", () => { deviceList = null; });
  return {
    reset,
    input: () => input,
    poll(now: number) {
      let pads: Gamepad[] = [], error = "";
      try {
        if (typeof navigator.getGamepads !== "function") error = "Gamepad API unavailable. Keyboard controls remain available.";
        else pads = [...navigator.getGamepads()].filter((pad): pad is Gamepad => pad !== null && pad.connected);
      } catch { error = "Browser blocked gamepad access. Use an HTTPS or localhost preview."; }
      if (!pads.some(pad => pad.index === selectedIndex)) {
        selectedIndex = (pads.find(pad => pad.mapping === "standard") ?? pads[0])?.index ?? null;
      }
      const signature = pads.map(pad => `${pad.index}:${pad.id}:${pad.mapping}`).join("|");
      if (signature !== deviceList || !selector.options.length) {
        selector.replaceChildren();
        if (!pads.length) selector.add(new Option("Waiting for a controller…", ""));
        for (const pad of pads) selector.add(new Option(`${pad.index + 1}. ${pad.id.slice(0, 90)}`, String(pad.index)));
        deviceList = signature;
      }
      selector.disabled = !pads.length;
      if (selectedIndex !== null) selector.value = String(selectedIndex);
      const pad = pads.find(pad => pad.index === selectedIndex) ?? null;
      const eligible = enabled.checked && options.eligible() && !profileError && !error;
      const result = stepPadSession(session, pad as PadSnapshot | null, Boolean(eligible), profile);
      if ((session.ready && !result.state.ready) || (session.device !== null && session.device !== result.state.device)) options.inputLost();
      session = result.state; input = result.input;
      if (result.actions.release) options.release();
      else if (result.actions.take) options.take();
      if (result.actions.follow) options.follow();
      if (result.actions.pause) options.pause();
      if (result.actions.level) options.level();
      if (result.actions.brake) options.brake();
      if (now - lastUi >= 100) {
        lastUi = now;
        message.textContent = error || profileError || (!enabled.checked ? "Gamepad off. Keyboard controls remain available."
          : !pad ? "Pair the gamepad in system settings, then press any controller button."
          : result.status === "unsupported" ? "Connected, but no compatible standard mapping. Choose Custom mapping to configure axes/buttons."
          : result.status === "inactive" ? "Connected · click the flight canvas to use the controller."
          : result.status === "neutral" ? "Connected · release sticks and action buttons to arm the controller."
          : "Ready · A take control · B return · LT + right stick pitch · LB level · RB boost.");
        get<HTMLElement>("gamepad-axes").textContent = pad
          ? `Raw axes: ${pad.axes.map((v, i) => `${i}: ${Number.isFinite(v) ? v.toFixed(2) : "?"}`).join(" · ")}` : "No axes to display.";
      }
      return input;
    },
  };
}
