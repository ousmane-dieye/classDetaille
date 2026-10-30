import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClassMember, Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const serverError = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  jsonResponse(status, { error: { code, ...extra }, requestId: 'r1' });

/** Le gestionnaire peut laisser un chemin au serveur par défaut en renvoyant `null`. */
type Handler = (url: string, init?: RequestInit) => Response | null;

function stubApi(handler: Handler): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

const DETAIL = '/api/classes/c1';
const MEMBERS = `${DETAIL}/members`;
const DELEGATES = `${DETAIL}/delegates`;
const ARCHIVE = `${DETAIL}/archive`;

const detail = {
  id: 'c1',
  name: 'GIT3',
  level: 'L3',
  academicYear: '2026-2027',
  status: 'ACTIVE',
  archivedAt: null,
  stats: { members: 42, pendingRequests: 3, decidedRequests: 17 },
};

const MEMBERS_LIST: ClassMember[] = [
  { userId: 'u1', firstName: 'Awa', lastName: 'Diop', email: 'a•••••@esp.sn', role: 'STUDENT', joinedAt: '2026-10-01T09:00:00.000Z' },
  { userId: 'u2', firstName: 'Mariama', lastName: 'Ba', email: 'm•••••@esp.sn', role: 'DELEGATE', joinedAt: '2026-10-01T09:00:00.000Z' },
];

const admin: Me = {
  id: 'a1',
  email: 'direction@esp.sn',
  firstName: 'Sokhna',
  lastName: 'Fall',
  globalRole: 'ADMIN',
  emailReminders: true,
  emailAnnouncements: true,
  enrollment: null,
  membership: null,
};

const delegate: Me = {
  ...admin,
  globalRole: 'USER',
  membership: { classId: 'c1', classLabel: 'GIT3 · L3 · 2026-2027', role: 'DELEGATE' },
};

/** Serveur par défaut : la fiche, les membres, la liste d'administration, et 200 sur toute écriture. */
function ok(handler?: Handler): Handler {
  return (url, init) => {
    const custom = handler?.(url, init);
    if (custom) return custom;
    if (url === DETAIL) return jsonResponse(200, detail);
    if (url === MEMBERS) return jsonResponse(200, MEMBERS_LIST);
    if (url === '/api/classes') return jsonResponse(200, []); // la liste, après navigation depuis la fiche
    return jsonResponse(200, {});
  };
}

async function at(handler?: Handler, me: Me = admin): Promise<void> {
  stubApi(ok(handler));
  render(
    <MemoryRouter initialEntries={['/classes/c1']}>
      <SessionProvider loadMe={async () => me}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
  // La fiche est posée (ou refusée) dès que la mention de chargement disparaît.
  await waitFor(() => expect(screen.queryByText('Chargement…')).toBeNull());
}

function writes(): Array<[string, RequestInit | undefined]> {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'DELETE') as Array<
    [string, RequestInit | undefined]
  >;
}

function sent(index: number): { url: string; body: unknown } | null {
  const call = writes()[index];
  if (!call) return null;
  return { url: call[0], body: JSON.parse(String(call[1]?.body)) };
}

/** Le formulaire d'une fenêtre de confirmation est soumis par son événement. */
function submit(): void {
  const form = document.querySelector('form');
  if (!form) throw new Error('formulaire absent');
  fireEvent.submit(form);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fiche de classe (M12)', () => {
  it('montre l’identité, le statut et les statistiques', async () => {
    await at();

    expect(screen.getByText('L3 · 2026-2027')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('Membres actifs')).toBeTruthy();
    expect(screen.queryByText('Archivée')).toBeNull();
  });

  it('une classe archivée le dit, et son archivage disparaît', async () => {
    await at((url) =>
      url === DETAIL ? jsonResponse(200, { ...detail, status: 'ARCHIVED', archivedAt: '2026-10-02T09:00:00.000Z' }) : null,
    );

    expect(screen.getByText('Archivée le 2 octobre 2026')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Archiver la classe' })).toBeNull();
  });

  it('nomme délégué après une confirmation nommant la personne', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Nommer délégué' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Nommer Awa Diop délégué de la classe ?' })).toBeTruthy();

    submit();

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(sent(0)).toEqual({ url: DELEGATES, body: { userId: 'u1' } });
  });

  it('la nomination réussie confirme par un retour temporaire nommant la personne', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Nommer délégué' }));
    await screen.findByRole('heading', { level: 2, name: 'Nommer Awa Diop délégué de la classe ?' });
    submit();

    expect(await screen.findByText('Awa Diop est désormais délégué de la classe.')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Nommer Awa Diop délégué de la classe ?' })).toBeNull();
  });

  it('la révocation réussie confirme par un retour temporaire nommant la personne', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Révoquer la délégation de Mariama Ba' }));
    await screen.findByRole('heading', { level: 2, name: 'Retirer la délégation de Mariama Ba ?' });
    submit();

    expect(await screen.findByText('Mariama Ba n’est plus délégué de la classe.')).toBeTruthy();
  });

  it('révoque la délégation après une confirmation nommant la personne', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Révoquer la délégation de Mariama Ba' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Retirer la délégation de Mariama Ba ?' })).toBeTruthy();

    submit();

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(sent(0)).toEqual({ url: `${DELEGATES}/u2`, body: {} });
  });

  it('le plafond de deux délégués s’affiche sans fermer la fenêtre', async () => {
    await at((url, init) => (url === DELEGATES && init?.method === 'POST' ? serverError(409, 'DELEGATE_LIMIT_REACHED') : null));
    fireEvent.click(screen.getByRole('button', { name: 'Nommer délégué' }));
    await screen.findByRole('heading', { level: 2, name: 'Nommer Awa Diop délégué de la classe ?' });

    submit();

    expect(await screen.findByText('Cette classe a déjà le maximum de délégués. Révoque-en un d’abord.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Nommer Awa Diop délégué de la classe ?' })).toBeTruthy();
  });

  it('l’archivage nomme la classe, exige la vérification, puis revient à la liste', async () => {
    let calls = 0;
    await at((url) => {
      if (url !== ARCHIVE) return null;
      calls += 1;
      // La première fois, l'API exige le mot de passe (R13) ; la seconde, elle archive.
      return calls === 1
        ? serverError(401, 'STEP_UP_REQUIRED', { missing: 'PASSWORD' })
        : jsonResponse(200, { id: 'c1', status: 'ARCHIVED' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Archiver la classe' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Archiver la classe GIT3 ?' })).toBeTruthy();
    expect(screen.getByText('Cette décision est définitive.')).toBeTruthy();

    submit();

    // La fenêtre de vérification s'ouvre au champ réclamé par le serveur.
    expect(await screen.findByRole('heading', { level: 2, name: 'Confirme que c’est toi' })).toBeTruthy();
    const password = screen.getByLabelText('Mot de passe');
    fireEvent.change(password, { target: { value: 'un mot de passe très long' } });
    fireEvent.submit(password.closest('form') as HTMLFormElement);

    // Le mot de passe accepté ouvre le second pas : le code à six chiffres (R13).
    expect(await screen.findByRole('heading', { level: 2, name: 'Entre le code reçu' })).toBeTruthy();
    const cell = screen.queryAllByLabelText(/^Chiffre /)[0] as HTMLInputElement;
    fireEvent.change(cell, { target: { value: '482190' } });
    fireEvent.submit(cell.closest('form') as HTMLFormElement);

    // L'action refusée est rejouée, et la classe archivée ramène à la liste.
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Classes' })).toBeTruthy());
    expect(sent(0)).toEqual({ url: ARCHIVE, body: {} });
    expect(sent(1)).toEqual({ url: '/api/me/step-up', body: { password: 'un mot de passe très long' } });
    expect(sent(2)).toEqual({ url: '/api/me/step-up/verify', body: { code: '482190' } });
    expect(sent(3)).toEqual({ url: ARCHIVE, body: {} });
    // L'archivage est confirmé même après la navigation : le retour suit l'utilisateur.
    expect(await screen.findByText('La classe GIT3 a été archivée.')).toBeTruthy();
  });

  it('une classe inconnue ou interdite affiche le même 404', async () => {
    await at((url) => (url === DETAIL ? serverError(404, 'NOT_FOUND') : null));

    expect(await screen.findByText("Cet élément n'existe pas ou n'est plus disponible.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Archiver la classe' })).toBeNull();
  });

  it('un délégué ne voit pas les sections réservées à l’administration', async () => {
    await at(undefined, delegate);

    expect(screen.getByRole('button', { name: 'Nommer délégué' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Archiver la classe' })).toBeNull();
  });

  it('un échec du serveur affiche son message et propose « Réessayer »', async () => {
    await at((url) => (url === DETAIL ? serverError(500, 'INTERNAL') : null));

    expect(await screen.findByText('Une erreur est survenue. Réessaie.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });
});
