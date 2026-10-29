# Greater London map database — ODbL 1.0

Map data © OpenStreetMap contributors.
Origin and source notices: https://www.openstreetmap.org/copyright
Database licence: https://opendatacommons.org/licenses/odbl/1-0/

This directory contains the complete detailed derived map database used by Million Drones.
`manifest.json` records the source date/hash, projection, data limits and every tile hash.
`tiles/*.js` contain script-wrapped JSON: geographic tile key and local building/road/base-map
geometry. No API key or remote map service is needed. The database is separate from app code
and CC0 drone assets. See the source project's `assets/city/london/README.md` for regeneration.

Heights include defaults/estimates and ground is nominally flat; this is not surveyed terrain.

`fleet.json` contains the current ground/roof launch sites, mission timetables, roaming paths and
model-only proofs. It is an ODbL derivative of the same snapshot. Supporting surface contact is
intentional; these modeled pads do not establish real-world flight permission or obstacle surveys.
