import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../api/client';
import type { Me } from '../api/types';
import { SessionProvider, useSession, type SessionValue } from './session-context';

afterEach(cleanup);

function Probe({ onReady }: { onReady?(session: SessionValue): void }): ReactElement {
  const session = useSession();
  const { status, me } = session;
  useEffect(() => {
    onReady?.(session);
  }, [session, onReady]);
  return (
    <div data-testid="probe">
      {status}
      {me ? ` ${me.firstName}` : ''}
    </div>
  );
}

const me: Me = {
  id: 'u1',
  email: 'awa@example.com',
  firstName: 'Awa',
  lastName: 'Diop',
  globalRole: 'USER',
  emailReminders: true,
  emailAnnouncements: true,
  enrollment: null,
};

const unauthenticated = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

describe('session', () => {
  it('passe de « chargement » à « anonyme » quand le serveur refuse', async () => {
    render(
      <SessionProvider loadMe={unauthenticated}>
        <Probe />
      </SessionProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toContain('loading');
    expect(await screen.findByText(/anonymous/)).toBeTruthy();
  });

  it('porte le profil quand le serveur le renvoie', async () => {
    render(
      <SessionProvider loadMe={async () => me}>
        <Probe />
      </SessionProvider>,
    );
    expect(await screen.findByText(/authenticated Awa/)).toBeTruthy();
  });

  it('enregistre un profil sans rechargement après une inscription', async () => {
    const box: { current: SessionValue | null } = { current: null };
    render(
      <SessionProvider loadMe={unauthenticated}>
        <Probe onReady={(s) => (box.current = s)} />
      </SessionProvider>,
    );
    await screen.findByText(/anonymous/);
    const session = box.current;
    if (!session) throw new Error('session indisponible');
    session.setMe(me);
    expect(await screen.findByText(/authenticated Awa/)).toBeTruthy();
  });

  it('recharge la session quand le réseau revient (M14)', async () => {
    const loadMe = vi.fn(async () => me);
    render(
      <SessionProvider loadMe={loadMe}>
        <Probe />
      </SessionProvider>,
    );
    await screen.findByText(/authenticated Awa/);
    expect(loadMe).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(loadMe).toHaveBeenCalledTimes(2));
  });
});
