import fs from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import proj4 from "proj4";
import clipping from "polygon-clipping";
import assert from "node:assert/strict";

// Input is `osmium export -f geojsonseq -u type_id` of the whole Greater London PBF.
// No code or preprocessed terrain from the reference application is imported.
const input = process.argv[2],
  pbf = process.argv[3];
assert(
  input && pbf,
  "Usage: yarn london:map /path/features.geojsonseq /path/greater-london.osm.pbf",
);
const output = resolve("apps/sky/public/london"),
  assets = resolve("assets/city/london"),
  spool = "/tmp/million-drones-london/spool";
fs.mkdirSync(output + "/tiles", { recursive: true });
fs.mkdirSync(assets, { recursive: true });
fs.mkdirSync(spool, { recursive: true });
const origin = { crs: "EPSG:27700", easting: 537273, northing: 180348 },
  tileSize = 1024;
const bng =
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs";
const converter = proj4("EPSG:4326", bng),
  bbox = [-0.511482, 51.28554, 0.335437, 51.69344];
const project = ([lng, lat]) => {
  const [e, n] = converter.forward([lng, lat]);
  return [e - origin.easting, origin.northing - n];
};
const corners = [
  [bbox[0], bbox[1]],
  [bbox[0], bbox[3]],
  [bbox[2], bbox[1]],
  [bbox[2], bbox[3]],
].map(project);
const bounds = {
  minX: Math.min(...corners.map((p) => p[0])),
  maxX: Math.max(...corners.map((p) => p[0])),
  minZ: Math.min(...corners.map((p) => p[1])),
  maxZ: Math.max(...corners.map((p) => p[1])),
};
const round = (n) => Math.round(n * 10) / 10;
function simplify(points, tolerance = 0.15) {
  if (points.length < 4) return points;
  const keep = new Set([0, points.length - 1]),
    stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(),
      p = points[a],
      q = points[b],
      dx = q[0] - p[0],
      dz = q[1] - p[1],
      l = dx * dx + dz * dz;
    let far = -1,
      max = tolerance;
    for (let i = a + 1; i < b; i++) {
      const v = points[i],
        t = l
          ? Math.max(
              0,
              Math.min(1, ((v[0] - p[0]) * dx + (v[1] - p[1]) * dz) / l),
            )
          : 0,
        d = Math.hypot(v[0] - p[0] - t * dx, v[1] - p[1] - t * dz);
      if (d > max) {
        max = d;
        far = i;
      }
    }
    if (far !== -1) {
      keep.add(far);
      stack.push([a, far], [far, b]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}
function extent(points) {
  return {
    minX: Math.min(...points.map((p) => p[0])),
    maxX: Math.max(...points.map((p) => p[0])),
    minZ: Math.min(...points.map((p) => p[1])),
    maxZ: Math.max(...points.map((p) => p[1])),
  };
}
function rect(x, z) {
  return [
    [
      [x, z],
      [x + tileSize, z],
      [x + tileSize, z + tileSize],
      [x, z + tileSize],
      [x, z],
    ],
  ];
}
const tiles = new Map(),
  buffers = new Map();
let buffered = 0;
function flush() {
  for (const [key, lines] of buffers) {
    fs.appendFileSync(`${spool}/${key}.jsonl`, lines.join(""));
  }
  buffers.clear();
  buffered = 0;
}
function add(key, kind, value) {
  if (!tiles.has(key)) {
    const [x, z] = key.split("_").map(Number);
    tiles.set(key, { key, x, z, buildings: 0, roads: 0, areas: 0 });
    fs.writeFileSync(`${spool}/${key}.jsonl`, "");
  }
  const t = tiles.get(key);
  t[kind === "b" ? "buildings" : kind === "r" ? "roads" : "areas"]++;
  const line = JSON.stringify([kind, value]) + "\n",
    list = buffers.get(key) ?? [];
  list.push(line);
  buffers.set(key, list);
  buffered += line.length;
  if (buffered > 32 * 1048576) flush();
}
function tilePolygon(polygons, kind, make) {
  for (const polygon of polygons) {
    if (!polygon[0] || polygon[0].length < 4) continue;
    const box = extent(polygon[0]);
    const minX = Math.max(
        Math.floor(bounds.minX / tileSize),
        Math.floor(box.minX / tileSize),
      ),
      maxX = Math.min(
        Math.floor(bounds.maxX / tileSize),
        Math.floor(box.maxX / tileSize),
      );
    const minZ = Math.max(
        Math.floor(bounds.minZ / tileSize),
        Math.floor(box.minZ / tileSize),
      ),
      maxZ = Math.min(
        Math.floor(bounds.maxZ / tileSize),
        Math.floor(box.maxZ / tileSize),
      );
    for (let tx = minX; tx <= maxX; tx++)
      for (let tz = minZ; tz <= maxZ; tz++) {
        const x = tx * tileSize,
          z = tz * tileSize;
        let fragments;
        if (
          box.minX >= x &&
          box.maxX <= x + tileSize &&
          box.minZ >= z &&
          box.maxZ <= z + tileSize
        )
          fragments = [polygon];
        else
          try {
            fragments = clipping.intersection(polygon, rect(x, z));
          } catch {
            stats.clipFailures++;
            continue;
          }
        for (const fragment of fragments) {
          const rings = fragment.map((r) =>
            r.map((p) => [round(p[0] - x), round(p[1] - z)]),
          );
          if (rings[0].length >= 4) add(`${tx}_${tz}`, kind, make(rings));
        }
      }
  }
}
function clippedSegment(a, b, minX, minZ, maxX, maxZ) {
  let lo = 0,
    hi = 1;
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - minX],
    [dx, maxX - a[0]],
    [-dz, a[1] - minZ],
    [dz, maxZ - a[1]],
  ]) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) lo = Math.max(lo, t);
      else hi = Math.min(hi, t);
      if (lo > hi) return null;
    }
  }
  const p = [a[0] + lo * dx, a[1] + lo * dz],
    q = [a[0] + hi * dx, a[1] + hi * dz];
  return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.2 ? [p, q] : null;
}
function tileRoad(points, roadClass, name) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const minX = Math.max(
        Math.floor(bounds.minX / tileSize),
        Math.floor(Math.min(a[0], b[0]) / tileSize),
      ),
      maxX = Math.min(
        Math.floor(bounds.maxX / tileSize),
        Math.floor(Math.max(a[0], b[0]) / tileSize),
      );
    const minZ = Math.max(
        Math.floor(bounds.minZ / tileSize),
        Math.floor(Math.min(a[1], b[1]) / tileSize),
      ),
      maxZ = Math.min(
        Math.floor(bounds.maxZ / tileSize),
        Math.floor(Math.max(a[1], b[1]) / tileSize),
      );
    for (let tx = minX; tx <= maxX; tx++)
      for (let tz = minZ; tz <= maxZ; tz++) {
        const x = tx * tileSize,
          z = tz * tileSize,
          pair = clippedSegment(a, b, x, z, x + tileSize, z + tileSize);
        if (pair)
          add(`${tx}_${tz}`, "r", [
            roadClass,
            pair.map((p) => [round(p[0] - x), round(p[1] - z)]),
            name,
          ]);
      }
  }
}
const classes = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "pedestrian",
  "cycleway",
  "footway",
  "path",
  "track",
  "steps",
];
function metres(value) {
  if (!value) return NaN;
  let n = parseFloat(String(value).replace(",", "."));
  if (/ft|feet|'/.test(String(value))) n *= 0.3048;
  return n;
}
const stats = {
  features: 0,
  uniqueBuildings: 0,
  buildingParts: 0,
  defaultHeights: 0,
  roadWays: 0,
  waterFeatures: 0,
  greenFeatures: 0,
  clipFailures: 0,
  invalidHeights: 0,
};
const overview = {
  schemaVersion: 1,
  origin,
  bounds,
  areas: [],
  roads: [],
  places: [],
};
const inputStream = createInterface({
  input: fs.createReadStream(input, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
let maxRoofM = 0;
for await (const line of inputStream) {
  const text = line.charCodeAt(0) === 30 ? line.slice(1) : line;
  if (!text.trim()) continue;
  const f = JSON.parse(text),
    p = f.properties ?? {},
    g = f.geometry;
  stats.features++;
  if (g.type === "Point") {
    if (["city", "town", "suburb"].includes(p.place) && p.name) {
      const xy = project(g.coordinates);
      if (
        xy[0] >= bounds.minX &&
        xy[0] <= bounds.maxX &&
        xy[1] >= bounds.minZ &&
        xy[1] <= bounds.maxZ
      )
        overview.places.push({
          name: p.name.slice(0, 60),
          kind: p.place,
          x: round(xy[0]),
          z: round(xy[1]),
        });
    }
    continue;
  }
  if (g.type === "LineString" && p.highway && classes.includes(p.highway)) {
    const points = simplify(g.coordinates.map(project), 0.4),
      roadClass = classes.indexOf(p.highway);
    tileRoad(points, roadClass, (p.name ?? "").slice(0, 70));
    stats.roadWays++;
    if (roadClass <= 8) {
      for (let i = 1; i < points.length; i++) {
        const pair = clippedSegment(
          points[i - 1],
          points[i],
          bounds.minX,
          bounds.minZ,
          bounds.maxX,
          bounds.maxZ,
        );
        if (pair)
          overview.roads.push([roadClass, ...pair.map((q) => q.map(round))]);
      }
    }
    continue;
  }
  if (!["Polygon", "MultiPolygon"].includes(g.type)) continue;
  const isBuilding =
    (p.building && p.building !== "no") ||
    (p["building:part"] && p["building:part"] !== "no");
  const water =
    p.natural === "water" ||
    p.waterway === "riverbank" ||
    p.landuse === "reservoir";
  const green =
    ["park", "garden", "golf_course", "pitch", "nature_reserve"].includes(
      p.leisure,
    ) ||
    [
      "forest",
      "grass",
      "meadow",
      "recreation_ground",
      "cemetery",
      "allotments",
      "farmland",
      "orchard",
    ].includes(p.landuse) ||
    ["wood", "heath", "grassland", "scrub"].includes(p.natural);
  if (!isBuilding && !water && !green) continue;
  const polygons = (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map(
    (poly) =>
      poly.map((ring) => simplify(ring.map(project), isBuilding ? 0.1 : 0.5)),
  );
  if (isBuilding) {
    const base = Math.max(0, metres(p.min_height) || 0),
      tag = metres(p.height),
      levels = Number(p["building:levels"]);
    let height =
      Number.isFinite(tag) && tag > 0 ? tag : levels > 0 ? levels * 3.2 : 9;
    if (height > 1000 || height <= base) {
      stats.invalidHeights++;
      height = Math.max(
        base + 3,
        levels > 0 && levels < 150 ? levels * 3.2 : 9,
      );
    }
    const flags =
      (p["building:part"] ? 1 : 0) |
      (Number.isFinite(tag) ? 4 : levels > 0 ? 8 : 16);
    maxRoofM = Math.max(maxRoofM, height);
    stats.uniqueBuildings++;
    if (flags & 1) stats.buildingParts++;
    if (flags & 16) stats.defaultHeights++;
    tilePolygon(polygons, "b", (rings) => [
      f.id,
      round(base),
      round(height),
      flags,
      rings,
    ]);
  } else {
    const kind = water ? "water" : "green";
    stats[water ? "waterFeatures" : "greenFeatures"]++;
    tilePolygon(polygons, "a", (rings) => [kind, rings]);
    for (const polygon of polygons) {
      try {
        const clipped = clipping.intersection(polygon, [
          [
            [bounds.minX, bounds.minZ],
            [bounds.maxX, bounds.minZ],
            [bounds.maxX, bounds.maxZ],
            [bounds.minX, bounds.maxZ],
            [bounds.minX, bounds.minZ],
          ],
        ]);
        for (const part of clipped)
          overview.areas.push([
            kind,
            part.map((r) => simplify(r, 6).map((q) => q.map(round))),
          ]);
      } catch {
        stats.clipFailures++;
      }
    }
  }
  if (stats.features % 250000 === 0)
    console.log(
      JSON.stringify({
        processed: stats.features,
        buildings: stats.uniqueBuildings,
        tiles: tiles.size,
      }),
    );
}
flush();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  tileEntries = [];
for (const entry of tiles.values()) {
  const contents = fs.readFileSync(`${spool}/${entry.key}.jsonl`, "utf8"),
    tile = { key: entry.key, x: entry.x, z: entry.z, b: [], r: [], a: [] };
  for (const line of contents.trim().split("\n")) {
    if (!line) continue;
    const [kind, value] = JSON.parse(line);
    tile[kind].push(value);
  }
  const payload = JSON.stringify(tile),
    script = `globalThis.__londonTileLoaded(${JSON.stringify(entry.key)},${payload});`;
  fs.writeFileSync(`${output}/tiles/${entry.key}.js`, script);
  tileEntries.push({
    ...entry,
    file: `tiles/${entry.key}.js`,
    bytes: Buffer.byteLength(script),
    sha256: sha(script),
  });
}
const pbfHash = createHash("sha256");
for await (const chunk of fs.createReadStream(pbf)) pbfHash.update(chunk);
const overviewBytes = JSON.stringify(overview);
fs.writeFileSync(`${assets}/overview.json`, overviewBytes);
const manifest = {
  schemaVersion: 1,
  region: "greater-london",
  origin,
  axes: "X east, Y up, Z south; local metres",
  verticalDatum:
    "Nominal flat ground Y=0, building tags/levels/defaults; no surveyed terrain or ODN claim",
  projection: {
    method:
      "BNG Transverse Mercator with 7-parameter Helmert, not OSTN15 survey accuracy",
    definition: bng,
  },
  bboxWgs84: bbox,
  bounds,
  tileSizeM: tileSize,
  tiles: tileEntries,
  statistics: stats,
  maxRoofM,
  source: {
    file: "greater-london-260927.osm.pbf",
    sha256: pbfHash.digest("hex"),
    bytes: fs.statSync(pbf).size,
    timestamp: "2026-09-27T20:23:36Z",
    provider: "Geofabrik / OpenStreetMap",
  },
  overview: {
    bytes: Buffer.byteLength(overviewBytes),
    sha256: sha(overviewBytes),
  },
  dataBytes: tileEntries.reduce((s, t) => s + t.bytes, 0),
  attribution: "© OpenStreetMap contributors",
  license: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  transformations:
    "Independent osmium GeoJSON export; full source extent; shared BNG projection; polygon clipping and road splitting at 1024m tile edges; 0.1m local rounding. Tag/level/default height extrusions. No reference application code, terrain, imagery or remote map tiles.",
};
fs.writeFileSync(`${assets}/manifest.json`, JSON.stringify(manifest));
fs.writeFileSync(`${output}/manifest.json`, JSON.stringify(manifest));
console.log(
  JSON.stringify({
    complete: true,
    ...stats,
    tiles: tiles.size,
    bytes: manifest.dataBytes,
    overviewBytes: overviewBytes.length,
    maxRoofM,
    bounds,
  }),
);
