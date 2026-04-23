import { readBundledPrompt } from '../utils/fs.js';

export function composeSystemPrompt(args: {
  projectRoots: string[];
  primaryLanguage: string;
  trackerType: string;
  repoMap: string;
}): string {
  const base = readBundledPrompt('generate-plan.md')
    .replace(/\{\{projectRoots\}\}/g, args.projectRoots.join(', '))
    .replace(/\{\{primaryLanguage\}\}/g, args.primaryLanguage)
    .replace(/\{\{trackerType\}\}/g, args.trackerType)
    .replace(
      /\{\{intakeContent\}\}/g,
      '_(The intake story is provided in the user message below. Do not ask for it.)_',
    );

  const apiPreamble = [
    '',
    '---',
    '',
    '## Direct-API mode notes',
    '',
    'You are being invoked by the squad-kit CLI, not by a human editor. The intake is already inlined below.',
    'The repository tree is provided. To see the contents of any file, **call the `read_file` tool** with a repo-relative path.',
    'You have a bounded context budget (file reads, total bytes, wall-clock time). Read files you genuinely need.',
    'When you have enough information, output the **complete plan markdown** as your final assistant message. No prose around it, no code fences wrapping the whole plan. The CLI will write your final message verbatim to disk.',
    '',
    '## Repository tree',
    '',
    '```',
    args.repoMap.trimEnd(),
    '```',
    '',
  ].join('\n');

  return base + apiPreamble;
}

export function composeUserPrompt(args: { intakeContent: string }): string {
  return [
    'Produce the implementation plan for the following intake.',
    '',
    '---',
    '',
    args.intakeContent.trimEnd(),
    '',
  ].join('\n');
}
