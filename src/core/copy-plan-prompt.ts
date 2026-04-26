import type { SquadConfig } from './config.js';
import { readBundledPrompt } from '../utils/fs.js';
import { render } from './template.js';

/** Same composed markdown as `squad new-plan --copy` / `emitCopyPrompt` (no clipboard or filesystem side effects). */
export function buildCopyPlanPromptMarkdown(config: SquadConfig, intakeContent: string): string {
  const metaPromptTemplate = readBundledPrompt('generate-plan.md');
  return render(metaPromptTemplate, {
    projectRoots: (config.project.projectRoots ?? ['.']).join(', '),
    primaryLanguage: config.project.primaryLanguage ?? '',
    trackerType: config.tracker.type,
    intakeContent,
  });
}
