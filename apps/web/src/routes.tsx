import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AdminCodeScreen } from './screens/login/AdminCodeScreen';
import { LoginScreen } from './screens/login/LoginScreen';
import { ForgotPasswordScreen } from './screens/forgot/ForgotPasswordScreen';
import { ResetPasswordScreen } from './screens/forgot/ResetPasswordScreen';
import { RegisterScreen } from './screens/register/RegisterScreen';
import { ProfileScreen } from './screens/profile/ProfileScreen';
import { SessionsScreen } from './screens/profile/SessionsScreen';
import { PendingScreen } from './screens/states/PendingScreen';
import { RefusedScreen } from './screens/states/RefusedScreen';
import { NotFoundScreen } from './screens/states/NotFoundScreen';
import { PrivacyScreen } from './screens/states/PrivacyScreen';

/**
 * Une adresse par écran (UX § 1.5). La table reste déclarative : les tests de routes
 * vérifient qu'aucun écran n'est orphelin et qu'une adresse inconnue est refusée.
 */
export function AppRoutes(): ReactElement {
  return (
    <main id="contenu" tabIndex={-1}>
      <Routes>
        <Route path="/" element={<Navigate to="/connexion" replace />} />
        <Route path="/inscription" element={<RegisterScreen />} />
        <Route path="/connexion" element={<LoginScreen />} />
        <Route path="/connexion/code" element={<AdminCodeScreen />} />
        <Route path="/mot-de-passe-oublie" element={<ForgotPasswordScreen />} />
        <Route path="/reinitialiser-mot-de-passe" element={<ResetPasswordScreen />} />
        <Route path="/profil" element={<ProfileScreen />} />
        <Route path="/profil/sessions" element={<SessionsScreen />} />
        <Route path="/confidentialite" element={<PrivacyScreen />} />
        <Route path="/etat/demande-envoyee" element={<PendingScreen />} />
        <Route path="/etat/demande-refusee" element={<RefusedScreen />} />
        <Route path="*" element={<NotFoundScreen />} />
      </Routes>
    </main>
  );
}
