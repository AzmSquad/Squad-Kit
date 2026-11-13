import type { ConnectionModule } from '../connection/types.js';

/** Jira on the Connections page: shown as coming in a next version, with no working button yet. */
export const jiraConnection: ConnectionModule = {
  name: 'jira',
  label: 'Jira',
  what: { en: 'Issues, sprints and Confluence', ar: 'المهام والسبرنتات وConfluence' },
  how: 'soon',
  next: { en: 'Sign in with Atlassian', ar: 'سجّل الدخول بـ Atlassian' },
  can: [],
  status: () => Promise.resolve({ state: 'soon', steps: [] }),
};
