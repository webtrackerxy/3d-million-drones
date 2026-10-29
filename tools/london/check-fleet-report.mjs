import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const root = new URL("../../", import.meta.url),
  folder = new URL("reports/fleet-tests/", root);
const read = async (p) =>
  JSON.parse(await fs.readFile(new URL(p, root), "utf8"));
const report = await read("reports/fleet-tests/fleet-million-correctness.json"),
  fleet = await read("assets/city/london/fleet.json");
assert(
  report.passed &&
    report.scenario === "london" &&
    report.population === 1000000,
);
assert(
  report.normal.passed &&
    report.fixtures.passed &&
    report.pausePassed &&
    report.lifecyclePassed,
);
assert.equal(report.normal.samples + report.fixtures.samples, 4192);
assert.equal(report.fleetPhases.length, 5);
assert(
  report.fleetPhases.every(
    (p) => p.passed && p.samples === 96 && p.invalid === 0,
  ),
);
assert.deepEqual(report.errors, []);
assert.equal(report.counts[3], 1000000);
assert.equal(
  report.counts.slice(0, 3).reduce((a, b) => a + b, 0),
  1000000,
);
assert.equal(report.counts[4], 0);
assert.equal(report.city.clearance.obstacleSha256, fleet.dataSha256);
assert.equal(report.city.clearance.fleetSha256, fleet.contentSha256);
for (const key of [
  "validatedSegments",
  "roamingGroups",
  "roamingRoutes",
  "launchRoutes",
  "groundSites",
  "roofSites",
])
  assert.equal(report.city.clearance[key], fleet.validation[key], key);
assert(report.screenshot.startsWith("data:image/png;base64,"));
const png = Buffer.from(report.screenshot.split(",")[1], "base64");
assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
await fs.writeFile(new URL("million-overview.png", folder), png);
console.log(
  JSON.stringify({
    passed: true,
    population: report.population,
    poseComparisons: 4672,
    maximumPositionErrorM: Math.max(
      report.normal.maxPositionError,
      ...report.fleetPhases.map((p) => p.maxPositionError),
    ),
    allocationDriftBytes: report.lifecycleDriftBytes,
    physicalPixels: [png.readUInt32BE(16), png.readUInt32BE(20)],
    fleetSha256: createHash("sha256")
      .update(await fs.readFile(new URL("assets/city/london/fleet.json", root)))
      .digest("hex"),
  }),
);
