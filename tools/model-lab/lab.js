import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const status = document.querySelector("#status");
const output = document.querySelector("#results");
const viewport = document.querySelector("#viewport");
const button = document.querySelector("#test");
const errors = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) =>
  errors.push(String(event.reason)),
);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#122233");
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
const entries = [];
const offlineData = document.querySelector("#offline-data");
const embedded = offlineData ? JSON.parse(offlineData.textContent) : null;
const savedFiles = new Map();
let renderer;
let controls;
let testing = false;
let selected = "all";
let adapterInfo;

async function save(name, body, type) {
  if (embedded) {
    savedFiles.set(
      name,
      body instanceof Blob ? body : new Blob([body], { type }),
    );
    if (name === "browser.json") {
      document.querySelector("#export").disabled = false;
      document.querySelector("#export-bundle").disabled = false;
    }
    if (name === "contact-sheet.png")
      document.querySelector("#export-image").disabled = false;
    return;
  }
  const result = await fetch(`/__report/${name}`, {
    method: "POST",
    headers: { "Content-Type": type },
    body,
  });
  if (!result.ok)
    throw new Error(`Cannot save ${name}: ${await result.text()}`);
}

function inspect(gltf) {
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const finiteBounds =
    [...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite) &&
    size.length() > 0;
  const materials = new Set();
  const textures = new Set();
  const geometries = new Set();
  const rotorNodes = [];
  let triangles = 0;
  let meshCount = 0;
  let invalidAttributes = 0;
  gltf.scene.traverse((node) => {
    if (/rotor|prop|blade/i.test(node.name)) {
      const bounds = new THREE.Box3().setFromObject(node);
      rotorNodes.push({
        name: node.name,
        originWorld: node.getWorldPosition(new THREE.Vector3()).toArray(),
        boundsCentreWorld: bounds.getCenter(new THREE.Vector3()).toArray(),
      });
    }
    if (!node.isMesh) return;
    meshCount++;
    const geometry = node.geometry;
    triangles +=
      (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    if (!geometries.has(geometry)) {
      geometries.add(geometry);
      for (const attribute of Object.values(geometry.attributes)) {
        for (let i = 0; i < attribute.count; i++) {
          const values = [attribute.getX(i)];
          if (attribute.itemSize > 1) values.push(attribute.getY(i));
          if (attribute.itemSize > 2) values.push(attribute.getZ(i));
          if (attribute.itemSize > 3) values.push(attribute.getW(i));
          if (!values.every(Number.isFinite)) invalidAttributes++;
        }
      }
    }
    for (const material of Array.isArray(node.material)
      ? node.material
      : [node.material]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value?.isTexture) textures.add(value);
    }
  });
  return {
    finiteBounds,
    dimensionsMetres: size.toArray(),
    boundsMin: box.min.toArray(),
    boundsMax: box.max.toArray(),
    triangles,
    meshCount,
    materials: materials.size,
    textures: textures.size,
    invalidAttributes,
    animationClips: gltf.animations.length,
    rotorNodes,
  };
}

function layout(id, view = document.querySelector("#view").value) {
  selected = id;
  entries.forEach((entry, index) => {
    entry.group.visible = id === "all" || entry.model.id === id;
    entry.group.position.set(id === "all" ? (index - 1) * 3.3 : 0, 0, 0);
  });
  const distance =
    id === "all"
      ? Math.max(
          6.5,
          5.8 /
            (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) *
              camera.aspect),
        )
      : 4.5;
  camera.up.set(0, 1, 0);
  if (view === "below")
    camera.position.set(
      id === "all" ? 0 : distance * 0.45,
      -distance * 0.55,
      distance,
    );
  else if (view === "front") camera.position.set(0, distance * 0.08, distance);
  else
    camera.position.set(
      id === "all" ? 0 : distance * 0.3,
      distance * 0.48,
      distance,
    );
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

function snapshot() {
  renderer.info.reset();
  renderer.render(scene, camera);
  const canvas = document.createElement("canvas");
  canvas.width = renderer.domElement.width;
  canvas.height = renderer.domElement.height;
  canvas
    .getContext("2d", { willReadFrequently: true })
    .drawImage(renderer.domElement, 0, 0);
  return canvas;
}

function boundsInFrustum(group) {
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const projected = new THREE.Vector3(x, y, z).project(camera);
        if (
          ![projected.x, projected.y, projected.z].every(
            (value) => Number.isFinite(value) && value >= -1 && value <= 1,
          )
        )
          return false;
      }
  return true;
}

function changedPixels(first, second) {
  const a = first
    .getContext("2d")
    .getImageData(0, 0, first.width, first.height).data;
  const b = second
    .getContext("2d")
    .getImageData(0, 0, second.width, second.height).data;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) +
        Math.abs(a[i + 1] - b[i + 1]) +
        Math.abs(a[i + 2] - b[i + 2]) >
      12
    )
      changed++;
  }
  return changed;
}

async function savePng(canvas, name) {
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Canvas PNG capture failed");
  await save(name, blob, "image/png");
}

async function runTests() {
  if (testing || entries.length !== 3) return;
  testing = true;
  button.disabled = true;
  controls.enabled = false;
  status.textContent = "Running GPU import and three-view pixel checks…";
  const results = [];
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(1280, 800, false);
    camera.aspect = 1280 / 800;
    camera.updateProjectionMatrix();
    await renderer.compileAsync(scene, camera);
    for (const entry of entries) {
      const views = [];
      for (const view of ["above", "front", "below"]) {
        layout(entry.model.id, view);
        entry.group.visible = false;
        const empty = snapshot();
        entry.group.visible = true;
        const rendered = snapshot();
        const pixels = changedPixels(empty, rendered);
        const drawCalls = renderer.info.render.drawCalls;
        const renderedTriangles = renderer.info.render.triangles;
        const fullyFramed = boundsInFrustum(entry.group);
        const image = `${entry.model.id}-${view}.png`;
        await savePng(rendered, image);
        views.push({
          view,
          changedPixels: pixels,
          drawCalls,
          renderedTriangles,
          fullyFramed,
          image,
          passed:
            pixels > 100 &&
            fullyFramed &&
            renderedTriangles >= entry.inspection.triangles,
        });
      }
      results.push({
        id: entry.model.id,
        ...entry.inspection,
        views,
        passed:
          entry.inspection.finiteBounds &&
          entry.inspection.invalidAttributes === 0 &&
          views.every((view) => view.passed),
      });
    }
    layout("all", "above");
    const contactSheetAllBoundsInFrustum = entries.every((entry) =>
      boundsInFrustum(entry.group),
    );
    await savePng(snapshot(), "contact-sheet.png");
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const report = {
      schemaVersion: 1,
      testedAt: new Date().toISOString(),
      scope:
        "Original GLB import, finite geometry/bounds, WebGPU shader/render and three-view non-empty pixel checks. Not a flight or population benchmark.",
      threeRevision: THREE.REVISION,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      adapter: adapterInfo,
      backend: renderer.backend.isWebGPUBackend ? "WebGPU" : "WebGL",
      drawingBuffer: [1280, 800],
      errors: [...errors],
      models: results,
      contactSheetAllBoundsInFrustum,
      passed:
        renderer.backend.isWebGPUBackend &&
        contactSheetAllBoundsInFrustum &&
        results.every((result) => result.passed) &&
        errors.length === 0,
    };
    await save(
      "browser.json",
      JSON.stringify(report, null, 2),
      "application/json",
    );
    output.textContent = JSON.stringify(report, null, 2);
    status.textContent = `${report.passed ? "PASS" : "FAIL"} · ${results.filter((result) => result.passed).length}/3 models · ${results.flatMap((result) => result.views).filter((view) => view.passed).length}/9 view checks · ${report.backend} · ${embedded ? "export JSON / contact sheet to save results" : "saved reports/model-tests/"}`;
    document.title = `${report.passed ? "PASS" : "FAIL"} · Drone Model Lab`;
  } catch (error) {
    status.textContent = `Test failed: ${error.message}`;
    const failure = {
      passed: false,
      testedAt: new Date().toISOString(),
      error: error.stack,
      errors,
      models: results,
    };
    output.textContent = JSON.stringify(failure, null, 2);
    await save(
      "browser.json",
      JSON.stringify(failure, null, 2),
      "application/json",
    ).catch(() => {});
  } finally {
    testing = false;
    button.disabled = false;
    controls.enabled = true;
    resize();
    layout("all", "above");
  }
}

function resize() {
  if (!renderer || testing) return;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(viewport.clientWidth, viewport.clientHeight, false);
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
}

async function start() {
  if (!navigator.gpu)
    throw new Error("WebGPU is unavailable. Use a WebGPU-capable browser.");
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("No WebGPU adapter was available.");
  adapterInfo = Object.fromEntries(
    ["vendor", "architecture", "device", "description"].map((key) => [
      key,
      adapter.info?.[key] ?? "unavailable",
    ]),
  );
  renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend)
    throw new Error("A WebGPU backend is required for this test.");
  renderer.backend.device.addEventListener("uncapturederror", (event) =>
    errors.push(event.error.message),
  );
  renderer.backend.device.lost.then((info) =>
    errors.push(`GPU device lost: ${info.message}`),
  );
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  viewport.append(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight("#dcecff", "#526376", 2.2));
  const key = new THREE.DirectionalLight("#fff1d8", 3.2);
  key.position.set(3, 6, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight("#91d2ef", 1.6);
  fill.position.set(-4, -3, -4);
  scene.add(fill);
  const manifest =
    embedded?.manifest ??
    (await (await fetch("/assets/drones/sources.json")).json());
  const loader = new GLTFLoader();
  for (const model of manifest.models) {
    const gltf = embedded
      ? await loader.parseAsync(
          Uint8Array.from(atob(embedded.models[model.id]), (value) =>
            value.charCodeAt(0),
          ).buffer,
          "",
        )
      : await loader.loadAsync(`/assets/drones/${model.file}`);
    const inspection = inspect(gltf);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const centre = box.getCenter(new THREE.Vector3());
    const span = Math.max(...box.getSize(new THREE.Vector3()).toArray());
    const group = new THREE.Group();
    group.scale.setScalar(2.2 / span);
    gltf.scene.position.sub(centre);
    group.add(gltf.scene);
    scene.add(group);
    entries.push({ model, group, inspection });
    const select = document.createElement("button");
    select.textContent = model.id.replace("-original", "");
    select.addEventListener("click", () => layout(model.id));
    document.querySelector("#model-buttons").append(select);
    const card = document.createElement("article");
    const heading = document.createElement("h2");
    heading.textContent = model.name;
    card.append(heading);
    const stats = document.createElement("p");
    stats.textContent = `${inspection.triangles.toLocaleString()} triangles · ${inspection.meshCount} meshes · ${inspection.materials} materials`;
    card.append(stats);
    const dimensions = document.createElement("p");
    dimensions.textContent = `Original dimensions: ${inspection.dimensionsMetres.map((value) => value.toFixed(3)).join(" × ")} m`;
    card.append(dimensions);
    const rotors = document.createElement("p");
    rotors.textContent = `${inspection.rotorNodes.length} named rotor-related nodes · ${inspection.animationClips} animation clips`;
    card.append(rotors);
    const source = document.createElement("a");
    source.href = model.sourceUrl;
    source.textContent = "Source / CC0 licence";
    source.target = "_blank";
    source.rel = "noopener";
    card.append(source);
    document.querySelector("#cards").append(card);
  }
  resize();
  layout("all");
  renderer.setAnimationLoop(() => {
    if (!testing) {
      controls.update();
      renderer.render(scene, camera);
    }
  });
  window.addEventListener("resize", resize);
  document.querySelector("#all").addEventListener("click", () => layout("all"));
  document
    .querySelector("#view")
    .addEventListener("change", () => layout(selected));
  button.addEventListener("click", runTests);
  document.querySelector("#export").addEventListener("click", async () => {
    const blob = savedFiles.get("browser.json");
    if (!blob) return;
    await exportFile("browser.json", blob, "application/json");
  });
  document
    .querySelector("#export-bundle")
    .addEventListener("click", async () => {
      const handle = await window.showSaveFilePicker({
        suggestedName: "browser-report.html",
        types: [
          {
            description: "Self-contained test report",
            accept: { "text/html": [".html"] },
          },
        ],
      });
      const report = await savedFiles.get("browser.json").text();
      let figures = "";
      for (const [name, blob] of savedFiles) {
        if (!name.endsWith(".png")) continue;
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        figures += `<figure><figcaption>${name}</figcaption><img src="${dataUrl}" alt="${name}"></figure>`;
      }
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Drone model browser test report</title><style>body{font:15px system-ui;background:#0c1420;color:#eaf0f8;margin:32px}img{max-width:100%;height:auto}figure{margin:24px 0}pre{white-space:pre-wrap}h1{font-weight:500}</style><h1>Drone model browser test report</h1><p>Original GLBs, Three.js WebGPU, above/front/below views. Asset checks only; no population performance claim.</p>${figures}<h2>Machine-readable results</h2><pre>${report.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre></html>`;
      const writable = await handle.createWritable();
      await writable.write(html);
      await writable.close();
      status.textContent =
        "PASS · browser report with all captured images exported";
    });
  document.querySelector("#export-image").addEventListener("click", () => {
    const blob = savedFiles.get("contact-sheet.png");
    if (blob) window.open(URL.createObjectURL(blob), "_blank");
  });
  window.modelLab = {
    runTests,
    inspect: () =>
      entries.map((entry) => ({ id: entry.model.id, ...entry.inspection })),
  };
  status.textContent =
    "3/3 models loaded · WebGPU · originals preserved · drag to orbit";
  if (new URLSearchParams(location.search).get("test") === "1")
    await runTests();
}

async function exportFile(name, blob, type) {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [
        {
          description: name,
          accept: { [type]: [name.endsWith(".json") ? ".json" : ".png"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    status.textContent = `PASS · exported ${name}`;
  } catch (error) {
    if (error.name !== "AbortError")
      status.textContent = `Export failed: ${error.message}`;
  }
}

start().catch(async (error) => {
  status.textContent = `Cannot start model lab: ${error.message}`;
  button.disabled = true;
  output.textContent = error.stack;
  await save(
    "browser.json",
    JSON.stringify(
      {
        passed: false,
        testedAt: new Date().toISOString(),
        error: error.stack,
        errors,
      },
      null,
      2,
    ),
    "application/json",
  ).catch(() => {});
});
