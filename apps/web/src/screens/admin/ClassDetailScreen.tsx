import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { archiveClass, getClassDetail, listMembers, appointDelegate, revokeDelegate } from '../../api/classes';
import type { ApiProblem } from '../../api/client';
import type { ClassDetail, ClassMember, Me } from '../../api/types';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { InlineAlert } from '../../components/InlineAlert';
import { Skeleton } from '../../components/Skeleton';
import { StepUpDialog } from '../../components/StepUpDialog';
import type { StepUpMissing } from '../../components/StepUpDialog';
import { useToasts } from '../../components/Toast';
import { formatLongDate } from '../../lib/format';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';
import { ClassNav, useClassId } from '../gestion/class-nav';
import { ClassStatsPanel } from '../gestion/class-stats-panel';
import { toProblem, useLoad } from '../gestion/class-load';

const NOT_FOUND = "Cet élément n'existe pas ou n'est plus disponible.";

type Action =
  | { kind: 'appoint'; member: ClassMember }
  | { kind: 'revoke'; member: ClassMember }
  | { kind: 'archive' };

const fullName = (member: ClassMember): string => `${member.firstName} ${member.lastName}`;

/**
 * M12 : la fiche d'une classe — identité, statistiques, et ce qu'un administrateur peut y faire.
 *
 * Un délégué y voit sa classe et ses chiffres ; nomination et archivage sont réservés à
 * l'administration, et l'écran n'affiche pas ce que le serveur refuserait. L'archivage exige
 * la vérification d'identité (R13) : le refus ouvre la fenêtre au champ réclamé, puis rejoue
 * l'action.
 */
function ClassDetail({ me }: { me: Me }): ReactElement {
  const classId = useClassId();
  const navigate = useNavigate();
  const { signOut } = useSession();
  const { notify } = useToasts();

  const loadDetail = useCallback(() => getClassDetail(classId), [classId]);
  const detail = useLoad<ClassDetail>(loadDetail, signOut);
  const loadMembers = useCallback(() => listMembers(classId), [classId]);
  const members = useLoad<ClassMember[]>(loadMembers, signOut);

  const [action, setAction] = useState<Action | null>(null);
  const [actionProblem, setActionProblem] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState<StepUpMissing | null>(null);

  const isAdmin = me.globalRole === 'ADMIN';

  /** L'archivage, tel qu'il part au serveur : rejoué par la fenêtre de vérification. */
  const doArchive = useCallback(async () => {
    await archiveClass(classId);
  }, [classId]);

  /** La classe quitte les listes : le toast suit l'utilisateur jusqu'à celles-ci, par quel chemin qu'il passe. */
  const notifyArchived = useCallback(() => {
    const archived = detail.data?.name;
    notify('success', archived ? `La classe ${archived} a été archivée.` : 'La classe a été archivée.');
  }, [detail.data?.name, notify]);

  async function run(next: Action): Promise<void> {
    if (busy) return; // une seule action à la fois : la seconde confirmation n'envoie rien.
    setBusy(true);
    setActionProblem(null);
    try {
      if (next.kind === 'archive') {
        await doArchive();
        notifyArchived();
        navigate('/classes');
        return;
      }
      if (next.kind === 'appoint') {
        await appointDelegate(classId, next.member.userId);
        notify('success', `${fullName(next.member)} est désormais délégué de la classe.`);
      } else {
        await revokeDelegate(classId, next.member.userId);
        notify('success', `${fullName(next.member)} n’est plus délégué de la classe.`);
      }
      setAction(null);
      members.reload();
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 401 && p.code === 'STEP_UP_REQUIRED') {
        // R13 : la fenêtre s'ouvre au champ que le serveur réclame, et l'action sera rejouée.
        setAction(null);
        const missing = typeof p.extra.missing === 'string' ? (p.extra.missing as StepUpMissing) : 'PASSWORD';
        setStepUp(missing);
        return;
      }
      if (p.status === 401) {
        await signOut();
        return;
      }
      // La fenêtre reste ouverte : le plafond de deux délégués, par exemple, se corrige dedans.
      setActionProblem(p);
    } finally {
      setBusy(false);
    }
  }

  const klass = detail.data;
  const notFound = detail.problem?.status === 404;

  const dialog = (): ReactElement | null => {
    if (!action) return null;
    if (action.kind === 'archive') {
      return (
        <ConfirmDialog
          title={`Archiver la classe ${klass?.name ?? ''} ?`}
          body="Les appartenances se ferment et la classe n'accepte plus aucune écriture. Elle reste consultable."
          definitive
          confirmLabel="Archiver la classe"
          busy={busy}
          problem={actionProblem?.text ?? null}
          onConfirm={() => void run({ kind: 'archive' })}
          onCancel={() => setAction(null)}
        />
      );
    }
    const name = fullName(action.member);
    return action.kind === 'appoint' ? (
      <ConfirmDialog
        title={`Nommer ${name} délégué de la classe ?`}
        body={`${name} pourra alors voir les demandes et retirer des étudiants. Il y a au maximum deux délégués par classe.`}
        confirmLabel={`Nommer ${name} délégué`}
        busy={busy}
        problem={actionProblem?.text ?? null}
        onConfirm={() => void run(action)}
        onCancel={() => setAction(null)}
      />
    ) : (
      <ConfirmDialog
        title={`Retirer la délégation de ${name} ?`}
        body={`${name} reste dans la classe, avec le rôle d'étudiant.`}
        definitive
        confirmLabel={`Retirer la délégation de ${name}`}
        busy={busy}
        problem={actionProblem?.text ?? null}
        onConfirm={() => void run(action)}
        onCancel={() => setAction(null)}
      />
    );
  };

  return (
    <div className="cp-page">
      <h1>{klass ? klass.name : 'Classe'}</h1>
      {klass ? (
        <p className="cp-legend">
          {klass.level} · {klass.academicYear}
        </p>
      ) : null}
      {klass ? <ClassNav classId={classId} /> : null}

      {!detail.done ? (
        <>
          <p className="cp-field__hint">Chargement…</p>
          <Skeleton height={56} />
          <Skeleton height={110} />
        </>
      ) : null}

      {notFound ? (
        <>
          <InlineAlert>{NOT_FOUND}</InlineAlert>
          <Link className="cp-btn cp-btn--secondary" to="/profil">
            Retour à mon profil
          </Link>
        </>
      ) : null}

      {detail.problem && !notFound ? (
        <>
          <InlineAlert>{detail.problem.text}</InlineAlert>
          <Button variant="secondary" onClick={detail.reload}>
            Réessayer
          </Button>
        </>
      ) : null}

      {klass ? (
        <>
          <p className="cp-request__meta">
            {klass.status === 'ARCHIVED' && klass.archivedAt
              ? `Archivée le ${formatLongDate(klass.archivedAt)}`
              : 'Classe active'}
          </p>

          <ClassStatsPanel stats={klass.stats} classId={classId} />

          <section aria-labelledby="delegues" className="cp-classdetail__section">
            <h2 className="cp-legend" id="delegues">
              Délégués
            </h2>
            {members.problem ? <InlineAlert>{members.problem.text}</InlineAlert> : null}
            <ul className="cp-members">
              {(members.data ?? []).map((member) => (
                <li className="cp-request" key={member.userId}>
                  <div className="cp-request__body">
                    <p className="cp-request__name">
                      {fullName(member)}{' '}
                      <span className="cp-role">{member.role === 'DELEGATE' ? 'Délégué' : 'Étudiant'}</span>
                    </p>
                    <p className="cp-request__meta">{member.email}</p>
                  </div>
                  <div className="cp-request__actions">
                    {member.role === 'STUDENT' ? (
                      <Button
                        disabled={busy || klass.status === 'ARCHIVED'}
                        onClick={() => {
                          setAction({ kind: 'appoint', member });
                          setActionProblem(null);
                        }}
                      >
                        Nommer délégué
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setAction({ kind: 'revoke', member });
                          setActionProblem(null);
                        }}
                      >
                        Révoquer la délégation de {fullName(member)}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* L'archivage est une décision d'administration : il n'apparaît que pour qui peut la prendre. */}
          {isAdmin && klass.status === 'ACTIVE' ? (
            <section aria-labelledby="archiver" className="cp-classdetail__section">
              <h2 className="cp-legend" id="archiver">
                Archiver la classe
              </h2>
              <p className="cp-field__hint">
                La classe sort des listes et ne reçoit plus de demande. Ses membres la perdent de leur profil.
              </p>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setAction({ kind: 'archive' });
                  setActionProblem(null);
                }}
              >
                Archiver la classe
              </Button>
            </section>
          ) : null}
        </>
      ) : null}

      {dialog()}

      {stepUp ? (
        <StepUpDialog
          initialMissing={stepUp}
          action={doArchive}
          onSucceeded={() => {
            setStepUp(null);
            notifyArchived();
            navigate('/classes');
          }}
          onCancel={() => setStepUp(null)}
        />
      ) : null}
    </div>
  );
}

/** M12 : la fiche de classe, réservée à une session ouverte. */
export function ClassDetailScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger la classe">
      {(me) => <ClassDetail me={me} />}
    </RequireSession>
  );
}
