export function isInteractive(): boolean {
  if (process.env.CI) return false;
  if (process.env.SQUAD_QUIET) return false;
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

export function stderrCols(): number {
  return process.stderr.columns ?? 80;
}
