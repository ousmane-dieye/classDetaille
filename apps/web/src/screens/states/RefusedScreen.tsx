import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { createEnrollment } from '../../api/me';
import { ApiProblem } from '../../api/client';
import { Button } from '../../components/Button';
import { InlineAlert } from '../../components/InlineAlert';
import { StateScreen } from '../../components/StateScreen';
import type { Me } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { useSession } from '../../session/session-context';
import { RequireSession } from './require-session';

const toProblem = (e: unknown): ApiProblem =>
  e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });

const classNameOf = (me: Me): string | null => (me.enrollment?.class ? `${me.enrollment.class.name} · ${me.enrollment.class.academicYear}` : null);

function SignOutButton(): ReactElement {
  const { signOut } = useSession();
  return (
    <Button
      variant="secondary"
      onClick={() => {
        void signOut();
      }}
    >
      Se déconnecter
    </Button>
  );
}

/** M7 « refusée » : motif s'il existe, date de nouvelle demande (24 h), et alternative. */
function Refused({ me }: { me: Me }): ReactElement {
  const enrollment = me.enrollment;
  const { refresh } = useSession();
  const navigate = useNavigate();

  const [retrying, setRetrying] = useState(false);
  const [retryProblem, setRetryProblem] = useState<ApiProblem | null>(null);

  if (enrollment?.status !== 'REFUSED') return <Navigate to="/etat/demande-envoyee" replace />;

  const className = classNameOf(me) ?? 'ta classe';
  const retryAfter = enrollment.retryAfter ? formatDateTime(enrollment.retryAfter) : '';
  const classId = enrollment.class?.id;

  /** R16 : on redemande la même classe. Le délai de 24 h et l'appartenance sont ceux du serveur. */
  const retry = async (): Promise<void> => {
    if (!classId) return;
    setRetrying(true);
    setRetryProblem(null);
    try {
      await createEnrollment(classId);
      await refresh();
      navigate('/etat/demande-envoyee', { replace: true });
    } catch (e) {
      // Le délai de 24 h nomme la date du serveur : aucun compte à rebours côté client.
      setRetryProblem(toProblem(e));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <StateScreen
      title="Demande refusée"
      tone="error"
      actions={
        <>
          {classId ? (
            <Button busy={retrying} onClick={() => void retry()}>
              Refaire ta demande
            </Button>
          ) : null}
          <Link className="cp-btn cp-btn--primary" to="/inscription">
            Demander une autre classe
          </Link>
          <SignOutButton />
        </>
      }
    >
      {retryProblem ? <InlineAlert>{retryProblem.text}</InlineAlert> : null}
      <p>
        Ta demande pour rejoindre <b>{className}</b> n&apos;a pas été acceptée.
      </p>
      {enrollment.decisionNote ? (
        <dl className="cp-recap cp-recap--block">
          <div>
            <dt>Motif indiqué par le délégué</dt>
            <dd>« {enrollment.decisionNote} »</dd>
          </div>
        </dl>
      ) : null}
      <p>
        {retryAfter ? (
          <>
            Tu pourras faire une nouvelle demande pour cette classe <b>à partir du {retryAfter}</b>. Tu peux déjà demander
            une autre classe.
          </>
        ) : (
          'Tu peux déjà demander une autre classe.'
        )}
      </p>
    </StateScreen>
  );
}

export function RefusedScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger ta demande">
      {(me) => <Refused me={me} />}
    </RequireSession>
  );
}
