import type { BufferAttribute, WebGPURenderer } from "three/webgpu";

// Three 0.186.1 exposes BufferAttribute.dispose(), but its common Attributes manager does not
// subscribe to that event for compute-only storage bindings. Geometry disposal only releases
// geometry attributes, so those buffers otherwise survive population resets. Isolate the pinned
// renderer bridge here; validate it through the browser's repeated-reset allocation check.
export function releaseStorage(
  renderer: WebGPURenderer,
  attributes: BufferAttribute[],
) {
  const manager = (
    renderer as unknown as {
      _attributes?: { delete(attribute: BufferAttribute): unknown };
    }
  )._attributes;
  if (!manager?.delete)
    throw new Error(
      "Unsupported Three.js storage cleanup; revalidate the pinned renderer",
    );
  for (const attribute of new Set(attributes)) manager.delete(attribute);
}
