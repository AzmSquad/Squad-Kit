import fs from 'node:fs';
import path from 'node:path';
import type { BoardMeta, Decision, TechRole } from './types.js';
import { reposOf } from '../engine/repos.js';

export type { TechRole } from './types.js';

/** One technology the code really uses, read from its package files. */
export interface Tech {
  name: string;
  role: TechRole;
  /** A Simple Icons slug, when there is a logo. */
  icon?: string;
  version?: string;
  repo: string;
  /** Technologies that bring this one along, so choosing them chose it too (Next.js brings React). */
  comesWith?: string[];
}

interface Known {
  name: string;
  role: TechRole;
  icon?: string;
  pkgs: string[];
  comesWith?: string[];
}

// Package names to technologies. Several packages can mean one technology (prisma and @prisma/client).
const KNOWN: Known[] = [
  { name: 'TypeScript', role: 'Language', icon: 'typescript', pkgs: ['typescript'] },
  { name: 'Next.js', role: 'Framework', icon: 'nextdotjs', pkgs: ['next'] },
  { name: 'Nuxt', role: 'Framework', icon: 'nuxt', pkgs: ['nuxt'] },
  { name: 'NestJS', role: 'Framework', icon: 'nestjs', pkgs: ['@nestjs/core'] },
  { name: 'Express', role: 'Framework', icon: 'express', pkgs: ['express'] },
  { name: 'Hono', role: 'Framework', icon: 'hono', pkgs: ['hono'] },
  { name: 'React', role: 'Interface', icon: 'react', pkgs: ['react'], comesWith: ['Next.js'] },
  { name: 'Vue', role: 'Interface', icon: 'vuedotjs', pkgs: ['vue'], comesWith: ['Nuxt'] },
  { name: 'Angular', role: 'Interface', icon: 'angular', pkgs: ['@angular/core'] },
  { name: 'Svelte', role: 'Interface', icon: 'svelte', pkgs: ['svelte'] },
  { name: 'PrimeReact', role: 'Interface', icon: 'primereact', pkgs: ['primereact'] },
  { name: 'Tailwind CSS', role: 'Interface', icon: 'tailwindcss', pkgs: ['tailwindcss'] },
  { name: 'MUI', role: 'Interface', icon: 'mui', pkgs: ['@mui/material'] },
  { name: 'Bootstrap', role: 'Interface', icon: 'bootstrap', pkgs: ['bootstrap', 'react-bootstrap'] },
  { name: 'Sass', role: 'Interface', icon: 'sass', pkgs: ['sass'] },
  { name: 'React Hook Form', role: 'Interface', icon: 'reacthookform', pkgs: ['react-hook-form'] },
  { name: 'TanStack Query', role: 'Interface', icon: 'reactquery', pkgs: ['@tanstack/react-query'] },
  { name: 'Redux', role: 'Interface', icon: 'redux', pkgs: ['redux', '@reduxjs/toolkit'] },
  { name: 'i18next', role: 'Interface', icon: 'i18next', pkgs: ['i18next', 'react-i18next', 'next-i18next'] },
  { name: 'Prisma', role: 'Data', icon: 'prisma', pkgs: ['prisma', '@prisma/client'] },
  { name: 'Drizzle', role: 'Data', icon: 'drizzle', pkgs: ['drizzle-orm'] },
  { name: 'Zod', role: 'Data', icon: 'zod', pkgs: ['zod'] },
  { name: 'GraphQL', role: 'Data', icon: 'graphql', pkgs: ['graphql'] },
  { name: 'tRPC', role: 'Data', icon: 'trpc', pkgs: ['@trpc/server'] },
  { name: 'PostgreSQL', role: 'Data', icon: 'postgresql', pkgs: ['pg', 'postgres'] },
  { name: 'MySQL', role: 'Data', icon: 'mysql', pkgs: ['mysql2'] },
  { name: 'MongoDB', role: 'Data', icon: 'mongodb', pkgs: ['mongodb', 'mongoose'] },
  { name: 'SQLite', role: 'Data', icon: 'sqlite', pkgs: ['better-sqlite3', 'sqlite3'] },
  { name: 'Redis', role: 'Data', icon: 'redis', pkgs: ['redis', 'ioredis'] },
  { name: 'Supabase', role: 'Services', icon: 'supabase', pkgs: ['@supabase/supabase-js'] },
  { name: 'Firebase', role: 'Services', icon: 'firebase', pkgs: ['firebase', 'firebase-admin'] },
  { name: 'Stripe', role: 'Services', icon: 'stripe', pkgs: ['stripe'] },
  { name: 'Twilio', role: 'Services', icon: 'twilio', pkgs: ['twilio'] },
  { name: 'Vitest', role: 'Testing', icon: 'vitest', pkgs: ['vitest'] },
  { name: 'Jest', role: 'Testing', icon: 'jest', pkgs: ['jest'] },
  { name: 'Playwright', role: 'Testing', pkgs: ['@playwright/test', 'playwright'] },
  { name: 'Cypress', role: 'Testing', icon: 'cypress', pkgs: ['cypress'] },
  { name: 'Storybook', role: 'Testing', icon: 'storybook', pkgs: ['storybook'] },
  { name: 'ESLint', role: 'Tooling', icon: 'eslint', pkgs: ['eslint'] },
  { name: 'Prettier', role: 'Tooling', icon: 'prettier', pkgs: ['prettier'] },
  { name: 'Vite', role: 'Tooling', icon: 'vite', pkgs: ['vite'] },
];

// A Prisma schema names its database; the database itself has no npm package.
const PRISMA_DB: Record<string, Known> = {
  sqlite: { name: 'SQLite', role: 'Data', icon: 'sqlite', pkgs: [] },
  postgresql: { name: 'PostgreSQL', role: 'Data', icon: 'postgresql', pkgs: [] },
  mysql: { name: 'MySQL', role: 'Data', icon: 'mysql', pkgs: [] },
  mongodb: { name: 'MongoDB', role: 'Data', icon: 'mongodb', pkgs: [] },
};

/** The technologies in each code repo, from package.json and the Prisma schema. Nothing is guessed. */
export function detectStack(root: string, meta: BoardMeta): Tech[] {
  const found = new Map<string, Tech>();
  for (const repo of reposOf(meta)) {
    const dir = path.join(root, repo.path);
    const deps = readDeps(path.join(dir, 'package.json'));
    if (!deps) continue;
    const add = (k: Known, version?: string) => {
      if (!found.has(k.name)) {
        found.set(k.name, { name: k.name, role: k.role, ...(k.icon ? { icon: k.icon } : {}), ...(version ? { version } : {}), repo: repo.path, ...(k.comesWith ? { comesWith: k.comesWith } : {}) });
      }
    };
    if (Object.keys(deps).length) add({ name: 'Node.js', role: 'Language', icon: 'nodedotjs', pkgs: [], comesWith: ['Next.js', 'Nuxt', 'NestJS', 'Express', 'Hono'] });
    for (const k of KNOWN) {
      const pkg = k.pkgs.find((p) => deps[p]);
      if (pkg) add(k, major(deps[pkg]!));
    }
    const db = prismaProvider(dir);
    if (db && PRISMA_DB[db]) add(PRISMA_DB[db]!);
  }
  return [...found.values()];
}

/** The saved decisions that chose a technology: the ones whose choice names it. */
export function decidedIn(tech: Tech, decisions: Decision[]): string[] {
  const words = [tech.name, tech.name.replace(/\.js$/, '')].map((w) => w.toLowerCase());
  return decisions
    .filter((d) => !d.replacedBy)
    .filter((d) => {
      const text = `${d.title} ${d.chosen}`.toLowerCase();
      return words.some((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(text));
    })
    .map((d) => d.id);
}

function readDeps(file: string): Record<string, string> | null {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return { ...p.devDependencies, ...p.dependencies };
  } catch {
    return null;
  }
}

function prismaProvider(dir: string): string | null {
  try {
    const schema = fs.readFileSync(path.join(dir, 'prisma', 'schema.prisma'), 'utf8');
    return /datasource\s+\w+\s*{[^}]*provider\s*=\s*"(\w+)"/.exec(schema)?.[1] ?? null;
  } catch {
    return null;
  }
}

function major(range: string): string | undefined {
  return /(\d+)(?:\.\d+)?/.exec(range)?.[0];
}
