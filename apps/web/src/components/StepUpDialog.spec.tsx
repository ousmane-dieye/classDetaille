import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../api/client';
import { StepUpDialog } from './StepUpDialog';

const jsonResponse = (status: number, body: unknown): Response =>
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  jsonResponse(status, { error: { code, ...extra }, requestId: 'r1' });

function stubApi(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

// `queryAll` : à l'étape « mot de passe », il n'y a aucune case — et ce n'est pas une erreur.
const cells = (): HTMLInputElement[] => (screen.queryAllByLabelText(/^Chiffre /) ?? []) as HTMLInputElement[];

/** Le formulaire est soumis par son événement : jsdom n'envoie rien de lui-même depuis un bouton. */
function submit(): void {
  const form = document.querySelector('form');
  if (!form) throw new Error('formulaire absent');
  fireEvent.submit(form);
}

function mount(props: { initialMissing?: 'PASSWORD' | 'CODE'; action?: () => Promise<void>; onSucceeded?: () => void; onCancel?: () => void } = {}) {
  const action = props.action ?? vi.fn(async () => {});
  const onSucceeded = props.onSucceeded ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  render(<StepUpDialog initialMissing={props.initialMissing ?? 'PASSWORD'} action={action} onSucceeded={onSucceeded} onCancel={onCancel} />);
  return { action, onSucceeded, onCancel };
}

beforeEach(() => {
  document.documentElement.lang = 'fr';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StepUpDialog (R13, P11)', () => {
  it('un refus « PASSWORD » ouvre sur le mot de passe, sans aucune case de code', () => {
    stubApi(() => problem(403, 'STEP_UP_REQUIRED', { missing: 'PASSWORD' }));
    mount({ initialMissing: 'PASSWORD' });
    expect(screen.getByLabelText('Mot de passe')).toBeTruthy();
    expect(cells()).toHaveLength(0);
  });

  it('un refus « CODE » ouvre directement sur les six cases', () => {
    stubApi(() => problem(403, 'STEP_UP_REQUIRED', { missing: 'CODE' }));
    mount({ initialMissing: 'CODE' });
    expect(cells()).toHaveLength(6);
    expect(screen.queryByLabelText('Mot de passe')).toBeNull();
  });

  it('le mot de passe accepté fait passer au code, et le mot de passe est effacé', async () => {
    stubApi((url) => (url === '/api/me/step-up' ? jsonResponse(202, { expiresInSeconds: 600 }) : problem(500, 'INTERNAL')));
    mount({ initialMissing: 'PASSWORD' });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'une phrase de passe assez longue' } });
    submit();

    await waitFor(() => expect(cells()).toHaveLength(6));
    expect(screen.queryByLabelText('Mot de passe')).toBeNull();
    expect(screen.getByRole('button', { name: 'Vérifier' })).toBeTruthy();
  });

  it('le code valide rejoue l’action puis referme la fenêtre', async () => {
    stubApi((url) => (url === '/api/me/step-up/verify' ? jsonResponse(204, null) : problem(500, 'INTERNAL')));
    const { action, onSucceeded } = mount({ initialMissing: 'CODE' });
    fireEvent.change(cells()[0] as HTMLInputElement, { target: { value: '482190' } });
    submit();

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledTimes(1);
    const verify = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/me/step-up/verify');
    expect(verify?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ code: '482190' }) });
  });

  it('un mot de passe refusé affiche le message et laisse la saisie intacte', async () => {
    stubApi(() => problem(400, 'CURRENT_PASSWORD_INVALID'));
    mount({ initialMissing: 'PASSWORD' });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'une phrase de passe fausse' } });
    submit();

    expect(await screen.findByText('Ce mot de passe actuel est incorrect.')).toBeTruthy();
    expect((screen.getByLabelText('Mot de passe') as HTMLInputElement).value).toBe('une phrase de passe fausse');
  });

  it('un code refusé affiche le message et garde les six cases', async () => {
    stubApi(() => problem(400, 'CODE_INVALID', { attemptsLeft: 4 }));
    mount({ initialMissing: 'CODE' });
    fireEvent.change(cells()[0] as HTMLInputElement, { target: { value: '000000' } });
    submit();

    expect(await screen.findByText('Code incorrect. Il te reste 4 essais.')).toBeTruthy();
    expect(cells()[0]?.value).toBe('0');
  });

  it('l’action rejouée qui échoue affiche sa cause et ne referme pas la fenêtre', async () => {
    stubApi((url) => (url === '/api/me/step-up/verify' ? jsonResponse(204, null) : problem(500, 'INTERNAL')));
    const action = vi.fn(async () => {
      throw new ApiProblem({ status: 409, code: 'CLASS_ARCHIVED', extra: {}, requestId: 'r1', retryAfterSeconds: null });
    });
    const { onSucceeded } = mount({ initialMissing: 'CODE', action });
    fireEvent.change(cells()[0] as HTMLInputElement, { target: { value: '482190' } });
    submit();

    expect(
      await screen.findByText('Cette classe est archivée : elle n’accepte plus aucune écriture.'),
    ).toBeTruthy();
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  it('un nouveau refus de vérification replace la fenêtre au champ demandé', async () => {
    stubApi((url) =>
      url === '/api/me/step-up/verify'
        ? problem(403, 'STEP_UP_REQUIRED', { missing: 'PASSWORD' })
        : problem(500, 'INTERNAL'),
    );
    mount({ initialMissing: 'CODE' });
    fireEvent.change(cells()[0] as HTMLInputElement, { target: { value: '482190' } });
    submit();

    await waitFor(() => expect(screen.getByLabelText('Mot de passe')).toBeTruthy());
  });

  it('le focus reste dans le panneau, quel que soit le sens de la tabulation', () => {
    stubApi(() => problem(403, 'STEP_UP_REQUIRED', { missing: 'CODE' }));
    mount({ initialMissing: 'CODE' });
    const cancel = screen.getByRole('button', { name: 'Annuler' });
    const firstCell = cells()[0] as HTMLInputElement;

    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(firstCell);

    fireEvent.keyDown(firstCell, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });

  it('à l’ouverture le focus part au champ, et il revient au déclencheur à la fermeture', () => {
    stubApi(() => problem(403, 'STEP_UP_REQUIRED', { missing: 'PASSWORD' }));
    const trigger = document.createElement('button');
    trigger.textContent = 'Transférer';
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = render(<StepUpDialog initialMissing="PASSWORD" action={vi.fn()} onSucceeded={vi.fn()} onCancel={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Mot de passe'));

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('« Annuler » et Échap abandonnent sans rien exécuter', async () => {
    stubApi(() => problem(500, 'INTERNAL'));
    const { action, onSucceeded, onCancel } = mount({ initialMissing: 'PASSWORD' });
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(action).not.toHaveBeenCalled();
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  it.each(['light', 'dark'] as const)('aucune violation sérieuse en thème %s', async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    stubApi(() => problem(400, 'CURRENT_PASSWORD_INVALID'));
    const { container } = render(
      <StepUpDialog initialMissing="PASSWORD" action={vi.fn()} onSucceeded={vi.fn()} onCancel={vi.fn()} />,
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id} (${v.impact}) : ${v.nodes.map((n) => n.html).join(' ;; ')}`)).toEqual([]);
    document.documentElement.removeAttribute('data-theme');
  });
});
