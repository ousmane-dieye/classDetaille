import { messageFor } from './messages';

/**
 * Client HTTP minimal : même origine que la page (§ 3.1, aucun CORS), cookie de session,
 * corps JSON. Le format d'erreur de l'API est `{ error: { code, …champs sûrs }, requestId }`
 * (§ « Validation » du lot 1a) ; il est recopié tel quel dans `ApiProblem`, jamais affiché cru.
 */
export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type ApiProblemBody = { status: number; code: string; extra: Record<string, unknown>; requestId: string; retryAfterSeconds: number | null };

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  readonly requestId: string;
  readonly retryAfterSeconds: number | null;

  constructor(body: ApiProblemBody) {
    super(body.code);
    this.name = 'ApiProblem';
    this.status = body.status;
    this.code = body.code;
    this.extra = body.extra;
    this.requestId = body.requestId;
    this.retryAfterSeconds = body.retryAfterSeconds;
  }

  /** Texte français prêt à afficher. */
  get text(): string {
    return messageFor(this.code, this.extra);
  }
}

export type ApiRequest = { method?: ApiMethod; body?: unknown };

const retryAfterSecondsOf = (res: Response): number | null => {
  const raw = res.headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds : null;
};

function parseErrorBody(data: unknown): { code: string; extra: Record<string, unknown>; requestId: string } {
  if (typeof data !== 'object' || data === null) return { code: 'INTERNAL', extra: {}, requestId: '' };
  const { error, requestId } = data as { error?: unknown; requestId?: unknown };
  if (typeof error !== 'object' || error === null) return { code: 'INTERNAL', extra: {}, requestId: typeof requestId === 'string' ? requestId : '' };
  const { code, ...extra } = error as { code?: unknown } & Record<string, unknown>;
  return {
    code: typeof code === 'string' ? code : 'INTERNAL',
    extra,
    requestId: typeof requestId === 'string' ? requestId : '',
  };
}

export async function apiFetch<T>(path: string, init: ApiRequest = {}): Promise<T> {
  // Hors connexion, la requête ne partirait pas : on le dit tout de suite, sans faux essai (M14).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiProblem({ status: 0, code: 'NETWORK', extra: {}, requestId: '', retryAfterSeconds: null });
  }

  const method = init.method ?? 'GET';
  const headers: Record<string, string> = init.body === undefined ? {} : { 'Content-Type': 'application/json' };
  // `exactOptionalPropertyTypes` : le corps n'est présent que s'il existe (un corps vide s'envoie `{}`).
  const request: RequestInit = { method, credentials: 'include', headers };
  if (init.body !== undefined) request.body = JSON.stringify(init.body);
  let response: Response;
  try {
    response = await fetch(path, request);
  } catch {
    throw new ApiProblem({ status: 0, code: 'NETWORK', extra: {}, requestId: '', retryAfterSeconds: null });
  }

  if (response.status === 204) return undefined as T;

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    // Réponse illisible : ni le contenu ni une trace interne n'est recopié.
    throw new ApiProblem({ status: response.status, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: retryAfterSecondsOf(response) });
  }

  if (!response.ok) {
    const { code, extra, requestId } = parseErrorBody(data);
    throw new ApiProblem({ status: response.status, code, extra, requestId, retryAfterSeconds: retryAfterSecondsOf(response) });
  }
  return data as T;
}
