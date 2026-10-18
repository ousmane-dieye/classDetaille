import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { acceptRequest, listRequests, refuseRequest } from '../../api/classes';
import type { ApiProblem } from '../../api/client';
import type { EnrollmentRequest, Me } from '../../api/types';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { InlineAlert } from '../../components/InlineAlert';
import { Skeleton, useDelayedFlag } from '../../components/Skeleton';
import { formatDateTime } from '../../lib/format';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';
import { ClassNav, useClassId } from './class-nav';
import { toProblem } from './class-load';

const fullName = (request: EnrollmentRequest): string => `${request.user.firstName} ${request.user.lastName}`;

const OFFLINE_REASON = 'Tu n’es pas connectée : les actions reprendront au retour de la connexion.';

type Decision = { kind: 'accept' | 'refuse'; request: EnrollmentRequest };

/** M9 (P8) : la file d'attente d'une classe, acceptation ou refus. Les interdictions ne sont pas ici :
 *  elles vivent d'abord en base (déclencheurs), puis dans l'API. Ce ne sont que des décisions. */
function ClassRequests({ me }: { me: Me }): ReactElement {
  const { signOut } = useSession();
  const classId = useClassId();

  const [requests, setRequests] = useState<EnrollmentRequest[] | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [decisionProblem, setDecisionProblem] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  const load = useCallback(async () => {
    setProblem(null);
    try {
      setRequests(await listRequests(classId));
    } catch (e) {
      const p = toProblem(e);
      // 401 : la session s'est terminée ailleurs. Rendre la page anonyme renvoie à la connexion.
      if (p.status === 401) {
        await signOut();
        return;
      }
      setProblem(p);
      setRequests(null);
    }
  }, [classId, signOut]);

  useEffect(() => {
    void load();
  }, [load]);

  // Hors connexion : lecture possible, écriture impossible — la raison est affichée (UX § 3.2).
  useEffect(() => {
    const onOnline = (): void => setOnline(true);
    const onOffline = (): void => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const showSkeleton = useDelayedFlag(requests === null && problem === null);

  async function decide(kind: Decision['kind'], request: EnrollmentRequest, note?: string): Promise<void> {
    setBusy(true);
    setDecisionProblem(null);
    try {
      if (kind === 'accept') await acceptRequest(classId, request.id);
      else await refuseRequest(classId, request.id, note);
      setDecision(null);
      setNotice(kind === 'accept' ? `${fullName(request)} rejoint la classe.` : `${fullName(request)} n’entre pas dans la classe.`);
      await load();
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 401) {
        await signOut();
        return;
      }
      if (p.code === 'REQUEST_ALREADY_DECIDED') {
        // Quelqu'un a tranché entre temps : la fenêtre se referme, la liste se rafraîchit,
        // et le message nomme ce qui s'est passé — après le rechargement, qui l'effacerait.
        setDecision(null);
        await load();
        setProblem(p);
        return;
      }
      // La fenêtre reste ouverte et la saisie est gardée : l'erreur nomme sa cause.
      setDecisionProblem(p);
    } finally {
      setBusy(false);
    }
  }

  const classLabel = me.membership?.classId === classId ? me.membership.classLabel : null;

  return (
    <div className="cp-page">
      <h1>Demandes</h1>
      <ClassNav classId={classId} />
      {classLabel ? <p className="cp-legend">{classLabel}</p> : null}

      {requests === null && problem === null && !showSkeleton ? <p className="cp-field__hint">Chargement…</p> : null}
      {showSkeleton ? (
        <>
          <Skeleton height={72} />
          <Skeleton height={72} />
        </>
      ) : null}

      {problem ? (
        <>
          <InlineAlert>{problem.text}</InlineAlert>
          <Button variant="secondary" onClick={() => void load()}>
            Réessayer
          </Button>
        </>
      ) : null}
      {notice ? <InlineAlert tone="info">{notice}</InlineAlert> : null}
      {!online ? <InlineAlert tone="info">{OFFLINE_REASON}</InlineAlert> : null}

      {requests !== null && requests.length === 0 ? (
        <p className="cp-requests__empty">Aucune demande en attente.</p>
      ) : null}

      <ul className="cp-requests">
        {(requests ?? []).map((request) => {
          const name = fullName(request);
          return (
            <li className="cp-request" key={request.id}>
              <div className="cp-request__body">
                <p className="cp-request__name">{name}</p>
                <p className="cp-request__meta">{request.user.email}</p>
                <p className="cp-request__meta">Envoyée le {formatDateTime(request.createdAt)}</p>
              </div>
              <div className="cp-request__actions">
                <Button disabled={!online} busy={busy && decision?.request.id === request.id && decision.kind === 'accept'} onClick={() => { setDecision({ kind: 'accept', request }); setDecisionProblem(null); }}>
                  Accepter {name}
                </Button>
                <Button
                  variant="danger"
                  disabled={!online}
                  busy={busy && decision?.request.id === request.id && decision.kind === 'refuse'}
                  onClick={() => { setDecision({ kind: 'refuse', request }); setDecisionProblem(null); }}
                >
                  Refuser {name}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {decision?.kind === 'accept' ? (
        <ConfirmDialog
          title={`Accepter ${fullName(decision.request)} dans la classe ?`}
          body={`${fullName(decision.request)} deviendra membre de ${classLabel ?? 'la classe'}. Il ou elle pourra alors voir les devoirs et les ressources.`}
          confirmLabel="Accepter"
          busy={busy}
          problem={decisionProblem?.text ?? null}
          onConfirm={(note) => void decide('accept', decision.request, note)}
          onCancel={() => setDecision(null)}
        />
      ) : null}

      {decision?.kind === 'refuse' ? (
        <ConfirmDialog
          title={`Refuser la demande de ${fullName(decision.request)} ?`}
          body={`${fullName(decision.request)} recevra ton refus par email, avec le motif s’il y en a un.`}
          definitive
          noteLabel="Motif"
          noteHint="Le motif est facultatif : la personne le recevra par email."
          confirmLabel={`Refuser la demande de ${fullName(decision.request)}`}
          busy={busy}
          problem={decisionProblem?.text ?? null}
          onConfirm={(note) => void decide('refuse', decision.request, note)}
          onCancel={() => setDecision(null)}
        />
      ) : null}
    </div>
  );
}

/** M9 : les demandes d'une classe, réservées à une session ouverte. */
export function ClassRequestsScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger les demandes">
      {(me) => <ClassRequests me={me} />}
    </RequireSession>
  );
}
