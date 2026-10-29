// Independent extractor for the documented CNVC/CNAV binary schema. No reference code is imported.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const source = process.argv[2];
assert(
  source,
  "Usage: node tools/city/import-canary-wharf.mjs /path/to/regions/canary-wharf",
);
const target = new URL("../../assets/city/canary-wharf/", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = await readFile(resolve(source, "manifest.json"));
const input = JSON.parse(manifestBytes);
assert.equal(input.region, "canary-wharf");
assert.equal(input.origin.crs, "EPSG:27700");
assert.equal(input.tileSizeM, 256);
assert.equal(input.tiles.length, 64);
assert.equal(new Set(input.tiles.map((t) => `${t.x},${t.y}`)).size, 64);
assert(
  input.tiles.every(
    (t) =>
      Number.isInteger(t.x) &&
      Number.isInteger(t.y) &&
      t.x >= 0 &&
      t.x < 8 &&
      t.y >= 0 &&
      t.y < 8,
  ),
);
assert(
  !input.terrain,
  "Terrain-aware bundles require a new vertical-datum audit",
);
const round = (n) => Math.round(n * 100) / 100;
function columns(bytes, section, expectedKind) {
  assert.equal(bytes.toString("ascii", 0, 4), "CNVC");
  assert.equal(bytes.readUInt16LE(4), 1);
  assert.equal(bytes.readUInt16LE(6), 7);
  const at = bytes.readUInt32LE(16 + section * 8),
    length = bytes.readUInt32LE(20 + section * 8);
  assert(at + length <= bytes.length && length >= 32);
  const b = bytes.subarray(at, at + length);
  assert.equal(b.toString("ascii", 0, 4), "CNAV");
  assert.equal(b.readUInt16LE(4), 1);
  assert.equal(b.readUInt16LE(6), expectedKind);
  const table = b.readUInt32LE(24),
    result = new Map();
  const types = {
    1: [1, "readUInt8"],
    3: [2, "readUInt16LE"],
    5: [4, "readUInt32LE"],
    7: [4, "readFloatLE"],
  };
  assert(table + 4 <= b.length);
  const count = b.readUInt32LE(table);
  assert(table + 4 + count * 12 <= b.length);
  for (let i = 0; i < count; i++) {
    const p = table + 4 + i * 12,
      id = b.readUInt16LE(p),
      type = types[b.readUInt16LE(p + 2)];
    if (!type) continue;
    const offset = b.readUInt32LE(p + 4),
      n = b.readUInt32LE(p + 8);
    assert(offset + n * type[0] <= b.length);
    result.set(
      id,
      Array.from({ length: n }, (_, j) => b[type[1]](offset + j * type[0])),
    );
  }
  return result;
}
const buildings = [],
  sources = [
    {
      file: "manifest.json",
      sha256: hash(manifestBytes),
      bytes: manifestBytes.length,
    },
  ];
let maxRoofM = 0,
  excluded = 0;
for (const tile of input.tiles) {
  assert.match(tile.file, /^tile_\d+_\d+\.nav$/);
  const bytes = await readFile(resolve(source, tile.file));
  sources.push({ file: tile.file, sha256: hash(bytes), bytes: bytes.length });
  const b = columns(bytes, 4, 5),
    r = columns(bytes, 5, 6);
  const ox = input.gridOrigin.x + tile.x * input.tileSizeM,
    north = input.gridOrigin.y + tile.y * input.tileSizeM;
  for (let i = 0; i < b.get(60).length; i++) {
    const flags = b.get(66)[i];
    if (flags & 32) {
      excluded++;
      continue;
    } // virtual transport demand only
    const top = b.get(64)[i],
      base = b.get(63)[i];
    assert(Number.isFinite(top) && top >= base);
    maxRoofM = Math.max(maxRoofM, top);
    if (flags & 2) {
      excluded++;
      continue;
    } // parent outline represented by parts
    const first = b.get(60)[i],
      n = b.get(61)[i],
      ring = [];
    assert(first + n <= r.get(80).length && n >= 3);
    for (let j = first; j < first + n; j++)
      ring.push([round(ox + r.get(80)[j]), round(-north - r.get(81)[j])]);
    if (ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1])
      ring.pop();
    buildings.push({
      osmId: String(BigInt(b.get(70)[i]) * 4294967296n + BigInt(b.get(69)[i])),
      tile: `${tile.x},${tile.y}`,
      base: round(base),
      top: round(top),
      flags,
      ring,
    });
  }
}
const data = { schemaVersion: 1, region: "canary-wharf", buildings };
const dataBytes = JSON.stringify(data);
const output = {
  schemaVersion: 1,
  region: "canary-wharf",
  origin: input.origin,
  bboxWgs84: input.bboxWgs84,
  localBoundsM: {
    minX: input.gridOrigin.x,
    maxX: input.gridOrigin.x + 8 * input.tileSizeM,
    minZ: -(input.gridOrigin.y + 8 * input.tileSizeM),
    maxZ: -input.gridOrigin.y,
  },
  axes: "X east, Y up, Z south; metres",
  verticalDatum:
    "Nominal flat ground at local Y=0; NOT ODN/AMSL. No surveyed terrain.",
  sourceBuild: input.build,
  sourceManifestSha256: hash(manifestBytes),
  sources,
  attribution: "© OpenStreetMap contributors",
  license: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  transformations:
    "Read building outer rings and tops from 64 source tiles; add tile offsets; north becomes negative Z; round to 0.01 m; omit virtual nodes and parent outlines with parts. No pedestrian graph or source code copied.",
  limitations: [
    "Source heights include tags, levels and defaults; incomplete/unverified real-world obstacles.",
    "Outer rings only; no terrain, water polygons, textures, roof shapes or building holes.",
    "Buildings crossing tile edges may extend outside the tile grid.",
  ],
  buildings: buildings.length,
  excluded,
  maxRoofM,
  defaultHeightBuildings: buildings.filter((b) => b.flags & 16).length,
  data: {
    file: "buildings.json",
    sha256: hash(dataBytes),
    bytes: Buffer.byteLength(dataBytes),
  },
};
await writeFile(new URL("buildings.json", target), dataBytes);
await writeFile(
  new URL("manifest.json", target),
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    buildings: output.buildings,
    maxRoofM,
    defaultHeightBuildings: output.defaultHeightBuildings,
    bytes: output.data.bytes,
  }),
);
