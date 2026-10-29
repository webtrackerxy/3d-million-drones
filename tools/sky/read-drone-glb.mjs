import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { Matrix4, Matrix3, Vector3, Quaternion } from "three";

// Offline preparation only. Preserve the original GLBs and their recorded hashes.
export async function readDroneGlb(path, expectedHash) {
  const bytes = await readFile(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, expectedHash, "Original drone source changed");
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
  const bin = bytes.subarray(28 + jsonLength);
  const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const readers = { 5126: ["readFloatLE", 4], 5125: ["readUInt32LE", 4], 5123: ["readUInt16LE", 2], 5121: ["readUInt8", 1] };
  function accessor(index) {
    const a = gltf.accessors[index], view = gltf.bufferViews[a.bufferView];
    assert(!a.sparse && readers[a.componentType]);
    const [method, size] = readers[a.componentType], width = widths[a.type];
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, j) => {
      const value = bin[method]((view.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * (view.byteStride ?? width * size) + j * size);
      return a.normalized ? value / (a.componentType === 5121 ? 255 : 65535) : value;
    }));
  }
  assert.equal((gltf.images ?? []).length, 0, "These additional drone sources must use material colours only");
  const parts = [];
  function visit(index, parent) {
    const node = gltf.nodes[index];
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3(...(node.translation ?? [0, 0, 0])), new Quaternion(...(node.rotation ?? [0, 0, 0, 1])), new Vector3(...(node.scale ?? [1, 1, 1])),
    );
    const matrix = new Matrix4().multiplyMatrices(parent, local), normalMatrix = new Matrix3().getNormalMatrix(matrix);
    if (node.mesh !== undefined) for (const primitive of gltf.meshes[node.mesh].primitives) {
      assert(primitive.mode === undefined || primitive.mode === 4, "Drone mesh must contain triangles");
      const points = accessor(primitive.attributes.POSITION).map(p => new Vector3(...p).applyMatrix4(matrix));
      const normals = accessor(primitive.attributes.NORMAL).map(n => new Vector3(...n).applyMatrix3(normalMatrix).normalize());
      const indices = primitive.indices === undefined ? points.map((_, i) => i) : accessor(primitive.indices).map(v => v[0]);
      const material = gltf.materials[primitive.material];
      parts.push({ name: node.name, material: material.name, color: (material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1]).slice(0, 3), points, normals, indices });
    }
    for (const child of node.children ?? []) visit(child, matrix);
  }
  for (const index of gltf.scenes[gltf.scene ?? 0].nodes) visit(index, new Matrix4());
  return { hash, parts };
}
