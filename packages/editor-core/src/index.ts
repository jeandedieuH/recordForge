// Pure timeline command engine.
// No React or DOM dependencies here.

export * from "@recordforge/domain"
export * from "./camera-presets"
export * from "./presets/preset-registry"
export * from "./text-presets"
export * from "./annotation-presets"
export * from "./background-presets"
export * from "./background-prefilter"
export * from "./command-records"
export * from "./time-mapping"
export * from "./history"
export * from "./commands"
export * from "./engine"
export * from "./selection"
export * from "./snap"
export * from "./composition"
export * from "./playback-clock"
export * from "./preview-composition"
export * from "./interaction-transaction"
export * from "./overlay-transaction"
export * from "./smart-zoom-builder"
export {
  analyzeCursorTelemetry,
  clampZoomTarget as clampCursorZoomTarget,
  generateSmartZoomSuggestions,
  generateZoomSuggestions,
  zoomTargetForCursorPoint,
} from "@recordforge/cursor-core"
export type {
  CursorAnalysisOptions,
  CursorClickFeature,
  CursorDwellFeature,
  CursorInteractionFeatures,
  CursorMovementFeature,
  CursorSafeEdgeFeature,
  SmartZoomGenerationOptions,
} from "@recordforge/cursor-core"
