import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertCircle, Check, Copy, RefreshCw, RotateCcw } from "lucide-react"
import { Button } from "@recordforge/ui"

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
  copied: boolean
}

/**
 * Root-level Error Boundary for recordForge desktop application.
 * Prevents full-screen crashes by presenting a premium error recovery UI
 * with retry, reload, diagnostic inspection, and clipboard export.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      copied: false,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo })
    console.error("Uncaught application error in recordForge:", error, errorInfo)
  }

  private handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      copied: false,
    })
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleCopyError = async (): Promise<void> => {
    const { error, errorInfo } = this.state
    const report = [
      `recordForge Error Report`,
      `Time: ${new Date().toISOString()}`,
      `Error: ${error?.name}: ${error?.message}`,
      `Stack:\n${error?.stack ?? "No stack trace available"}`,
      `Component Stack:\n${errorInfo?.componentStack ?? "No component stack available"}`,
      `User Agent: ${navigator.userAgent}`,
    ].join("\n\n")

    try {
      await navigator.clipboard.writeText(report)
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2500)
    } catch {
      // Clipboard write failed
    }
  }

  override render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      const { error, errorInfo, copied } = this.state

      return (
        <div className="flex min-h-screen w-full flex-col items-center justify-center bg-background p-6 text-foreground font-sans antialiased select-none">
          <div className="flex w-full max-w-xl flex-col items-center gap-6 rounded-2xl border border-border bg-surface p-8 shadow-2xl">
            {/* Error Icon Badge */}
            <div className="flex size-14 items-center justify-center rounded-2xl bg-recording/15 text-recording ring-8 ring-recording/5">
              <AlertCircle className="size-7" aria-hidden />
            </div>

            {/* Error Title and Description */}
            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground">
                Something went wrong
              </h1>
              <p className="max-w-md text-xs text-subtle-foreground leading-relaxed">
                An unexpected error occurred while rendering the application shell. You can retry
                reloading the UI or restart the application.
              </p>
            </div>

            {/* Actions Bar */}
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                onClick={this.handleReset}
                className="gap-2 bg-primary hover:bg-primary-hover text-white cursor-pointer h-9 px-4 text-xs font-semibold"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Try again
              </Button>

              <Button
                variant="secondary"
                onClick={this.handleReload}
                className="gap-2 cursor-pointer h-9 px-4 text-xs font-semibold"
              >
                <RefreshCw className="size-3.5" aria-hidden />
                Reload application
              </Button>

              <Button
                variant="outline"
                onClick={() => void this.handleCopyError()}
                className="gap-2 cursor-pointer h-9 px-4 text-xs font-semibold"
              >
                {copied ? (
                  <>
                    <Check className="size-3.5 text-success" aria-hidden />
                    <span>Copied report</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" aria-hidden />
                    <span>Copy error</span>
                  </>
                )}
              </Button>
            </div>

            {/* Collapsible Technical Details */}
            <details className="w-full rounded-xl border border-border bg-surface-dim p-4 text-left group">
              <summary className="cursor-pointer text-xs font-semibold text-subtle-foreground hover:text-foreground list-none flex items-center justify-between">
                <span>Technical details</span>
                <span className="text-[10px] text-muted-foreground group-open:hidden">
                  (click to expand)
                </span>
              </summary>
              <div className="mt-3 flex flex-col gap-2 border-t border-border/50 pt-3">
                <p className="font-mono text-xs font-bold text-recording wrap-break-word">
                  {error.name}: {error.message}
                </p>
                {error.stack ? (
                  <pre className="max-h-48 overflow-y-auto rounded-md bg-background p-3 font-mono text-[11px] text-subtle-foreground leading-relaxed select-text">
                    {error.stack}
                  </pre>
                ) : null}
                {errorInfo?.componentStack ? (
                  <pre className="max-h-36 overflow-y-auto rounded-md bg-background p-3 font-mono text-[10px] text-muted-foreground leading-relaxed select-text">
                    {errorInfo.componentStack}
                  </pre>
                ) : null}
              </div>
            </details>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
