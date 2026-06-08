import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

/**
 * Catches render errors in any screen so a single bad data shape (e.g. a
 * meeting whose action-items are objects) shows a recoverable fallback
 * instead of blanking the entire app. Reset by changing `resetKey` (we key
 * it on the route path, so navigating away clears the error).
 */
interface Props { children: ReactNode; resetKey?: string }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface in the console for diagnosis; never rethrow.
    console.error('[console-web] render error:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-8">
        <div className="max-w-md rounded-xl border border-border bg-surface p-6 text-center shadow-sm">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-warning" aria-hidden />
          <h2 className="mb-1 text-h3 text-fg">This view hit a snag</h2>
          <p className="mb-4 text-body text-muted">Something on this screen couldn't render. The rest of the app is fine — try again, or switch tabs.</p>
          <button type="button" onClick={() => this.setState({ error: null })}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-body font-semibold text-primary-fg hover:bg-primary-hover cursor-pointer">
            <RotateCw className="h-4 w-4" aria-hidden /> Try again
          </button>
          <p className="mt-3 break-words font-mono text-caption text-faint">{this.state.error.message}</p>
        </div>
      </div>
    );
  }
}
