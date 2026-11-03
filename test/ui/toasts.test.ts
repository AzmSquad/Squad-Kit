import { describe, expect, it } from 'vitest';
import { toastLife, withToast, type Toast } from '../../console-ui/src/lib/toasts.js';

describe('toasts', () => {
  it('a note goes by itself; an error stays until the person closes it', () => {
    expect(toastLife('ok')).toBe(3200);
    expect(toastLife('err')).toBeNull();
  });

  it('the same error twice shows once, notes stack', () => {
    const err: Toast = { id: 1, text: 'Could not reach the tracker.', kind: 'err' };
    let list = withToast([], err);
    list = withToast(list, { ...err, id: 2 });
    expect(list.map((t) => t.id)).toEqual([1]);
    list = withToast(list, { id: 3, text: 'Saved.', kind: 'ok' });
    list = withToast(list, { id: 4, text: 'Saved.', kind: 'ok' });
    list = withToast(list, { id: 5, text: 'Another problem.', kind: 'err' });
    expect(list.map((t) => t.id)).toEqual([1, 3, 4, 5]);
  });
});
