import fs from "node:fs";
import { createHash } from "node:crypto";
const root = "assets/city/london",
  publicRoot = "apps/sky/public/london";
const o = JSON.parse(fs.readFileSync(`${root}/overview.json`)),
  m = JSON.parse(fs.readFileSync(`${root}/manifest.json`));
const area = (ring) =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;
o.areas = o.areas.filter(
  ([kind, polygons]) => area(polygons[0]) > (kind === "water" ? 800 : 6000),
);
o.roads = o.roads.filter(([kind]) => kind <= 6);
o.landmarks = [];
let buildings = 0;
for (const t of m.tiles) {
  const text = fs.readFileSync(`${publicRoot}/${t.file}`, "utf8"),
    first = text.indexOf(",");
  const data = JSON.parse(text.slice(first + 1, -2));
  const tall = data.b.filter((b) => b[2] >= 45);
  if (tall.length) {
    o.landmarks.push({ key: t.key, x: t.x, z: t.z, b: tall });
    buildings += tall.length;
  }
}
const bytes = JSON.stringify(o);
fs.writeFileSync(`${root}/overview.json`, bytes);
m.overview = {
  bytes: Buffer.byteLength(bytes),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  coarseBuildings: buildings,
  areaThresholdM2: { water: 800, green: 6000 },
  roadMaximumClass: 6,
};
m.dataSha256 = createHash("sha256")
  .update(JSON.stringify(m.tiles.map((t) => [t.key, t.sha256])))
  .digest("hex");
fs.writeFileSync(`${root}/manifest.json`, JSON.stringify(m));
fs.writeFileSync(`${publicRoot}/manifest.json`, JSON.stringify(m));
console.log({
  overviewBytes: bytes.length,
  areas: o.areas.length,
  roads: o.roads.length,
  tallBuildings: buildings,
  places: o.places.length,
});
