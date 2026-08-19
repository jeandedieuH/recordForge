import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertCircle, RotateCcw } from "lucide-react"
import { Button, EmptyState } from "@recordforge/ui"

interface ViewErrorBoundaryProps {
  children: ReactNode
  viewName: string
  resetKey?: string
  onNavigateHome?: () => void
}

interface ViewErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * View-level Error Boundary for AppShell views (Library, Projects, Storage, Editor, Export, Settings).
 * Prevents a failure in one view from crashing the whole shell or hiding the navigation bar.
 */
export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  constructor(props: ViewErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ViewErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`View ${this.props.viewName} crashed:`, error, errorInfo)
  }

  override componentDidUpdate(prevProps: ViewErrorBoundaryProps): void {
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
        <div className="flex h-full min-h-100 flex-col items-center justify-center p-8 text-center">
          <EmptyState
            icon={AlertCircle}
            title={`${this.props.viewName} view error`}
            description={
              this.state.error?.message ||
              `An unexpected error occurred while rendering the ${this.props.viewName} view.`
            }
            action={
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={this.handleReset}
                  className="gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Retry {this.props.viewName}
                </Button>
                {this.props.onNavigateHome ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={this.props.onNavigateHome}
                    className="cursor-pointer"
                  >
                    Go to Library
                  </Button>
                ) : null}
              </div>
            }
          />
        </div>
      )
    }

    return this.props.children
  }
}
