import React, { useState } from "react"
import { ChevronDown, HelpCircle } from "lucide-react"

interface FaqItem {
  question: string
  answer: string
  category: string
}

const faqs: FaqItem[] = [
  {
    category: "Licensing & Ownership",
    question: "Is RecordForge free to use? Is it open-source?",
    answer:
      "RecordForge is 100% free to download and use for personal, commercial, and professional screen recording with unlimited capture time and zero export watermarks. It is proprietary software engineered by Prestige Tech and is not open-source.",
  },
  {
    category: "Roadmap & Monetization",
    question: "What is planned for Version 2.0? Will the free version go away?",
    answer:
      "No, the core recorder and essential proxy timeline editor will always remain 100% free. Version 2.0 will introduce optional paid premium features (such as AI-driven smart zoom auto-framing, multi-track studio audio isolation, and team cloud workspaces) for high-velocity power creators.",
  },
  {
    category: "Engineering & Developer",
    question: "Who develops and maintains RecordForge?",
    answer:
      "RecordForge is engineered and maintained by Prestige Tech (https://prestigetech.dev), an independent software engineering studio dedicated to native performance and privacy-first digital tools, and was created by its Master Developer (https://me.prestigetech.dev).",
  },
  {
    category: "Performance & Low-End Support",
    question: "How does RecordForge run so well on budget or low-end laptops?",
    answer:
      "Unlike electron-wrapped recorders that chew through gigabytes of RAM, RecordForge's backend is written in pure native Rust with Tauri v2. It captures directly via Windows Graphics Capture and Direct3D 11, leverages hardware NVENC/QuickSync/AMF encoders, and uses WASAPI for zero-drift audio. The entire idle footprint is under 48MB.",
  },
  {
    category: "Cursor & Telemetry",
    question: "What is 'telemetry-based cursor smoothing'?",
    answer:
      "Standard screen recorders record mouse cursor pixels directly into the video stream, resulting in jerky movement, jittery stops, and blur. RecordForge records raw subpixel cursor telemetry vectors separately at 60Hz. During preview and export, it applies mathematical spring-damping curves, click ripples, and automatic camera auto-zooming with crisp SVG vector rendering.",
  },
  {
    category: "Audio & Sync Guarantee",
    question: "How does RecordForge eliminate microphone and system audio desync?",
    answer:
      "We use native Windows WASAPI loopback capture coupled with high-precision timestamp indexing in Rust. Both microphone input and system sound are captured on dedicated sample clocks with drift-compensation buffers, guaranteeing exact lip-sync alignment even over multi-hour recording sessions.",
  },
  {
    category: "Reliability & Recovery",
    question: "What happens if my PC crashes or loses power during a recording?",
    answer:
      "RecordForge writes audio, video chunks, and editor state via SQLite Write-Ahead Logging (WAL) continuously to disk. If an unexpected power outage or system crash occurs, simply relaunch RecordForge. The session recovery wizard will automatically restore and reconstruct your recording with zero lost takes.",
  },
  {
    category: "Storage & Cloud",
    question: "Can I export to S3 or Google Drive if I want to share videos?",
    answer:
      "Absolutely. While RecordForge is local-first, it includes built-in optional direct publishers for AWS S3 (or any S3-compatible provider like Cloudflare R2, MinIO, Wasabi) and Google Drive. All API tokens and credentials are encrypted securely in your native OS Credential Vault (Windows Credential Manager).",
  },
]

export function FaqAccordion() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)

  const toggle = (idx: number) => {
    setOpenIndex(openIndex === idx ? null : idx)
  }

  return (
    <div className="w-full max-w-4xl mx-auto space-y-3">
      {faqs.map((faq, index) => {
        const isOpen = openIndex === index
        return (
          <div
            key={index}
            className={`rounded-xl border transition-all duration-200 overflow-hidden ${
              isOpen
                ? "bg-surface border-primary/50 shadow-lg shadow-primary/20"
                : "bg-surface-dim border-border hover:border-border-strong"
            }`}
          >
            <button
              onClick={() => toggle(index)}
              className="w-full px-5 py-4 text-left flex items-center justify-between gap-4 select-none cursor-pointer"
            >
              <span className="text-sm sm:text-base font-semibold text-foreground flex items-center gap-3">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isOpen ? "bg-track-screen" : "bg-tertiary"
                  }`}
                />
                {faq.question}
              </span>
              <div
                className={`p-1 rounded-md text-muted-foreground transition-transform duration-200 shrink-0 ${
                  isOpen ? "rotate-180 text-track-screen bg-surface-container-high" : ""
                }`}
              >
                <ChevronDown className="w-4 h-4" />
              </div>
            </button>

            {isOpen && (
              <div className="px-5 pb-5 pt-1 text-xs sm:text-sm text-muted-foreground leading-relaxed border-t border-border">
                <p className="text-foreground">{faq.answer}</p>
                <div className="mt-3 inline-block px-2.5 py-0.5 rounded-full bg-surface-container-high border border-border text-[10px] font-mono text-track-screen">
                  {faq.category}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
