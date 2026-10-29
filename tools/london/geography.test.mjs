import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import proj4 from "proj4";
const root = new URL("../../", import.meta.url),
  manifest = JSON.parse(
    await readFile(new URL("assets/city/london/manifest.json", root), "utf8"),
  );
test("new London projection aligns the known Canary Wharf source landmark and height", async () => {
  const project = proj4("EPSG:4326", manifest.projection.definition);
  const [e, n] = project.forward([-0.0197931, 51.5047959]);
  assert(Math.abs(e - manifest.origin.easting - 258.69) < 0.1);
  assert(Math.abs(manifest.origin.northing - n - 60.22) < 0.1);
  const text = await readFile(
    new URL("apps/sky/public/london/tiles/0_0.js", root),
    "utf8",
  );
  const tile = JSON.parse(text.slice(text.indexOf(",") + 1, -2));
  const tower = tile.b.find((b) => b[0] === "a865554932");
  assert(tower);
  assert.equal(tower[1], 0);
  assert.equal(tower[2], 235);
});
