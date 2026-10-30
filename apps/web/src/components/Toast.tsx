import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { AlertIcon, CheckIcon, CloseIcon } from './icons';

/** UX § 3.1 « Retours » : le succès et l'info s'annoncent poliment, l'erreur insiste. */
export type ToastTone = 'success' | 'info' | 'error';

export type ToastItem = { id: number; tone: ToastTone; message: string };

export type ToastsValue = {
  /** Annonce le résultat réel d'une action : le message apparaît, s'annonce, puis disparaît seul. */
  notify(tone: ToastTone, message: string): void;
};

/** Le temps de lire sans presser : l'erreur reste plus longtemps, pour pouvoir être comprise. */
const DURATION_MS: Record<ToastTone, number> = { success: 5000, info: 5000, error: 8000 };

/** Trois au maximum : au-delà, l'écran devient un mur de notifications. */
const MAX_VISIBLE = 3;

const ToastContext = createContext<ToastsValue | null>(null);

export function useToasts(): ToastsValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToasts doit être utilisé sous un ToastProvider');
  return value;
}

export type ToastProviderProps = {
  children: ReactNode;
};

/**
 * Retours temporaires (UX § 3.1) : un flux commun à toute l'application, monté une fois pour
 * toutes dans `AppRoutes` — un retour survit à la navigation, là où un message dans la page
 * disparaît avec elle. Les erreurs restent affichées près de leur action ( `InlineAlert`,
 * fenêtre de confirmation ) : le toast ne sert qu'au résultat d'une action déjà confirmée,
 * jamais à cacher un échec, jamais à interrompre une saisie.
 */
export function ToastProvider({ children }: ToastProviderProps): ReactElement {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [paused, setPaused] = useState(false);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, { timer: ReturnType<typeof setTimeout>; endsAt: number; item: ToastItem }>());
  const remaining = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((tone: ToastTone, message: string) => {
    setToasts((list) => {
      // Un même message revient : il remplace l'autre et repart de zéro — jamais deux fois de suite.
      const existing = list.find((toast) => toast.tone === tone && toast.message === message);
      const item: ToastItem = { id: existing?.id ?? nextId.current++, tone, message };
      remaining.current.delete(item.id);
      const kept = list.filter((toast) => toast.id !== item.id);
      const next = [...kept, item];
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });
  }, []);

  // Un minuteur par toast visible ; le survol ou le focus retient la fermeture (on lit à son rythme).
  useEffect(() => {
    if (paused) {
      for (const [id, entry] of timers.current) {
        remaining.current.set(id, Math.max(0, entry.endsAt - Date.now()));
        clearTimeout(entry.timer);
      }
      timers.current.clear();
      return;
    }
    const live = new Set(toasts.map((toast) => toast.id));
    for (const [id, entry] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(entry.timer);
        timers.current.delete(id);
      }
    }
    for (const toast of toasts) {
      const entry = timers.current.get(toast.id);
      // Le même objet posé une seconde fois (un message répété) repart de zéro.
      if (entry && entry.item === toast) continue;
      if (entry) clearTimeout(entry.timer);
      const ms = remaining.current.get(toast.id) ?? DURATION_MS[toast.tone];
      timers.current.set(toast.id, { timer: setTimeout(() => dismiss(toast.id), ms), endsAt: Date.now() + ms, item: toast });
    }
  }, [toasts, paused, dismiss]);

  // Nettoyage au démontage : aucun minuteur orphelin ne doit tenir le composant en vie.
  useEffect(
    () => () => {
      for (const [, entry] of timers.current) clearTimeout(entry.timer);
      timers.current.clear();
    },
    [],
  );

  const value = useMemo<ToastsValue>(() => ({ notify }), [notify]);
  const hold = useCallback(() => setPaused(true), []);
  const release = useCallback(() => setPaused(false), []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onHold={hold} onRelease={release} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export type ToastViewportProps = {
  toasts: ToastItem[];
  onHold(): void;
  onRelease(): void;
  onDismiss(id: number): void;
};

/**
 * Les régions vivantes n'existent que lorsqu'elles portent un message : une région vide
 * perturbe les lecteurs d'écran (et double les rôles « alerte » ailleurs dans la page).
 * Le rôle `status` annonce les retours attendus ; le rôle `alert`, réservé aux erreurs,
 * les signale avec plus d'insistance.
 */
export function ToastViewport({ toasts, onHold, onRelease, onDismiss }: ToastViewportProps): ReactElement | null {
  if (toasts.length === 0) return null;
  const polite = toasts.filter((toast) => toast.tone !== 'error');
  const assertive = toasts.filter((toast) => toast.tone === 'error');
  return (
    <div className="cp-toasts" onMouseEnter={onHold} onMouseLeave={onRelease} onFocusCapture={onHold} onBlurCapture={onRelease}>
      {polite.length > 0 ? (
        <div className="cp-toasts__region" role="status" aria-live="polite">
          {polite.map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
          ))}
        </div>
      ) : null}
      {assertive.length > 0 ? (
        <div className="cp-toasts__region" role="alert">
          {assertive.map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss(id: number): void }): ReactElement {
  return (
    <div className={`cp-toast cp-toast--${toast.tone}`}>
      {toast.tone === 'success' ? (
        <CheckIcon className="cp-toast__icon" />
      ) : (
        <AlertIcon className="cp-toast__icon" />
      )}
      <p className="cp-toast__text">{toast.message}</p>
      <button type="button" className="cp-toast__close" aria-label="Fermer la notification" onClick={() => onDismiss(toast.id)}>
        <CloseIcon />
      </button>
    </div>
  );
}
