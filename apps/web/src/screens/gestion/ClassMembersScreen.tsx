import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { listMembers, removeMember } from '../../api/classes';
import type { ApiProblem } from '../../api/client';
import type { ClassMember, Me } from '../../api/types';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { InlineAlert } from '../../components/InlineAlert';
import { Skeleton, useDelayedFlag } from '../../components/Skeleton';
import { useToasts } from '../../components/Toast';
import { formatDateTime } from '../../lib/format';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';
import { ClassNav, useClassId } from './class-nav';
import { toProblem, useLoad } from './class-load';

const fullName = (member: ClassMember): string => `${member.firstName} ${member.lastName}`;

/**
 * M9 : qui est dans la classe, et comment retirer quelqu'un.
 *
 * Un délégué ne retire que des étudiants — la matrice le refuse déjà côté serveur
 * ( `memberships.remove` ) ; l'écran ne montre pas un bouton qui échouerait.
 */
function ClassMembers({ me }: { me: Me }): ReactElement {
  const classId = useClassId();
  const { signOut, refresh } = useSession();
  const { notify } = useToasts();

  const load = useCallback(() => listMembers(classId), [classId]);
  const members = useLoad<ClassMember[]>(load, signOut);

  const [removing, setRemoving] = useState<ClassMember | null>(null);
  const [removeProblem, setRemoveProblem] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  const removable = (member: ClassMember): boolean => me.globalRole === 'ADMIN' || member.role === 'STUDENT';

  async function remove(member: ClassMember, note?: string): Promise<void> {
    if (busy) return; // une seule exécution à la fois : la seconde confirmation n'envoie rien.
    setBusy(true);
    setRemoveProblem(null);
    try {
      await removeMember(classId, member.userId, note);
      setRemoving(null);
      // Le retrait est fait : le retour nomme la personne, sans dire si c'est « lui » ou « elle ».
      notify('success', `${fullName(member)} ne fait plus partie de la classe.`);
      await refresh();
      members.reload();
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 401) {
        await signOut();
        return;
      }
      // La fenêtre reste ouverte et le motif est gardé : l'erreur nomme sa cause.
      setRemoveProblem(p);
    } finally {
      setBusy(false);
    }
  }

  const showSkeleton = useDelayedFlag(!members.done);

  return (
    <div className="cp-page">
      <h1>Membres</h1>
      <ClassNav classId={classId} />

      {!members.done && !showSkeleton ? <p className="cp-field__hint">Chargement…</p> : null}
      {showSkeleton ? (
        <>
          <Skeleton height={72} />
          <Skeleton height={72} />
        </>
      ) : null}

      {members.problem ? (
        <>
          <InlineAlert>{members.problem.text}</InlineAlert>
          <Button variant="secondary" onClick={members.reload}>
            Réessayer
          </Button>
        </>
      ) : null}

      {members.done && members.data !== null && members.data.length === 0 ? (
        <p className="cp-requests__empty">Aucun membre dans cette classe.</p>
      ) : null}

      <ul className="cp-members">
        {(members.data ?? []).map((member) => (
          <li className="cp-request" key={member.userId}>
            <div className="cp-request__body">
              <p className="cp-request__name">
                {fullName(member)}{' '}
                {/* Masculin générique : le serveur ne connaît pas le genre. */}
                <span className="cp-role">{member.role === 'DELEGATE' ? 'Délégué' : 'Étudiant'}</span>
              </p>
              <p className="cp-request__meta">{member.email}</p>
              <p className="cp-request__meta">Membre depuis le {formatDateTime(member.joinedAt)}</p>
            </div>
            {removable(member) ? (
              <div className="cp-request__actions">
                <Button
                  variant="danger"
                  disabled={busy}
                  busy={busy && removing?.userId === member.userId}
                  onClick={() => {
                    setRemoving(member);
                    setRemoveProblem(null);
                  }}
                >
                  Retirer {fullName(member)}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {removing ? (
        <ConfirmDialog
          title={`Retirer ${fullName(removing)} de la classe ?`}
          body={`${fullName(removing)} ne verra plus les devoirs ni les ressources de la classe. Son compte reste intact.`}
          definitive
          noteLabel="Motif"
          noteHint="Le motif est facultatif : il sera envoyé à la personne."
          confirmLabel={`Retirer ${fullName(removing)}`}
          busy={busy}
          problem={removeProblem?.text ?? null}
          onConfirm={(note) => void remove(removing, note)}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}

/** M9 : la liste des membres, réservée à une session ouverte. */
export function ClassMembersScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger les membres">
      {(me) => <ClassMembers me={me} />}
    </RequireSession>
  );
}
