import { useState } from "react"
import { ArrowLeft, ArrowRight } from "lucide-react"
import { Badge, Button, Dialog, DialogContent, DialogTitle, cn } from "@recordforge/ui"
import { isTauri, setSetting } from "../../lib/settings"
import { WelcomeStep } from "./steps/welcome-step"
import { PerformanceStep } from "./steps/performance-step"
import { DevicesStep } from "./steps/devices-step"
import { CursorStep } from "./steps/cursor-step"
import { ReadyStep } from "./steps/ready-step"
import type { OnboardingModalProps, OnboardingStepInfo } from "./types"

const STEPS: OnboardingStepInfo[] = [
  {
    id: "welcome",
    number: 1,
    title: "Welcome",
    subtitle: "Brand intro & studio themes",
  },
  {
    id: "performance",
    number: 2,
    title: "Performance",
    subtitle: "Hardware & recording profile",
  },
  {
    id: "devices",
    number: 3,
    title: "Audio & Delay",
    subtitle: "Microphone & countdown",
  },
  {
    id: "cursor",
    number: 4,
    title: "Smart Cursor",
    subtitle: "Telemetry & ripple effects",
  },
  {
    id: "ready",
    number: 5,
    title: "Shortcuts & Start",
    subtitle: "Global keys & launch",
  },
]

export function OnboardingModal({ open, onClose, onStartRecording }: OnboardingModalProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)

  const currentStep = STEPS[currentStepIndex]
  const isFirstStep = currentStepIndex === 0
  const isLastStep = currentStepIndex === STEPS.length - 1

  async function handleComplete() {
    try {
      if (isTauri()) {
        await setSetting("onboardingCompleted", "true")
      }
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("recordforge:onboardingCompleted", "true")
      }
    } catch {
      // Ignore storage errors
    }
    onClose()
  }

  function handleNext() {
    if (!isLastStep) {
      setCurrentStepIndex((prev) => prev + 1)
    } else {
      void handleComplete()
    }
  }

  function handleBack() {
    if (!isFirstStep) {
      setCurrentStepIndex((prev) => prev - 1)
    }
  }

  function handleSkip() {
    void handleComplete()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          void handleComplete()
        }
      }}
    >
      <DialogContent
        className="max-w-3xl sm:max-w-4xl p-0 overflow-hidden border-border bg-surface-dim/95 backdrop-blur-xl shadow-e3 text-foreground"
        aria-describedby={undefined}
      >
        {/* Top Header & Step Progress Bar */}
        <div className="border-b border-border bg-surface/80 px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 border border-primary/20">
                <img
                  src="/icon.svg"
                  alt="RecordForge"
                  className="size-5 object-contain select-none"
                />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold tracking-tight text-foreground flex items-center gap-2">
                  <span>RecordForge Setup & Tour</span>
                  <Badge variant="accent" className="text-[10px] px-2 py-0 font-mono">
                    Step {currentStepIndex + 1} of {STEPS.length}
                  </Badge>
                </DialogTitle>
                <p className="text-xs text-subtle-foreground">
                  {currentStep.title} — {currentStep.subtitle}
                </p>
              </div>
            </div>

            {/* Skip Tour Button */}
            {!isLastStep && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSkip}
                className="text-xs text-subtle-foreground hover:text-foreground h-8 px-2.5"
              >
                Skip Tour
              </Button>
            )}
          </div>

          {/* Stepper Progress Bar */}
          <div className="mt-4 flex items-center gap-1.5 sm:gap-2">
            {STEPS.map((step, idx) => {
              const isCompleted = idx < currentStepIndex
              const isCurrent = idx === currentStepIndex

              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setCurrentStepIndex(idx)}
                  className="group flex-1 cursor-pointer flex flex-col gap-1.5 focus:outline-hidden"
                >
                  <div
                    className={cn(
                      "h-1.5 w-full rounded-full transition-all duration-base ease-forge",
                      isCompleted
                        ? "bg-primary"
                        : isCurrent
                          ? "bg-primary shadow-xs ring-2 ring-primary/30"
                          : "bg-border group-hover:bg-border-strong",
                    )}
                  />
                  <div className="hidden sm:flex items-center justify-between text-[10px]">
                    <span
                      className={cn(
                        "font-medium truncate transition-colors",
                        isCurrent
                          ? "text-foreground font-semibold"
                          : isCompleted
                            ? "text-primary"
                            : "text-subtle-foreground",
                      )}
                    >
                      {step.title}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Step Content Body with Scroll Area */}
        <div className="p-6 max-h-[68vh] overflow-y-auto">
          {currentStep.id === "welcome" && <WelcomeStep />}
          {currentStep.id === "performance" && <PerformanceStep />}
          {currentStep.id === "devices" && <DevicesStep />}
          {currentStep.id === "cursor" && <CursorStep />}
          {currentStep.id === "ready" && (
            <ReadyStep onStartRecording={onStartRecording} onFinish={() => void handleComplete()} />
          )}
        </div>

        {/* Footer Navigation Controls */}
        <div className="flex items-center justify-between border-t border-border bg-surface/90 px-6 py-3.5">
          <div>
            {!isFirstStep ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleBack}
                className="gap-1.5 text-xs h-8 px-3"
              >
                <ArrowLeft className="size-3.5" />
                Back
              </Button>
            ) : (
              <span className="text-xs text-subtle-foreground">
                Welcome to the local-first recorder
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!isLastStep ? (
              <Button
                variant="primary"
                size="sm"
                onClick={handleNext}
                className="gap-1.5 text-xs h-8 px-4 bg-primary text-white hover:bg-primary/90 shadow-sm"
              >
                Continue
                <ArrowRight className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
