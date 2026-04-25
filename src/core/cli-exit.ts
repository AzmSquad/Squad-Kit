/** Thrown to exit the CLI with a specific code (after normal UI output). */
export class SquadExit extends Error {
  override readonly name = 'SquadExit';

  constructor(
    public readonly exitCode: number,
    message?: string,
  ) {
    super(message ?? '');
  }
}

export function isSquadExit(err: unknown): err is SquadExit {
  return err instanceof SquadExit;
}
