import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiProblem } from '../../api/client';
import { listActiveClasses, register } from '../../api/auth';
import { messageFor } from '../../api/messages';
import type { ClassSummary } from '../../api/types';
import { AuthShell } from '../../components/AuthShell';
import { Button } from '../../components/Button';
import { Countdown } from '../../components/Countdown';
import { InlineAlert } from '../../components/InlineAlert';
import { PasswordField } from '../../components/PasswordField';
import { SelectField } from '../../components/SelectField';
import { Skeleton } from '../../components/Skeleton';
import { TextField } from '../../components/TextField';
import { TurnstileField } from '../../components/TurnstileField';
import { useSession } from '../../session/session-context';
import { useOnline } from '../../lib/online';

const PASSWORD_MINIMUM = 15;
const EMAIL_HINT = 'Tes rappels et la récupération de ton compte arriveront à cette adresse : vérifie-la bien.';
const MISMATCH_MESSAGE = 'Les deux mots de passe ne correspondent pas.';
const MISSING_FIELD_MESSAGE = 'Remplis tous les champs pour envoyer ta demande.';

const classLabel = (c: ClassSummary): string => `${c.name} · ${c.academicYear}`;

/** M7 et P1 : inscription d'une étudiante et demande d'adhésion à une classe active. */
export function RegisterScreen(): ReactElement {
  const navigate = useNavigate();
  const { setMe } = useSession();
  const online = useOnline();

  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [classesLoading, setClassesLoading] = useState(true);
  const [classesError, setClassesError] = useState(false);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [classId, setClassId] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setClassesLoading(true);
    setClassesError(false);
    listActiveClasses()
      .then((list) => {
        if (cancelled) return;
        // Réponse inattendue : jamais un crash, l'écran bascule sur son état d'erreur.
        if (!Array.isArray(list)) throw new Error('REPONSE_CLASSES_INVALIDE');
        setClasses(list);
      })
      .catch(() => {
        if (!cancelled) setClassesError(true);
      })
      .finally(() => {
        if (!cancelled) setClassesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mismatch = confirm !== '' && confirm !== password;
  const retryIn = problem?.retryAfterSeconds ?? 0;
  const waiting = retryIn > 0;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setProblem(null);
    setLocalError(null);

    if (!firstName || !lastName || !email || !password || !classId) {
      setLocalError(MISSING_FIELD_MESSAGE);
      return;
    }
    if ([...password].length < PASSWORD_MINIMUM) {
      setLocalError(messageFor('PASSWORD_TOO_SHORT'));
      return;
    }
    if (confirm !== password) {
      setConfirmTouched(true);
      setLocalError(MISMATCH_MESSAGE);
      return;
    }
    if (!token) {
      setLocalError(messageFor('TURNSTILE_REQUIRED'));
      setAttempt((a) => a + 1);
      return;
    }

    setBusy(true);
    try {
      const profile = await register({ firstName, lastName, email, password, classId, turnstileToken: token });
      setMe(profile);
      navigate('/etat/demande-envoyee');
    } catch (e) {
      const p = e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });
      setProblem(p);
      // Le jeton n'est plus bon : on demande une nouvelle vérification, jamais un réenvoi du même jeton.
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
      title="Créer ton compte"
      lead="Ton délégué validera ta demande pour rejoindre ta classe."
      claim="La vie de ta classe, au même endroit."
      claimDetail="Devoirs, ressources, annonces et discussions de ta promo."
      footer={
        <>
          Déjà un compte ?{' '}
          <Link className="cp-link" to="/connexion">
            Se connecter
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="cp-two">
          <TextField id="firstName" label="Prénom" value={firstName} onChange={setFirstName} autoComplete="given-name" required />
          <TextField id="lastName" label="Nom" value={lastName} onChange={setLastName} autoComplete="family-name" required />
        </div>
        <TextField id="email" label="Email" type="email" value={email} onChange={setEmail} hint={EMAIL_HINT} autoComplete="email" required />
        <div className="cp-two">
          <PasswordField id="password" label="Mot de passe" value={password} onChange={setPassword} autoComplete="new-password" minimum={PASSWORD_MINIMUM} required />
          <PasswordField
            id="confirmPassword"
            label="Confirme ton mot de passe"
            value={confirm}
            onChange={setConfirm}
            onBlur={() => setConfirmTouched(true)}
            autoComplete="new-password"
            {...(confirmTouched && mismatch ? { error: MISMATCH_MESSAGE } : {})}
            required
          />
        </div>
        {classesLoading ? <Skeleton height={48} /> : null}
        {classesError ? (
          <InlineAlert>
            Impossible de charger les classes.
            <Button variant="link" onClick={() => setClassesError(false)}>
              Réessayer
            </Button>
          </InlineAlert>
        ) : null}
        {!classesLoading && !classesError ? (
          <SelectField id="classId" label="Ta classe" value={classId} onChange={setClassId} options={classes.map((c) => ({ value: c.id, label: classLabel(c) }))} />
        ) : null}

        <TurnstileField key={attempt} onChange={setToken} />

        {localError ? <InlineAlert>{localError}</InlineAlert> : null}
        {problem ? <InlineAlert>{problem.text}</InlineAlert> : null}
        {waiting ? (
          <p className="cp-field__hint">
            Réessaie dans <Countdown seconds={retryIn} onDone={() => setProblem(null)} />
          </p>
        ) : null}

        {/* M14 : hors connexion l'écriture est impossible — la raison est dite, pas seulement le bouton gris. */}
        {!online ? <p className="cp-field__hint">Hors connexion, tu peux consulter mais pas modifier. Tout reprend dès le retour du réseau.</p> : null}

        <Button type="submit" busy={busy} disabled={waiting || !online}>
          Envoyer ma demande
        </Button>
      </form>
    </AuthShell>
  );
}
