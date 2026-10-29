import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three/webgpu";
import { TilesRenderer } from "3d-tiles-renderer/three";
import {
  createGoogleCity,
  prepareGoogleModel,
  validateGoogleConnection,
} from "../../apps/sky/src/google-city.ts";
import { createMapGeography } from "../../apps/sky/src/map-geography.ts";
const key = "AIza" + "x".repeat(35),
  reference = JSON.parse(
    fs.readFileSync(
      new URL("../../assets/city/london/manifest.json", import.meta.url),
    ),
  );
test("Google setup rejects file origins and missing keys before any tile session", () => {
  assert.throws(() => validateGoogleConnection("file:", key), /HTTP/);
  assert.throws(() => validateGoogleConnection("https:", ""), /key/);
  assert.doesNotThrow(() => validateGoogleConnection("https:", key));
});
test("Google imagery material keeps GLTF resource ownership and baked colors", () => {
  const root = new THREE.Group(),
    map = new THREE.Texture(),
    material = new THREE.MeshStandardMaterial({ map, color: "#aabbcc" }),
    geometry = new THREE.BoxGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  root.add(mesh);
  const original = material.color.clone();
  prepareGoogleModel(root, 8);
  assert.equal(mesh.material, material);
  assert.equal(mesh.geometry, geometry);
  assert.equal(material.emissiveMap, map);
  assert(material.emissive.equals(original));
  assert.equal(material.color.getHex(), 0);
  assert.equal(material.toneMapped, false);
  assert.equal(material.fog, false);
  assert.equal(map.anisotropy, 8);
  assert(geometry.boundingBox?.containsPoint(new THREE.Vector3(0.5, 0.5, 0.5)));
  assert(Math.abs(geometry.boundingSphere.radius - Math.sqrt(3) / 2) < 1e-12);
  geometry.dispose();
  material.dispose();
  map.dispose();
});
test("Google layer stays network-idle until update and disconnects without retaining a key setting", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw Error("Unexpected network");
  });
  const states = [],
    scene = new THREE.Scene(),
    layer = createGoogleCity({
      scene,
      camera: new THREE.PerspectiveCamera(),
      geography: createMapGeography(reference),
      onState: (state, message) => states.push([state, message]),
      onCredits: () => {},
    });
  assert(!layer.isConnected());
  layer.connect(key, "https:", "https://example.invalid/index.html");
  assert(layer.isConnected());
  assert.equal(requests, 0);
  layer.disconnect();
  assert(!layer.isConnected());
  assert.equal(scene.children.length, 0);
  assert.equal(requests, 0);
  assert(states.every(([, message]) => !message.includes(key)));
});
test("a denied Google root request restores local mode and reports a credential-free error", async (t) => {
  const states = [],
    scene = new THREE.Scene();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    requests++;
    const u = new URL(String(url));
    assert.equal(u.hostname, "tile.googleapis.com");
    assert.equal(u.searchParams.get("key"), key);
    return new Response("Denied", { status: 403 });
  });
  t.mock.method(console, "error", () => {});
  const layer = createGoogleCity({
    scene,
    camera: new THREE.PerspectiveCamera(),
    geography: createMapGeography(reference),
    onState: (state, message) => states.push([state, message]),
    onCredits: () => {},
  });
  layer.connect(key, "https:", "https://example.invalid/index.html");
  layer.update(800, 600, true);
  for (let i = 0; i < 10 && !states.some(([state]) => state === "error"); i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert(states.some(([state]) => state === "error"));
  assert(!layer.isConnected());
  assert.equal(scene.children.length, 0);
  assert(states.every(([, message]) => !message.includes(key)));
});

test("Cesium ion accepts its token format without a Google key and rejects missing/invalid setup", () => {
  const ionToken = "eyJhbGciOiJIUzI1NiJ9.fixture-token.signature";
  assert.doesNotThrow(() => validateGoogleConnection("https:", ionToken, "ion"));
  assert.throws(() => validateGoogleConnection("file:", ionToken, "ion"), /HTTP/);
  assert.throws(() => validateGoogleConnection("https:", "", "ion"), /Cesium ion/);
  assert.throws(() => validateGoogleConnection("https:", "token with spaces", "ion"), /Cesium ion/);
  assert.throws(() => validateGoogleConnection("https:", ionToken, "other"), /Unsupported/);
});

test("a denied Cesium ion endpoint restores local mode without sending the token to Google", async (t) => {
  const ionToken = "eyJhbGciOiJIUzI1NiJ9.fixture-token.signature";
  const states = [], requests = [], scene = new THREE.Scene();
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = new URL(String(url));
    requests.push(u.hostname);
    assert.equal(u.hostname, "api.cesium.com");
    assert.equal(u.pathname, "/v1/assets/2275207/endpoint");
    assert.equal(u.searchParams.get("access_token"), ionToken);
    return new Response("Denied", { status: 401 });
  });
  t.mock.method(console, "error", () => {});
  const layer = createGoogleCity({scene, camera: new THREE.PerspectiveCamera(),
    geography: createMapGeography(reference), onState: (state,message) => states.push([state,message]), onCredits: () => {}});
  layer.connect(ionToken,"https:","https://example.invalid/index.html","ion");
  assert.equal(requests.length, 0, "connect must wait for an enabled update");
  layer.update(800,600,true);
  for (let i=0; i<20 && !states.some(([state])=>state==="error"); i++) await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests,["api.cesium.com"]);
  assert(states.some(([state,message])=>state==="error" && message.includes("Cesium ion")));
  assert(states.every(([,message])=>!message.includes(ionToken)));
  assert(!layer.isConnected());
  assert.equal(scene.children.length,0);
});

test("Cesium ion resolves the Google tileset using the provider credential returned by ion", async (t) => {
  const ionToken = "eyJhbGciOiJIUzI1NiJ9.fixture-token.signature";
  const providerKey = "AIza" + "p".repeat(35), requests=[], states=[], loadErrors=[], scene=new THREE.Scene();
  globalThis.window = { location: { href: "https://example.invalid/index.html" } };
  t.after(() => { delete globalThis.window; });
  const dispatch = TilesRenderer.prototype.dispatchEvent;
  t.mock.method(TilesRenderer.prototype, "dispatchEvent", function(event) {
    if (event.type === "load-error") loadErrors.push(String(event.error));
    return dispatch.call(this, event);
  });
  t.mock.method(globalThis,"fetch",async(url)=>{
    const u=new URL(String(url));requests.push(u.hostname);
    if (u.hostname==="api.cesium.com") {
      assert.equal(u.searchParams.get("access_token"),ionToken);
      return Response.json({externalType:"GOOGLE_3D_TILES",options:{url:`https://tile.googleapis.com/v1/3dtiles/root.json?key=${providerKey}`}});
    }
    assert.equal(u.hostname,"tile.googleapis.com");
    assert.equal(u.searchParams.get("key"),providerKey);
    assert(!u.href.includes(ionToken));
    return Response.json({asset:{version:"1.0"},geometricError:0,root:{boundingVolume:{sphere:[0,0,0,1]},geometricError:0,refine:"REPLACE"}});
  });
  const layer=createGoogleCity({scene,camera:new THREE.PerspectiveCamera(),geography:createMapGeography(reference),onState:(state,message)=>states.push([state,message]),onCredits:()=>{}});
  layer.connect(ionToken,"https:","https://example.invalid/index.html","ion");
  layer.update(800,600,true);
  for(let i=0;i<20 && requests.length<2;i++) await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests,["api.cesium.com","tile.googleapis.com"]);
  assert.deepEqual(loadErrors, []);
  assert(!states.some(([state])=>state==="error"));
  layer.disconnect();
  assert.equal(scene.children.length,0);
  assert(states.every(([,message])=>!message.includes(ionToken) && !message.includes(providerKey)));
});
