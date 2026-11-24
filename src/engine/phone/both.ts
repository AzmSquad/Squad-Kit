import type { PhoneSize } from '../../modules/phone/types.js';
import type { WindowPhone } from '../window.js';
import type { PhoneAsk, PhoneSession } from './session.js';
import type { PhoneSystem } from '../tools/which-phone.js';

/**
 * An app built for both phones gets its pictures on both: the Tester's shots go to the first phone by its sizes
 * ("phone", "tablet"), and to the second by one more size named after it ("android", or "iphone"). One phone runs at a
 * time (turn.ts), so the Tester takes the first phone's pictures first. The second phone is built before the Tester's
 * clock starts (PhoneSession.build) and comes up at its first picture.
 */

/** The size the second phone's pictures are asked by. */
export const secondSize = (system: PhoneSystem): string => (system === 'android' ? 'android' : 'iphone');

export function bothPhones(first: PhoneSession, second: PhoneSession, system: PhoneSystem): WindowPhone {
  // Not a real size of either phone: the window only passes it back, and the second phone takes its own phone size.
  const key = secondSize(system) as PhoneSize;
  const toSecond = (ask: PhoneAsk): PhoneAsk => ({ ...ask, size: 'phone' });
  return {
    get sizes() {
      return [...first.sizes, key];
    },
    label: `${first.label} and ${second.label}`,
    labels: () => ({ ...first.labels(), [key]: second.labels().phone ?? second.word }),
    links: () => first.links(),
    ready: () => first.ready(),
    shoot: (ask, c) => (ask.size === key ? second.shoot(toSecond(ask), c) : first.shoot(ask, c)),
    look: (ask, c) => (ask.size === key ? second.look(toSecond(ask), c) : first.look(ask, c)),
    close: async () => {
      await Promise.all([first.close(), second.close()]);
    },
  };
}
