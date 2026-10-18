import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { startStepUp, verifyStepUp } from '../api/account';
import { ApiProblem } from '../api/client';
import { Button } from './Button';
import { InlineAlert } from './InlineAlert';
import { OtpInput } from './OtpInput';
import { PasswordField } from './PasswordField';

export type StepUpMissing = 'PASSWORD' | 'CODE';

export type StepUpDialogProps = {
  /** `missing` du refus (R13) : la fenêtre s'ouvre directement au bon champ. */
  initialMissing?: StepUpMissing;
  /** L'action sensible, rejouée dès que l'identité est confirmée. */
  action(): Promise<void>;
  /** L'action a réussi : l'écran referme la fenêtre et affiche son résultat. */
  onSucceeded(): void;
  /** Abandon (Échap ou « Annuler ») : rien n'a été exécuté. */
  onCancel(): void;
};

const toProblem = (e: unknown): ApiProblem =>
  e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });

/** Ce que le serveur dit manquer : le mot de passe vient toujours avant le code. */
export function missingOf(problem: ApiProblem): StepUpMissing {
  return problem.extra.missing === 'CODE' ? 'CODE' : 'PASSWORD';
}

/**
 * Vérification supplémentaire (R13, P11) : sur `403 STEP_UP_REQUIRED`, le mot de passe d'abord,
 * le code à six chiffres ensuite (`OtpInput` réutilisé), puis rejeu de l'action refusée.
 *
 * Aucun écran ne reproduit cette logique : le délai de fraîcheur vient du serveur. Un échec
 * affiche le message du code d'erreur et laisse la saisie intacte — l'utilisateur corrige
 * sans tout recommencer.
 */
export function StepUpDialog({ initialMissing = 'PASSWORD', action, onSucceeded, onCancel }: StepUpDialogProps): ReactElement {
  const [step, setStep] = useState<StepUpMissing>(initialMissing);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = 'stepup-title';

  // Ouverture : mémoriser l'élément d'origine AVANT de prendre le focus ; fermeture : le lui rendre (UX § 5.1).
  useEffect(() => {
    restoreFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => restoreFocusTo.current?.focus();
  }, []);

  // Le focus part au champ de l'étape courante, y compris quand l'étape change.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [step]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  /** Le focus reste dans le panneau (UX § 5.1) : Tab au dernier élément revient au premier, et l'inverse. */
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>('input, button');
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  async function attempt(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      const p = toProblem(e);
      setProblem(p);
      // Un nouveau refus remet la fenêtre au champ que le serveur réclame vraiment.
      if (p.code === 'STEP_UP_REQUIRED') setStep(missingOf(p));
    } finally {
      setBusy(false);
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    if (step === 'PASSWORD') {
      void attempt(async () => {
        await startStepUp(password);
        setPassword(''); // le mot de passe ne sert plus : il est effacé dès qu'il a été accepté
        setCode('');
        setStep('CODE');
      });
      return;
    }
    void attempt(async () => {
      await verifyStepUp(code);
      await action();
      onSucceeded();
    });
  };

  return (
    <div className="cp-dialog">
      <div className="cp-dialog__backdrop" aria-hidden="true" />
      <div
        className="cp-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        onKeyDown={trapFocus}
      >
        <h2 id={titleId}>{step === 'PASSWORD' ? 'Confirme que c’est toi' : 'Entre le code reçu'}</h2>
        <p className="cp-dialog__lead">
          {step === 'PASSWORD'
            ? 'Cette action touche ta classe : confirme ton mot de passe, puis le code reçu par email.'
            : 'Un code à six chiffres vient d’être envoyé à ton adresse email.'}
        </p>
        <InlineAlert>{problem?.text}</InlineAlert>
        <form onSubmit={submit} noValidate>
          {step === 'PASSWORD' ? (
            <PasswordField
              id="stepup-password"
              label="Mot de passe"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              required
            />
          ) : (
            <OtpInput value={code} onChange={setCode} autoFocus invalid={problem !== null} />
          )}
          <div className="cp-dialog__actions">
            <Button type="submit" busy={busy}>
              {step === 'PASSWORD' ? 'Continuer' : 'Vérifier'}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
              Annuler
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
