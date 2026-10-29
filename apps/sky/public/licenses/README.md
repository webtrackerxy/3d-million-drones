# Runtime notices and asset origins

Three.js 0.186.1 (MIT), 3d-tiles-renderer 0.5.3 (Apache-2.0), Proj4js 2.22.0 (MIT), and associated runtime notices are included here. Versions and transitive resolutions are pinned in yarn.lock.

Draco wrapper/WASM are copied unchanged from the pinned Three.js package's examples/jsm/libs/draco directory. Upstream: https://github.com/google/draco (Apache-2.0); licence includes upstream third-party notices. No remote decoder CDN is required. File hashes are in asset-origins.json.

The Google Maps logo comes from the official Google Maps attribution asset ZIP. It is a Google brand asset, not licensed as project code or ODbL data. It is shown only with the optional live Google imagery layer. See https://developers.google.com/maps/documentation/tile/policies and assets/maps/google/README.md in the source checkout.

London data and its source/tile hashes remain under london/README.md and london/manifest.json, with OpenStreetMap ODbL attribution. Google imagery is requested live after explicit connection; it is not included in either build.

Additional installed transitive notices are included for PBF, Mapbox vector-tile/point-geometry, resolve-protobuf-schema and PMTiles (BSD-3-Clause; upstream licence retrieved 2026-10-28 from https://raw.githubusercontent.com/protomaps/PMTiles/main/LICENSE). Unused library modules are tree-shaken from the runtime bundle.
