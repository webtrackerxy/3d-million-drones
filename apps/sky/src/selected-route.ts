import { Line2NodeMaterial } from "three/webgpu";
import { Line2 } from "three/addons/lines/webgpu/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";

export const SELECTED_ROUTE_COLOR = "#2684ff";

// One selected-ID guide, excluded from drone population and picking buffers.
// Wide-line geometry makes the 4 px width work on WebGPU at every zoom level.
export function createSelectedRouteLine() {
  const line = new Line2(
    new LineGeometry(),
    new Line2NodeMaterial({
      color: SELECTED_ROUTE_COLOR,
      linewidth: 4,
      worldUnits: false,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }),
  );
  line.name = "Selected drone route";
  return line;
}
