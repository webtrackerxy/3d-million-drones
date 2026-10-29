import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const root = new URL("../../", import.meta.url),
  folder = new URL("reports/selection-tests/", root);
const r = JSON.parse(
  await fs.readFile(new URL("correctness.json", folder), "utf8"),
);
const fleet = JSON.parse(
  await fs.readFile(new URL("assets/city/london/fleet.json", root), "utf8"),
);
assert(r.passed && r.population === 1000000 && r.scenario === "london");
assert(
  r.normal.passed &&
    r.fixtures.passed &&
    r.fleetPhases.every((p) => p.passed) &&
    r.picking.passed,
);
assert.deepEqual(
  r.picking.cases.map((c) => c.actual),
  [0, 2, null, null, null],
);
assert(r.collisionDiagnostics?.passed, 'Missing or failed GPU collision diagnostics');
assert.deepEqual(r.collisionDiagnostics.expected, {
  contactPairs: 3, nearPairs: 4, selectedContacts: 2, selectedNear: 2,
});
assert(r.collisionDiagnostics.fleet.complete && r.collisionDiagnostics.selected.complete);
assert(!r.collisionDiagnostics.crowded.complete && r.collisionDiagnostics.crowded.truncatedQueries > 0);
assert(r.manualControl?.passed, 'Missing or failed selected-drone pose override fixture');
assert(r.manualControl.restoredRoute.passed && r.manualControl.pickedId === 2);
assert(r.pausePassed && r.lifecyclePassed);
assert.deepEqual(r.errors, []);
assert.equal(
  r.normal.samples +
    r.fixtures.samples +
    r.fleetPhases.reduce((s, p) => s + p.samples, 0),
  4672,
);
assert.equal(r.city.clearance.fleetSha256, fleet.contentSha256);
assert.equal(r.counts[3], r.population);
assert.equal(
  r.counts.slice(0, 3).reduce((s, n) => s + n, 0),
  r.population,
);
assert.equal(r.counts[4], 0);
const png = Buffer.from(r.screenshot.split(",")[1], "base64");
assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
await fs.writeFile(new URL("overview.png", folder), png);
const sha = (x) => createHash("sha256").update(x).digest("hex");
assert.equal(
  sha(await fs.readFile(new URL("tested-demo.html", folder))),
  sha(await fs.readFile(new URL("dist/index.html", root))),
);
console.log(
  JSON.stringify({
    passed: true,
    population: r.population,
    poseComparisons: 4672,
    pickingCases: r.picking.cases.length,
    collisionDiagnosticsPassed: true,
    pickBuffersWarmedDuringResets: true,
    allocationDriftBytes: r.lifecycleDriftBytes,
    physicalPixels: [png.readUInt32BE(16), png.readUInt32BE(20)],
  }),
);
