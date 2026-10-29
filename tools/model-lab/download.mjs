import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const base = resolve(root, "assets/drones");
const manifest = JSON.parse(
  await readFile(resolve(base, "sources.json"), "utf8"),
);

// curl follows the publishers' download redirects without executing asset content.
async function download(url, destination, expectedHash) {
  await mkdir(dirname(destination), { recursive: true });
  if (!process.argv.includes("--refresh")) {
    const current = await readFile(destination).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      current &&
      (!expectedHash ||
        createHash("sha256").update(current).digest("hex") === expectedHash)
    ) {
      console.log(
        `${destination.slice(root.length)}: already downloaded${expectedHash ? ", SHA-256 verified" : ""}`,
      );
      return;
    }
  }
  const temporary = `${destination}.tmp`;
  try {
    const result = spawnSync(
      "curl",
      [
        "-fL",
        "--max-time",
        "45",
        "--max-filesize",
        "10000000",
        "-o",
        temporary,
        url,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Download failed: ${url}`);
    const bytes = await readFile(temporary);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (expectedHash && hash !== expectedHash) {
      throw new Error(
        `Source changed: ${url}; expected ${expectedHash}, received ${hash}. Existing asset preserved.`,
      );
    }
    if (expectedHash && bytes.toString("ascii", 0, 4) !== "glTF") {
      throw new Error(`Not a GLB file: ${url}`);
    }
    await rename(temporary, destination);
    console.log(
      `${destination.slice(root.length)}: ${bytes.length} bytes, SHA-256 ${hash}`,
    );
  } finally {
    await rm(temporary, { force: true });
  }
}

for (const model of manifest.models) {
  await download(model.downloadUrl, resolve(base, model.file), model.sha256);
}
await download(
  "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt",
  resolve(base, manifest.licenceFile),
);
