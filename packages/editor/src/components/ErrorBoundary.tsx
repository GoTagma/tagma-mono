import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * C5: Global error boundary so a single render error doesn't white-screen
 * the entire application.
 */
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
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '16px',
          padding: '24px',
          fontFamily: 'system-ui, sans-serif',
          background: '#18181b',
          color: '#e4e4e7',
        }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ color: '#a1a1aa', maxWidth: '480px', textAlign: 'center', margin: 0 }}>
            An unexpected error occurred in the editor. You can try reloading, or click the button below to recover.
          </p>
          {this.state.error && (
            <pre style={{
              background: '#27272a',
              padding: '12px 16px',
              borderRadius: '8px',
              fontSize: '0.8rem',
              maxWidth: '600px',
              overflow: 'auto',
              color: '#f87171',
            }}>
              {this.state.error.message}
            </pre>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={this.handleReset}
              style={{
                padding: '8px 20px',
                borderRadius: '6px',
                border: 'none',
                background: '#3b82f6',
                color: 'white',
                cursor: 'pointer',
                fontSize: '0.9rem',
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 20px',
                borderRadius: '6px',
                border: '1px solid #3f3f46',
                background: 'transparent',
                color: '#e4e4e7',
                cursor: 'pointer',
                fontSize: '0.9rem',
              }}
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
