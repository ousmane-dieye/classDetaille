import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { changePassword, updatePreferences, updateProfile } from '../../api/account';
import { ApiProblem } from '../../api/client';
import type { Me } from '../../api/types';
import { Button } from '../../components/Button';
import { InlineAlert } from '../../components/InlineAlert';
import { PasswordField } from '../../components/PasswordField';
import { TextField } from '../../components/TextField';
import { applyTheme, readTheme, type ThemeChoice } from '../../lib/theme';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';

const toProblem = (e: unknown): ApiProblem =>
  e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });

function Profile({ me }: { me: Me }): ReactElement {
  const { setMe } = useSession();

  const [firstName, setFirstName] = useState(me.firstName);
  const [lastName, setLastName] = useState(me.lastName);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
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
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const [reminders, setReminders] = useState(me.emailReminders);
  const [announcements, setAnnouncements] = useState(me.emailAnnouncements);
  const [preferencesNotice, setPreferencesNotice] = useState<string | null>(null);
  const [preferencesProblem, setPreferencesProblem] = useState<ApiProblem | null>(null);

  const [theme, setTheme] = useState<ThemeChoice>(readTheme);

  /** Règle serveur : 15 caractères pour un étudiant, 16 pour un administrateur (lot 1b). */
  const minimum = me.globalRole === 'ADMIN' ? 16 : 15;
  const mismatch = confirm.length > 0 && next !== confirm;

  async function saveProfile(): Promise<void> {
    setProfileNotice(null);
    setProfileProblem(null);
    if (!firstName || !lastName) {
      setProfileProblem(new ApiProblem({ status: 400, code: 'VALIDATION_FAILED', extra: {}, requestId: '', retryAfterSeconds: null }));
      return;
    }
    setSavingProfile(true);
    try {
      setMe(await updateProfile({ firstName, lastName }));
      setProfileNotice('Profil enregistré.');
    } catch (e) {
      // Rien n'est effacé : les champs gardent ce qui a été saisi (§ 3.1).
      setProfileProblem(toProblem(e));
    } finally {
      setSavingProfile(false);
    }
  }

  async function savePassword(): Promise<void> {
    setPasswordNotice(null);
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
      setPasswordNotice('Mot de passe modifié. Toutes les autres sessions sont fermées.');
    } catch (e) {
      const p = toProblem(e);
      if (p.code === 'CURRENT_PASSWORD_INVALID') setCurrentError(p.text);
      else setPasswordProblem(p);
    } finally {
      setSavingPassword(false);
    }
  }

  async function savePreferences(nextReminders: boolean, nextAnnouncements: boolean): Promise<void> {
    setPreferencesNotice(null);
    setPreferencesProblem(null);
    const previous = { reminders, announcements };
    setReminders(nextReminders);
    setAnnouncements(nextAnnouncements);
    try {
      const updated = await updatePreferences({ emailReminders: nextReminders, emailAnnouncements: nextAnnouncements });
      setMe(updated);
      setPreferencesNotice('Préférences enregistrées.');
    } catch (e) {
      setReminders(previous.reminders);
      setAnnouncements(previous.announcements);
      setPreferencesProblem(toProblem(e));
    }
  }

  const mismatchError = confirmTouched && mismatch ? 'Les deux mots de passe ne correspondent pas.' : undefined;

  return (
    <div className="cp-page">
      <h1>Profil</h1>

      <section aria-labelledby="profil-nom">
        <h2 className="cp-legend" id="profil-nom">
          Nom
        </h2>
        <div className="cp-row">
          <TextField id="firstName" label="Prénom" value={firstName} onChange={setFirstName} autoComplete="given-name" required />
          <TextField id="lastName" label="Nom" value={lastName} onChange={setLastName} autoComplete="family-name" required />
        </div>
        {profileNotice ? <InlineAlert tone="info">{profileNotice}</InlineAlert> : null}
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
            {passwordNotice ? <InlineAlert tone="info">{passwordNotice}</InlineAlert> : null}
            {passwordError ? <InlineAlert>{passwordError}</InlineAlert> : null}
            {passwordProblem ? <InlineAlert>{passwordProblem.text}</InlineAlert> : null}
            <Button type="submit" busy={savingPassword}>
              Mettre à jour mon mot de passe
            </Button>
          </form>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setPasswordOpen(true)}>
              Changer mon mot de passe
            </Button>
            {passwordNotice ? <InlineAlert tone="info">{passwordNotice}</InlineAlert> : null}
          </>
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
              aria-describedby="prefRemindersHint"
              onChange={(e) => void savePreferences(e.target.checked, announcements)}
            />
            <span className="cp-switch__hint" id="prefRemindersHint">
              Récapitulatif chaque matin
            </span>
          </div>
          <div className="cp-switch">
            <label htmlFor="prefAnnouncements">Annonces par email</label>
            <input id="prefAnnouncements" type="checkbox" checked={announcements} onChange={(e) => void savePreferences(reminders, e.target.checked)} />
          </div>
        </div>
        <p className="cp-field__hint">Les notifications dans l&apos;application restent toujours actives.</p>
        {preferencesNotice ? <InlineAlert tone="info">{preferencesNotice}</InlineAlert> : null}
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
