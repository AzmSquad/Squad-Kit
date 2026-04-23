// All ui.* helpers write to stderr. stdout is reserved for command data output
// (e.g. `new-plan` prompt text, `list` table). Violating this breaks piping.

export { banner, bannerMinimal } from './banner.js';
export { step, success, failure, warning, info, blank, line, kv } from './prefix.js';
export { spinner, type SquadSpinner } from './spinner.js';
export { divider } from './divider.js';
export { summaryBox, type SummaryRow } from './box.js';
export { renderError } from './error.js';
export { isInteractive } from './tty.js';
export * as theme from './theme.js';
