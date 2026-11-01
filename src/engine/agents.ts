import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import { AI_TOOLS } from '../modules/registry.js';

/**
 * One agent per role, each defined by a small file the team can read and edit: which AI tool runs it, an optional
 * model, and extra instructions that the role reads before every run.
 */

export type AgentRole = 'analyst' | 'architect' | 'builder' | 'reviewer' | 'tester';

export const AGENTS: { role: AgentRole; name: string; job: string; phases: string[] }[] = [
  { role: 'analyst', name: 'Analyst', job: 'Reads the ticket and asks the questions that matter', phases: ['analyst-read', 'triage'] },
  { role: 'architect', name: 'Architect', job: 'Reads the project, chooses how to build it, and writes the plan', phases: ['plan-write', 'plan-rewrite'] },
  { role: 'builder', name: 'Builder', job: 'Writes the code in small steps and fixes what the checks find', phases: ['build', 'unstick', 'fix', 'test'] },
  { role: 'reviewer', name: 'Reviewer', job: "Reviews the Builder's work in a fresh session, up to 2 rounds", phases: ['review'] },
  { role: 'tester', name: 'Tester', job: 'Runs the app and records before and after screenshots', phases: ['proof'] },
];

/** The steps of each role. Teams can add instructions for one step; the core prompt of each stays inside squad-kit. */
export const STEPS: Record<AgentRole, { id: string; name: string }[]> = {
  analyst: [
    { id: 'questions', name: 'Questions' },
    { id: 'spec', name: 'Spec' },
  ],
  architect: [
    { id: 'scan', name: 'Reading the project' },
    { id: 'design', name: 'Design' },
    { id: 'blueprint', name: 'Stack and patterns' },
  ],
  builder: [
    { id: 'build', name: 'Build' },
    { id: 'fix', name: 'Fixes' },
  ],
  reviewer: [{ id: 'review', name: 'Review' }],
  tester: [{ id: 'proof', name: 'Proof' }],
};

/** The AI tools an agent file can name: one per AI tool module. The first is the default. */
export const AGENT_TOOLS: string[] = AI_TOOLS.map((t) => t.name);
export type AgentTool = string;

export interface Agent {
  role: AgentRole;
  tool: AgentTool;
  model: string;
  instructions: string;
  /** Extra instructions for one step, by step id. Written in the file under "## Step: <id>". */
  steps: Record<string, string>;
}

export function agentsDir(bp: BoardPaths): string {
  return path.join(bp.dir, 'agents');
}

function fileOf(bp: BoardPaths, role: AgentRole): string {
  return path.join(agentsDir(bp), `${role}.md`);
}

function render(a: Agent): string {
  const steps = Object.entries(a.steps)
    .filter(([, text]) => text.trim())
    .map(([id, text]) => `\n## Step: ${id}\n${text.trim()}\n`)
    .join('');
  return `---\ntool: ${a.tool}\nmodel: ${a.model}\n---\n${a.instructions.trim()}\n${steps}`;
}

const STEP_HEAD = /^## Step: ([\w-]+)[ \t]*$/m;

/** Splits the file body into the role's general instructions and its per-step sections. */
function splitSteps(body: string): { instructions: string; steps: Record<string, string> } {
  const parts = body.split(new RegExp(STEP_HEAD.source, 'm'));
  const steps: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) steps[parts[i]!] = (parts[i + 1] ?? '').trim();
  return { instructions: (parts[0] ?? '').trim(), steps };
}

function defaultAgent(role: AgentRole): Agent {
  const name = AGENTS.find((a) => a.role === role)!.name;
  return {
    role,
    tool: AGENT_TOOLS[0]!,
    model: '',
    steps: {},
    instructions: `<!-- Extra instructions for the ${name}, in plain words. The ${name} reads them before every run. For example: "Write the questions in simple English." For one step only, add a heading like "## Step: ${STEPS[role][0]!.id}" and write under it. -->`,
  };
}

/** Every role has its file, so the team can see and edit each agent. */
export function ensureAgents(bp: BoardPaths): void {
  fs.mkdirSync(agentsDir(bp), { recursive: true });
  for (const { role } of AGENTS) {
    const file = fileOf(bp, role);
    if (!fs.existsSync(file)) fs.writeFileSync(file, render(defaultAgent(role)), 'utf8');
  }
}

export function readAgent(bp: BoardPaths, role: AgentRole): Agent {
  const file = fileOf(bp, role);
  if (!fs.existsSync(file)) return defaultAgent(role);
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const head = Object.fromEntries(
    (m?.[1] ?? '')
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()] as const)
      .filter(([k]) => k),
  );
  const tool = head.tool && AGENT_TOOLS.includes(head.tool) ? head.tool : AGENT_TOOLS[0]!;
  return { role, tool, model: head.model ?? '', ...splitSteps((m ? m[2] : text) ?? '') };
}

export function writeAgent(bp: BoardPaths, role: AgentRole, change: Partial<Omit<Agent, 'role'>>): Agent {
  if (!AGENTS.some((a) => a.role === role)) throw new Error(`There is no ${role} agent.`);
  if (change.tool && !AGENT_TOOLS.includes(change.tool)) throw new Error(`"${change.tool}" is not a tool squad-kit can run.`);
  if (change.model && !/^[\w.:-]{1,60}$/.test(change.model)) throw new Error('A model name is one word, for example sonnet or opus.');
  const known = new Set(STEPS[role].map((x) => x.id));
  const bad = Object.keys(change.steps ?? {}).find((k) => !known.has(k));
  if (bad) throw new Error(`The ${role} has no step "${bad}". Its steps: ${[...known].join(', ')}.`);
  const current = readAgent(bp, role);
  const next = { ...current, ...change, steps: { ...current.steps, ...(change.steps ?? {}) }, role };
  fs.mkdirSync(agentsDir(bp), { recursive: true });
  fs.writeFileSync(fileOf(bp, role), render(next), 'utf8');
  return next;
}

/**
 * The team's instructions for a role, and for the step it runs now, ready to add to its system prompt. They add to
 * the core prompt and never replace it. Comments in the file are left out.
 */
export function agentInstructions(a: Agent, step?: string): string {
  const clean = (x: string | undefined) => (x ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const general = clean(a.instructions);
  const forStep = step ? clean(a.steps[step]) : '';
  const name = AGENTS.find((x) => x.role === a.role)!.name;
  const stepName = STEPS[a.role].find((x) => x.id === step)?.name;
  const parts = [general, forStep ? `For the ${stepName ?? step} step:\n${forStep}` : ''].filter(Boolean);
  return parts.length ? `Instructions from the project team for the ${name}. Follow them unless they conflict with the task:\n${parts.join('\n\n')}` : '';
}

export function roleForPhase(phase: string | undefined): AgentRole | null {
  return AGENTS.find((a) => phase && a.phases.includes(phase))?.role ?? null;
}
