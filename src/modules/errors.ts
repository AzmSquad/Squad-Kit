/**
 * Every module reports a problem in one of these few ways, so the board's ways out (sign in again, try later, fix
 * the clash) work the same whichever tracker, code host, AI tool or speech service the project uses. 'waiting': not yet,
 * and it needs nobody (a pull request's checks still run): squad-kit looks again by itself.
 */
export type ModuleErrorKind = 'sign-in' | 'not-found' | 'too-many' | 'offline' | 'clash' | 'waiting' | 'other';

export class ModuleError extends Error {
  constructor(
    message: string,
    readonly kind: ModuleErrorKind = 'other',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModuleError';
  }
}

/** The kind of problem behind an HTTP status. */
export function kindOfStatus(status: number): ModuleErrorKind {
  if (status === 401 || status === 403 || status === 302 || status === 203) return 'sign-in';
  if (status === 404) return 'not-found';
  if (status === 429) return 'too-many';
  if (status === 409) return 'clash';
  return 'other';
}

/**
 * The other side said no and will say it again: the item is gone, or one of its own rules refuses this. Waiting changes
 * nothing. A sign-in, a busy service or a lost connection can pass, so they are never this.
 */
export function refusedForGood(err: unknown): boolean {
  return err instanceof ModuleError && (err.kind === 'not-found' || err.status === 400 || err.status === 405 || err.status === 410 || err.status === 422);
}
