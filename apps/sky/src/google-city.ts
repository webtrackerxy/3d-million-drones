import * as THREE from "three/webgpu";
import { TilesRenderer } from "3d-tiles-renderer/three";
import { GoogleCloudAuthPlugin, CesiumIonAuthPlugin } from "3d-tiles-renderer/core/plugins";
import { GLTFCesiumRTCExtension } from "3d-tiles-renderer/src/three/plugins/gltf/GLTFCesiumRTCExtension.js";
import {
  LRUCache,
  PriorityQueue,
  DownloadPriorityQueue,
} from "3d-tiles-renderer/core";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { createMapGeography } from "./map-geography.ts";

export type GoogleMapState = "local" | "loading" | "ready" | "error";
export type GoogleMapProvider = "ion" | "google";
export const GOOGLE_ION_ASSET_ID = "2275207";
export function validateGoogleConnection(protocol: string, key: string, provider: GoogleMapProvider = "google") {
  if (!["http:", "https:"].includes(protocol))
    throw new Error(
      "Google 3D needs an HTTP/HTTPS preview. Run yarn dev and open http://localhost:5175.",
    );
  if (provider !== "ion" && provider !== "google")
    throw new Error("Unsupported Google 3D connection");
  if (provider === "ion") {
    if (!/^[A-Za-z0-9._-]{20,4096}$/.test(key.trim()))
      throw new Error("Cesium ion Photo is not configured for this build.");
    return;
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(key.trim()))
    throw new Error(
      "Enter a Google Maps Platform key with Map Tiles API and billing enabled.",
    );
}
// Use baked imagery as an unlit surface without replacing material/texture owners.
// TilesRenderer continues to own and dispose all original GLTF resources.
export function prepareGoogleModel(root: THREE.Object3D, anisotropy = 1) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // Million Robots computes tile bounds and sharpens textures viewed at a slant.
    object.geometry.computeBoundingBox();
    object.geometry.computeBoundingSphere();
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        if (material.map && material.map.anisotropy !== anisotropy) {
          material.map.anisotropy = anisotropy;
          material.map.needsUpdate = true;
        }
        material.emissive.copy(material.color);
        material.emissiveMap = material.map;
        material.emissiveIntensity = 1;
        material.color.setHex(0);
        material.metalness = 0;
      }
      material.toneMapped = false;
      material.fog = false;
      material.needsUpdate = true;
    }
  });
}
export function createGoogleCity(options: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  geography: ReturnType<typeof createMapGeography>;
  onState: (state: GoogleMapState, message: string) => void;
  onCredits: (credits: string) => void;
  anisotropy?: number;
}) {
  let tiles: TilesRenderer | null = null,
    draco: DRACOLoader | null = null,
    ready = false,
    paused = false,
    lastStatus = 0;
  let height = 46,
    lastCredit = "";
  function disconnect(
    message = "Local London map active.",
    state: GoogleMapState = "local",
  ) {
    const old = tiles;
    tiles = null;
    ready = false;
    lastCredit = "";
    options.onCredits("");
    if (old) {
      options.scene.remove(old.group);
    }
    try {
      old?.dispose();
    } finally {
      draco?.dispose();
      draco = null;
      options.onState(state, message);
    }
  }
  return {
    isConnected: () => tiles !== null,
    isReady: () => ready,
    pickOccluders: () => (ready && tiles ? [tiles.group] : []),
    setPaused: (value: boolean) => {
      paused = value;
    },
    setGroundHeight(value: number) {
      const frame = options.geography.ecefFrame(value);
      height = value;
      if (tiles) {
        tiles.group.matrix.copy(frame.ecefToLocal);
        tiles.group.matrixWorldNeedsUpdate = true;
      }
    },
    connect(key: string, protocol: string, baseUrl: string, provider: GoogleMapProvider = "google") {
      validateGoogleConnection(protocol, key, provider);
      const frame = options.geography.ecefFrame(height);
      disconnect();
      const current = new TilesRenderer();
      tiles = current;
      // Give this optional layer its own budgets/queues, isolated from other renderers.
      const lru = new LRUCache();
      lru.unloadPriorityCallback = current.lruCache.unloadPriorityCallback;
      lru.minSize = 48;
      lru.maxSize = 128;
      lru.minBytesSize = 96 * 1024 ** 2;
      lru.maxBytesSize = 192 * 1024 ** 2;
      current.lruCache = lru;
      const downloads = new DownloadPriorityQueue();
      downloads.priorityCallback = current.downloadQueue.priorityCallback;
      downloads.maxJobsPerOrigin = 3;
      current.downloadQueue = downloads;
      const parse = new PriorityQueue();
      parse.priorityCallback = current.parseQueue.priorityCallback;
      parse.maxJobs = 1;
      current.parseQueue = parse;
      const process = new PriorityQueue();
      process.priorityCallback = current.processNodeQueue.priorityCallback;
      process.maxJobs = 8;
      current.processNodeQueue = process;
      current.fetchOptions = {
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      };
      current.errorTarget = 8;
      current.registerPlugin(provider === "ion"
        ? new CesiumIonAuthPlugin({
          apiToken: key.trim(),
          assetId: GOOGLE_ION_ASSET_ID,
          autoRefreshToken: false,
          useRecommendedSettings: false,
        })
        : new GoogleCloudAuthPlugin({
          apiToken: key.trim(),
          autoRefreshToken: false,
          useRecommendedSettings: false,
        }),
      );
      draco = new DRACOLoader()
        .setDecoderPath(new URL("./draco/", baseUrl).href)
        .setWorkerLimit(2);
      // Only load the extensions used here. The general plugin also imports WebGL-only
      // metadata texture readers, which are incompatible with the WebGPU-only bundle.
      const gltfPattern = /\.(gltf|glb)$/i;
      const loader = new GLTFLoader(current.manager)
        .setDRACOLoader(draco)
        .register(() => new GLTFCesiumRTCExtension());
      current.registerPlugin(
        {
          name: "GOOGLE_DRACO_GLTF",
          init() {
            current.manager.addHandler(gltfPattern, loader);
          },
          dispose() {
            current.manager.removeHandler(gltfPattern);
          },
        },
      );
      current.setCamera(options.camera);
      current.group.matrixAutoUpdate = false;
      current.group.matrix.copy(frame.ecefToLocal);
      current.group.matrixWorldNeedsUpdate = true;
      current.group.visible = false;
      current.accelerateRaycast = false;
      current.addEventListener("load-model", ({ scene }) => {
        if (tiles === current) prepareGoogleModel(scene, options.anisotropy ?? 1);
      });
      let failing = false;
      current.addEventListener("load-error", () => {
        if (tiles !== current || failing) return;
        failing = true;
        queueMicrotask(() => {
          if (tiles === current)
            disconnect(
              provider === "ion"
                ? "Photo tiles could not load through Cesium ion. Check provider access, quota and website restrictions. Local London restored."
                : "Google 3D could not load. Check the key, Map Tiles API, billing and website restrictions. Local London restored.",
              "error",
            );
        });
      });
      options.scene.add(current.group);
      options.onState(
        "loading",
        provider === "ion"
          ? "Connecting to Google Photo through Cesium ion… Local London remains visible while tiles load."
          : "Connecting to Google 3D… Local London remains visible while tiles load.",
      );
    },
    disconnect,
    update(width: number, physicalHeight: number, enabled: boolean) {
      if (!tiles) return;
      tiles.group.visible = enabled && ready;
      if (paused || !enabled) return;
      options.camera.updateMatrixWorld();
      tiles.group.updateMatrixWorld(true);
      tiles.setResolution(options.camera, width, physicalHeight);
      tiles.update();
      if (!ready && tiles.visibleTiles.size > 0) {
        ready = true;
        tiles.group.visible = true;
        options.onState(
          "ready",
          "Google 3D active · imagery/terrain only; routes use the local flat-ground model.",
        );
      }
      const credits = tiles
        .getAttributions()
        .filter((a) => a.type === "string")
        .map((a) => String(a.value))
        .filter(Boolean)
        .join("; ");
      if (credits !== lastCredit) {
        lastCredit = credits;
        options.onCredits(credits);
      }
      if (ready && performance.now() - lastStatus > 1000) {
        lastStatus = performance.now();
        options.onState(
          "ready",
          `Google 3D · ${tiles.visibleTiles.size} visible tiles · routes and heights use the local model.`,
        );
      }
    },
  };
}
