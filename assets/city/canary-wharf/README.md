# Canary Wharf building database

© OpenStreetMap contributors. This derived database is available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See [OpenStreetMap copyright](https://www.openstreetmap.org/copyright) for source notices.
The database is separate from the CC0 drone assets and application code.

`buildings.json` contains the building database; `roads.json` contains source road geometry.
`navigation.json` is the derived route database. All three are available under ODbL 1.0.
`manifest.json` records its SHA-256, original manifest/tile hashes, source build,
coordinate origin, transformations, inferred-height count and limitations.

Input: the reference million-robots checkout's `apps/city/public/regions/canary-wharf`
dataset, built 2026-09-29 from `greater-london-260927.osm.pbf`. No reference source code,
pedestrian graph, terrain dataset, imagery, credentials or remote map tiles are included.
The independently written importer reads the documented CNVC/CNAV column layout.

Rebuild with `yarn city:import /path/to/regions/canary-wharf`. Ordinary installation,
build and execution require only the checked-in data, not the reference checkout.

This is a nominal flat-ground model: Y=0 is not ODN, sea level or surveyed ground.
1,077 rendered buildings use default heights; other heights may derive from levels.
Outer rings are extruded without holes or detailed roofs. Parent outlines with parts
are omitted from rendering; the envelope maximum includes all physical source records.
Real obstacles can be absent or inaccurate. The city graph's clearance claim applies
only to this model. Flight permissions and drone-to-drone separation are not established.

Road/navigation extension: `roads.json` records the source `roads.bin` SHA-256 and build metadata.
It has 3,675 local-metre nodes and 5,993 source directed edges. The independent RDS1 reader flips
north to negative Z and rounds to 0.01 m. Vehicle direction/class are retained as provenance,
not flight permissions. `navigation.json` records the exact road JSON and obstacle hashes plus
route-generation and validation metadata. It contains 96 road-guided street trips and 33 district
trips, with rounded corners and checked climbs/crossings/descents. Build with
`yarn city:import-roads /path/to/regions/canary-wharf` and `yarn city:routes`.
