import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertCircle, RotateCcw } from "lucide-react"
import { Button, EmptyState } from "@recordforge/ui"

interface ActivePanelErrorBoundaryProps {
  children: ReactNode
  resetKey?: string
  panelName?: string
}

interface ActivePanelErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ActivePanelErrorBoundary extends Component<
  ActivePanelErrorBoundaryProps,
  ActivePanelErrorBoundaryState
> {
  constructor(props: ActivePanelErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ActivePanelErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("ActivePanel crashed:", error, errorInfo)
  }

  override componentDidUpdate(prevProps: ActivePanelErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null })
    }
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center p-6 text-center">
          <EmptyState
            icon={AlertCircle}
            title={`${this.props.panelName ?? "Panel"} error`}
            description={
              this.state.error?.message || "An unexpected error occurred while rendering this panel."
            }
            action={
              <Button variant="secondary" size="sm" onClick={this.handleReset} className="gap-1.5">
                <RotateCcw className="size-3.5" aria-hidden />
                Retry panel
              </Button>
            }
          />
        </div>
      )
    }

    return this.props.children
  }
}
