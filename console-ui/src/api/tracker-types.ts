import type { Stage } from './types';

/**
 * The tracker as the board reads it: the Settings part (GET /api/v1/tracker), drawn from the chosen tracker module's
 * fields, and the Backlog (GET /api/v1/backlog).
 */

export interface SetupChoice {
  value: string;
  label: string;
}

export interface SetupField {
  key: string;
  label: string;
  secret?: boolean;
  /** Picked from these, or from GET /api/v1/tracker/choices for the values so far. */
  options?: SetupChoice[];
  choice?: boolean;
  /** A choice that may also be typed: the list only suggests. */
  typed?: boolean;
  /** Shown only while another field has one of these values. */
  when?: { key: string; is: string[] };
  placeholder?: string;
  /** Shown under More. */
  more?: boolean;
}

/** Something to do on this computer before the tracker can connect. */
export interface SetupStep {
  say: string;
  command?: string;
  link?: string;
}

export interface TrackerStatus {
  /** The tracker the project uses now, or none. */
  type: string;
  /** The tracker the form shows: the one in use, the one asked for, or the one the git remote points to. */
  module: string;
  /** The tracker's name in words: "Azure DevOps". */
  label?: string;
  about?: string;
  hint?: string;
  fields: SetupField[];
  values: Record<string, string>;
  modules: { name: string; label: string }[];
  steps: SetupStep[];
  organization: string;
  project: string;
  hasToken: boolean;
  /** One plain line about the saved settings, such as that squad-kit only reads the tracker for now. */
  note?: string;
  /** Signed in on the Connections page instead: no token is needed. */
  signedIn?: boolean;
  user?: string;
  error?: string;
  /** How an item is written on the connected tracker, like AB#40. */
  example?: string;
}

export interface WorkItemRow {
  id: string;
  /** How people write it, for example AB#40. */
  ref: string;
  type: string;
  title: string;
  state: string;
  points?: number;
  priority?: number;
  sprint?: string;
  assignedTo?: string;
  tags: string[];
  url: string;
  isBug?: boolean;
  /** Its ticket on the board; `merged`: its work is in the base. */
  ticket: { id: string; stage: Stage; status: string; merged?: boolean } | null;
}

export interface Sprint {
  name: string;
  path: string;
  start?: string;
  finish?: string;
  current: boolean;
}

export interface BacklogResponse {
  connected: boolean;
  error?: string | null;
  user?: string;
  sprints: Sprint[];
  sprint?: string;
  /** The tracker had more than it reads at once: only these are shown. */
  capped?: boolean;
  items: WorkItemRow[];
  /** How the items nest, when the tracker has epics and features above them. Left out: a flat list. */
  tree?: BacklogTree;
}

/** An epic or feature above backlog items. `type` is the tracker's own word (Epic, Feature, Initiative). */
export interface BacklogGroup extends Omit<WorkItemRow, 'ticket'> {
  level: 'epic' | 'feature';
}

export interface BacklogTree {
  /** The item right above each item that has one, by id: the items' and the groups' own. */
  above: Record<string, string>;
  /** The epics and features above the items that are not items themselves, in no set order. */
  groups: BacklogGroup[];
}
