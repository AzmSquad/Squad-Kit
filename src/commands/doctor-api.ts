import type { SquadPaths } from '../core/paths.js';
import { gatherContext, runAllChecks, type DoctorContext } from './doctor-engine.js';

export type { DoctorContext };

export async function gatherContextForApi(paths: SquadPaths): Promise<DoctorContext> {
  return gatherContext(paths);
}

export async function runAllChecksForApi(
  paths: SquadPaths,
  ctx: DoctorContext,
  fix: boolean,
): ReturnType<typeof runAllChecks> {
  return runAllChecks(paths, ctx, fix);
}
