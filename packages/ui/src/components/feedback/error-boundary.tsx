import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertCircle, RotateCcw } from "lucide-react"
import { Button } from "../actions/button"
import { EmptyState } from "./empty-state"

export interface ErrorFallbackProps {
  error: Error
  resetErrorBoundary: () => void
}

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Optional custom fallback element or render function */
  fallback?: ReactNode | ((props: ErrorFallbackProps) => ReactNode)
  /** Title shown in the default empty-state fallback */
  title?: string
  /** Description shown in the default empty-state fallback */
  description?: string
  /** Optional callback fired when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  /** Values that trigger automatic error reset when changed */
  resetKeys?: unknown[]
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Standard React Error Boundary component conforming to Forge UI four-states pattern.
 * Catches JavaScript errors in child component trees, logs them, and displays a fallback UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo)
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (!this.state.hasError) return
    if (!this.props.resetKeys || !prevProps.resetKeys) return

    const hasChanged = this.props.resetKeys.some(
      (key, index) => !Object.is(key, prevProps.resetKeys?.[index]),
    )
    if (hasChanged) {
      this.resetErrorBoundary()
    }
  }

  resetErrorBoundary = (): void => {
    this.setState({ hasError: false, error: null })
  }

  override render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback({
          error: this.state.error,
          resetErrorBoundary: this.resetErrorBoundary,
        })
      }

      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="flex h-full min-h-60 flex-col items-center justify-center p-6 text-center">
          <EmptyState
            icon={AlertCircle}
            title={this.props.title ?? "An unexpected error occurred"}
            description={
              this.props.description ??
              this.state.error.message ??
              "A rendering error interrupted the application."
            }
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={this.resetErrorBoundary}
                className="gap-1.5 cursor-pointer"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Try again
              </Button>
            }
          />
        </div>
      )
    }

    return this.props.children
  }
}
