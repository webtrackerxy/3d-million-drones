# Folder structure

This guide maps the published repository to the current implementation. Start with the
[reading guide](readness.md), then use [architecture](architecture.md) for ownership and
[data structures](data-structures.md) for record layouts.

## Repository layout

```text
3d-million-drones/
├── apps/
│   └── sky/
│       ├── src/                 Viewer, input, cameras, maps and implementation guides
│       ├── public/
│       │   ├── london/          Local ODbL map data, manifests and tile scripts
│       │   │   └── tiles/       1,820 detail tiles
│       │   ├── drones/          Model reference images and their origins
│       │   ├── draco/           Local decoder wrapper and WASM
│       │   └── licenses/        Runtime notices and asset-origin hashes
│       ├── index.html          UI markup and application entry
│       ├── vite.config.ts      Development and web-build configuration
│       └── package.json        Viewer workspace declaration
├── packages/
│   ├── core-types/src/          Shared tuples, strides, flags, hashes and drone types
│   ├── flight/src/              Pure routes, clock, pilot/return and gamepad maths
│   ├── city/src/                Geographic frame, obstacles and mission compilation
│   ├── render/src/              GPU evaluation, draws, picking, collisions and disposal
│   └── metrics/src/             Timing summaries
├── assets/
│   ├── city/
│   │   ├── london/              Bundled manifest, overview and fleet build inputs
│   │   └── canary-wharf/        Bounded city-lab inputs
│   ├── drones/
│   │   ├── original/           Original CC0 GLB model sources
│   │   ├── prepared/           Generated shared meshes and LOD JSON build inputs
│   │   ├── licences/           Model licence text
│   │   └── sources.json        Authors, source URLs, licences and original hashes
│   └── maps/google/            Attribution/logo asset and provenance
├── tools/
│   ├── sky/                    Build, asset, shader, boundary and report tooling
│   ├── london/                 Offline map/fleet generation and geographic checks
│   ├── city/                   Bounded-city import and navigation preparation
│   └── model-lab/              Original-model download, validation and preview lab
├── docs/
│   ├── readness.md              Reading order and working guidelines
│   ├── folder-structure.md      Repository layout and file-location guide
│   ├── architecture.md         Implemented runtime architecture
│   ├── data-structures.md      Packed contracts and mission/map structures
│   └── testing.md              Commands, fixtures and validation limits
├── README.md                   Setup, controls, credits and limitations
├── package.json                Root scripts, workspace list and pinned dependencies
├── yarn.lock                   Exact dependency resolutions
├── tsconfig.json               TypeScript configuration
├── vercel.json                 Static-hosting build, output and cache configuration
├── .nvmrc                      Node version
└── .gitignore                  Local/generated-file exclusions
```

The tree highlights important paths; it does not list every file. Each package has its own
`package.json`. Tests live beside the relevant source as `*.test.ts` or tooling as `*.test.mjs`;
there is no separate top-level test runner service.

## Where to make a change

| Change | Start here |
| --- | --- |
| UI, selection, simulation composition | [main.ts](../apps/sky/src/main.ts), [index.html](../apps/sky/index.html), [style.css](../apps/sky/src/style.css) |
| Top navigation and implementation pages | [guide-pages.ts](../apps/sky/src/guide-pages.ts), [index.html](../apps/sky/index.html) |
| Local London streaming, labels and geometry | [london-scene.ts](../apps/sky/src/london-scene.ts) |
| Optional live imagery | [google-city.ts](../apps/sky/src/google-city.ts) |
| Automatic route maths and simulation clock | [flight/index.ts](../packages/flight/src/index.ts) |
| Selected-drone control and smooth return | [manual.ts](../packages/flight/src/manual.ts) |
| Gamepad normalization and browser integration | [gamepad.ts](../packages/flight/src/gamepad.ts), [gamepad-controller.ts](../apps/sky/src/gamepad-controller.ts) |
| London missions and descriptor assignment | [fleet.ts](../packages/city/src/fleet.ts) |
| GPU movement, LOD and picking | [render/index.ts](../packages/render/src/index.ts), [draw-layout.ts](../packages/render/src/draw-layout.ts) |
| Optional GPU collision snapshots | [collisions.ts](../packages/render/src/collisions.ts) |
| Model preparation | [prepare-drone.mjs](../tools/sky/prepare-drone.mjs), [prepare-fleet-models.mjs](../tools/sky/prepare-fleet-models.mjs) |
| Static/offline packaging | [vite.config.ts](../apps/sky/vite.config.ts), [build-offline.mjs](../tools/sky/build-offline.mjs) |

## Build inputs and public data

`assets/` contains source/build inputs. `apps/sky/public/` contains files copied to the static
build. London manifest/overview/fleet inputs are imported into the application, while detail
tiles are loaded from the adjacent public map folder. Preserve both roles, source/tile hashes
and licence notices when regenerating data. Visual tile residency does not own simulation state.

Prepared drone JSON is generated by `yarn assets:prepare` and is checked in as a build input.
Keep original model files and provenance. Builds must not depend on an external reference checkout.

## Local and generated folders

These paths may appear after installation or checks; they are not published source inputs:

```text
node_modules/                  Installed dependencies
dist/
├── web/                       Normal HTTPS/localhost static build
├── index.html                 Offline entry
├── london/                    Adjacent offline map data
├── draco/                     Adjacent offline decoder
├── drones/                    Adjacent offline model reference images
└── licenses/                  Adjacent offline notices
reports/                       Locally generated shader/check/benchmark evidence
.vercel/                       Local project/build/deployment metadata
```

`yarn build` creates both distribution variants. Keep the full `dist/web/` folder for hosting.
For the offline variant, keep `dist/index.html` beside `dist/london/`, `dist/draco/`,
`dist/drones/` and `dist/licenses/`; London is not a single-file map. Actual env files, such as
`apps/sky/.env.local`, stay ignored. The intentional public browser token can be embedded by
the build; deployment/server credentials must not be treated as public assets.

See [testing](testing.md) for commands and the distinction between generated artifacts and
executed browser/GPU validation.
