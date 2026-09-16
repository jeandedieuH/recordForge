import { Disc3, Rocket, Scissors } from "lucide-react"
import { Reveal } from "./reveal"
import { SectionHeading } from "./section-heading"

const STEPS = [
  {
    icon: Disc3,
    step: "01",
    title: "Record",
    description:
      "Hit a global shortcut or the floating controls. Screen, mic, system audio, and webcam start together — already in sync.",
  },
  {
    icon: Scissors,
    step: "02",
    title: "Edit",
    description:
      "Open the proxy timeline, trim the dead air, split the good take. Every action is instant and undoable.",
  },
  {
    icon: Rocket,
    step: "03",
    title: "Export",
    description:
      "Hardware-encoded MP4 lands on your disk. Optionally push to your own S3 or Google Drive — still no account with us.",
  },
]

/** Three-step Record → Edit → Export walkthrough. */
export function StepsStrip() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-20">
      <Reveal>
        <SectionHeading eyebrow="Workflow" title="From shortcut to shareable MP4 in three steps" />
      </Reveal>
      <ol className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <Reveal key={step.step} delay={index * 100}>
            <li className="relative h-full rounded-2xl border border-border bg-surface-dim p-1.5">
              <div className="flex h-full flex-col gap-3 rounded-[0.625rem] bg-surface p-6">
                <div className="flex items-center justify-between">
                  <step.icon className="size-6 text-accent" aria-hidden />
                  <span className="text-3xl font-semibold tracking-tight text-border-strong tnum">
                    {step.step}
                  </span>
                </div>
                <h3 className="text-lg font-semibold text-foreground">{step.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{step.description}</p>
              </div>
            </li>
          </Reveal>
        ))}
      </ol>
    </section>
  )
}
