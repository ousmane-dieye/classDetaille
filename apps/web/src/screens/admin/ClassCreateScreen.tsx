import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { createClass } from '../../api/classes';
import type { ApiProblem } from '../../api/client';
import { Button } from '../../components/Button';
import { InlineAlert } from '../../components/InlineAlert';
import { useToasts } from '../../components/Toast';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';
import { toProblem } from '../gestion/class-load';

/** `AAAA-AAAA` : le format que l'API accepte déjà, vérifié avant d'envoyer. */
const YEAR = /^\d{4}-\d{4}$/;

const MESSAGES = {
  NAME: 'Le nom de la classe est obligatoire.',
  LEVEL: 'Le niveau est obligatoire.',
  YEAR: "L'année scolaire prend le format AAAA-AAAA.",
} as const;

type Field = keyof typeof MESSAGES;

/** M11 : création d'une classe. Un champ vide ou une année mal formée ne part pas — l'API valide aussi. */
function ClassCreate(): ReactElement {
  const navigate = useNavigate();
  const { signOut } = useSession();
  const { notify } = useToasts();

  const [name, setName] = useState('');
  const [level, setLevel] = useState('');
  const [academicYear, setAcademicYear] = useState('');
  const [field, setField] = useState<Field | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return; // une seule création à la fois : une seconde frappe n'envoie rien.
    setProblem(null);
    setField(null);

    if (name.trim() === '') {
      setField('NAME');
      return;
    }
    if (level.trim() === '') {
      setField('LEVEL');
      return;
    }
    if (!YEAR.test(academicYear.trim())) {
      setField('YEAR');
      return;
    }

    setBusy(true);
    try {
      await createClass(name.trim(), level.trim(), academicYear.trim());
      // Le toast part avant la navigation : il se retrouve sur la liste, où la classe apparaît.
      notify('success', `La classe « ${name.trim()} » a été créée.`);
      navigate('/classes');
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 401) {
        await signOut();
        return;
      }
      // La saisie reste : corriger un nom n'est pas le recommencer.
      setProblem(p);
    } finally {
      setBusy(false);
    }
  }

  /** Le champ décrit par son aide et, s'il est fautif, par son message — jamais l'un au détriment de l'autre. */
  const describedBy = (which: Field, hint?: string): string | undefined => {
    const ids = [hint, field === which ? `${which.toLowerCase()}-error` : null].filter((id): id is string => id !== null);
    return ids.length > 0 ? ids.join(' ') : undefined;
  };

  const invalid = (which: Field): { 'aria-invalid': true } | undefined =>
    field === which ? { 'aria-invalid': true } : undefined;

  return (
    <div className="cp-page">
      <h1>Créer une classe</h1>

      {problem ? <InlineAlert>{problem.text}</InlineAlert> : null}

      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="cp-field">
          <label className="cp-field__label" htmlFor="nom">
            Nom de la classe
          </label>
          <input
            id="nom"
            className="cp-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            aria-describedby={describedBy('NAME')}
            {...invalid('NAME')}
          />
          {field === 'NAME' ? (
            <p className="cp-field__error" id="name-error">
              {MESSAGES.NAME}
            </p>
          ) : null}
        </div>

        <div className="cp-field">
          <label className="cp-field__label" htmlFor="niveau">
            Niveau
          </label>
          <input
            id="niveau"
            className="cp-input"
            type="text"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
            maxLength={60}
            aria-describedby={describedBy('LEVEL')}
            {...invalid('LEVEL')}
          />
          {field === 'LEVEL' ? (
            <p className="cp-field__error" id="level-error">
              {MESSAGES.LEVEL}
            </p>
          ) : null}
        </div>

        <div className="cp-field">
          <label className="cp-field__label" htmlFor="annee">
            Année scolaire
          </label>
          <input
            id="annee"
            className="cp-input"
            type="text"
            inputMode="numeric"
            value={academicYear}
            onChange={(event) => setAcademicYear(event.target.value)}
            maxLength={9}
            aria-describedby={describedBy('YEAR', 'annee-hint')}
            {...invalid('YEAR')}
          />
          <p className="cp-field__hint" id="annee-hint">
            Le format attendu est AAAA-AAAA.
          </p>
          {field === 'YEAR' ? (
            <p className="cp-field__error" id="year-error">
              {MESSAGES.YEAR}
            </p>
          ) : null}
        </div>

        <Button type="submit" busy={busy}>
          Créer la classe
        </Button>
      </form>
    </div>
  );
}

/** M11 : le formulaire de création, réservé à une session ouverte. */
export function ClassCreateScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible d’ouvrir le formulaire">
      {() => <ClassCreate />}
    </RequireSession>
  );
}
