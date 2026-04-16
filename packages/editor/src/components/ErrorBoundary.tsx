import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex flex-col items-center justify-center gap-4 p-6 font-sans bg-tagma-elevated text-tagma-text">
          <h1 className="text-2xl font-semibold m-0">Something went wrong</h1>
          <p className="text-tagma-muted max-w-[480px] text-center m-0">
            An unexpected error occurred in the editor. You can try reloading, or click the button below to recover.
          </p>
          {this.state.error && (
            <pre className="bg-tagma-bg p-3 px-4 text-sm max-w-[600px] overflow-auto text-tagma-error border border-tagma-border">
              {this.state.error.message}
            </pre>
          )}
          <div className="flex gap-2">
            <button
              onClick={this.handleReset}
              className="px-5 py-2 border-0 bg-tagma-accent text-white cursor-pointer text-sm hover:bg-tagma-accent/85 transition-colors"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-2 border border-tagma-border bg-transparent text-tagma-text cursor-pointer text-sm hover:border-tagma-muted/60 transition-colors"
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}