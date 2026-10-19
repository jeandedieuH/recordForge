import type { AudioMastering, ProFeatureKey } from "@recordforge/contracts"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@recordforge/ui"
import { ProBadge } from "../../licensing/pro-badge"

// Shared Studio Audio controls — the Finishing panel, Audio panel, and the
// export view all edit the same durable project.exportSettings.audioMastering.
interface StudioAudioControlsProps {
  mastering: AudioMastering | undefined
  disabled?: boolean
  isPro: boolean
  onChange: (mastering: AudioMastering) => void
  onUpgradeRequest: (features?: ProFeatureKey[]) => void
}

// afftdn strengths — higher values cut more noise but can soften speech.
const NOISE_REDUCTION_OPTIONS = [
  { value: "6", label: "Gentle (6 dB)", hint: "Light hiss and fan noise" },
  { value: "12", label: "Balanced (12 dB)", hint: "Default — most recordings" },
  { value: "18", label: "Strong (18 dB)", hint: "Noisy rooms; can soften speech" },
] as const

const LOUDNESS_OPTIONS = [
  { value: "off", label: "Off", hint: "Keep original loudness" },
  { value: "-14", label: "−14 LUFS", hint: "YouTube" },
  { value: "-16", label: "−16 LUFS", hint: "Podcast" },
  { value: "-19", label: "−19 LUFS", hint: "Streaming" },
] as const

export function StudioAudioControls({
  mastering,
  disabled,
  isPro,
  onChange,
  onUpgradeRequest,
}: StudioAudioControlsProps) {
  const denoise = mastering?.denoise ?? false
  const loudnessTarget = mastering?.loudnessTarget ?? null
  const noiseReductionDb = mastering?.noiseReductionDb ?? 12

  // Only enabling/setting paid processing opens the upgrade dialog —
  // disabling noise reduction or choosing loudness Off after a downgrade
  // must always work.
  function gate(): boolean {
    if (isPro) return false
    onUpgradeRequest(["studio-audio"])
    return true
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-foreground">
          Noise reduction
          {!isPro ? <ProBadge /> : null}
        </span>
        <Switch
          checked={denoise}
          disabled={disabled}
          onCheckedChange={(next) => {
            if (next && gate()) return
            onChange({ denoise: next, noiseReductionDb, loudnessTarget })
          }}
          aria-label="Noise reduction"
        />
      </div>

      {denoise ? (
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-foreground">
            Reduction strength
            {!isPro ? <ProBadge /> : null}
          </span>
          <Select
            value={String(noiseReductionDb)}
            onValueChange={(value) => {
              if (gate()) return
              onChange({ denoise, noiseReductionDb: Number(value), loudnessTarget })
            }}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 w-full" aria-label="Reduction strength">
              {/* Explicit short label — ItemText children (incl. hints) would
                  otherwise portal into the trigger. */}
              <SelectValue>
                {NOISE_REDUCTION_OPTIONS.find((o) => o.value === String(noiseReductionDb))?.label ??
                  `${noiseReductionDb} dB`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {NOISE_REDUCTION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    <span className="text-ui-micro text-subtle-foreground">{option.hint}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-foreground">
          Loudness target
          {!isPro ? <ProBadge /> : null}
        </span>
        <Select
          value={loudnessTarget != null ? String(loudnessTarget) : "off"}
          onValueChange={(value) => {
            if (value !== "off" && gate()) return
            onChange({
              denoise,
              noiseReductionDb,
              loudnessTarget: value === "off" ? null : Number(value),
            })
          }}
          disabled={disabled}
        >
          <SelectTrigger className="h-8 w-full" aria-label="Loudness target">
            {/* Short selected label — hints live in the dropdown content. */}
            <SelectValue>
              {LOUDNESS_OPTIONS.find(
                (o) => o.value === (loudnessTarget != null ? String(loudnessTarget) : "off"),
              )?.label ?? "Off"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LOUDNESS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <div className="flex flex-col">
                  <span>{option.label}</span>
                  <span className="text-ui-micro text-subtle-foreground">{option.hint}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <p className="text-ui-caption">
        Studio Audio applies noise reduction and broadcast loudness normalization to the final mixed
        track at export. Stronger reduction can soften speech — preview the finished video before
        exporting.
      </p>
    </div>
  )
}
