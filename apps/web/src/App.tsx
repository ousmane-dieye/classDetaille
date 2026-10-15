import type { ReactElement } from 'react';
import { BrowserRouter } from 'react-router';
import './app.css';
import { Banner } from './components/Banner';
import { SkipLink } from './components/SkipLink';
import { useOnline } from './lib/online';
import { AppRoutes } from './routes';
import { SessionProvider } from './session/session-context';

export function App(): ReactElement {
  const online = useOnline();

  return (
    <BrowserRouter>
      <SessionProvider>
        <SkipLink />
        <Banner online={online} />
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}
