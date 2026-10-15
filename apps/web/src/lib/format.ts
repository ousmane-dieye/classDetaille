const DATE_TIME = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

const toDate = (iso: string): Date | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** « 14 oct. à 09:41 » : la mise en forme des maquettes (« Envoyée le », « à partir du »). */
export function formatDateTime(iso: string): string {
  const date = toDate(iso);
  if (!date) return '';
  return DATE_TIME.format(date).replace(',', ' à');
}

/** « 15 octobre 2026 » : dates lisibles quand l'heure n'apporte rien. */
export function formatLongDate(iso: string): string {
  const date = toDate(iso);
  if (!date) return '';
  return DATE.format(date);
}
