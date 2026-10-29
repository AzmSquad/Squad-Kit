import type { Ticket } from './types.js';

/** Tell the squad to take its next step on this ticket after `seconds` (scaled by the board speed). */
export function scheduleSquad(ticket: Ticket, phase: string, seconds: number, speed: number, index?: number): void {
  const ms = (seconds * 1000) / Math.max(speed, 0.1);
  ticket.squad = {
    phase,
    nextAt: new Date(Date.now() + ms).toISOString(),
    ...(index !== undefined ? { index } : {}),
  };
}
