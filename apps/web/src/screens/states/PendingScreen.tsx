import type { ReactElement } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { StateScreen } from '../../components/StateScreen';
import { Button } from '../../components/Button';
import type { Me } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { useSession } from '../../session/session-context';
import { RequireSession } from './require-session';

const classNameOf = (me: Me): string | null => me.enrollment?.class ? `${me.enrollment.class.name} · ${me.enrollment.class.academicYear}` : null;

function SignOutButton(): ReactElement {
  const { signOut } = useSession();
  const navigate = useNavigate();
  return (
    <Button
      variant="secondary"
      onClick={() => {
        void signOut().then(() => navigate('/connexion'));
      }}
    >
      Se déconnecter
    </Button>
  );
}

/** M7 « en attente » : rappel de l'email pour repérer une faute de frappe. */
function Pending({ me }: { me: Me }): ReactElement {
  const enrollment = me.enrollment;
  const className = classNameOf(me);

  if (enrollment?.status === 'REFUSED') return <Navigate to="/etat/demande-refusee" replace />;

  if (enrollment?.status === 'PENDING' && className) {
    return (
      <StateScreen title="Demande envoyée" tone="success" actions={<SignOutButton />}>
        <p>
          Ta demande pour rejoindre <b>{className}</b> a bien été envoyée. Un délégué de ta classe va la valider.
        </p>
        <dl className="cp-recap">
          <div>
            <dt>Email utilisé</dt>
            <dd>{me.email}</dd>
          </div>
          <div>
            <dt>Envoyée le</dt>
            <dd>{formatDateTime(enrollment.createdAt)}</dd>
          </div>
        </dl>
        <p className="cp-state__small">
          Tu recevras un email dès que ta demande sera traitée. Si l&apos;email ci-dessus est faux, contacte ton délégué.
        </p>
      </StateScreen>
    );
  }

  if (enrollment?.status === 'ACCEPTED' && !className) {
    return (
      <StateScreen title="Ta classe est prête" tone="success" actions={<SignOutButton />}>
        <p>Ta demande a été acceptée. L&apos;application de ta classe arrive avec les prochains lots : reviens bientôt.</p>
      </StateScreen>
    );
  }

  return (
    <StateScreen title="Aucune demande en attente" actions={<SignOutButton />}>
      <p>Aucune demande n&apos;est en cours pour ce compte. Si tu dois rejoindre une classe, contacte le délégué de ta classe pour qu&apos;il t&apos;envoie une invitation.</p>
    </StateScreen>
  );
}

export function PendingScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger ta demande">
      {(me) => <Pending me={me} />}
    </RequireSession>
  );
}
