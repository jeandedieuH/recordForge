import { HardDrive, KeyRound, ShieldCheck, WifiOff } from "lucide-react"
import { Reveal } from "./reveal"
import { SectionHeading } from "./section-heading"

const PRIVACY_POINTS = [
  {
    icon: WifiOff,
    title: "Works fully offline",
    description:
      "Recording, editing, and exporting never touch a network. No account, no sign-in, no activation.",
  },
  {
    icon: ShieldCheck,
    title: "No telemetry or analytics",
    description:
      "The app ships zero tracking. We can't see your recordings — they never leave your disk.",
  },
  {
    icon: KeyRound,
    title: "OS credential vault",
    description:
      "Optional cloud-upload tokens live in Windows Credential Manager, Keychain, or Secret Service — never in our database or plaintext files.",
  },
  {
    icon: HardDrive,
    title: "Your storage, your rules",
    description:
      "Exports go to your disk, your S3 bucket, or your Google Drive. There is no RecordForge cloud holding your media.",
  },
]

/** Privacy / local-first pitch — the #local-first anchor target. */
export function LocalFirstSection() {
  return (
    <section id="local-first" className="relative mx-auto w-full max-w-6xl scroll-mt-24 px-4 py-20">
      <div
        aria-hidden
        className="pointer-events-none absolute -left-48 top-1/3 h-96 w-[24rem] opacity-25 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in srgb, var(--color-secondary) 45%, transparent), transparent)",
        }}
      />
      <div className="relative grid items-start gap-10 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Reveal>
          <SectionHeading
            align="left"
            eyebrow="Why local-first"
            title="Recordings stay yours. Literally."
            description="Most recorders treat your footage as their product. RecordForge treats your disk as the source of truth — everything else is opt-in."
          />
        </Reveal>
        <div className="grid gap-4 sm:grid-cols-2">
          {PRIVACY_POINTS.map((point, index) => (
            <Reveal key={point.title} delay={index * 80}>
              <div className="h-full rounded-2xl border border-border bg-surface-dim p-1.5">
                <div className="flex h-full flex-col gap-3 rounded-[0.625rem] bg-surface p-5">
                  <point.icon className="size-5 text-accent" aria-hidden />
                  <h3 className="text-sm font-semibold text-foreground">{point.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {point.description}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
