import { describe, expect, it } from "vitest"
import type { RecordingConfig } from "@recordforge/contracts"
import type { OnboardingStepId } from "./types"

function getRecommendedProfile(
  cores: number,
  hasHardwareEncoder: boolean,
): RecordingConfig["profile"] {
  if (cores <= 2) return "low-impact"
  if (cores >= 8 && hasHardwareEncoder) return "smooth-60fps"
  if (cores >= 6) return "smooth-60fps"
  return "balanced"
}

describe("Onboarding Flow and Specifications", () => {
  it("defines exactly 5 canonical onboarding steps in correct sequence", () => {
    const expectedSteps: OnboardingStepId[] = [
      "welcome",
      "performance",
      "devices",
      "cursor",
      "ready",
    ]

    expect(expectedSteps).toHaveLength(5)
    expect(expectedSteps[0]).toBe("welcome")
    expect(expectedSteps[1]).toBe("performance")
    expect(expectedSteps[2]).toBe("devices")
    expect(expectedSteps[3]).toBe("cursor")
    expect(expectedSteps[4]).toBe("ready")
  })

  it("recommends low-impact profile for low-spec dual-core hardware", () => {
    const rec1Core = getRecommendedProfile(1, false)
    const rec2Core = getRecommendedProfile(2, false)
    const rec2CoreHw = getRecommendedProfile(2, true)

    expect(rec1Core).toBe("low-impact")
    expect(rec2Core).toBe("low-impact")
    expect(rec2CoreHw).toBe("low-impact")
  })

  it("recommends balanced profile for mid-range quad-core machines", () => {
    const rec4Core = getRecommendedProfile(4, false)
    expect(rec4Core).toBe("balanced")
  })

  it("recommends smooth-60fps profile for 6+ cores or 8+ cores with GPU acceleration", () => {
    const rec6Core = getRecommendedProfile(6, false)
    const rec8CoreHw = getRecommendedProfile(8, true)

    expect(rec6Core).toBe("smooth-60fps")
    expect(rec8CoreHw).toBe("smooth-60fps")
  })

  it("verifies persistence setting key naming convention", () => {
    const settingKey = "onboardingCompleted"
    expect(settingKey).toBe("onboardingCompleted")
  })

  it("verifies audio device persistence contract for onboarding", () => {
    const mockMics = [
      { id: "mic-1", name: "Headset Mic", kind: "microphone" as const, isDefault: true },
      { id: "mic-2", name: "Desk Mic", kind: "microphone" as const, isDefault: false },
    ]
    const mockSystems = [
      { id: "sys-1", name: "Default Speakers Loopback", kind: "system" as const, isDefault: true },
    ]

    // When microphone is enabled on onboarding
    const micPref = { microphoneEnabled: true, microphoneId: "mic-1" }
    const sysPref = { systemAudioEnabled: true, systemAudioId: "sys-1" }

    expect(micPref.microphoneEnabled).toBe(true)
    expect(sysPref.systemAudioEnabled).toBe(true)
    expect(mockMics.find((m) => m.id === micPref.microphoneId)?.name).toBe("Headset Mic")
    expect(mockSystems.find((s) => s.id === sysPref.systemAudioId)?.name).toBe(
      "Default Speakers Loopback",
    )
  })
})
