import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react';
import { Button } from './Button';
import { InlineAlert } from './InlineAlert';

export type ConfirmDialogProps = {
  /** Titre nommant l'objet et l'action (UX § 3.3 : « Accepter Awa Diop dans la classe ? »). */
  title: string;
  /** Ce qui va se passer, au tutoiement. */
  body?: ReactNode;
  /** La décision ne peut pas être annulée : rappel affiché sous le titre (refus, retrait). */
  definitive?: boolean;
  /** Champ « Motif » facultatif (refus, retrait) — absent quand l'action n'en prévoit pas. */
  noteLabel?: string;
  noteHint?: string;
  /** Raison qui empêche l'action (classe archivée, hors connexion) : affichée, et l'action bloquée. */
  blockedReason?: string;
  /** Message du serveur, affiché sous les champs — la saisie n'est jamais effacée. */
  problem?: string | null;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  /** `note` vaut `undefined` quand le champ est vide ou absent : le corps reste un objet fermé. */
  onConfirm(note: string | undefined): void;
  onCancel(): void;
};

/**
 * Fenêtre de confirmation (UX § 3.3) : nomme l'objet, rappelle ce qui va se passer, et refuse
 * l'ambiguïté — un bouton seul ne dit jamais assez. Le focus part au premier champ ou à la
 * confirmation, reste dans le panneau, et revient au déclencheur en fermant (UX § 5.1).
 */
export function ConfirmDialog({
  title,
  body,
  definitive = false,
  noteLabel,
  noteHint,
  blockedReason,
  problem,
  confirmLabel,
  cancelLabel = 'Annuler',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement {
  const [note, setNote] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = 'confirm-title';
  const blocked = busy || blockedReason !== undefined;

  // Ouverture : mémoriser l'élément d'origine AVANT de prendre le focus ; fermeture : le lui rendre.
  useEffect(() => {
    restoreFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => restoreFocusTo.current?.focus();
  }, []);

  // Le focus part au premier champ ou à la confirmation, selon qu'il y a un motif ou non.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  /** Le focus reste dans le panneau : Tab au dernier élément remonte au premier, et l'inverse. */
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>('input, button');
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (blocked) return;
    const trimmed = note.trim();
    onConfirm(trimmed === '' ? undefined : trimmed);
  };

  return (
    <div className="cp-dialog">
      <div className="cp-dialog__backdrop" aria-hidden="true" />
      <div
        className="cp-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        onKeyDown={trapFocus}
      >
        <h2 id={titleId}>{title}</h2>
        {body ? <p className="cp-dialog__lead">{body}</p> : null}
        {definitive ? <p className="cp-dialog__definitive">Cette décision est définitive.</p> : null}
        {blockedReason ? <InlineAlert>{blockedReason}</InlineAlert> : null}
        {problem ? <InlineAlert>{problem}</InlineAlert> : null}
        <form onSubmit={submit} noValidate>
          {noteLabel ? (
            <>
              <label className="cp-field__label" htmlFor="confirm-note">
                {noteLabel}
              </label>
              <input
                id="confirm-note"
                className="cp-input"
                type="text"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                aria-describedby={noteHint ? 'confirm-note-hint' : undefined}
                maxLength={500}
              />
              {noteHint ? (
                <p className="cp-field__hint" id="confirm-note-hint">
                  {noteHint}
                </p>
              ) : null}
            </>
          ) : null}
          <div className="cp-dialog__actions">
            <Button type="submit" busy={busy} disabled={blockedReason !== undefined}>
              {confirmLabel}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
