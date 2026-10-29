import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const source = process.argv[2];
assert(source, "Usage: yarn city:import-roads /path/to/regions/canary-wharf");
const manifest = JSON.parse(
  await readFile(resolve(source, "manifest.json"), "utf8"),
);
assert.equal(manifest.region, "canary-wharf");
assert.equal(manifest.origin.easting, 537273);
assert.equal(manifest.origin.northing, 180348);
assert(!manifest.terrain);
const b = await readFile(resolve(source, "roads.bin"));
assert.equal(b.toString("ascii", 0, 4), "RDS1");
const n = b.readUInt32LE(4),
  e = b.readUInt32LE(8),
  ends = 16 + n * 8,
  classesAt = ends + e * 12 + Math.ceil(e / 4) * 4;
assert(n > 0 && e > 0 && classesAt < b.length);
const classes = JSON.parse(b.subarray(classesAt).toString());
assert.equal(classes.length, b.readUInt32LE(12));
const nodes = Array.from({ length: n }, (_, i) =>
  [b.readFloatLE(16 + i * 8), -b.readFloatLE(20 + i * 8)].map(
    (x) => Math.round(x * 100) / 100,
  ),
);
const edges = Array.from({ length: e }, (_, i) => [
  b.readUInt32LE(ends + i * 8),
  b.readUInt32LE(ends + i * 8 + 4),
  b[ends + e * 12 + i],
]);
assert(
  nodes.every((p) => p.every(Number.isFinite)) &&
    edges.every(([a, c, k]) => a < n && c < n && k < classes.length),
);
const output = {
  schemaVersion: 1,
  region: "canary-wharf",
  origin: manifest.origin,
  nodes,
  edges,
  classes,
  license: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "© OpenStreetMap contributors",
  source: {
    file: "roads.bin",
    sha256: createHash("sha256").update(b).digest("hex"),
    bytes: b.length,
    build: manifest.build,
  },
  transformations:
    "Extract RDS1 centreline coordinates; X east, Z south in local metres; 0.01m rounding. Vehicle direction/class retained as source data, not drone airspace permissions. No source code copied.",
};
await writeFile(
  new URL("../../assets/city/canary-wharf/roads.json", import.meta.url),
  JSON.stringify(output),
);
console.log(`Imported ${n} road nodes, ${e} directed source edges`);
