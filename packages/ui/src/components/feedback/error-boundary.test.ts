import { describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderToString } from "react-dom/server"
import { ErrorBoundary } from "./error-boundary"

function ProblematicComponent({ shouldThrow }: { shouldThrow: boolean }): ReactNode {
  if (shouldThrow) {
    throw new Error("Test intentional render explosion")
  }
  return createElement("div", null, "Normal content")
}

describe("ErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    const html = renderToString(
      createElement(
        ErrorBoundary,
        null,
        createElement(ProblematicComponent, { shouldThrow: false }),
      ),
    )
    expect(html).toContain("Normal content")
  })

  it("has getDerivedStateFromError updating state", () => {
    const testError = new Error("Derived state test")
    const nextState = ErrorBoundary.getDerivedStateFromError(testError)
    expect(nextState.hasError).toBe(true)
    expect(nextState.error).toBe(testError)
  })

  it("invokes onError callback on error", () => {
    const onError = vi.fn()
    const boundary = new ErrorBoundary({
      children: null,
      onError,
    })

    const testError = new Error("Catch test")
    const testInfo = { componentStack: "\n    in TestComponent" }
    boundary.componentDidCatch(testError, testInfo)

    expect(onError).toHaveBeenCalledWith(testError, testInfo)
  })
})
