import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { login } from '../../api/auth';
import { ApiProblem } from '../../api/client';
import { AuthShell } from '../../components/AuthShell';
import { Button } from '../../components/Button';
import { Countdown } from '../../components/Countdown';
import { InlineAlert } from '../../components/InlineAlert';
import { PasswordField } from '../../components/PasswordField';
import { TextField } from '../../components/TextField';
import { TurnstileField } from '../../components/TurnstileField';
import { homePathFor } from '../../lib/home';
import { useSession } from '../../session/session-context';

const IDENTICAL_MESSAGE = 'Email ou mot de passe incorrect.';
const MISSING_FIELD_MESSAGE = 'Renseigne ton email et ton mot de passe.';

/**
 * § 3.2 « Connexion » : message identique dans tous les cas pour la tentative elle-même ;
 * la suspension (403) et les limites (429) gardent leur texte propre.
 */
function loginText(problem: ApiProblem): string {
  const isCredentialAttempt = problem.status === 401 || (problem.status === 400 && (problem.code === 'TURNSTILE_FAILED' || problem.code === 'TURNSTILE_REQUIRED'));
  return isCredentialAttempt ? IDENTICAL_MESSAGE : problem.text;
}

/** M8 et P2 : connexion par email et mot de passe, avec vérification anti-robot après échecs. */
export function LoginScreen(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, me, setMe } = useSession();
  // Un écran protégé renvoie vers la connexion en laissant la trace de l'origine (§ 3.2).
  const from = (location.state as { from?: string } | null)?.from ?? null;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [needTurnstile, setNeedTurnstile] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated' && me) return <Navigate to={from ?? homePathFor(me)} replace />;

  const retryIn = problem?.retryAfterSeconds ?? 0;
  const waiting = retryIn > 0;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setProblem(null);
    setLocalError(null);

    if (!email || !password) {
      setLocalError(MISSING_FIELD_MESSAGE);
      return;
    }

    setBusy(true);
    try {
      const result = await login(token === null ? { email, password } : { email, password, turnstileToken: token });
      if (result.kind === 'second-factor') {
        navigate('/connexion/code', {
          state: { email, from, expiresInSeconds: result.expiresInSeconds, resendAfterSeconds: result.resendAfterSeconds },
        });
        return;
      }
      setMe(result.me);
      navigate(from ?? homePathFor(result.me));
    } catch (e) {
      const p = e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });
      setProblem(p);
      // Après plusieurs échecs, le serveur exige la vérification anti-robot (§ 3.2, UX P2).
      if (p.extra.turnstileRequired === true) setNeedTurnstile(true);
      if (p.code === 'TURNSTILE_FAILED' || p.code === 'TURNSTILE_REQUIRED') {
        setToken(null);
        setAttempt((a) => a + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Se connecter"
      lead="Avec l'email utilisé à l'inscription."
      claim="Content de te revoir."
      claimDetail="Retrouve tes devoirs, tes ressources et ta classe."
      footer={
        <>
          Pas encore de compte ?{' '}
          <Link className="cp-link" to="/inscription">
            Créer un compte
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <TextField id="email" label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required />
        <PasswordField id="password" label="Mot de passe" value={password} onChange={setPassword} autoComplete="current-password" required />

        <p className="cp-auth__forgot">
          <Link className="cp-link" to="/mot-de-passe-oublie">
            Mot de passe oublié ?
          </Link>
        </p>

        {needTurnstile ? <TurnstileField key={attempt} onChange={setToken} /> : null}

        {localError ? <InlineAlert>{localError}</InlineAlert> : null}
        {problem ? <InlineAlert>{loginText(problem)}</InlineAlert> : null}
        {waiting ? (
          <p className="cp-field__hint">
            Réessaie dans <Countdown seconds={retryIn} onDone={() => setProblem(null)} />
          </p>
        ) : null}

        <Button type="submit" busy={busy} disabled={waiting}>
          Se connecter
        </Button>
      </form>
    </AuthShell>
  );
}
