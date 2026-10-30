import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { changePassword, updatePreferences, updateProfile } from '../../api/account';
import { listRequests } from '../../api/classes';
import { ApiProblem } from '../../api/client';
import type { Me } from '../../api/types';
import { Button } from '../../components/Button';
import { InlineAlert } from '../../components/InlineAlert';
import { PasswordField } from '../../components/PasswordField';
import { TextField } from '../../components/TextField';
import { useToasts } from '../../components/Toast';
import { applyTheme, readTheme, type ThemeChoice } from '../../lib/theme';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';

const toProblem = (e: unknown): ApiProblem =>
  e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });

function ManageClassLink({ classId }: { classId: string }): ReactElement {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void listRequests(classId)
      .then((requests) => {
        if (alive) setCount(requests.length);
      })
      .catch(() => {
        /* le badge n'est qu'un détail : son absence ne doit pas peser sur le profil */
      });
    return () => {
      alive = false;
    };
  }, [classId]);

  return (
    <Link className="cp-btn cp-btn--secondary" to={`/classes/${classId}/demandes`}>
      Gestion de ma classe
      {count ? <span className="cp-badge">{count}</span> : null}
    </Link>
  );
}

function Profile({ me }: { me: Me }): ReactElement {
  const { setMe } = useSession();
  const { notify } = useToasts();

  const [firstName, setFirstName] = useState(me.firstName);
  const [lastName, setLastName] = useState(me.lastName);
  const [profileProblem, setProfileProblem] = useState<ApiProblem | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordProblem, setPasswordProblem] = useState<ApiProblem | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const [reminders, setReminders] = useState(me.emailReminders);
  const [announcements, setAnnouncements] = useState(me.emailAnnouncements);
  const [preferencesProblem, setPreferencesProblem] = useState<ApiProblem | null>(null);
  // Les interrupteurs se figent pendant l'enregistrement : deux basculements simultanés
  // s'enverraient l'un après l'autre, et le second répondrait peut-être le premier.
  const [savingPreferences, setSavingPreferences] = useState(false);

  const [theme, setTheme] = useState<ThemeChoice>(readTheme);

  /** Règle serveur : 15 caractères pour un étudiant, 16 pour un administrateur (lot 1b). */
  const minimum = me.globalRole === 'ADMIN' ? 16 : 15;
  const mismatch = confirm.length > 0 && next !== confirm;

  async function saveProfile(): Promise<void> {
    if (savingProfile) return; // un seul enregistrement à la fois.
    setProfileProblem(null);
    if (!firstName || !lastName) {
      setProfileProblem(new ApiProblem({ status: 400, code: 'VALIDATION_FAILED', extra: {}, requestId: '', retryAfterSeconds: null }));
      return;
    }
    setSavingProfile(true);
    try {
      setMe(await updateProfile({ firstName, lastName }));
      notify('success', 'Profil enregistré.');
    } catch (e) {
      // Rien n'est effacé : les champs gardent ce qui a été saisi (§ 3.1).
      setProfileProblem(toProblem(e));
    } finally {
      setSavingProfile(false);
    }
  }

  async function savePassword(): Promise<void> {
    if (savingPassword) return; // une seule mise à jour à la fois.
    setPasswordProblem(null);
    setPasswordError(null);
    setCurrentError(null);
    if (current.length === 0) {
      setCurrentError('Indique ton mot de passe actuel.');
      return;
    }
    if (next.length < minimum) {
      setPasswordError(`Ce mot de passe est trop court : ${minimum} caractères minimum.`);
      return;
    }
    if (next !== confirm) {
      // L'erreur s'affiche sous le champ, en quittant celui-ci : un seul message, pas deux.
      setConfirmTouched(true);
      return;
    }

    setSavingPassword(true);
    try {
      await changePassword({ currentPassword: current, newPassword: next });
      setPasswordOpen(false);
      setCurrent('');
      setNext('');
      setConfirm('');
      setConfirmTouched(false);
      notify('success', 'Mot de passe modifié. Toutes les autres sessions sont fermées.');
    } catch (e) {
      const p = toProblem(e);
      if (p.code === 'CURRENT_PASSWORD_INVALID') setCurrentError(p.text);
      else setPasswordProblem(p);
    } finally {
      setSavingPassword(false);
    }
  }

  async function savePreferences(nextReminders: boolean, nextAnnouncements: boolean): Promise<void> {
    if (savingPreferences) return; // un seul enregistrement à la fois : pas de réponse à dépiler.
    setPreferencesProblem(null);
    const previous = { reminders, announcements };
    setReminders(nextReminders);
    setAnnouncements(nextAnnouncements);
    setSavingPreferences(true);
    try {
      const updated = await updatePreferences({ emailReminders: nextReminders, emailAnnouncements: nextAnnouncements });
      setMe(updated);
      notify('success', 'Préférences enregistrées.');
    } catch (e) {
      setReminders(previous.reminders);
      setAnnouncements(previous.announcements);
      setPreferencesProblem(toProblem(e));
    } finally {
      setSavingPreferences(false);
    }
  }

  const mismatchError = confirmTouched && mismatch ? 'Les deux mots de passe ne correspondent pas.' : undefined;

  return (
    <div className="cp-page">
      <h1>Profil</h1>

      {/* R9 : la classe vient du serveur avec le profil — jamais une liste, jamais une autre classe. */}
      {me.membership ? (
        <section aria-labelledby="profil-classe">
          <h2 className="cp-legend" id="profil-classe">
            Ma classe
          </h2>
          <p className="cp-recap">
            <span>{me.membership.classLabel}</span>
            {/* Masculin générique : le serveur ne connaît pas le genre. */}
            <span>{me.membership.role === 'DELEGATE' ? 'Délégué' : 'Étudiant'}</span>
          </p>
          {/* R14 : l'entrée de gestion n'existe que pour qui la gère. */}
          {me.membership.role === 'DELEGATE' ? <ManageClassLink classId={me.membership.classId} /> : null}
        </section>
      ) : null}

      {/* M11 : la liste d'administration n'existe que pour qui administre. */}
      {me.globalRole === 'ADMIN' ? (
        <section aria-labelledby="profil-admin">
          <h2 className="cp-legend" id="profil-admin">
            Administration
          </h2>
          <Link className="cp-btn cp-btn--secondary" to="/classes">
            Classes
          </Link>
        </section>
      ) : null}

      <section aria-labelledby="profil-nom">
        <h2 className="cp-legend" id="profil-nom">
          Nom
        </h2>
        <div className="cp-row">
          <TextField id="firstName" label="Prénom" value={firstName} onChange={setFirstName} autoComplete="given-name" required />
          <TextField id="lastName" label="Nom" value={lastName} onChange={setLastName} autoComplete="family-name" required />
        </div>
        {profileProblem ? <InlineAlert>{profileProblem.text}</InlineAlert> : null}
        <Button busy={savingProfile} onClick={() => void saveProfile()}>
          Enregistrer
        </Button>
      </section>

      <section aria-labelledby="profil-compte">
        <h2 className="cp-legend" id="profil-compte">
          Compte
        </h2>
        <TextField id="email" label="Email" value={me.email} onChange={() => {}} readOnly autoComplete="email" hint="Ton adresse est celle de l'inscription : elle reçoit tes rappels et sert à récupérer ton compte." />
        {passwordOpen ? (
          <form
            className="cp-password"
            onSubmit={(e) => {
              e.preventDefault();
              void savePassword();
            }}
            noValidate
          >
            <h3>Changer mon mot de passe</h3>
            <PasswordField id="currentPassword" label="Mot de passe actuel" value={current} onChange={setCurrent} autoComplete="current-password" required {...(currentError ? { error: currentError } : {})} />
            <PasswordField id="newPassword" label="Nouveau mot de passe" value={next} onChange={setNext} autoComplete="new-password" minimum={minimum} required />
            <PasswordField
              id="confirmPassword"
              label="Confirme ton nouveau mot de passe"
              value={confirm}
              onChange={setConfirm}
              onBlur={() => setConfirmTouched(true)}
              autoComplete="new-password"
              required
              {...(mismatchError ? { error: mismatchError } : {})}
            />
            {passwordError ? <InlineAlert>{passwordError}</InlineAlert> : null}
            {passwordProblem ? <InlineAlert>{passwordProblem.text}</InlineAlert> : null}
            <Button type="submit" busy={savingPassword}>
              Mettre à jour mon mot de passe
            </Button>
          </form>
        ) : (
          <Button variant="secondary" onClick={() => setPasswordOpen(true)}>
            Changer mon mot de passe
          </Button>
        )}
        <p>
          <Link className="cp-link" to="/profil/sessions">
            Sessions actives
          </Link>
        </p>
      </section>

      <section aria-labelledby="profil-emails">
        <h2 className="cp-legend" id="profil-emails">
          EMAILS
        </h2>
        <div className="cp-switches">
          <div className="cp-switch">
            <label htmlFor="prefReminders">Rappels de devoirs</label>
            <input
              id="prefReminders"
              type="checkbox"
              checked={reminders}
              disabled={savingPreferences}
              aria-describedby="prefRemindersHint"
              onChange={(e) => void savePreferences(e.target.checked, announcements)}
            />
            <span className="cp-switch__hint" id="prefRemindersHint">
              Récapitulatif chaque matin
            </span>
          </div>
          <div className="cp-switch">
            <label htmlFor="prefAnnouncements">Annonces par email</label>
            <input
              id="prefAnnouncements"
              type="checkbox"
              checked={announcements}
              disabled={savingPreferences}
              onChange={(e) => void savePreferences(reminders, e.target.checked)}
            />
          </div>
        </div>
        <p className="cp-field__hint">Les notifications dans l&apos;application restent toujours actives.</p>
        {preferencesProblem ? <InlineAlert>{preferencesProblem.text}</InlineAlert> : null}
      </section>

      <section aria-labelledby="profil-theme">
        <h2 className="cp-legend" id="profil-theme">
          Thème
        </h2>
        <fieldset className="cp-theme">
          <legend className="cp-visually-hidden">Thème de l’application</legend>
          {(
            [
              ['system', 'Système'],
              ['light', 'Clair'],
              ['dark', 'Sombre'],
            ] as [ThemeChoice, string][]
          ).map(([choice, label]) => (
            <label key={choice} className="cp-theme__choice">
              <input type="radio" name="theme" value={choice} checked={theme === choice} onChange={() => { setTheme(choice); applyTheme(choice); }} />
              {label}
            </label>
          ))}
        </fieldset>
      </section>
    </div>
  );
}

/** M14 et P10 : nom, mot de passe, préférences d'email, thème, email en lecture seule. */
export function ProfileScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger ton profil">
      {(me) => <Profile me={me} />}
    </RequireSession>
  );
}
