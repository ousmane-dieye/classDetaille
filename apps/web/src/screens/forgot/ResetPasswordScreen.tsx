import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { resetPassword } from '../../api/auth';
import { ApiProblem } from '../../api/client';
import { AuthShell } from '../../components/AuthShell';
import { Button } from '../../components/Button';
import { Countdown } from '../../components/Countdown';
import { InlineAlert } from '../../components/InlineAlert';
import { PasswordField } from '../../components/PasswordField';
import { StateScreen } from '../../components/StateScreen';

const MINIMUM = 15;
const MISMATCH_MESSAGE = 'Les deux mots de passe ne correspondent pas.';
const TOO_SHORT_MESSAGE = 'Ce mot de passe est trop court : 15 caractères minimum.';

/** Le serveur place le jeton dans le **fragment** du lien (`#token=…`, R8 du lot 1b) : ni query string, ni requête. */
function readToken(hash: string): string | null {
  if (!hash) return null;
  return new URLSearchParams(hash.slice(1)).get('token');
}

/** § 3.2 : réinitialisation depuis le lien reçu par email, nouveau mot de passe saisi deux fois. */
export function ResetPasswordScreen(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => readToken(location.hash));

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Une fois lu, le jeton quitte l'adresse affichée : il ne doit survivre ni à l'historique
  // ni à un partage d'écran (le fragment n'est de toute façon jamais envoyé au serveur).
  useEffect(() => {
    if (!location.hash) return;
    navigate({ pathname: location.pathname, search: '', hash: '' }, { replace: true });
  }, [location.hash, location.pathname, navigate]);

  if (done) {
    return (
      <StateScreen
        title="Mot de passe modifié"
        tone="success"
        actions={
          <Link className="cp-btn cp-btn--primary" to="/connexion">
            Se connecter
          </Link>
        }
      >
        <p>Tu peux te connecter avec ton nouveau mot de passe. Toutes les anciennes sessions sont fermées.</p>
      </StateScreen>
    );
  }

  if (!token) {
    return (
      <StateScreen
        title="Choisis un nouveau mot de passe"
        tone="error"
        actions={
          <Link className="cp-btn cp-btn--primary" to="/mot-de-passe-oublie">
            Demander un nouveau lien
          </Link>
        }
      >
        <p>Ce lien n’est plus valable. Demande un nouveau mot de passe oublié : un lien neuf t’arrivera dans quelques minutes.</p>
      </StateScreen>
    );
  }

  const retryIn = problem?.retryAfterSeconds ?? 0;
  const waiting = retryIn > 0;
  const mismatch = confirm.length > 0 && password !== confirm;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setProblem(null);
    setLocalError(null);

    if (password.length < MINIMUM) {
      setLocalError(TOO_SHORT_MESSAGE);
      return;
    }
    if (password !== confirm) {
      setConfirmTouched(true);
      setLocalError(MISMATCH_MESSAGE);
      return;
    }

    // La réduction de type du corps ne s'applique pas à l'intérieur de la fonction : on la refait.
    const currentToken = token;
    if (!currentToken) return;

    setBusy(true);
    try {
      await resetPassword({ token: currentToken, newPassword: password });
      setDone(true);
    } catch (e) {
      const p = e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });
      setProblem(p);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Choisis un nouveau mot de passe"
      lead="Ce lien remplace ton ancien mot de passe : choisis-en un que tu n'utilises pas ailleurs."
      claim="Content de te revoir."
      claimDetail="Retrouve tes devoirs, tes ressources et ta classe."
      footer={
        <Link className="cp-link" to="/connexion">
          Se connecter
        </Link>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <PasswordField
          id="password"
          label="Nouveau mot de passe"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minimum={MINIMUM}
          required
        />
        <PasswordField
          id="confirmPassword"
          label="Confirme ton nouveau mot de passe"
          value={confirm}
          onChange={setConfirm}
          onBlur={() => setConfirmTouched(true)}
          autoComplete="new-password"
          required
          {...(confirmTouched && mismatch ? { error: MISMATCH_MESSAGE } : {})}
        />

        {localError ? <InlineAlert>{localError}</InlineAlert> : null}
        {problem ? <InlineAlert>{problem.text}</InlineAlert> : null}
        {waiting ? (
          <p className="cp-field__hint">
            Réessaie dans <Countdown seconds={retryIn} onDone={() => setProblem(null)} />
          </p>
        ) : null}
        {problem?.code === 'RESET_TOKEN_INVALID' ? (
          <p className="cp-auth__forgot">
            <Link className="cp-link" to="/mot-de-passe-oublie">
              Demander un nouveau lien
            </Link>
          </p>
        ) : null}

        <Button type="submit" busy={busy} disabled={waiting}>
          Choisir ce mot de passe
        </Button>
      </form>
    </AuthShell>
  );
}
