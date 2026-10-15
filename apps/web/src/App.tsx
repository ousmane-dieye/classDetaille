import type { ReactElement } from 'react';
import { BrowserRouter } from 'react-router';
import './app.css';
import { SkipLink } from './components/SkipLink';
import { AppRoutes } from './routes';

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <SkipLink />
      <AppRoutes />
    </BrowserRouter>
  );
}
