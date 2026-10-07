import { Component, type ErrorInfo, type ReactNode } from 'react'

interface BoundaryProps {
  children: ReactNode
  /** Rendered in place of children after an error. Inside a <Canvas>, keep this null (no DOM). */
  fallback?: (error: Error) => ReactNode
  onError?: (error: Error) => void
  /** Changing this value clears the error and re-renders children (e.g. pass the asset URL). */
  resetKey?: unknown
}

interface BoundaryState {
  error: Error | null
  resetKey: unknown
}

/** Catches render-time errors in the viewer tree so they surface instead of blanking the canvas. */
export class ViewerErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey }
    return null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[viewer]', error, info.componentStack)
    this.props.onError?.(error)
  }

  render() {
    if (this.state.error) return this.props.fallback ? this.props.fallback(this.state.error) : null
    return this.props.children
  }
}

export interface ViewerErrorItem {
  source: string
  message: string
}

/** Visible overlay listing real viewer errors (splat, watch, renderer). */
export function ViewerErrorOverlay({ errors, className = '' }: { errors: ViewerErrorItem[]; className?: string }) {
  if (errors.length === 0) return null
  return (
    <div className={`pointer-events-none absolute inset-x-0 top-4 z-10 flex flex-col items-center gap-2 px-4 ${className}`}>
      {errors.map((e) => (
        <div
          key={e.source}
          role="alert"
          className="pointer-events-auto max-w-xl rounded border border-white/15 bg-black/70 px-3 py-2 text-xs text-white backdrop-blur-md"
        >
          <span className="font-semibold text-red-300">{e.source} error: </span>
          <span className="break-words">{e.message}</span>
        </div>
      ))}
    </div>
  )
}
