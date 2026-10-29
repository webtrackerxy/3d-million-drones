# Project reading guide

Updated 2026-10-29. Use this guide to understand Million Drones before changing it.

## Start here

**Start with the [README](../README.md)** for the overview, setup, controls and limitations.
Then use the architecture and data reference below to follow the implementation.

Million Drones is a browser WebGPU demo of one million individually addressable drones over
Greater London. Compact route descriptors and shared sampled routes define automatic motion;
the GPU evaluates poses and chooses rendering detail. Three designs share that pipeline. One
selected drone can use a CPU manual-flight override. There is no simulation server or persistent
per-drone database in the current runtime.

The experimental v0.1.0 release is deployed at https://3d-million-drones.vercel.app. Deployment
does not mean the remaining browser/GPU, physical controller, soak or performance gates passed.

## Recommended reading order

| Order | Document | What to learn |
| --- | --- | --- |
| 1 | [README](../README.md) | Product overview, setup, controls, credits and limitations. |
| 2 | [Architecture](architecture.md) | Current ownership, package boundaries, coordinates and CPU/GPU pipeline. |
| 3 | [Data structures](data-structures.md) | Mission, route, descriptor, pose, rendering and map layouts. |
| 4 | [Testing](testing.md) | Reproducible commands, fixture coverage and browser/GPU acceptance boundaries. |

## Follow one drone through the code

1. Start with [core contracts](../packages/core-types/src/index.ts) and
   [type assignment](../packages/core-types/src/drone-types.ts). Stable ID is the descriptor
   array index; design is `id % 3`.
2. Read [London fleet generation](../packages/city/src/fleet.ts). A mission becomes sampled
   routes; `londonDescriptors()` assigns each active ID a route, phase, speed and offsets.
3. Read [flight evaluation](../packages/flight/src/index.ts). `poseAt()` is the CPU reference
   for automatic position/orientation at a simulation timestamp.
4. Read [GPU rendering](../packages/render/src/index.ts) and
   [draw layout](../packages/render/src/draw-layout.ts). The GPU evaluates all active poses,
   applies the one-ID override, classifies visible IDs and writes seven indirect draws.
5. Read [manual flight](../packages/flight/src/manual.ts) and the selected-pose/control functions
   in [app composition](../apps/sky/src/main.ts). Takeover preserves velocity/attitude; return
   blends back to the moving planned route without duplicating the drone.
6. Read [London scene streaming](../apps/sky/src/london-scene.ts). Camera-dependent map detail
   residency affects visuals; it does not own route progress or population.

## Choose the next document by task

| Task | Read next |
| --- | --- |
| Change routes or units | [Data structures](data-structures.md), [fleet compiler](../packages/city/src/fleet.ts), [CPU reference](../packages/flight/src/index.ts). |
| Change map projection or streaming | [Architecture](architecture.md), [local London data notes](../apps/sky/public/london/README.md), [map scene](../apps/sky/src/london-scene.ts). |
| Change selection, picking or follow | [Renderer](../packages/render/src/index.ts), [app composition](../apps/sky/src/main.ts). |
| Change manual flight or input | [Manual state](../packages/flight/src/manual.ts), [gamepad adapter](../packages/flight/src/gamepad.ts). |
| Change models, counts or LOD | [Draw layout](../packages/render/src/draw-layout.ts), [source provenance](../assets/drones/sources.json). |
| Change collision diagnostics | [Data structures](data-structures.md), [GPU monitor](../packages/render/src/collisions.ts). |
| Validate a change or performance claim | [Testing](testing.md). Record evidence for the exact artifact, device and scenario. |

## Working guideline

- Read existing source alongside its specification. Keep implemented behaviour, historical
  measurements and future acceptance targets separate.
- Keep stable IDs and the selected active population. Camera/quality changes may alter visual
  detail, not simulation membership or route progress.
- Use local metres with Y up, seconds for flight maths, and explicit conversion at packed
  millisecond timestamps. Quaternions store orientation; displayed Euler angles are derived.
- Keep route/scenario maths pure and worker-safe. Do not add one scene object or CPU frame
  update per drone. Manual control remains one existing ID with one GPU override.
- Keep local ODbL map/proof hashes and asset licences. Google tiles are optional visual content,
  separate from local route/clearance data. Builds must work without a reference checkout.
- Run checks appropriate to the change. `yarn run check` runs TypeScript, package boundaries
  and source tests; `yarn build` produces the web and offline artifacts. Use `yarn shaders:check`
  for affected shader generation. Source/build success alone does not prove browser/GPU behaviour.
- Commit changes after their relevant checks pass. Keep env files and generated builds out of
  source commits. Update the public documentation when behaviour or packed contracts change.

This guide and the data-structure document describe the current implementation. They do not
introduce a new runtime format, change the architecture or complete an acceptance milestone.
