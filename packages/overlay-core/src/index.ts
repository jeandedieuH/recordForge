export { createOverlayWasmEngine } from "./wasm-engine"
export type { OverlayEngine } from "./wasm-engine"
export { diffOverlayPlanGeometry } from "./plan-geometry"
export type { OverlayGeometryPatch } from "./plan-geometry"
export { renderOverlayDisplayList, wrapTextToLines } from "./canvas-renderer"
export type { OverlayCanvasRenderOptions } from "./canvas-renderer"
export {
  calloutAttachPoint,
  connectorEndToward,
  connectorHeadPathD,
  connectorHeadTrim,
  connectorLength,
  connectorPathD,
  connectorPathFor,
  connectorStartToward,
  strokeConnectorPath,
  trimConnectorPath,
} from "./connectors"
export type { CalloutBox, ConnectorAxis, ConnectorPath, ConnectorPoint } from "./connectors"
export type { OverlayDisplayList, OverlayRenderPlan } from "@recordforge/contracts"
