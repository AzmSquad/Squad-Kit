import { isArabic, plainArabic } from '../../board/ask.js';
import { listTickets, readMeta, type BoardPaths } from '../../board/store.js';
import { squadNow } from './needs-you.js';
import type { LeadAnswer } from './types.js';
import { waitingCount } from './waiting.js';

/**
 * Small talk ("Hello", "Thanks", "صباح الخير") needs no AI run: squad-kit answers it at once, in the person's language,
 * from the board's real numbers: the stories open and released, what needs the person, and who is working now.
 */

export type SmallTalk = 'hello' | 'thanks' | 'bye';

/** Words that make up small talk, longest first, as typed (English) or as plainArabic writes them. */
const EN: [string, SmallTalk][] = [
  ['assalamu alaikum', 'hello'],
  ['good afternoon', 'hello'],
  ['good morning', 'hello'],
  ['good evening', 'hello'],
  ['how are you doing', 'hello'],
  ['how is it going', 'hello'],
  ["how's it going", 'hello'],
  ['how are you', 'hello'],
  ["what's up", 'hello'],
  ['thank you so much', 'thanks'],
  ['thanks a lot', 'thanks'],
  ['thank you', 'thanks'],
  ['see you', 'bye'],
  ['goodbye', 'bye'],
  ['greetings', 'hello'],
  ['morning', 'hello'],
  ['evening', 'hello'],
  ['hello', 'hello'],
  ['hiya', 'hello'],
  ['salaam', 'hello'],
  ['salam', 'hello'],
  ['hey', 'hello'],
  ['hi', 'hello'],
  ['yo', 'hello'],
  ['thanks', 'thanks'],
  ['thx', 'thanks'],
  ['cheers', 'thanks'],
  ['bye', 'bye'],
];
/** Words that may sit around small talk and change nothing: "Hi there, lead!", "OK thanks". */
const EN_FILL = ['squad lead', 'there', 'lead', 'team', 'all', 'everyone', 'again', 'ok', 'okay', 'great', 'cool', 'nice', 'very', 'much', 'and', 'so'];

const AR: [string, SmallTalk][] = [
  ['السلام عليكم ورحمه الله وبركاته', 'hello'],
  ['السلام عليكم ورحمه الله', 'hello'],
  ['وعليكم السلام', 'hello'],
  ['السلام عليكم', 'hello'],
  ['اهلا وسهلا', 'hello'],
  ['صباح الخير', 'hello'],
  ['صباح النور', 'hello'],
  ['مساء الخير', 'hello'],
  ['مساء النور', 'hello'],
  ['كيف حالك', 'hello'],
  ['كيف الحال', 'hello'],
  ['عامل ايه', 'hello'],
  ['اخبارك ايه', 'hello'],
  ['يعطيك العافيه', 'thanks'],
  ['شكرا جزيلا', 'thanks'],
  ['مع السلامه', 'bye'],
  ['مرحبا', 'hello'],
  ['اهلين', 'hello'],
  ['اهلا', 'hello'],
  ['كيفك', 'hello'],
  ['ازيك', 'hello'],
  ['ازيكم', 'hello'],
  ['شلونك', 'hello'],
  ['هلا', 'hello'],
  ['هاي', 'hello'],
  ['سلام', 'hello'],
  ['شكرا', 'thanks'],
  ['مشكور', 'thanks'],
  ['تسلم', 'thanks'],
];
const AR_FILL = ['يا', 'لك', 'كتير', 'كثيرا', 'تمام', 'ليد', 'قائد الفريق', 'الفريق'];

/** The most words a message of small talk has. */
const MOST_WORDS = 8;

/** The message is only small talk, and which kind: thanks and bye win over hello ("ok thanks, bye"). Null otherwise. */
export function smallTalkOf(text: string): SmallTalk | null {
  const ar = isArabic(text);
  const plain = (ar ? plainArabic(text) : text.toLowerCase().replace(/[’`]/g, "'"))
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain || plain.split(' ').length > MOST_WORDS) return null;
  let rest = ` ${plain} `;
  const kinds = new Set<SmallTalk>();
  for (const [words, kind] of ar ? AR : EN) {
    const at = ` ${words} `;
    while (rest.includes(at)) {
      rest = rest.replace(at, ' ');
      kinds.add(kind);
    }
  }
  if (!kinds.size) return null;
  for (const w of ar ? AR_FILL : EN_FILL) rest = rest.split(` ${w} `).join(' ');
  if (rest.trim()) return null;
  return kinds.has('bye') ? 'bye' : kinds.has('thanks') ? 'thanks' : 'hello';
}

/** The board's numbers small talk answers with, counted as the board counts them. */
export interface BoardNumbers {
  project: string;
  /** Open: not merged yet, as the side menu's "6 open tickets". */
  open: number;
  /** Merged, going out with the next release. */
  accepted: number;
  released: number;
  waiting: number;
  working: number;
}

export function boardNumbers(bp: BoardPaths): BoardNumbers {
  const all = listTickets(bp).filter((t) => !t.archived);
  const done = all.filter((t) => t.stage === 'done').length;
  const accepted = all.filter((t) => t.stage !== 'done' && t.mergedAt).length;
  return { project: readMeta(bp).project, open: all.length - done - accepted, accepted, released: done, waiting: waitingCount(bp), working: squadNow(bp).length };
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** The answer to small talk, in English or Arabic, with the board's numbers. */
export function smallTalkAnswer(kind: SmallTalk, b: BoardNumbers, arabic: boolean): LeadAnswer {
  const answer = (headline: string, body: string): LeadAnswer => ({ headline, body, evidence: [], sources: [], cards: [], by: 'board' });
  if (arabic) {
    const waiting = b.waiting ? `ما ينتظرك الآن: ${b.waiting}.` : 'لا شيء ينتظرك الآن.';
    const working = b.working ? `يعمل الآن: ${b.working} من الفريق.` : 'لا أحد يعمل الآن.';
    const stories = `القصص المفتوحة: ${b.open}${b.accepted ? `، والمقبولة للإصدار القادم: ${b.accepted}` : ''}، والتي صدرت: ${b.released}.`;
    if (kind === 'thanks') return answer('العفو.', waiting);
    if (kind === 'bye') return answer('مع السلامة.', waiting);
    return answer(`أهلًا! هذا وضع ${b.project} الآن.`, `${stories}\n\n${waiting} ${working}\n\nاسألني عن أي قصة، أو عن التطبيق، أو عن الكود.`);
  }
  const waiting = b.waiting ? `${n(b.waiting, 'thing needs', 'things need')} you.` : 'Nothing needs you right now.';
  const working = b.working ? `${n(b.working, 'agent is', 'agents are')} working.` : 'No one is working right now.';
  const later = [...(b.accepted ? [`${b.accepted} accepted for the next release`] : []), ...(b.released ? [`${b.released} released`] : [])];
  const stories = `${n(b.open, 'story is', 'stories are')} open${later.length ? `, ${later.join(' and ')}` : ''}.`;
  if (kind === 'thanks') return answer("You're welcome.", b.waiting ? `${n(b.waiting, 'thing still needs', 'things still need')} you.` : waiting);
  if (kind === 'bye') return answer('See you.', waiting);
  return answer(`Hello! Here is ${b.project} right now.`, `${stories} ${waiting} ${working}\n\nAsk me about any story, the app or the code.`);
}

/** Small talk, answered at once from the board; null for anything else. */
export function smallTalk(bp: BoardPaths, text: string): LeadAnswer | null {
  const kind = smallTalkOf(text);
  return kind ? smallTalkAnswer(kind, boardNumbers(bp), isArabic(text)) : null;
}
