import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initThemeEarly } from './hooks/use-theme';
import './index.css';

// Apply the saved theme class to <html> before React renders to avoid a
// dark-flash for light-mode users on reload.
initThemeEarly();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
