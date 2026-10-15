import type { ReactElement } from 'react';
import { BrowserRouter } from 'react-router';
import './app.css';
import { SkipLink } from './components/SkipLink';
import { AppRoutes } from './routes';
import { SessionProvider } from './session/session-context';

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <SessionProvider>
        <SkipLink />
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}
