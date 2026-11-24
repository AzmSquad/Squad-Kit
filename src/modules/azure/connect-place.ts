import fs from 'node:fs';
import { buildPaths } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import type { AddressAsk, GuideStep, TokenAsk, Words } from '../connection/types.js';
import { ModuleError } from '../errors.js';
import { Azure } from './client.js';
import { parseBoardAddress } from './hosts.js';
import { projectThere } from './reach.js';
import { azurePlace, signInFor } from './sign-in.js';
import { orgTenant } from './tenant.js';
import { azureTracker } from './tracker.js';

/**
 * Connecting Azure DevOps in one place, the Connections page: the project's stories need an organization and a project
 * on Azure Boards, picked from what the sign-in reaches, or pasted as the board's address from the browser, never typed
 * as names. A token is pasted on the same row, with real steps, when a sign-in cannot reach the organization. Only a
 * project whose stories come (or may come) from Azure Boards is asked: one on another tracker keeps it.
 */

/** Stories from Azure Boards, or from no tracker yet: a place is asked on the row. Another tracker's project is not. */
export function storiesFromAzure(root: string): boolean {
  const file = buildPaths(root).configFile;
  if (!fs.existsSync(file)) return false;
  const type = loadConfig(file).tracker.type;
  return type === 'azure' || type === 'none';
}

export const placeWords = (p: { organization: string; project: string }) => `${p.organization} / ${p.project}`;

export function addressAsk(now?: string): AddressAsk {
  return {
    ...(now ? { now } : {}),
    example: 'dev.azure.com/your-organization/your-project',
    where: {
      en: 'Copy it from your browser while you look at your Azure Boards.',
      ar: 'انسخه من المتصفح وأنت فاتح Azure Boards.',
    },
  };
}

const TOKEN_COMMAND = 'squad config set tracker';

/** The token steps, with the organization's own tokens page when it is known. */
export function tokenSteps(org?: string): GuideStep[] {
  return [
    org
      ? { text: { en: 'Open your tokens page on Azure DevOps.', ar: 'افتح صفحة الرموز في Azure DevOps.' }, link: `https://dev.azure.com/${encodeURIComponent(org)}/_usersSettings/tokens` }
      : {
          text: { en: 'Open Azure DevOps, then User settings (top right), then Personal access tokens.', ar: 'افتح Azure DevOps، ثم User settings (فوق يمين)، ثم Personal access tokens.' },
          link: 'https://dev.azure.com',
        },
    { text: { en: 'Press New Token. Name it squad-kit, and pick how long it lasts (a year at most).', ar: 'اضغط New Token. سمّه squad-kit، واختر مدته (سنة كحد أقصى).' } },
    {
      text: {
        en: 'Under Scopes, tick Work Items: Read, write, & manage, and Code: Read, write, & manage.',
        ar: 'تحت Scopes، اختر Work Items: Read, write, & manage، وCode: Read, write, & manage.',
      },
    },
    { text: { en: 'Press Create, copy the token and paste it here. It stays on this computer.', ar: 'اضغط Create، انسخ الرمز والصقه هنا. يبقى على هذا الجهاز.' }, command: TOKEN_COMMAND },
  ];
}

const WHY_TOKEN: Words = {
  en: "Use a token when you can't sign in with Microsoft here.",
  ar: 'استخدم رمز إذا ما تقدر تسجّل الدخول بـ Microsoft هنا.',
};

export function tokenAsk(o: { org?: string; address?: string; open?: boolean }): TokenAsk {
  return { steps: tokenSteps(o.org), ...(o.address ? { address: o.address } : {}), ...(o.open ? { open: true } : {}), why: WHY_TOKEN, command: TOKEN_COMMAND };
}

/** The address as a place, or plain words on what to paste. */
function placeOf(address: string): { organization: string; project: string } {
  const p = parseBoardAddress(address);
  if (!p) throw new ModuleError('Paste the address of your Azure Boards, like dev.azure.com/your-organization/your-project. Copy it from your browser.', 'not-found');
  return p;
}

function onlyForAzure(root: string): void {
  if (!storiesFromAzure(root)) {
    throw new ModuleError("This project's stories come from another tracker. To take them from Azure DevOps instead, choose Azure DevOps in Settings first.", 'other');
  }
}

/** The organization is there: Azure DevOps answers for it. Not reaching it is no reason to stop. */
async function orgThere(org: string): Promise<void> {
  if ((await orgTenant(org)).kind === 'not-found') throw new ModuleError(`squad-kit could not find the organization ${org} on Azure DevOps. Check the address.`, 'not-found');
}

/** The saved token works in this organization too; else plain words on what to do, and nothing is saved. */
async function tokenWorksIn(pat: string, org: string): Promise<void> {
  try {
    await new Azure({ organization: org, project: '', pat }).whoAmI();
  } catch (err) {
    if (err instanceof ModuleError && err.kind === 'sign-in') {
      throw new ModuleError(`The token saved for this project does not work in ${org}, and a saved token is used before any sign-in. Paste a token for ${org} with "Use a token instead" on this card. Nothing was changed.`, 'sign-in');
    }
    // Not reaching Azure DevOps: the row says what is left once it answers.
  }
}

const noProject = (p: { organization: string; project: string }) =>
  new ModuleError(`squad-kit could not find the project ${p.project} in ${p.organization}. Check the address, or pick it from the list.`, 'not-found');

/**
 * Uses this project on Azure Boards for the project's stories: one from the list the sign-in reaches, or a pasted
 * address. Checked first where the sign-in can: a project that is not there is never saved. A sign-in that cannot reach
 * it yet is saved all the same, and the row then says what is left (sign in with the right account, or a token).
 */
export async function pickAzurePlace(root: string, asked: string): Promise<{ line: string }> {
  onlyForAzure(root);
  const p = placeOf(asked);
  await orgThere(p.organization);
  const saved = azurePlace(root);
  // A saved token wins over the sign-in: one made for another organization would leave this place unreachable.
  if (saved?.pat && saved.organization && saved.organization.toLowerCase() !== p.organization.toLowerCase()) await tokenWorksIn(saved.pat, p.organization);
  const auth = signInFor(p.organization, saved?.pat);
  let project = p.project;
  if (auth) {
    const real = await projectThere(auth, p).catch((err: unknown) => {
      // A no for the sign-in, or not reaching Azure DevOps: saved, and the row says what is left.
      if (err instanceof ModuleError && err.kind !== 'not-found') return p.project;
      throw err;
    });
    if (!real) throw noProject(p);
    project = real;
  }
  azureTracker.save(root, { organization: p.organization, project });
  return { line: `Stories for this project come from ${placeWords({ organization: p.organization, project })} on Azure DevOps.` };
}

/** A token pasted on the row: checked against the organization and project first, and saved only when it works. */
export async function saveAzureToken(root: string, input: { address?: string; token: string }): Promise<{ line: string }> {
  onlyForAzure(root);
  const token = input.token?.trim();
  if (!token) throw new ModuleError('Paste the token first.', 'other');
  const saved = azurePlace(root);
  const p = input.address?.trim() ? placeOf(input.address) : saved?.organization && saved.project ? { organization: saved.organization, project: saved.project } : null;
  if (!p) throw new ModuleError('Paste the address of your Azure Boards too, like dev.azure.com/your-organization/your-project.', 'not-found');
  await orgThere(p.organization);
  let account: string;
  let project: string | null;
  try {
    account = await new Azure({ organization: p.organization, project: p.project, pat: token }).whoAmI();
    project = await projectThere({ pat: token }, p);
  } catch (err) {
    if (err instanceof ModuleError && err.kind === 'sign-in') {
      throw new ModuleError(`Azure DevOps did not accept this token for ${p.organization}. Make a new one with the steps here, and paste it again. Nothing was saved.`, 'sign-in');
    }
    throw err;
  }
  if (!project) throw noProject(p);
  azureTracker.save(root, { organization: p.organization, project, token });
  return { line: `Azure DevOps is connected with your token, as ${account}. Stories come from ${placeWords({ organization: p.organization, project })}.` };
}
