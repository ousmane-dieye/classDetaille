import { useCallback, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { createSubject, deleteSubject, listSubjects } from '../../api/classes';
import type { ApiProblem } from '../../api/client';
import type { Me, Subject } from '../../api/types';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { InlineAlert } from '../../components/InlineAlert';
import { Skeleton, useDelayedFlag } from '../../components/Skeleton';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';
import { ClassNav, useClassId } from './class-nav';
import { toProblem, useLoad } from './class-load';

/**
 * R12 (M9) : les matières de la classe.
 *
 * La base refuse une matière déjà portée par la classe ; le lot 2 ne refuse pas encore une
 * matière utilisée — aucune table ne la référence avant le lot 3. Le message est écrit et
 * l'appel le laisse passer : c'est le déclencheur, en premier, qui dira non.
 */
function ClassSubjects({ me }: { me: Me }): ReactElement {
  const classId = useClassId();
  const { signOut } = useSession();

  const load = useCallback(() => listSubjects(classId), [classId]);
  const subjects = useLoad<Subject[]>(load, signOut);

  const [name, setName] = useState('');
  const [addProblem, setAddProblem] = useState<ApiProblem | null>(null);
  const [deleting, setDeleting] = useState<Subject | null>(null);
  const [deleteProblem, setDeleteProblem] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setAddProblem(null);
    try {
      await createSubject(classId, trimmed);
      // Le champ ne s'efface qu'une fois la matière posée : sinon on perd la saisie.
      setName('');
      subjects.reload();
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 401) {
        await signOut();
        return;
      }
      setAddProblem(p);
    } finally {
      setBusy(false);
    }
  }

  async function remove(subject: Subject): Promise<void> {
    setBusy(true);
    setDeleteProblem(null);
    try {
      await deleteSubject(classId, subject.id);
      setDeleting(null);
      subjects.reload();
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 401) {
        await signOut();
        return;
      }
      // 409 SUBJECT_IN_USE : le message nomme ce qu'il faut faire d'abord, la liste tient.
      setDeleteProblem(p);
    } finally {
      setBusy(false);
    }
  }

  const classLabel = me.membership?.classId === classId ? me.membership.classLabel : 'la classe';

  const showSkeleton = useDelayedFlag(!subjects.done);

  return (
    <div className="cp-page">
      <h1>Matières</h1>
      <ClassNav classId={classId} />

      {!subjects.done && !showSkeleton ? <p className="cp-field__hint">Chargement…</p> : null}
      {showSkeleton ? (
        <>
          <Skeleton height={56} />
          <Skeleton height={56} />
        </>
      ) : null}

      {subjects.problem ? (
        <>
          <InlineAlert>{subjects.problem.text}</InlineAlert>
          <Button variant="secondary" onClick={subjects.reload}>
            Réessayer
          </Button>
        </>
      ) : null}

      {subjects.done && subjects.data !== null && subjects.data.length === 0 ? (
        <p className="cp-requests__empty">Aucune matière pour le moment.</p>
      ) : null}

      <ul className="cp-subjects">
        {(subjects.data ?? []).map((subject) => (
          <li className="cp-request" key={subject.id}>
            <div className="cp-request__body">
              <p className="cp-request__name">{subject.name}</p>
            </div>
            <div className="cp-request__actions">
              <Button variant="danger" disabled={busy} onClick={() => { setDeleting(subject); setDeleteProblem(null); }}>
                Supprimer {subject.name}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <section aria-labelledby="ajouter-matiere" className="cp-subjects__add">
        <h2 className="cp-legend" id="ajouter-matiere">
          Ajouter une matière
        </h2>
        {addProblem ? <InlineAlert>{addProblem.text}</InlineAlert> : null}
        <form onSubmit={(event) => void add(event)} noValidate>
          <label className="cp-field__label" htmlFor="matiere">
            Nom de la matière
          </label>
          <div className="cp-field__row">
            <input
              id="matiere"
              className="cp-input"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
            />
            <Button type="submit" busy={busy}>
              Ajouter la matière
            </Button>
          </div>
        </form>
      </section>

      {deleting ? (
        <ConfirmDialog
          title={`Supprimer la matière ${deleting.name} ?`}
          body={`La matière disparaît de ${classLabel}. Elle n'apparaît plus dans les listes.`}
          definitive
          confirmLabel="Supprimer la matière"
          busy={busy}
          problem={deleteProblem?.text ?? null}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

/** R12 : les matières de la classe, réservées à une session ouverte. */
export function ClassSubjectsScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger les matières">
      {(me) => <ClassSubjects me={me} />}
    </RequireSession>
  );
}
