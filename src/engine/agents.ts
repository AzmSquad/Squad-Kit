import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';

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

export const AGENT_TOOLS = ['claude', 'codex'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

export interface Agent {
  role: AgentRole;
  tool: AgentTool;
  model: string;
  instructions: string;
}

export function agentsDir(bp: BoardPaths): string {
  return path.join(bp.dir, 'agents');
}

function fileOf(bp: BoardPaths, role: AgentRole): string {
  return path.join(agentsDir(bp), `${role}.md`);
}

function render(a: Agent): string {
  return `---\ntool: ${a.tool}\nmodel: ${a.model}\n---\n${a.instructions.trim()}\n`;
}

function defaultAgent(role: AgentRole): Agent {
  const name = AGENTS.find((a) => a.role === role)!.name;
  return {
    role,
    tool: 'claude',
    model: '',
    instructions: `<!-- Extra instructions for the ${name}, in plain words. The ${name} reads them before every run. For example: "Write the questions in simple English." -->`,
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
  const tool = AGENT_TOOLS.includes(head.tool as AgentTool) ? (head.tool as AgentTool) : 'claude';
  return { role, tool, model: head.model ?? '', instructions: (m ? m[2] : text)?.trim() ?? '' };
}

export function writeAgent(bp: BoardPaths, role: AgentRole, change: Partial<Omit<Agent, 'role'>>): Agent {
  if (!AGENTS.some((a) => a.role === role)) throw new Error(`There is no ${role} agent.`);
  if (change.tool && !AGENT_TOOLS.includes(change.tool)) throw new Error(`"${change.tool}" is not a tool squad-kit can run.`);
  if (change.model && !/^[\w.:-]{1,60}$/.test(change.model)) throw new Error('A model name is one word, for example sonnet or opus.');
  const next = { ...readAgent(bp, role), ...change, role };
  fs.mkdirSync(agentsDir(bp), { recursive: true });
  fs.writeFileSync(fileOf(bp, role), render(next), 'utf8');
  return next;
}

/** The team's instructions for a role, ready to add to its system prompt. Comments in the file are left out. */
export function agentInstructions(a: Agent): string {
  const text = a.instructions.replace(/<!--[\s\S]*?-->/g, '').trim();
  const name = AGENTS.find((x) => x.role === a.role)!.name;
  return text ? `Instructions from the project team for the ${name}. Follow them unless they conflict with the task:\n${text}` : '';
}

export function roleForPhase(phase: string | undefined): AgentRole | null {
  return AGENTS.find((a) => phase && a.phases.includes(phase))?.role ?? null;
}
