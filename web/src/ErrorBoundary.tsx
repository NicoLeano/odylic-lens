import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'

type State = { err: Error | null; info: ErrorInfo | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { err: null, info: null }

  static getDerivedStateFromError(err: Error): State {
    return { err, info: null }
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[Atelier] render error:', err, info)
    this.setState({ err, info })
  }

  reset = () => this.setState({ err: null, info: null })

  render() {
    if (!this.state.err) return this.props.children
    return (
      <div className="min-h-screen flex items-center justify-center p-8 bg-[#f7f2ea]">
        <div className="max-w-2xl w-full bg-white rounded-2xl shadow-xl border border-black/[0.08] p-6">
          <div className="font-display text-lg font-medium mb-2">Atelier hit a rendering error</div>
          <div className="text-xs text-text-muted mb-4">
            The UI caught the crash so the whole app didn't blank out. Check
            the browser console for the stack trace — it's also logged below.
          </div>
          <pre className="text-[10px] bg-black/[0.04] rounded-lg p-3 overflow-x-auto max-h-80 whitespace-pre-wrap">
            <b>{this.state.err.name}:</b> {this.state.err.message}
            {'\n\n'}
            {this.state.err.stack}
            {this.state.info?.componentStack}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              onClick={this.reset}
              className="px-3 py-1.5 rounded-lg bg-text-primary text-white text-xs font-medium"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 rounded-lg bg-black/[0.04] text-text-secondary text-xs font-medium"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    )
  }
}
