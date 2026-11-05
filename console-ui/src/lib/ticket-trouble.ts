/** Why a ticket did not load: only a real "not found" says the ticket is not there. */
export function ticketTrouble(err: unknown, id: string): string {
  const said = err instanceof Error ? err.message : String(err);
  if (/^404\b/.test(said)) return `There is no ticket ${id} on this board. It may have been deleted.`;
  return said;
}

/** An install that needs permission: on a Mac or Linux the same command, asking for it. */
export function withPermission(command: string, windows = /win/i.test(typeof navigator === 'undefined' ? '' : navigator.platform) && !/darwin/i.test(navigator.platform)): string {
  return windows || /^sudo\b/.test(command) ? command : `sudo ${command}`;
}
