import type { BoardMeta, Ticket } from './types.js';

/**
 * Who a ticket belongs to (ADR-001). The owner is saved in ticket.md, so the whole team sees it. Only the owner's
 * squad works on a ticket; everyone else sees it on their board, and sees its work when the owner pushes.
 */

/** The owner, or for a ticket from before owners, the person who made it. */
export function ownerOf(t: Pick<Ticket, 'owner' | 'createdBy'>): string {
  return t.owner?.trim() || t.createdBy;
}

export function sameName(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a?.trim()) && a!.trim().toLowerCase() === b?.trim().toLowerCase();
}

/** True when the person on this computer owns the ticket, so this computer's squad may work on it. */
export function isMine(t: Pick<Ticket, 'owner' | 'createdBy'>, meta: Pick<BoardMeta, 'user'>): boolean {
  return sameName(ownerOf(t), meta.user?.name);
}
