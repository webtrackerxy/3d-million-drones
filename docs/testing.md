# Testing and validation

Updated 2026-10-29 for experimental v0.1.0. This guide distinguishes runnable source checks,
build checks, browser/GPU fixtures and performance acceptance. Start with the [README](../README.md)
for setup and the [architecture](architecture.md) for ownership.

## Run the available checks

Use Node 24.x and Yarn 1.22.22 from the repository root:

```sh
yarn install --frozen-lockfile
yarn run check
yarn build
yarn shaders:check
```

`yarn run check` is required: bare `yarn check` invokes Yarn 1's own dependency-integrity command.
Each command must finish with exit code zero. The shader command writes generated artifacts
under an ignored `reports/shader-checks/` folder; it does not require a GPU. Tests use checked-in
local map/model inputs and do not need live imagery credentials or a reference checkout.

| Command | What it checks | What it does not establish |
| --- | --- | --- |
| `yarn typecheck` | TypeScript contracts and imports. | Runtime/GPU correctness. |
| `yarn boundaries` | Package dependency rules and cycles. | Simulation behaviour. |
| `yarn test` | Node source fixtures; currently 71 tests. | Browser input, shader execution or device performance. |
| `yarn run check` | The three source checks above. | Full acceptance. |
| `yarn build` | Model preparation, Vite web build and adjacent-folder offline build. | Successful browser rendering or live Google imagery. |
| `yarn shaders:check` | Generates 27 WGSL stages across flight, picking, collision, models and selected route. | Driver compilation, compute execution, GPU readback or lifetime correctness. |

## Source-fixture coverage

| Area | Fixtures and useful failures |
| --- | --- |
| [Automatic flight](../packages/flight/src/flight.test.ts) | Independent straight/circle/vertical references, packed descriptors, loop seams, stable seeds, pause and invalid routes. |
| [Manual flight](../packages/flight/src/manual.test.ts) | Takeover velocity/attitude continuity, coasting/braking, fixed-tick agreement at 30/60/120 Hz, held acceleration, pitch, floor/ceiling and continuous return. |
| [Gamepad](../packages/flight/src/gamepad.test.ts) | Dead zones, neutral arming, press edges, disconnect/focus gates, custom mappings and mixed keyboard/analogue input. |
| [London fleet](../packages/city/src/fleet.test.ts) | 30%/70% cohorts, stable prefixes, scheduled starts, launch/hold/return phases, roaming variation, model clearance and mismatched inputs. |
| [City and obstacles](../packages/city/src/city.test.ts) | Local frame and authored route contracts; adjacent city fixtures cover obstacles, London identity and bounded residency. |
| [Collision reference](../packages/flight/src/collision-reference.test.ts) | Independent contact/proximity fixture with negative cells and vertical separation. |
| [Asset and viewer tooling](../tools/sky) | Source hashes/licences, prepared geometry/rotors/envelopes, three-type draw-list contracts and served-control markup. |
| [Map tooling](../tools/london/geography.test.mjs) | Geographic frame/visual alignment contracts. |

Source fixtures may evaluate many CPU poses to validate a scenario; this is not a per-frame
population-sized CPU loop in the application. A count or geometry fixture does not prove that
the browser emitted the corresponding GPU draw.

## Browser/GPU verification

Run `yarn dev`, or `yarn build` followed by `yarn preview`, and open the printed localhost URL
in a WebGPU-capable browser. The offline alternative is `dist/index.html` with all adjacent
`london/`, `draco/`, `drones/` and `licenses/` folders intact. Missing folders are a packaging
failure; the map is not a single-file artifact.

In the flight controls, use the available correctness/benchmark actions and export the JSON
report. Inspect failures rather than accepting a completed button action as success. GPU fixtures
are implemented in [app composition](../apps/sky/src/main.ts); they require actual execution.

Check these independently:

1. Automatic route poses agree with the CPU reference across ordinary, vertical, scheduled,
   holding and boundary/seam cases. Pause must freeze simulation state.
2. Every visible active ID appears once across the seven draws, with valid types and shared
   LOD caps. Force cap overflow and verify marker fallback without losing IDs.
3. Picking handles nearest hit, ID ties, misses, occlusion bounds and behind-camera cases.
   Dragging must not act as a click; follow must preserve orbit angle and zoom.
4. The manual override changes exactly one existing ID and is visible to drawing, picking and
   diagnostics. Takeover must retain current motion; return must be continuous and allow a new
   selection. Test keyboard and a physical gamepad, including focus loss and reconnect/neutral gates.
5. Collision fixture results agree with the independent CPU reference. Deliberately dense/capped
   queries must report incomplete/partial results, including selected-query completeness.
6. Repeated population/scenario resets with warmed picking/diagnostics must release owned GPU
   allocations. Freeze map streaming during these checks so tile arrivals cannot mask drift.
7. Pan through local tile load/eviction, check labels/attribution, then exercise missing-detail
   failure paths. Optional imagery must keep credits and fall back locally on connection failure.

The repository includes report extractors/checkers, but some read fixed paths under `reports/`
and require previously exported JSON, screenshots and the exact tested build. Those inputs are
not bundled with a clean release checkout. Report validators do not launch a browser or create
new GPU evidence; inspect their expected inputs before running them. No `test:e2e` CLI is provided.

## Performance and soak evidence

For a claim, record the commit/build hash, map/scenario identity, hardware/OS, browser version,
GPU/adapter, physical drawing-buffer pixels, active population, visible counts, per-LOD/type
counts, time scale, camera route, warm-up/measurement durations and repeated-run results. Report
mean/p95 frame timing, available CPU/GPU timing, tracked allocations, device errors, truncation
and limitations. Keep wall-frame timing distinct from GPU pass time and tracked memory distinct
from total browser/driver memory.

Include overview, dense, close and camera-sweep views; a distant marker-only overview is not
close-view evidence. Compare repeated runs of the same artifact. A sustained soak should exercise
camera moves, pause/resume, resets, resize and foreground/background recovery while recording
memory trends and worst frame windows. Do not copy results from another project or an older
single-model fleet into current mixed-fleet claims.

## Release status and hosting checks

The initial v0.1.0 release passed 71 source tests, TypeScript, package boundaries, both builds
and WGSL generation. All 1,820 local tile hashes and public asset copies were checked; production
HTTP checks covered HTML, JS/CSS, decoder MIME, model images, real map data, cache headers and
missing-asset 404 responses. These are source/build/content checks.

Current mixed-fleet browser/GPU correctness/lifetime, physical gamepad, imagery rendering,
wider-device performance and sustained soak acceptance remain pending. Historical original-model
or single-fleet results are not current acceptance. Collision-free flight is not claimed.

For later hosting changes, compare served asset hashes to the intended build, check attribution,
test a real tile and missing-file 404s, and verify credential/fallback behaviour. HTTP 200 alone
does not demonstrate a rendered map, successful GPU execution or provider imagery access.
