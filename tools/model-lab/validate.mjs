import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import validator from "gltf-validator";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(root, "assets/drones/sources.json"), "utf8"),
);
const results = [];

for (const model of manifest.models) {
  try {
    const bytes = await readFile(resolve(root, "assets/drones", model.file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== model.sha256)
      throw new Error("SHA-256 differs from the source manifest");
    if (
      bytes.toString("ascii", 0, 4) !== "glTF" ||
      bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length
    ) {
      throw new Error("Invalid GLB header/version/length");
    }
    if (bytes.readUInt32LE(16) !== 0x4e4f534a)
      throw new Error("Missing first JSON chunk");
    const gltf = JSON.parse(
      bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)),
    );
    const externalUris = [...(gltf.buffers ?? []), ...(gltf.images ?? [])]
      .map((item) => item.uri)
      .filter((uri) => uri && !uri.startsWith("data:"));
    if (externalUris.length)
      throw new Error(
        `Unexpected external asset references: ${externalUris.join(", ")}`,
      );

    const report = await validator.validateBytes(new Uint8Array(bytes), {
      uri: model.file,
      maxIssues: 1000,
      externalResourceFunction: () =>
        Promise.reject(new Error("External resources are not allowed")),
    });
    let sceneTriangles = 0;
    let primitiveInstances = 0;
    const rotorNodes = [];
    const visited = new Set();
    function visit(index) {
      if (visited.has(index)) throw new Error(`Repeated/cyclic node ${index}`);
      visited.add(index);
      const node = gltf.nodes[index];
      if (/rotor|prop|blade/i.test(node.name ?? "")) rotorNodes.push(node.name);
      if (node.mesh !== undefined) {
        for (const primitive of gltf.meshes[node.mesh].primitives) {
          primitiveInstances++;
          const count =
            gltf.accessors[primitive.indices ?? primitive.attributes.POSITION]
              .count;
          const mode = primitive.mode ?? 4;
          sceneTriangles +=
            mode === 4
              ? count / 3
              : mode === 5 || mode === 6
                ? Math.max(0, count - 2)
                : 0;
        }
      }
      for (const child of node.children ?? []) visit(child);
    }
    if (report.issues.numErrors === 0) {
      for (const index of gltf.scenes[gltf.scene ?? 0].nodes ?? [])
        visit(index);
    }
    const result = {
      id: model.id,
      file: model.file,
      bytes: bytes.length,
      sha256,
      passed: report.issues.numErrors === 0,
      sceneTriangles,
      primitiveInstances,
      meshes: gltf.meshes?.length ?? 0,
      materials: gltf.materials?.length ?? 0,
      animations: gltf.animations?.length ?? 0,
      images: gltf.images?.length ?? 0,
      requiredExtensions: gltf.extensionsRequired ?? [],
      rotorNodes,
      validator: report,
    };
    results.push(result);
    console.log(
      `${result.passed ? "PASS" : "FAIL"} ${model.id}: ${sceneTriangles} triangles, ${report.issues.numErrors} errors, ${report.issues.numWarnings} warnings`,
    );
  } catch (error) {
    results.push({ id: model.id, passed: false, error: error.message });
    console.error(`FAIL ${model.id}: ${error.message}`);
  }
}
const report = {
  schemaVersion: 1,
  testedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  validatorVersion: validator.version(),
  scope:
    "Source integrity and Khronos glTF structural validation; no rendering/performance claim.",
  passed: results.every((result) => result.passed),
  models: results,
};
await mkdir(resolve(root, "reports/model-tests"), { recursive: true });
await writeFile(
  resolve(root, "reports/model-tests/validation.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
if (!report.passed) process.exitCode = 1;
