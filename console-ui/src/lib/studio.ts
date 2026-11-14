/**
 * The Studio's last tab, one per project, kept in this browser tab's own memory (sessionStorage, AB-127.1): it lasts
 * through a reload and ends when squad-kit's tab closes. Nothing goes to the board server or the project's files: those
 * appear only when the person makes a sketch or a design system.
 */

export type StudioTab = 'sketches' | 'systems';

export const STUDIO_TABS: { id: StudioTab; label: string }[] = [
  { id: 'sketches', label: 'Sketches' },
  { id: 'systems', label: 'Design systems' },
];

/** Where one project's last tab is kept. */
export const studioTabKey = (project: string) => `squad-studio-tab:${project}`;

const isTab = (v: unknown): v is StudioTab => STUDIO_TABS.some((t) => t.id === v);

/** The tab this project's Studio opens on: Sketches the first time, and when the saved value is unknown or unreadable. */
export function readStudioTab(project: string): StudioTab {
  try {
    const saved = sessionStorage.getItem(studioTabKey(project));
    return isTab(saved) ? saved : 'sketches';
  } catch {
    return 'sketches';
  }
}

/** Keeps the tab the person chose for this project. A browser that refuses storage just forgets it. */
export function saveStudioTab(project: string, tab: StudioTab): void {
  try {
    sessionStorage.setItem(studioTabKey(project), tab);
  } catch {
    // Private windows and full storage: the Studio opens on Sketches next time.
  }
}
