/**
 * Run records and the `done` SSE event carry `planFile` as a path relative to the workspace root
 * (`.squad/plans/<feature>/<file>.md`) — both `new-plan.ts` and the console runs API write it that
 * way, and it is shown to the user as-is. The `/plans/$feature/$planFile` route and
 * `GET /api/plans/:feature/:planFile` want only the file name: the API resolves it under
 * `plansDir/<feature>/`, so handing it the full path resolves to
 * `plansDir/<feature>/.squad/plans/<feature>/<file>.md` and 404s.
 *
 * Normalising here rather than at the writers fixes every run record already on disk, which all
 * carry the long form. See https://github.com/AzmSquad/Squad-Kit/issues/9.
 */
export function planFileParam(planFile: string): string {
  const name = planFile.split(/[/\\]/).pop();
  return name && name.length > 0 ? name : planFile;
}
