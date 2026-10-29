import fs from "node:fs";
import readline from "node:readline";
import assert from "node:assert/strict";
import proj4 from "proj4";

// Preserve actual source polygons for reproducible, model-only surface selection.
// This selects demo geometry, not permission or suitability for real flights.
const input = process.argv[2];
assert(input, "Usage: yarn london:sites /path/to/features.geojsonseq");
const manifest = JSON.parse(
  fs.readFileSync("assets/city/london/manifest.json"),
);
const converter = proj4("EPSG:4326", manifest.projection.definition);
const project = (p) => {
  const [e, n] = converter.forward(p);
  return [e - manifest.origin.easting, manifest.origin.northing - n];
};
const parks = new Map(),
  patches = [];
const names = [
  "Hyde Park",
  "Richmond Park",
  "Blackheath",
  "Clapham Common",
  "Victoria Park",
  "The Regent's Park",
];
const seeds = [
  [-0.165, 51.507],
  [-0.275, 51.445],
  [0.009, 51.469],
  [-0.149, 51.457],
  [-0.037, 51.537],
  [-0.149, 51.532],
].map(project);
let seen = 0;
for await (const line of readline.createInterface({
  input: fs.createReadStream(input),
})) {
  const f = JSON.parse(line.replace(/^\x1e/, "")),
    p = f.properties,
    g = f.geometry;
  if (!g || !["Polygon", "MultiPolygon"].includes(g.type)) continue;
  const named = names.includes(p.name),
    grass =
      ["grass", "meadow", "recreation_ground"].includes(p.landuse) ||
      ["grassland", "heath"].includes(p.natural);
  if (!named && !grass) continue;
  const source = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const polygon of source) {
    const rings = polygon.map((r) => r.map(project));
    if (
      !named &&
      !rings[0].some((p) =>
        seeds.some((s) => Math.hypot(p[0] - s[0], p[1] - s[1]) < 2200),
      )
    )
      continue;
    const entry = { sourceId: f.id, tags: p, rings };
    if (named) {
      const old = parks.get(p.name) || [];
      old.push(entry);
      parks.set(p.name, old);
    }
    if (grass) patches.push(entry);
  }
  seen++;
}
const inside = (p, ring) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      hit = !hit;
  }
  return hit;
};
const inRings = (p, rings) =>
  inside(p, rings[0]) && !rings.slice(1).some((r) => inside(p, r));
function edgeDistance(p, rings) {
  let best = Infinity;
  for (const ring of rings)
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1],
        b = ring[i],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        t = Math.max(
          0,
          Math.min(
            1,
            ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) /
              (dx * dx + dz * dz || 1),
          ),
        );
      best = Math.min(
        best,
        Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz),
      );
    }
  return best;
}
const sites = [];
for (const name of names) {
  const boundaries = parks.get(name) || [],
    candidates = [];
  for (const patch of patches) {
    const xs = patch.rings[0].map((p) => p[0]),
      zs = patch.rings[0].map((p) => p[1]);
    if (
      Math.max(...xs) - Math.min(...xs) < 100 ||
      Math.max(...zs) - Math.min(...zs) < 100
    )
      continue;
    // Coarse interior grid, followed by an exact edge-distance disk containment test.
    for (
      let x = Math.ceil(Math.min(...xs) / 30) * 30;
      x <= Math.max(...xs);
      x += 30
    )
      for (
        let z = Math.ceil(Math.min(...zs) / 30) * 30;
        z <= Math.max(...zs);
        z += 30
      ) {
        const p = [x, z],
          park = boundaries.find((b) => inRings(p, b.rings));
        if (!park || !inRings(p, patch.rings)) continue;
        const radius =
          Math.min(
            180,
            edgeDistance(p, patch.rings),
            edgeDistance(p, park.rings),
          ) - 6;
        if (radius >= 45)
          candidates.push({
            position: p,
            radiusM: Math.floor(radius),
            patch,
            park,
          });
      }
  }
  candidates.sort(
    (a, b) =>
      b.radiusM - a.radiusM ||
      a.position[0] - b.position[0] ||
      a.position[1] - b.position[1],
  );
  // Keep alternatives: the fleet compiler checks buildings, water and nearby higher roofs.
  const selected = [];
  for (const c of candidates) {
    if (
      selected.every(
        (s) =>
          Math.hypot(
            c.position[0] - s.position[0],
            c.position[1] - s.position[1],
          ) > 60,
      )
    )
      selected.push(c);
    if (selected.length === 12) break;
  }
  if (selected.length) sites.push({ name, candidates: selected });
  console.log(name, selected[0]?.radiusM ?? "no suitable grass patch");
}
assert(sites.length >= 4, "Insufficient named open-ground sites");
fs.writeFileSync(
  "assets/city/london/launch-candidates.json",
  JSON.stringify({
    schemaVersion: 1,
    dataSha256: manifest.dataSha256,
    source: manifest.source,
    sites,
    license: "ODbL-1.0",
    scope:
      "Source grass/heath patches inside named parks; flat-ground demo geometry, not real flight sites.",
  }),
);
console.log({
  sourceFeaturesConsidered: seen,
  parks: sites.length,
  grassPatches: patches.length,
});
