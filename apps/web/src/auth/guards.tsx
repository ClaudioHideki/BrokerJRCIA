import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { useSession } from './SessionProvider.js';

export function SessionBoot() {
  return <main className="centered-state" aria-live="polite">Restaurando sua sessão…</main>;
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const location = useLocation();
  if (status === 'booting') return <SessionBoot />;
  if (status === 'selecting') return <Navigate replace to="/selecionar-organizacao" />;
  if (status !== 'authenticated') {
    return <Navigate replace to="/login" state={{ from: location.pathname }} />;
  }
  return children;
}

export function HomeRedirect() {
  const { status } = useSession();
  if (status === 'booting') return <SessionBoot />;
  if (status === 'selecting') return <Navigate replace to="/selecionar-organizacao" />;
  return <Navigate replace to={status === 'authenticated' ? '/channels' : '/login'} />;
}
