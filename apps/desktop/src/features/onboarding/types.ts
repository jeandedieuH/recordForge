import type { RecordingConfig } from "@recordforge/contracts"

export type OnboardingStepId = "welcome" | "performance" | "devices" | "cursor" | "ready"

export interface OnboardingStepInfo {
  id: OnboardingStepId
  number: number
  title: string
  subtitle: string
}

export interface HardwareDetectionResult {
  cores: number
  cpuName: string
  bestEncoderName: string | null
  recommendedProfileId: RecordingConfig["profile"]
  isLowSpec: boolean
}

export interface OnboardingModalProps {
  open: boolean
  onClose: () => void
  onStartRecording?: () => void
}
