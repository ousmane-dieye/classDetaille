import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Link } from 'react-router';
import { forgotPassword } from '../../api/auth';
import { ApiProblem } from '../../api/client';
import { AuthShell } from '../../components/AuthShell';
import { Button } from '../../components/Button';
import { Countdown } from '../../components/Countdown';
import { InlineAlert } from '../../components/InlineAlert';
import { StateScreen } from '../../components/StateScreen';
import { TextField } from '../../components/TextField';
import { TurnstileField } from '../../components/TurnstileField';

const MISSING_EMAIL = 'Renseigne ton email.';

/**
 * § 3.2 « mot de passe oublié » : la réponse `202` est identique dans tous les cas — on ne dit
 * jamais si l'email existe. Le jeton anti-robot est obligatoire : le widget est là dès l'ouverture.
 */
export function ForgotPasswordScreen(): ReactElement {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <StateScreen
        title="Vérifie ta boîte mail"
        tone="success"
        actions={
          <Link className="cp-btn cp-btn--primary" to="/connexion">
            Se connecter
          </Link>
        }
      >
        <p>Si un compte existe avec cet email, tu reçois un message.</p>
        <p className="cp-state__small">Le lien est valable 30 minutes. Vérifie tes indésirables.</p>
      </StateScreen>
    );
  }

  const retryIn = problem?.retryAfterSeconds ?? 0;
  const waiting = retryIn > 0;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setProblem(null);
    setLocalError(null);

    if (!email) {
      setLocalError(MISSING_EMAIL);
      return;
    }
    if (!token) {
      setProblem(new ApiProblem({ status: 401, code: 'TURNSTILE_REQUIRED', extra: {}, requestId: '', retryAfterSeconds: null }));
      return;
    }

    setBusy(true);
    try {
      await forgotPassword({ email, turnstileToken: token });
      setSent(true);
    } catch (e) {
      const p = e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });
      setProblem(p);
      if (p.code === 'TURNSTILE_FAILED') {
        setToken(null);
        setAttempt((a) => a + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Mot de passe oublié"
      lead="Indique l'email utilisé à l'inscription. On t'enverra un lien pour choisir un nouveau mot de passe."
      claim="Content de te revoir."
      claimDetail="Retrouve tes devoirs, tes ressources et ta classe."
      footer={
        <Link className="cp-link" to="/connexion">
          Retour à la connexion
        </Link>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <TextField id="email" label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required />

        <TurnstileField key={attempt} onChange={setToken} />

        {localError ? <InlineAlert>{localError}</InlineAlert> : null}
        {problem ? <InlineAlert>{problem.text}</InlineAlert> : null}
        {waiting ? (
          <p className="cp-field__hint">
            Réessaie dans <Countdown seconds={retryIn} onDone={() => setProblem(null)} />
          </p>
        ) : null}

        <Button type="submit" busy={busy} disabled={waiting}>
          Envoyer le lien
        </Button>
      </form>
    </AuthShell>
  );
}
