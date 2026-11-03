/** The short messages at the bottom of the screen: a note that something worked, or an error. */
export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

/**
 * How long a toast shows, in milliseconds. A note goes by itself; an error stays until the person closes it, so it
 * never vanishes while they read it or look for what it says to do.
 */
export function toastLife(kind: Toast['kind']): number | null {
  return kind === 'err' ? null : 3200;
}

/** The list with one more toast. An error that is already showing is not shown twice. */
export function withToast(list: Toast[], t: Toast): Toast[] {
  if (t.kind === 'err' && list.some((x) => x.kind === 'err' && x.text === t.text)) return list;
  return [...list, t];
}
