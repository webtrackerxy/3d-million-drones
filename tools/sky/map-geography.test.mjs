import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createMapGeography,
  wgs84ToEcef,
  formatDronePosition,
} from "../../apps/sky/src/map-geography.ts";
const manifest = JSON.parse(
  fs.readFileSync(
    new URL("../../assets/city/london/manifest.json", import.meta.url),
  ),
);
const geography = createMapGeography(manifest);
test("selected drone coordinates match the known Canary Wharf source location and retain model height", () => {
  const p = geography.geographic([258.69, 235, 60.22]);
  assert(Math.abs(p.latitude - 51.5047959) < 0.000002);
  assert(Math.abs(p.longitude + 0.0197931) < 0.000002);
  assert.equal(p.height, 235);
  assert.match(
    formatDronePosition([258.69, 235, 60.22], geography),
    /Lat 51\.50480 · Lng -0\.01979/,
  );
  assert.equal(formatDronePosition([10, 30, -20]), "X 10.0 m · Z -20.0 m");
});
test("ECEF conversion and local Google rendering frame preserve origin, height and London grid axes", () => {
  assert(Math.abs(wgs84ToEcef(0, 0, 0).x - 6378137) < 0.001);
  assert(Math.abs(wgs84ToEcef(90, 0, 0).z - 6356752.314245) < 0.001);
  const frame = geography.ecefFrame(45),
    local = frame.origin.clone().applyMatrix4(frame.ecefToLocal);
  assert(local.length() < 0.000001);
  const origin = geography.geographic([0, 0, 0]),
    high = wgs84ToEcef(origin.latitude, origin.longitude, 65).applyMatrix4(
      frame.ecefToLocal,
    );
  assert(Math.abs(high.y - 20) < 0.02);
  for (const p of [
    [1000, 0, 0],
    [0, 0, 1000],
  ]) {
    const geo = geography.geographic(p),
      v = wgs84ToEcef(geo.latitude, geo.longitude, 45).applyMatrix4(
        frame.ecefToLocal,
      );
    assert(Math.abs(v.x - p[0]) < 0.3);
    assert(Math.abs(v.z - p[2]) < 0.3);
    assert(v.y > -0.2 && v.y < 0.01);
  }
  assert(geography.geographic([0, 0, 1000]).latitude < origin.latitude);
  assert.throws(() => geography.ecefFrame(NaN), /alignment/);
  assert.throws(() => geography.ecefFrame(501), /alignment/);
});
