import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { resendCode, verifyCode } from '../../api/auth';
import { ApiProblem } from '../../api/client';
import { AuthShell } from '../../components/AuthShell';
import { Button } from '../../components/Button';
import { Countdown } from '../../components/Countdown';
import { InlineAlert } from '../../components/InlineAlert';
import { OtpInput } from '../../components/OtpInput';
import { maskEmail } from '../../lib/format';
import { homePathFor } from '../../lib/home';
import { useSession } from '../../session/session-context';

/** État posé par la connexion : le défi est dans le cookie, pas dans l'URL (jamais dans l'historique). */
type ChallengeState = { email?: string; from?: string | null; expiresInSeconds?: number; resendAfterSeconds?: number };

/** Codes après lesquels il faut repartir de la connexion (§ 3.3). */
const RELOGIN_CODES = ['CHALLENGE_EXPIRED', 'CODE_LOCKED', 'UNAUTHENTICATED'];

/** M8 : contrôle à deux facteurs pour les administrateurs (§ 3.3, P2). */
export function AdminCodeScreen(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const { setMe } = useSession();
  const challenge = (location.state ?? null) as ChallengeState | null;

  const otpRef = useRef<HTMLDivElement | null>(null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [expiresIn, setExpiresIn] = useState(challenge?.expiresInSeconds ?? 0);
  const [resendIn, setResendIn] = useState(challenge?.resendAfterSeconds ?? 0);

  // Un code incorrect garde la saisie et renvoie le focus au premier champ (M8).
  useEffect(() => {
    if (problem?.code !== 'CODE_INVALID') return;
    otpRef.current?.querySelector('input')?.focus();
  }, [problem]);

  if (!challenge?.email) return <Navigate to="/connexion" replace />;

  const email = challenge.email;
  // Tracé par la connexion : après le code, on revient à l'écran qui avait demandé une session.
  const from = challenge.from ?? null;
  const ready = code.length === 6;
  const expired = expiresIn <= 0;
  const waiting = resendIn > 0;

  async function onValidate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready || busy) return;
    setProblem(null);
    setBusy(true);
    try {
      const me = await verifyCode({ code });
      setMe(me);
      navigate(from ?? homePathFor(me));
    } catch (e) {
      setProblem(
        e instanceof ApiProblem
          ? e
          : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function onResend(): Promise<void> {
    if (resending || waiting) return;
    setProblem(null);
    setResending(true);
    try {
      const delays = await resendCode();
      // Un nouveau code invalide le précédent : on repart de cases vides.
      setCode('');
      setExpiresIn(delays.expiresInSeconds);
      setResendIn(delays.resendAfterSeconds);
    } catch (e) {
      const p =
        e instanceof ApiProblem
          ? e
          : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });
      setProblem(p);
      if (p.retryAfterSeconds) setResendIn(p.retryAfterSeconds);
    } finally {
      setResending(false);
    }
  }

  const needsRelogin = problem !== null && RELOGIN_CODES.includes(problem.code);

  return (
    <AuthShell
      title="Vérifie ton email"
      lead={`On a envoyé un code à 6 chiffres à ${maskEmail(email)}.`}
      claim="Content de te revoir."
      claimDetail="Retrouve tes devoirs, tes ressources et ta classe."
    >
      <form onSubmit={(e) => void onValidate(e)} noValidate>
        <OtpInput value={code} onChange={setCode} invalid={problem?.code === 'CODE_INVALID'} containerRef={otpRef} />

        {problem ? <InlineAlert>{problem.text}</InlineAlert> : null}
        {needsRelogin ? (
          <p className="cp-auth__forgot">
            <Link className="cp-link" to="/connexion">
              Retour à la connexion
            </Link>
          </p>
        ) : null}

        <div className="cp-otp__timer">
          <span>
            Code valable encore <Countdown seconds={expiresIn} onDone={() => setExpiresIn(0)} />
          </span>
          {waiting ? (
            <span className="cp-otp__resend-wait">
              Renvoyer (<Countdown seconds={resendIn} onDone={() => setResendIn(0)} />)
            </span>
          ) : (
            <button className="cp-link cp-otp__resend" type="button" onClick={() => void onResend()}>
              Renvoyer
            </button>
          )}
        </div>

        <Button type="submit" busy={busy} disabled={!ready || expired}>
          Valider
        </Button>

        <p className="cp-field__hint cp-otp__note">
          Tu peux coller le code reçu. Pas d&apos;email ? Vérifie tes indésirables, puis renvoie le code.
        </p>
        <p className="cp-field__hint cp-otp__note">
          Tu n&apos;arrives pas à recevoir le code ? Contacte un opérateur de la plateforme : il pourra te délivrer un
          code de récupération.
        </p>
      </form>
    </AuthShell>
  );
}
