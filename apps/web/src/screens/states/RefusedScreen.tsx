import type { ReactElement } from 'react';
import { Link, Navigate } from 'react-router';
import { Button } from '../../components/Button';
import { StateScreen } from '../../components/StateScreen';
import type { Me } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { useSession } from '../../session/session-context';
import { RequireSession } from './require-session';

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

  if (enrollment?.status !== 'REFUSED') return <Navigate to="/etat/demande-envoyee" replace />;

  const className = classNameOf(me) ?? 'ta classe';
  const retryAfter = enrollment.retryAfter ? formatDateTime(enrollment.retryAfter) : '';

  return (
    <StateScreen
      title="Demande refusée"
      tone="error"
      actions={
        <>
          <Link className="cp-btn cp-btn--primary" to="/inscription">
            Demander une autre classe
          </Link>
          <SignOutButton />
        </>
      }
    >
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
