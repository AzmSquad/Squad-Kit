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
  ticket: { id: string; stage: Stage; status: string } | null;
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
}
