import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { BoxGeometry, Matrix4, Quaternion, Vector3, Matrix3 } from "three";
import { PNG } from "pngjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = await readFile(
  resolve(root, "assets/drones/original/scifi-drone.glb"),
);
const manifest = JSON.parse(
  await readFile(resolve(root, "assets/drones/sources.json"), "utf8"),
);
const original = manifest.models.find((model) => model.id === "scifi-drone");
const hash = createHash("sha256").update(source).digest("hex");
assert.equal(hash, original.sha256, "Original source changed");
const jsonLength = source.readUInt32LE(12);
const gltf = JSON.parse(source.toString("utf8", 20, 20 + jsonLength));
const bin = source.subarray(28 + jsonLength);
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const reader = {
  5126: ["readFloatLE", 4],
  5125: ["readUInt32LE", 4],
  5123: ["readUInt16LE", 2],
  5121: ["readUInt8", 1],
};
function accessor(index) {
  const a = gltf.accessors[index],
    view = gltf.bufferViews[a.bufferView];
  assert(!a.sparse && reader[a.componentType]);
  const [method, size] = reader[a.componentType],
    width = components[a.type];
  return Array.from({ length: a.count }, (_, i) =>
    Array.from({ length: width }, (_, j) => {
      const value = bin[method](
        (view.byteOffset ?? 0) +
          (a.byteOffset ?? 0) +
          i * (view.byteStride ?? width * size) +
          j * size,
      );
      return a.normalized
        ? value / (a.componentType === 5121 ? 255 : 65535)
        : value;
    }),
  );
}
const images = (gltf.images ?? []).map((image) => {
  const view = gltf.bufferViews[image.bufferView];
  return PNG.sync.read(
    bin.subarray(
      view.byteOffset ?? 0,
      (view.byteOffset ?? 0) + view.byteLength,
    ),
  );
});
const srgb = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
function colour(material, uv) {
  const pbr = material.pbrMetallicRoughness ?? {};
  const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
  const texture = pbr.baseColorTexture;
  if (!texture) return factor.slice(0, 3);
  const image = images[gltf.textures[texture.index].source];
  const u = uv[0] - Math.floor(uv[0]),
    v = uv[1] - Math.floor(uv[1]);
  const at =
    (Math.min(image.height - 1, Math.floor(v * image.height)) * image.width +
      Math.min(image.width - 1, Math.floor(u * image.width))) *
    4;
  return [0, 1, 2].map(
    (channel) => srgb(image.data[at + channel] / 255) * factor[channel],
  );
}
const nodes = [];
function visit(index, parent) {
  const node = gltf.nodes[index];
  const transform = node.matrix
    ? new Matrix4().fromArray(node.matrix)
    : new Matrix4().compose(
        new Vector3(...(node.translation ?? [0, 0, 0])),
        new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
        new Vector3(...(node.scale ?? [1, 1, 1])),
      );
  const matrix = new Matrix4().multiplyMatrices(parent, transform);
  if (node.mesh !== undefined)
    for (const primitive of gltf.meshes[node.mesh].primitives) {
      const points = accessor(primitive.attributes.POSITION).map((p) =>
        new Vector3(...p).applyMatrix4(matrix),
      );
      const centre = new Vector3();
      const min = new Vector3(Infinity, Infinity, Infinity),
        max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (const point of points) {
        min.min(point);
        max.max(point);
      }
      centre.addVectors(min, max).multiplyScalar(0.5);
      nodes.push({ node, primitive, matrix, points, centre });
    }
  for (const child of node.children ?? []) visit(child, matrix);
}
for (const index of gltf.scenes[gltf.scene ?? 0].nodes)
  visit(index, new Matrix4());
const origin = nodes.find(({ node }) => /drone body/i.test(node.name)).centre;
const full = { position: [], normal: [], color: [], rotor: [] };
const pivots = [];
let radius = 0;
for (const { node, primitive, matrix, points, centre } of nodes) {
  const normals = accessor(primitive.attributes.NORMAL),
    uvs = accessor(primitive.attributes.TEXCOORD_0);
  const normalMatrix = new Matrix3().getNormalMatrix(matrix);
  const blade = /rotor blade/i.test(node.name);
  const pivot = blade ? centre.clone().sub(origin) : new Vector3();
  const spin = blade ? Math.sign(pivot.x * pivot.z) : 0;
  if (blade) pivots.push({ name: node.name, pivot: pivot.toArray(), spin });
  const indices =
    primitive.indices === undefined
      ? points.map((_, i) => i)
      : accessor(primitive.indices).map((value) => value[0]);
  for (const index of indices) {
    const point = points[index].clone().sub(origin);
    const normal = new Vector3(...normals[index])
      .applyMatrix3(normalMatrix)
      .normalize();
    full.position.push(...point.toArray());
    full.normal.push(...normal.toArray());
    full.color.push(...colour(gltf.materials[primitive.material], uvs[index]));
    full.rotor.push(...pivot.toArray(), spin);
    if (blade) {
      const radial = Math.hypot(point.x - pivot.x, point.z - pivot.z);
      radius = Math.max(
        radius,
        Math.hypot(Math.hypot(pivot.x, pivot.z) + radial, point.y),
      );
    } else radius = Math.max(radius, point.length());
  }
}
assert.equal(full.position.length / 9, 360);
assert.equal(pivots.length, 4);
for (const { pivot, spin } of pivots) {
  assert(
    Math.abs(Math.abs(pivot[0]) - 0.5) < 0.001 &&
      Math.abs(Math.abs(pivot[2]) - 0.5) < 0.001,
  );
  assert(Math.abs(spin) === 1);
}
const low = { position: [], normal: [], color: [], rotor: [] };
function box(width, height, depth, angle, tint) {
  const geometry = new BoxGeometry(width, height, depth).toNonIndexed();
  const rotation = new Matrix4().makeRotationY(angle);
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    low.position.push(
      ...new Vector3()
        .fromBufferAttribute(geometry.attributes.position, i)
        .applyMatrix4(rotation)
        .toArray(),
    );
    low.normal.push(
      ...new Vector3()
        .fromBufferAttribute(geometry.attributes.normal, i)
        .transformDirection(rotation)
        .toArray(),
    );
    low.color.push(...tint);
    low.rotor.push(0, 0, 0, 0);
  }
  geometry.dispose();
}
box(0.43, 0.18, 0.43, 0, [0.06, 0.3, 0.48]);
box(1.45, 0.07, 0.1, Math.PI / 4, [0.12, 0.16, 0.18]);
box(1.45, 0.07, 0.1, -Math.PI / 4, [0.12, 0.16, 0.18]);
assert.equal(low.position.length / 9, 36);
for (const buffers of [full, low])
  for (const key of Object.keys(buffers))
    buffers[key] = buffers[key].map((value) => Number(value.toFixed(7)));
const prepared = {
  schemaVersion: 1,
  sourceSha256: hash,
  sourceUrl: original.sourceUrl,
  licence: "CC0-1.0",
  axis: "Y up, -Z forward",
  origin: "source body bounding-box centre",
  sourceOrigin: origin.toArray(),
  boundingRadius: Math.ceil(radius * 1.02 * 1000) / 1000,
  rotorPivots: pivots,
  modifications: [
    "Merged 22 source meshes into one non-indexed mesh",
    "Baked source texture samples to linear vertex colours",
    "Reconstructed four blade pivots; counter-rotating diagonal pairs",
    "Added authored 36-triangle silhouette",
  ],
  lods: [
    { triangles: 360, ...full },
    { triangles: 36, ...low },
  ],
};
await mkdir(resolve(root, "assets/drones/prepared"), { recursive: true });
await writeFile(
  resolve(root, "assets/drones/prepared/scifi-drone.json"),
  JSON.stringify(prepared),
);
console.log(
  `Prepared 360 / 36 triangle single-draw LODs, 4 rotor pivots, conservative radius ${prepared.boundingRadius} m. Source unchanged.`,
);
