import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DRONE_TYPES, DRONE_ENVELOPE_RADIUS_M, droneType, droneTypeCounts } from "../../packages/core-types/src/drone-types.ts";
import { manualFloorM } from "../../packages/flight/src/manual.ts";
import { Euler, Quaternion, Vector3 } from "three";
import { droneDrawLayout, auditDroneDraws } from "../../packages/render/src/draw-layout.ts";
const asset = JSON.parse(
  await readFile(
    new URL("../../assets/drones/prepared/scifi-drone.json", import.meta.url),
    "utf8",
  ),
);
test("prepared asset preserves provenance and aligned finite vertex attributes", async () => {
  const source = await readFile(
    new URL("../../assets/drones/original/scifi-drone.glb", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    asset.sourceSha256,
  );
  assert.deepEqual(
    asset.lods.map((lod) => lod.triangles),
    [360, 36],
  );
  assert.equal(asset.boundingRadius, DRONE_ENVELOPE_RADIUS_M);
  for (const lod of asset.lods) {
    const count = lod.triangles * 3;
    assert.equal(lod.position.length, count * 3);
    assert.equal(lod.normal.length, count * 3);
    assert.equal(lod.color.length, count * 3);
    assert.equal(lod.rotor.length, count * 4);
    for (const array of [lod.position, lod.normal, lod.color, lod.rotor])
      assert(array.every(Number.isFinite));
    for (let i = 0; i < count; i++)
      assert(
        Math.abs(Math.hypot(...lod.normal.slice(i * 3, i * 3 + 3)) - 1) < 1e-5,
      );
    assert(lod.color.every((value) => value >= 0 && value <= 1));
  }
});
test("four local motor axes and opposite diagonal spin directions", () => {
  assert.equal(asset.rotorPivots.length, 4);
  assert.equal(
    new Set(
      asset.rotorPivots.map(
        (rotor) => `${Math.sign(rotor.pivot[0])},${Math.sign(rotor.pivot[2])}`,
      ),
    ).size,
    4,
  );
  const [a, b, c, d] = asset.rotorPivots;
  assert.equal(a.spin * d.spin, 1);
  assert.equal(b.spin * c.spin, 1);
  assert.equal(a.spin * b.spin, -1);
  for (const rotor of asset.rotorPivots) {
    assert(Math.abs(Math.abs(rotor.pivot[0]) - 0.5) < 1e-5);
    assert(Math.abs(Math.abs(rotor.pivot[2]) - 0.5) < 1e-5);
  }
});
test("swept rotor vertices stay inside the declared conservative sphere", () => {
  const full = asset.lods[0];
  let movingVertices = 0;
  for (let i = 0; i < full.position.length / 3; i++) {
    const p = full.position.slice(i * 3, i * 3 + 3),
      r = full.rotor.slice(i * 4, i * 4 + 4);
    if (r[3]) movingVertices++;
    const radius = Math.hypot(p[0] - r[0], p[2] - r[2]);
    for (let step = 0; step < 32; step++) {
      const angle = (step / 32) * Math.PI * 2 * r[3],
        c = Math.cos(angle),
        s = Math.sin(angle),
        x = c * (p[0] - r[0]) + s * (p[2] - r[2]) + r[0],
        z = c * (p[2] - r[2]) - s * (p[0] - r[0]) + r[2];
      assert(
        Math.hypot(x, p[1], z) <= asset.boundingRadius,
        "Animated rotor escaped culling bound",
      );
      assert(
        Math.abs(Math.hypot(x - r[0], z - r[2]) - radius) < 1e-6,
        "Rotor moved away from its local motor axis",
      );
      if (!r[3]) {
        assert(Math.abs(x - p[0]) < 1e-8);
        assert(Math.abs(z - p[2]) < 1e-8);
      }
    }
  }
  assert(movingVertices > 0);
});

test("all three designs preserve provenance, unit normals, supporting contact and swept clearance", async () => {
  for (const type of DRONE_TYPES) {
    const model = JSON.parse(await readFile(new URL(`../../assets/drones/prepared/${type.id}.json`, import.meta.url), "utf8"));
    const source = await readFile(new URL(`../../assets/drones/original/${type.id}.glb`, import.meta.url));
    assert.equal(createHash("sha256").update(source).digest("hex"), model.sourceSha256);
    assert.equal(model.licence, "CC0-1.0");
    assert.deepEqual(model.lods.map(l => l.triangles), [type.fullTriangles, type.lowTriangles]);
    assert.equal(model.boundingRadius, asset.boundingRadius);
    const pivots = new Set(); let moving = 0;
    for (const [level, lod] of model.lods.entries()) {
      const vertices = lod.triangles * 3;
      assert.equal(lod.position.length, vertices * 3); assert.equal(lod.rotor.length, vertices * 4);
      assert.equal(lod.color.length, vertices * 3); assert.equal(lod.normal.length, vertices * 3);
      for (const values of [lod.position, lod.normal, lod.rotor, lod.color]) assert(values.every(Number.isFinite));
      assert(lod.color.every(v => v >= 0 && v <= 1));
      let minimumY = Infinity;
      for (let i = 0; i < vertices; i++) {
        const p = lod.position.slice(i * 3, i * 3 + 3), r = lod.rotor.slice(i * 4, i * 4 + 4);
        minimumY = Math.min(minimumY, p[1]);
        assert(Math.abs(Math.hypot(...lod.normal.slice(i * 3, i * 3 + 3)) - 1) < 1e-5);
        if (!level && r[3]) { pivots.add(r.slice(0, 3).join(",")); moving++; }
        for (let step = 0; step < 16; step++) {
          const angle = step * Math.PI / 8 * r[3], c = Math.cos(angle), s = Math.sin(angle);
          const x = c * (p[0] - r[0]) + s * (p[2] - r[2]) + r[0];
          const z = c * (p[2] - r[2]) - s * (p[0] - r[0]) + r[2];
          assert(Math.hypot(x, p[1], z) <= asset.boundingRadius, `${type.id} animated LOD escaped the shared envelope`);
        }
      }
      assert(minimumY >= -0.350001);
      if (!level) assert(Math.abs(minimumY + 0.35) < 1e-6, "Every full model must contact the same supporting surface");
    }
    assert.equal(pivots.size, 4); assert(moving > 0);
    if (type.id === "inspection-drone") assert.equal(moving, 48 * 3, "Only four blade boxes rotate; guards remain static");
  }
});

test("stable types cover the full million without changing prefixes or selected ID 42", () => {
  assert.deepEqual(Array.from({ length: 7 }, (_, id) => DRONE_TYPES[droneType(id)].id), ["scifi-drone", "quadcopter-original", "inspection-drone", "scifi-drone", "quadcopter-original", "inspection-drone", "scifi-drone"]);
  assert.equal(droneType(42), 0);
  for (const population of [1, 2, 3, 10000, 100000, 1000000]) {
    const actual = [0, 0, 0]; for (let id = 0; id < population; id++) actual[droneType(id)]++;
    assert.deepEqual(droneTypeCounts(population), actual);
    assert.equal(actual.reduce((a, b) => a + b, 0), population);
    const layout = droneDrawLayout(population);
    assert.equal(layout.offsets.length, 7);
    for (let i = 1; i < 7; i++) assert.equal(layout.offsets[i], layout.offsets[i - 1] + layout.capacities[i - 1]);
    assert.equal(layout.size, layout.offsets[6] + population);
  }
  assert.deepEqual(droneTypeCounts(1000000), [333334, 333333, 333333]);
  for (const value of [-1, 1.5, NaN]) assert.throws(() => droneType(value));
  assert.throws(() => droneDrawLayout(0)); assert.throws(() => droneTypeCounts(1000001));
});

test("mixed draw audit independently catches missing, duplicated, wrong-type and out-of-range submissions", () => {
  const population = 12, layout = droneDrawLayout(population);
  const ids = new Uint32Array(layout.size), args = new Uint32Array(35);
  const groups = [[0, 3], [1], [2], [6], [4, 7], [5], [8, 9, 10, 11]];
  groups.forEach((group, bucket) => { ids.set(group, layout.offsets[bucket]); args[bucket * 5 + 1] = group.length; });
  const audit = auditDroneDraws(population, ids, args, true);
  assert(audit.passed); assert.deepEqual(audit.typeCounts, [4, 4, 4]); assert.deepEqual(audit.lodCounts, [4, 4, 4]);
  const duplicate = ids.slice(); duplicate[layout.offsets[6]] = 9;
  assert.equal(auditDroneDraws(population, duplicate, args, true).duplicates, 1);
  const wrong = ids.slice(); [wrong[0], wrong[layout.offsets[1]]] = [wrong[layout.offsets[1]], wrong[0]];
  assert.equal(auditDroneDraws(population, wrong, args, true).wrongType, 2);
  const invalid = ids.slice(); invalid[layout.offsets[6]] = 12;
  assert(!auditDroneDraws(population, invalid, args, true).passed);
  const missing = args.slice(); missing[31]--;
  assert.equal(auditDroneDraws(population, ids, missing, true).missing, 1);
  assert(auditDroneDraws(population, ids, missing, false).passed);
  assert.throws(() => auditDroneDraws(population, ids.subarray(1), args, true));
});

test("pitched manual ground floor clears actual model vertices and rotor sweeps for all types",async()=>{
  const attitudes=[];
  for(const pitch of [-Math.PI/4,-Math.PI/12,0,Math.PI/12,Math.PI/4])for(const yaw of [0,1.2])attitudes.push(new Quaternion().setFromEuler(new Euler(pitch,yaw,0,"YXZ")));
  attitudes.push(new Quaternion().setFromEuler(new Euler(0,0,Math.PI/4)),new Quaternion().setFromEuler(new Euler(Math.PI,0,0)));
  const vertex=new Vector3();
  for(const type of DRONE_TYPES){
    const model=JSON.parse(await readFile(new URL(`../../assets/drones/prepared/${type.id}.json`,import.meta.url),'utf8'));
    for(const q of attitudes){
      const floor=manualFloorM(q.toArray());
      for(const lod of model.lods)for(let i=0;i<lod.position.length/3;i++){
        const p=lod.position.slice(i*3,i*3+3),r=lod.rotor.slice(i*4,i*4+4);
        for(let step=0;step<4;step++){
          const angle=step*Math.PI/2*r[3],c=Math.cos(angle),s=Math.sin(angle);
          vertex.set(c*(p[0]-r[0])+s*(p[2]-r[2])+r[0],p[1],c*(p[2]-r[2])-s*(p[0]-r[0])+r[2]).applyQuaternion(q);
          assert(vertex.y+floor>=0.01999,`${type.id} intersects nominal ground while tilted`);
        }
      }
    }
  }
});
