import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentRequest, Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const serverError = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  jsonResponse(status, { error: { code, ...extra }, requestId: 'r1' });

function stubApi(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

const LIST = '/api/classes/c1/requests';

const REQUESTS: EnrollmentRequest[] = [
  { id: 'r1', status: 'PENDING', createdAt: '2026-10-14T09:41:00.000Z', user: { firstName: 'Awa', lastName: 'Diop', email: 'a•••••@esp.sn' } },
  { id: 'r2', status: 'PENDING', createdAt: '2026-10-14T10:02:00.000Z', user: { firstName: 'Fatou', lastName: 'Sow', email: 'f•••••@esp.sn' } },
];

const me: Me = {
  id: 'u9',
  email: 'delegue@esp.sn',
  firstName: 'Mariama',
  lastName: 'Ba',
  globalRole: 'USER',
  emailReminders: true,
  emailAnnouncements: true,
  enrollment: null,
  membership: { classId: 'c1', classLabel: 'GIT3 · L3 · 2026-2027', role: 'DELEGATE' },
};

async function at(path = '/classes/c1/demandes'): Promise<void> {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider loadMe={async () => me}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Demandes' });
  // La liste est posée dès que la mention de chargement disparaît.
  await waitFor(() => expect(screen.queryByText('Chargement…')).toBeNull());
}

/** File d'attente vide, décisions acceptées, déconnexion neutre : la base des tests « succès ». */
function happyList(requests: EnrollmentRequest[] = REQUESTS): void {
  stubApi((url, init) => {
    if (url === LIST) return jsonResponse(200, requests);
    if (url === '/api/auth/logout') return jsonResponse(204, null);
    if (init?.method === 'POST') return jsonResponse(200, { status: 'ACCEPTED', decidedAt: '2026-10-14T11:00:00.000Z' });
    return jsonResponse(200, {});
  });
}

/** Le formulaire du ConfirmDialog est soumis par son événement : jsdom n'envoie rien depuis un bouton. */
function submit(): void {
  const form = document.querySelector('form');
  if (!form) throw new Error('formulaire absent');
  fireEvent.submit(form);
}

function posts(): Array<[string, RequestInit | undefined]> {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST') as Array<
    [string, RequestInit | undefined]
  >;
}

/** L'appel n° `index` : `apiFetch` sérialise le corps, on le relit pour le comparer. */
function sent(index: number): { url: string; body: unknown } | null {
  const call = posts()[index];
  if (!call) return null;
  return { url: call[0], body: JSON.parse(String(call[1]?.body)) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('écran des demandes (M9, P8)', () => {
  it('liste les demandes avec l’email masqué et la date d’envoi', async () => {
    happyList();
    await at();

    expect(screen.getByText('a•••••@esp.sn')).toBeTruthy();
    expect(screen.getByText('f•••••@esp.sn')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Accepter Awa Diop/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Refuser Awa Diop/ })).toBeTruthy();
  });

  it('sans demande en attente, affiche l’état vide', async () => {
    happyList([]);
    await at();

    expect(screen.getByText('Aucune demande en attente.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accepter/ })).toBeNull();
  });

  it('« Refuser » ouvre la fenêtre nommant l’objet, avec motif facultatif et mention définitive', async () => {
    happyList();
    await at();
    fireEvent.click(await screen.findByRole('button', { name: 'Refuser Awa Diop' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Refuser la demande de Awa Diop ?' })).toBeTruthy();
    expect(screen.getByLabelText('Motif')).toBeTruthy();
    expect(screen.getByText('Cette décision est définitive.')).toBeTruthy();
    expect(screen.getByText('Le motif est facultatif : la personne le recevra par email.')).toBeTruthy();
  });

  it('refuser sans motif envoie un corps vide', async () => {
    happyList();
    await at();
    fireEvent.click(await screen.findByRole('button', { name: 'Refuser Awa Diop' }));
    await screen.findByRole('heading', { level: 2, name: 'Refuser la demande de Awa Diop ?' });
    submit();

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(sent(0)).toEqual({ url: `${LIST}/r1/refuse`, body: {} });
  });

  it('refuser avec un motif envoie le motif tel quel', async () => {
    happyList();
    await at();
    fireEvent.click(await screen.findByRole('button', { name: 'Refuser Fatou Sow' }));
    await screen.findByRole('heading', { level: 2, name: 'Refuser la demande de Fatou Sow ?' });
    fireEvent.change(screen.getByLabelText('Motif'), { target: { value: 'Tu es déjà en GIT2.' } });
    submit();

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(sent(0)).toEqual({ url: `${LIST}/r2/refuse`, body: { note: 'Tu es déjà en GIT2.' } });
  });

  it('« Accepter » demande confirmation nommant l’objet, puis envoie la décision', async () => {
    happyList();
    await at();
    fireEvent.click(await screen.findByRole('button', { name: 'Accepter Awa Diop' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Accepter Awa Diop dans la classe ?' })).toBeTruthy();
    expect(screen.queryByText('Cette décision est définitive.')).toBeNull();
    expect(screen.getByText(/Awa Diop deviendra membre de/)).toBeTruthy();

    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(sent(0)).toEqual({ url: `${LIST}/r1/accept`, body: {} });
  });

  it('la décision réussie confirme par un retour temporaire, puis recharge la liste', async () => {
    // La file se vide une fois la décision prise : le rechargement montre le résultat réel.
    let decided = false;
    stubApi((url, init) => {
      if (url === LIST) return jsonResponse(200, decided ? [] : REQUESTS);
      if (url === '/api/auth/logout') return jsonResponse(204, null);
      if (init?.method === 'POST') {
        decided = true;
        return jsonResponse(200, { status: 'ACCEPTED', decidedAt: '2026-10-14T11:00:00.000Z' });
      }
      return jsonResponse(200, {});
    });
    await at();
    fireEvent.click(await screen.findByRole('button', { name: 'Accepter Awa Diop' }));
    await screen.findByRole('heading', { level: 2, name: 'Accepter Awa Diop dans la classe ?' });
    submit();

    expect(await screen.findByText('Awa Diop rejoint la classe.')).toBeTruthy();
    expect(await screen.findByText('Aucune demande en attente.')).toBeTruthy();
    // La fenêtre a disparu : la décision est faite, la file est à jour.
    expect(screen.queryByRole('heading', { level: 2, name: 'Accepter Awa Diop dans la classe ?' })).toBeNull();
  });

  it('une décision en cours ferme les autres boutons : jamais deux requêtes à la fois', async () => {
    let release: ((response: Response) => void) | null = null;
    stubApi((url, init) => {
      if (url === LIST) return jsonResponse(200, REQUESTS);
      if (init?.method === 'POST') {
        // Le serveur ne répond pas encore : l'action est en vol.
        return new Promise<Response>((resolve) => {
          release = resolve;
        }) as unknown as Response;
      }
      return jsonResponse(200, {});
    });
    await at();
    fireEvent.click(await screen.findByRole('button', { name: 'Accepter Awa Diop' }));
    await screen.findByRole('heading', { level: 2, name: 'Accepter Awa Diop dans la classe ?' });
    submit();

    // Tant que la décision voyage, plus aucune autre ne peut partir.
    await waitFor(() => expect(release).not.toBeNull());
    expect((screen.getByRole('button', { name: /Refuser Fatou Sow/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Accepter Fatou Sow/ }) as HTMLButtonElement).disabled).toBe(true);

    (release as unknown as (response: Response) => void)(jsonResponse(200, { status: 'ACCEPTED', decidedAt: '2026-10-14T11:00:00.000Z' }));
    expect(await screen.findByText('Awa Diop rejoint la classe.')).toBeTruthy();
    // Une fois la réponse reçue, les autres décisions reprennent leur place.
    await waitFor(() => expect((screen.getByRole('button', { name: /Accepter Fatou Sow/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('un refus déjà tranché côté serveur affiche le message et recharge la liste', async () => {
    stubApi((url, init) => {
      if (url === LIST) return jsonResponse(200, REQUESTS);
      if (init?.method === 'POST') return serverError(409, 'REQUEST_ALREADY_DECIDED');
      return jsonResponse(200, {});
    });
    await at();
    fireEvent.click(await screen.findByRole('button', { name: 'Refuser Awa Diop' }));
    await screen.findByRole('heading', { level: 2, name: 'Refuser la demande de Awa Diop ?' });
    submit();

    expect(await screen.findByText('Cette demande a déjà été traitée. Recharge la page.')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Refuser la demande de Awa Diop ?' })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === LIST).length).toBeGreaterThan(1);
  });

  it('un échec du serveur affiche son message et propose « Réessayer »', async () => {
    let failing = true;
    stubApi((url) => {
      if (url === LIST) {
        if (failing) return serverError(500, 'INTERNAL');
        return jsonResponse(200, REQUESTS);
      }
      return jsonResponse(200, {});
    });
    await at();

    expect(await screen.findByText('Une erreur est survenue. Réessaie.')).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('a•••••@esp.sn')).toBeTruthy();
  });

  it('la session terminée ramène à la connexion', async () => {
    stubApi((url) => (url === LIST ? serverError(401, 'UNAUTHENTICATED') : jsonResponse(204, null)));
    render(
      <MemoryRouter initialEntries={['/classes/c1/demandes']}>
        <SessionProvider loadMe={async () => me}>
          <AppRoutes />
        </SessionProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });

  it('si la connexion tombe, les écritures sont désactivées avec la raison', async () => {
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get');
    onLine.mockReturnValue(true);
    happyList();
    await at();

    // La liste est déjà affichée quand la connexion cesse.
    onLine.mockReturnValue(false);
    fireEvent(window, new Event('offline'));

    expect(await screen.findByText('Tu n’es pas connectée : les actions reprendront au retour de la connexion.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Accepter Awa Diop/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Refuser Awa Diop/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('déjà hors connexion au chargement, l’état d’erreur propose de réessayer', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    happyList();
    await at();

    expect(screen.getByText('Connexion impossible. Vérifie ta connexion internet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });
});
