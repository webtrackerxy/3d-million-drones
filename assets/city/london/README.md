# Greater London source and derived data

© OpenStreetMap contributors. The city, base-map, road and route databases are available under
the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See [OpenStreetMap copyright](https://www.openstreetmap.org/copyright) for source notices.

Input: `greater-london-260927.osm.pbf`, 129,214,362 bytes, timestamp 2026-09-27T20:23:36Z,
from the local million-robots source data. The provider is
[Geofabrik's Greater London extract](https://download.geofabrik.de/europe/united-kingdom/england/greater-london.html).
The reference checkout was read only. No application code, terrain, imagery or provider tiles
were imported. This is a reproducible dated snapshot, not a live/latest-data claim.

`manifest.json` records the exact input SHA-256, all 1,820 tile hashes, full geographic envelope,
projection, statistics, transformations and ODbL notice. `overview.json` holds the citywide map,
place names and coarse tall-building layer. `navigation.json` preserves the earlier road-flight
network. `fleet.json` is the current 30% ground/roof trips / 70% grouped-roaming database, with
model proofs bound to the tile catalog and a content hash. `launch-candidates.json` retains the
source grass/park polygons used to choose ground pads.

The complete detailed database is in `apps/sky/public/london/tiles`. Each script calls
`globalThis.__londonTileLoaded(key, data)`. Its second argument is plain JSON, with tile coordinates
`x,z`, `b` building pieces, `r` road/path segments and `a` base-map polygon areas. Coordinates
inside a tile are local metres from its 1,024 m grid origin. Building entries contain source ID,
base/top, source flags and polygon rings. Road entries contain class, line endpoints and name.
The runtime accesses only these checked-in assets and never accesses the reference checkout.

Data extent is the full source extract, approximately 60 × 47 km including boundary context.
There are 1,200,400 building/building-part records and 571,776 road/path ways. These are source
record counts, not a count of distinct physical houses or flying drones. 935,202 building records
use default heights; other heights can be inferred from levels. Ground is nominally flat and
there is no ODN/surveyed-terrain claim. Some original invalid geometries can be omitted by osmium;
the independent polygon clipping stage reports zero failures in this build.

The renderer streams bounded detail. Current flight has 120 roaming groups on 480 paths and eleven
ground/roof cycles. Its building margin applies only to the represented model and excludes intentional
supporting surface contact. Terrain, trees, crowds, pad capacity and drone separation are unvalidated.
Routes repeat and do not provide live planning. See decision 0008 for exact contact/proof semantics.

Optional regeneration (ordinary builds use the included data):

```sh
osmium export /path/greater-london-260927.osm.pbf --geometry-types=point,linestring,polygon \
  --add-unique-id=type_id -f geojsonseq -o /tmp/london-features.geojsonseq --overwrite
yarn london:map /tmp/london-features.geojsonseq /path/greater-london-260927.osm.pbf
yarn london:overview
yarn london:routes # optional historical road-flight bundle
yarn london:sites /tmp/london-features.geojsonseq
yarn london:fleet
yarn run check
yarn build
```

The importer uses pinned proj4 2.22.0 and polygon-clipping 0.15.7. The public tile directory is
copied to both static builds. Keep `dist/london` beside `dist/index.html` when opening locally.
