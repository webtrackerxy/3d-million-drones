import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../../", import.meta.url));
const allowed = {
  "core-types": [],
  flight: ["core-types"],
  city: ["core-types", "flight"],
  metrics: ["core-types"],
  render: ["core-types", "flight", "metrics", "city"],
};
const graph = new Map();
async function visit(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (path.endsWith(".ts")) {
      const source = await readFile(path, "utf8"),
        ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true),
        imports = [];
      function scan(node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          imports.push(node.moduleSpecifier.text);
        ts.forEachChild(node, scan);
      }
      scan(ast);
      const owner = relative(root, path).match(/^packages\/([^/]+)\//)?.[1],
        dependencies = [];
      for (const specifier of imports) {
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(path), specifier),
            other = relative(root, target).match(/^packages\/([^/]+)\//)?.[1];
          if (target.endsWith(".ts")) dependencies.push(target);
          if (owner && other && other !== owner)
            assert(
              allowed[owner].includes(other),
              `${relative(root, path)} cannot import ${other}`,
            );
          if (owner)
            assert(
              !relative(root, target).startsWith("apps/"),
              `Package imports app: ${path}`,
            );
        } else if (
          owner &&
          ["core-types", "flight", "metrics", "city"].includes(owner)
        )
          assert(
            path.endsWith(".test.ts") && specifier.startsWith("node:"),
            `Pure package imports runtime dependency ${specifier}: ${path}`,
          );
      }
      graph.set(path, dependencies);
    }
  }
}
await visit(resolve(root, "packages"));
await visit(resolve(root, "apps/sky"));
const done = new Set(),
  stack = new Set();
function check(path) {
  if (done.has(path)) return;
  assert(
    !stack.has(path),
    `Circular dependency through ${relative(root, path)}`,
  );
  stack.add(path);
  for (const target of graph.get(path) ?? []) check(target);
  stack.delete(path);
  done.add(path);
}
for (const path of graph.keys()) check(path);
console.log(
  `PASS: package import boundaries and dependency cycles across ${graph.size} TypeScript files.`,
);
