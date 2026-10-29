import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { Box3, BoxGeometry, RingGeometry, Vector3, Matrix4, Matrix3 } from "three";
import { readDroneGlb } from "./read-drone-glb.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, "assets/drones/sources.json"), "utf8"));
const baseline = JSON.parse(await readFile(resolve(root, "assets/drones/prepared/scifi-drone.json"), "utf8"));
const bounds = points => new Box3().setFromPoints(points);
const empty = () => ({ position: [], normal: [], color: [], rotor: [] });

for (const id of ["quadcopter-original", "inspection-drone"]) {
  const source = manifest.models.find(m => m.id === id);
  const model = await readDroneGlb(resolve(root, "assets/drones", source.file), source.sha256);
  const body = model.parts.find(p => p.name === (id === "inspection-drone" ? "shell" : "Center frame"));
  const origin = bounds(body.points).getCenter(new Vector3());
  const all = model.parts.flatMap(p => p.points);
  const box = bounds(all), size = box.getSize(new Vector3());
  const rotorGroups = [];
  if (id === "quadcopter-original") {
    for (const hub of model.parts.filter(p => /^Rotor hub/.test(p.name)))
      rotorGroups.push({ name: hub.name, pivot: bounds(hub.points).getCenter(new Vector3()) });
  } else {
    // This source's dark material contains exactly four disconnected 12-triangle blade boxes.
    const part = model.parts.find(p => p.material === "dark");
    const groups = new Map();
    for (let i = 0; i < part.indices.length; i += 3) {
      const triangle = part.indices.slice(i, i + 3).map(j => part.points[j]);
      const centre = triangle.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / 3);
      const key = `${Math.sign(centre.x)},${Math.sign(centre.z)}`;
      const points = groups.get(key) ?? []; points.push(...triangle); groups.set(key, points);
    }
    assert.equal(groups.size, 4);
    for (const [key, points] of groups) {
      assert.equal(points.length, 36, "Inspection rotor extraction changed");
      rotorGroups.push({ name: `guarded rotor ${key}`, pivot: bounds(points).getCenter(new Vector3()) });
    }
  }
  assert.equal(rotorGroups.length, 4);
  const nearestRotor = point => rotorGroups.reduce((best, r) => r.pivot.distanceToSquared(point) < best.pivot.distanceToSquared(point) ? r : best);
  const triangles = [];
  for (const part of model.parts) for (let at = 0; at < part.indices.length; at += 3) {
    const indices = part.indices.slice(at, at + 3);
    const centre = indices.reduce((v, i) => v.add(part.points[i]), new Vector3()).multiplyScalar(1 / 3);
    const moving = id === "inspection-drone" ? part.material === "dark" : /^Rotor blade/.test(part.name);
    const rotor = moving ? nearestRotor(centre) : null;
    triangles.push({ part, indices, rotor });
  }
  const rotation = new Matrix4().makeRotationY(Math.PI); // Both source cameras face +Z.
  let scale = 1.5 / Math.max(size.x, size.z);
  function point(p) {
    const v = p.clone().sub(origin).multiplyScalar(scale).applyMatrix4(rotation);
    v.y += -0.35 - (box.min.y - origin.y) * scale;
    return v;
  }
  function sweptRadius() {
    let radius = 0;
    for (const { part, indices, rotor } of triangles) for (const index of indices) {
      const p = point(part.points[index]);
      const pivot = rotor ? point(rotor.pivot) : new Vector3();
      radius = Math.max(radius, rotor
        ? Math.hypot(Math.hypot(pivot.x, pivot.z) + Math.hypot(p.x - pivot.x, p.z - pivot.z), p.y)
        : p.length());
    }
    return radius;
  }
  while (sweptRadius() * 1.02 > baseline.boundingRadius) scale *= 0.99;
  const full = empty();
  for (const { part, indices, rotor } of triangles) for (const index of indices) {
    const p = point(part.points[index]);
    const n = part.normals[index].clone().transformDirection(rotation);
    const pivot = rotor ? point(rotor.pivot) : new Vector3();
    const spin = rotor ? Math.sign(pivot.x * pivot.z) : 0;
    full.position.push(...p.toArray()); full.normal.push(...n.toArray()); full.color.push(...part.color);
    full.rotor.push(...pivot.toArray(), spin);
  }
  const pivots = rotorGroups.map(r => ({ name: r.name, pivot: point(r.pivot).toArray(), spin: Math.sign(r.pivot.x * r.pivot.z) }));
  const low = empty();
  function append(geometry, matrix, color, rotor = [0, 0, 0, 0]) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const normals = new Matrix3().getNormalMatrix(matrix);
    for (let i = 0; i < flat.attributes.position.count; i++) {
      low.position.push(...new Vector3().fromBufferAttribute(flat.attributes.position, i).applyMatrix4(matrix).toArray());
      low.normal.push(...new Vector3().fromBufferAttribute(flat.attributes.normal, i).applyMatrix3(normals).normalize().toArray());
      low.color.push(...color); low.rotor.push(...rotor);
    }
    if (flat !== geometry) flat.dispose(); geometry.dispose();
  }
  const bodyBox = bounds(body.points), bodySize = bodyBox.getSize(new Vector3()).multiplyScalar(scale), bodyCentre = point(bodyBox.getCenter(new Vector3()));
  append(new BoxGeometry(bodySize.x, bodySize.y, bodySize.z), new Matrix4().makeTranslation(...bodyCentre.toArray()), body.color);
  const span = Math.hypot(pivots[0].pivot[0], pivots[0].pivot[2]) * 2;
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const matrix = new Matrix4().makeRotationY(angle); matrix.setPosition(bodyCentre);
    append(new BoxGeometry(span, 0.035, 0.055), matrix, [0.09, 0.12, 0.14]);
  }
  for (const { pivot, spin } of pivots) {
    const matrix = new Matrix4().makeTranslation(...pivot);
    append(new BoxGeometry(0.24 * scale, 0.008, 0.025), matrix, id === "inspection-drone" ? [0.055, 0.1, 0.15] : [0.86, 0.22, 0.018], [...pivot, spin]);
    if (id === "inspection-drone") {
      const ring = new Matrix4().makeRotationX(-Math.PI / 2); ring.setPosition(...pivot);
      append(new RingGeometry(0.20 * scale, 0.23 * scale, 8), ring, [0.08, 0.49, 0.53]);
    }
  }
  for (const lod of [full, low]) for (const key of Object.keys(lod)) lod[key] = lod[key].map(v => Number(v.toFixed(7)));
  const asset = {
    schemaVersion: 1, id, name: source.name, sourceSha256: model.hash, sourceUrl: source.sourceUrl, author: source.author, licence: source.licence,
    axis: "Y up, -Z forward", origin: "body-centred X/Z; common gear contact Y=-0.35 m", sourceOrigin: origin.toArray(), demoScale: scale,
    boundingRadius: baseline.boundingRadius, sweptRadius: sweptRadius(), rotorPivots: pivots,
    modifications: ["Merged original meshes; material colours baked into linear vertex colours", "Rotated source +Z front to -Z", "Uniform demo scaling and gear contact alignment within the existing flight envelope", id === "inspection-drone" ? "Extracted four blade boxes from dark material; guards stay static" : "Paired eight half-blades with the nearest original motor hub", "Added matching authored low-detail silhouette"],
    lods: [{ triangles: full.position.length / 9, ...full }, { triangles: low.position.length / 9, ...low }],
  };
  assert.equal(asset.lods[0].triangles, id === "inspection-drone" ? 1252 : 5036);
  for (const lod of asset.lods) for (let i = 0; i < lod.position.length / 3; i++) {
    const p = lod.position.slice(i * 3, i * 3 + 3), r = lod.rotor.slice(i * 4, i * 4 + 4);
    const radius = r[3] ? Math.hypot(Math.hypot(r[0], r[2]) + Math.hypot(p[0] - r[0], p[2] - r[2]), p[1]) : Math.hypot(...p);
    assert(radius <= baseline.boundingRadius, "Prepared LOD exceeds existing clearance envelope");
    assert(p[1] >= -0.350001, "Prepared LOD extends below supporting contact plane");
  }
  await writeFile(resolve(root, `assets/drones/prepared/${id}.json`), JSON.stringify(asset));
  console.log(`Prepared ${id}: ${asset.lods.map(l => l.triangles).join('/')} triangles, four animated rotors, common ${baseline.boundingRadius} m envelope.`);
}
