import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SmartCutScanControls } from "../panels/smart-cut-controls"
import { StudioAudioControls } from "./studio-audio-controls"
import { KeystrokeOverlayCard } from "./keystroke-overlay-card"
import { VirtualBackgroundCard } from "../../export/virtual-background-card"

// SSR smoke coverage for the shared finishing controls: a Radix primitive
// misuse (SelectItem outside SelectContent) only throws at render time, so
// every exported control renders a real string before acceptance.
const noop = () => {}

describe("shared finishing controls render", () => {
  it("SmartCutScanControls renders all selects without a primitive crash", () => {
    const html = renderToString(
      createElement(SmartCutScanControls, {
        thresholdDb: null,
        minDurationMs: 500,
        paddingMs: 120,
        onThresholdDbChange: noop,
        onMinDurationMsChange: noop,
        onPaddingMsChange: noop,
      }),
    )
    expect(html).toContain("Sensitivity")
    expect(html.length).toBeGreaterThan(0)
  })

  it("StudioAudioControls renders gated and ungated states", () => {
    const mastering = { denoise: true, noiseReductionDb: 12, loudnessTarget: -14 }
    const free = renderToString(
      createElement(StudioAudioControls, {
        mastering,
        isPro: false,
        onChange: noop,
        onUpgradeRequest: noop,
      }),
    )
    expect(free).toContain("Noise reduction")
    const pro = renderToString(
      createElement(StudioAudioControls, {
        mastering,
        isPro: true,
        onChange: noop,
        onUpgradeRequest: noop,
      }),
    )
    expect(pro).toContain("Reduction strength")
  })

  it("KeystrokeOverlayCard renders capture states honestly", () => {
    const overlay = {
      enabled: true,
      durationMs: 1400,
      position: "bottom-center" as const,
      scalePercent: 100,
    }
    const empty = renderToString(
      createElement(KeystrokeOverlayCard, {
        overlay,
        isPro: true,
        eventCount: 0,
        captureSupported: false,
        status: "loaded",
        onChange: noop,
        onUpgradeRequest: noop,
      }),
    )
    // SSR escapes the apostrophe — assert the stable parts of the copy.
    expect(empty).toContain("capture isn")
    expect(empty).toContain("available on Linux")
    expect(empty).toContain("still preview and export")
    const populated = renderToString(
      createElement(KeystrokeOverlayCard, {
        overlay,
        isPro: true,
        eventCount: 3,
        captureSupported: true,
        status: "loaded",
        onChange: noop,
        onUpgradeRequest: noop,
      }),
    )
    // SSR splits adjacent expressions with <!-- --> markers — strip them.
    expect(populated.replace(/<!-- -->/g, "")).toContain("3 shortcuts captured")
  })

  it("VirtualBackgroundCard renders the no-camera state", () => {
    const background = {
      enabled: true,
      mode: "blur" as const,
      blurSigma: 20,
      replaceColor: "#0f172a",
    }
    const html = renderToString(
      createElement(VirtualBackgroundCard, {
        background,
        hasCamera: false,
        onChange: noop,
      }),
    )
    expect(html).toContain("No webcam in this project")
  })
})
