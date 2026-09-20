import {
  Camera,
  CloudUpload,
  Cpu,
  History,
  MemoryStick,
  MousePointer2,
  Ratio,
  Scissors,
  StickyNote,
  Waves,
  ZoomIn,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { ExportSizesVisual } from "./export-sizes-visual"
import { FeatureCard, type FeatureTone } from "./feature-card"
import { Reveal } from "./reveal"
import { SectionHeading } from "./section-heading"

interface Feature {
  icon: LucideIcon
  tone: FeatureTone
  title: string
  description: string
  demoLabel?: string
  stat?: string
  chips?: string[]
  visual?: ReactNode
  span: string
}

const FEATURES: Feature[] = [
  {
    icon: MousePointer2,
    tone: "screen",
    title: "Subpixel cursor telemetry",
    description:
      "Raw cursor vectors are captured at up to 120 Hz alongside the video — replayed with spring-damped motion, click ripples, and automatic focal framing. No post-hoc smoothing guesswork.",
    demoLabel: "Cursor smoothing & click ripples",
    span: "md:col-span-7",
  },
  {
    icon: Scissors,
    tone: "graphic",
    title: "A feature-rich timeline editor",
    description:
      "Multi-track editing: trim, split, move, delete, markers — with unlimited undo/redo. Every edit lands instantly; nothing re-renders until you export.",
    demoLabel: "Trim, split & undo on the timeline",
    span: "md:col-span-5",
  },
  {
    icon: ZoomIn,
    tone: "webcam",
    title: "Smart & manual zoom",
    description:
      "Auto-zoom follows clicks and focal points to keep the action readable — or drop manual zoom keyframes exactly where you want the punch-in.",
    demoLabel: "Smart zoom following a click",
    span: "md:col-span-5",
  },
  {
    icon: Camera,
    tone: "system",
    title: "Better camera layouts",
    description:
      "Webcam picture-in-picture presets tuned per aspect ratio — 16:9, 1:1, and 4:5 placements with pixel-perfect crop preservation, no awkward overlaps.",
    demoLabel: "Camera layout presets in action",
    span: "md:col-span-7",
  },
  {
    icon: StickyNote,
    tone: "annotation",
    title: "Annotations & titles",
    description:
      "Auto-numbered markers, draggable callouts, and title cards — plus burned-in captions and YouTube-valid chapters when you export.",
    demoLabel: "Markers, titles & burned-in captions",
    span: "md:col-span-6",
  },
  {
    icon: Ratio,
    tone: "captions",
    title: "Export any screen size",
    description:
      "One recording, every destination. Reframe to 16:9, 9:16, 1:1, or 4:5 and export — no second take, no re-recording.",
    visual: <ExportSizesVisual />,
    span: "md:col-span-6",
  },
  {
    icon: MemoryStick,
    tone: "title",
    title: "Sips memory, never gulps",
    description:
      "Native Rust + Tauri, not a bundled browser. Your CPU and battery stay free for the thing you're actually recording.",
    stat: "<50 MB",
    span: "md:col-span-4",
  },
  {
    icon: Cpu,
    tone: "mic",
    title: "Hardware-accelerated everything",
    description:
      "Pinned FFmpeg 9.0 sidecars drive your GPU encoder directly — exports finish fast without pinning your CPU at 100%.",
    chips: ["NVENC", "VideoToolbox", "QuickSync", "VAAPI", "AMF"],
    span: "md:col-span-4",
  },
  {
    icon: Waves,
    tone: "mic",
    title: "Zero-drift audio",
    description:
      "Native WASAPI, CoreAudio, and PipeWire capture mic and system audio on isolated tracks, synchronized to microsecond precision — no desync on long recordings.",
    span: "md:col-span-4",
  },
  {
    icon: History,
    tone: "system",
    title: "Crash-free by design",
    description:
      "SQLite WAL persistence checkpoints every session in real time. Crash, power loss, accidental close — relaunch and your recording is right where you left it.",
    span: "md:col-span-6",
  },
  {
    icon: CloudUpload,
    tone: "screen",
    title: "Optional cloud storage",
    description:
      "Push exports to your own S3-compatible bucket or Google Drive. Tokens live in the OS credential vault — there's no recordForge cloud holding your media.",
    chips: ["S3-compatible", "Google Drive"],
    span: "md:col-span-6",
  },
]

/** Asymmetric bento of the headline features; collapses to one column on mobile. */
export function FeatureGrid() {
  return (
    <section id="features" className="mx-auto w-full max-w-6xl scroll-mt-24 px-4 py-20">
      <Reveal>
        <SectionHeading
          eyebrow="Features"
          title="Recorder-first engineering, editor-grade finish"
          description="Every feature exists to get a clean, in-sync, recoverable recording onto your disk fast — then polish it without ever leaving the app."
        />
      </Reveal>
      <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-12">
        {FEATURES.map((feature, index) => (
          <Reveal key={feature.title} delay={(index % 3) * 80} className={feature.span}>
            <FeatureCard
              icon={feature.icon}
              tone={feature.tone}
              title={feature.title}
              description={feature.description}
              demoLabel={feature.demoLabel}
              stat={feature.stat}
              chips={feature.chips}
              visual={feature.visual}
              className="h-full"
            />
          </Reveal>
        ))}
      </div>
    </section>
  )
}
