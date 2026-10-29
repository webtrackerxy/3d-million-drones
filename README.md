# Million Drones

Experimental desktop WebGPU demo of **1,000,000 individual drones** over Greater London.
Three stable designs share GPU route evaluation, culling, level of detail and indirect draws.

Initial version: **v0.1.0 (experimental prerelease)**.
Website: https://3d-million-drones.vercel.app
Source: https://github.com/webtrackerxy/3d-million-drones

## Run locally

Use Node 24.x and the pinned Yarn 1.22.22 toolchain:

```sh
yarn install --frozen-lockfile
yarn run check
yarn dev
```

Open the localhost address printed by Vite. WebGPU is required; unsupported devices show a
capability message. Use `yarn run check`, not Yarn 1's unrelated bare `yarn check` command.

```sh
yarn build
yarn preview
```

`dist/web/` is the HTTPS static build. `dist/index.html` is the local entry with its adjacent
`london/`, `draco/`, `drones/` and `licenses/` folders. London detail is streamed from local data;
this is not a single-file map. A clean build needs no reference checkout or external tile server.

## Explore

The default scene selects one million active IDs. Population changes are explicit; camera,
quality and map visibility never silently reduce the selected population.

- Choose a London district, orbit, pan or use free flight. Pan map enables drag-to-pan;
  Shift-drag or middle-drag pans in ordinary orbit views. Scroll zooms.
- Click a drone to select/follow it. Its label shows ID, coordinates, model height, speed in
  km/h and Euler roll/pitch/yaw in degrees. The blue path is the planned route; red marks its
  actual pose. The selected mini-map stays at bottom left.
- Top navigation opens separate implementation guides: `#/lod`, `#/paths`, `#/simulation`,
  `#/collision` and `#/credit`. `#/flights` returns to the viewer without resetting simulation.
- Exactly 30% of IDs run scheduled ground/roof launch trips; 70% use seeded roaming groups.
  A mission cohort is not a simultaneous-ascent count. Routes repeat and remain camera-independent.

## Manual flight and gamepad

Right-click a drone and choose Take control. The pilot guide opens automatically.

| Control | Action |
| --- | --- |
| W/A/S/D | Move in the drone's heading frame |
| Left/right arrows | Turn; up/down arrows also move forward/back |
| E / Space; Q / C | Climb; descend |
| I / K; R | Pitch nose up/down; smoothly level pitch |
| Shift | Higher movement speed limit |
| Z / left-stick press | Brake smoothly toward hover |
| Escape / Return to route | Smooth return to the moving planned route |

Holding movement/turn/pitch input ramps its target over four simulation seconds. Release brakes
translation while retaining pitch; pitch is limited to ±45°. Forward follows the pitched heading.
A conservative flat-ground floor is applied. There is no manual terrain/building avoidance.

Pair a gamepad in system settings, press any controller button, click the canvas and release
sticks/action buttons to arm. Standard mapping: left stick moves; right stick turns/climbs;
LT + right stick pitches; LB levels; RB boosts; A takes control; B returns; X follows; Start
pauses; left-stick press brakes. Unknown/raw controllers have custom mapping and raw-axis status. A dead zone suppresses
drift; focus loss or disconnect clears input and requires neutral controls before rearming.

Another drone can be selected/followed as soon as return starts. A new manual takeover waits
for that return to finish; only one existing ID is controlled/returning at a time.

## Three designs and LOD

Stable ID modulo three assigns 333,334 sci-fi drones, 333,333 quadcopters and 333,333 inspection
drones at 1M. IDs retain their design across views and quality/population changes.
Full/silhouette triangles are 360/36, 5,036/84 and 1,252/148. Shared caps are 4,096 full models and
32,768 silhouettes; remaining visible IDs become markers. There are seven fixed indirect draws,
not per-drone scene objects or CPU pose updates. Only the selected pilot is integrated on CPU.

## Maps, imagery and credits

The complete local London road/building/base-map database ships under
[apps/sky/public/london](apps/sky/public/london/README.md), including source/per-tile hashes.
Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Ground is nominally flat and most
building heights include estimates. The dataset is separate from application code and CC0 assets.

The three original models are CC0: sci-fi drone and quadcopter by Innerscene, inspection drone
by 3DAssets.dev. [Source URLs, licences and hashes](assets/drones/sources.json) and
[preparation notes](assets/drones/prepared/README.md) record modifications. The original GLBs are
preserved. Third-party runtime/decoder licences ship in
[apps/sky/public/licenses](apps/sky/public/licenses/README.md). No project-wide open-source
licence is asserted for application code. Theme patterns are adapted from the owner's Million Robots.

Optional Photo uses Google Photorealistic 3D Tiles through Cesium ion asset 2275207, after an
explicit connection. Set `VITE_CESIUM_ION_TOKEN` in ignored `apps/sky/.env.local` before building,
or use the production environment. It is an intentional public browser token, so use an
asset/site-restricted read token. No credential value is committed. Provider restrictions and
quota may prevent imagery; local OSM remains the fallback and the only route/clearance input.
Google/provider attribution stays visible with imagery. No live imagery is bundled offline.

## Validation and limitations

The initial release passes 71 source tests, TypeScript/package boundaries, both static builds,
and WGSL generation. These checks do not establish current GPU or hardware acceptance. The
mixed fleet, picking/disposal fixtures, gamepad/browser interaction, close/dense/sweep timing,
wider devices and sustained soak still need recorded execution. No current 1M city FPS or
collision-free claim is made. Device-specific original-model/older-renderer results are historical.

Collision diagnostics are optional capped snapshots of conservative rotor-sphere contacts and
near neighbours, not avoidance or continuous collision detection. Dense searches report partial
lower bounds. They do not test buildings/Google geometry. Terrain, pad capacity, drone separation,
real flight dynamics, live replanning and formations remain unvalidated or unimplemented.
This demo is not a real-aircraft planning or control system.

Take control preserves the current position, full velocity and orientation. It coasts until
movement input takes over or an explicit brake is applied. Z, Brake to hover or left-stick
press starts smooth braking. Focus/controller loss or leaving the viewer also ends coasting.
