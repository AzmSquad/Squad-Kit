import { createHmac, randomBytes } from 'node:crypto';

/**
 * Hiding personal data in a template (a per-project switch, off by default). Columns and fields are found by their
 * names: people's names, ID and national numbers, phones, emails, addresses and birth dates. Their values become fake
 * ones while the template is made, so the real values are never written anywhere; the source is never changed.
 *
 * Fake values are consistent: the same real value always becomes the same fake one within a template, so rows that
 * matched still match. They come from a keyed hash with a fresh random key for each template, never kept, so a fake
 * value cannot be traced back to the real one. They keep the real value's shape where it matters to the app: a phone
 * keeps its length and separators, a date stays a date.
 */

export type Personal = 'name' | 'first-name' | 'last-name' | 'username' | 'email' | 'phone' | 'id-number' | 'address' | 'birth-date';

/** The words in a column's name: `patientFirstName`, `first_name` and `First Name` all give first, name. */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const singular = (w: string) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w === 'people' ? 'person' : w === 'children' ? 'child' : w === 'parties' ? 'party' : w.replace(/(?<=[^s])s$/, ''));

/** Tables (or parent fields) that hold people, where a bare `name` column is a person's name. */
const PEOPLE = new Set(
  'user patient customer client person employee member contact doctor physician nurse staff student teacher pupil party applicant citizen owner author guest visitor driver beneficiary lawyer attorney judge witness defendant plaintiff claimant guardian spouse child parent resident tenant buyer seller recipient sender subscriber profile worker representative attendee participant candidate volunteer passenger traveler traveller tourist employer agent investor heir family kin relative dependent sibling father mother son daughter wife husband partner'.split(' '),
);

/** True when a table's name says it holds people. */
export function peopleTable(table: string): boolean {
  return words(table).some((w) => PEOPLE.has(singular(w)));
}

const LANG = new Set(['ar', 'en', 'arabic', 'english', 'local', 'native', 'fr', 'latin']);
const FIRST_BEFORE_NAME = new Set(['first', 'given', 'fore', 'middle', 'father', 'mother', 'grandfather', 'second', 'third']);
const LAST_BEFORE_NAME = new Set(['last', 'family', 'sur', 'maiden', 'tribe']);
const FULL_BEFORE_NAME = new Set([...PEOPLE, 'full', 'display', 'legal', 'real', 'emergency', 'holder', 'father', 'mother']);
const PHONE = new Set(['phone', 'mobile', 'telephone', 'tel', 'cell', 'cellphone', 'fax', 'msisdn', 'whatsapp', 'landline', 'gsm']);
const NUMBER_END = new Set(['number', 'no', 'num', 'nr', 'nbr']);
const ID_WORDS = new Set(['national', 'passport', 'identity', 'civil', 'iqama', 'residence', 'residency', 'social', 'ssn', 'tax', 'emirates', 'citizen', 'nin', 'personal', 'license', 'licence', 'driving', 'driver', 'drivers']);
const ID_WHOLE = new Set(['ssn', 'nin', 'nid', 'sin', 'passport', 'iqama', 'idnumber', 'idno', 'idnum', 'nationalid', 'nationalnumber', 'socialsecurity', 'socialsecuritynumber']);
const NOT_A_PLACE = new Set(['ip', 'mac', 'email', 'mail', 'web', 'url', 'wallet', 'remote', 'server', 'host', 'bitcoin', 'eth', 'hardware', 'memory', 'network', 'node', 'contract', 'return']);
const NOT_A_VALUE = new Set(['id', 'ids', 'type', 'kind', 'count', 'status', 'verified', 'confirmed', 'at', 'on', 'format', 'version', 'flag', 'is', 'has', 'enabled', 'visible', 'public', 'hash', 'key', 'code', 'template', 'subject', 'sent', 'opt']);

/** What personal data a column holds, from its name and its table's name, or null when nothing personal. */
/** Plural field names, as lists in a document often have: phones, emails, addresses. */
const PLURAL: Record<string, string> = { phones: 'phone', mobiles: 'mobile', telephones: 'telephone', emails: 'email', mails: 'mail', addresses: 'address', streets: 'street', names: 'name', numbers: 'number' };

export function personalKind(column: string, table = ''): Personal | null {
  const w = words(column).map((x) => PLURAL[x] ?? x);
  if (!w.length) return null;
  const last = w[w.length - 1]!;
  const joined = w.join('');
  if (w.some((x) => ['is', 'has', 'can', 'should', 'allow'].includes(x)) && w[0] !== 'id') return null;
  if (w.length > 1 && NOT_A_VALUE.has(last) && !(last === 'id' && w.some((x) => ID_WORDS.has(x)))) return null;

  // Birth dates.
  if (w.includes('dob') || joined.includes('birthdate') || joined.includes('birthday') || joined === 'dateofbirth') return 'birth-date';
  if (w.includes('birth') && (['date', 'day', 'dt', 'on'].includes(last) || (w.includes('date') && w.includes('of')))) return 'birth-date';

  if ((w.includes('email') || w.includes('mail')) && (['email', 'mail', 'address', 'addr'].includes(last) || joined === 'email')) return 'email';
  if (joined === 'email' || joined === 'emailaddress') return 'email';

  if (w.some((x) => PHONE.has(x)) && (PHONE.has(last) || NUMBER_END.has(last))) return 'phone';

  if (ID_WHOLE.has(joined)) return 'id-number';
  if (w[0] === 'id' && w.length === 2 && NUMBER_END.has(last)) return 'id-number';
  if ((NUMBER_END.has(last) || last === 'id' || last === 'code' || joined.endsWith('passport')) && w.some((x) => ID_WORDS.has(x))) return 'id-number';

  if (w.some((x) => ['address', 'addr', 'street'].includes(x)) && !w.some((x) => NOT_A_PLACE.has(x))) return 'address';

  if (['username', 'login', 'loginname', 'userlogin', 'screenname', 'handle', 'nickname', 'nick'].includes(joined)) return 'username';
  if (joined === 'username' || (w.length === 2 && w[0] === 'user' && last === 'name')) return 'username';

  if (['firstname', 'fname', 'givenname', 'forename', 'middlename', 'fathername', 'mothername'].includes(joined)) return 'first-name';
  if (['lastname', 'lname', 'surname', 'familyname', 'maidenname'].includes(joined)) return 'last-name';
  if (['fullname', 'displayname'].includes(joined)) return 'name';
  const nameAt = w.lastIndexOf('name');
  if (nameAt >= 0) {
    const around = w.filter((_, i) => i !== nameAt);
    const before = w[nameAt - 1];
    if (before && FIRST_BEFORE_NAME.has(before)) return 'first-name';
    if (before && LAST_BEFORE_NAME.has(before)) return 'last-name';
    if (before && FULL_BEFORE_NAME.has(singular(before))) return 'name';
    // A bare name, or one in a language (name_ar, englishName), is a person's in a table of people.
    if (around.every((x) => LANG.has(x)) && peopleTable(table)) return 'name';
  }
  return null;
}

/** The kinds of value a column's type holds, for whether a fake value fits it. */
export type TypeClass = 'text' | 'number' | 'date' | 'other';

export function typeClass(sqlType: string): TypeClass {
  const t = sqlType.toLowerCase();
  // A list of values (Postgres arrays) takes no single fake value.
  if (/\[\]\s*$/.test(t) || t.startsWith('_')) return 'other';
  if (/\b(char|varchar|character|text|citext|string|clob|nchar|nvarchar|ntext|tinytext|mediumtext|longtext|name)\b/.test(t) || t === '') return 'text';
  if (/\b(date|time|timestamp|datetime|timestamptz)\b/.test(t)) return 'date';
  if (/\b(int|integer|bigint|smallint|tinyint|mediumint|numeric|decimal|number|int2|int4|int8|real|double|float)\b/.test(t)) return 'number';
  return 'other';
}

/** A fake value cut to the column's length (`varchar(20)`), so the database takes it. */
export function fitLength(value: string, sqlType: string): string {
  const m = /\b(?:char|varchar|character varying|character|nchar|nvarchar|varbinary|binary)\s*\((\d+)\)/i.exec(sqlType);
  return m && value.length > Number(m[1]) ? value.slice(0, Number(m[1])) : value;
}

/** True when a fake value of this kind can go in a column of this type without breaking it. */
export function fits(kind: Personal, type: TypeClass): boolean {
  if (type === 'text') return true;
  if (type === 'number') return kind === 'phone' || kind === 'id-number';
  if (type === 'date') return kind === 'birth-date';
  return false;
}

const FIRST = 'Lina Omar Sara Yusuf Maya Adam Noor Karim Hana Sami Rana Ziad Laila Tarek Dina Fadi Mona Rami Salma Hadi Nadia Bilal Reem Amir Yara Jamal Lara Nabil Huda Malik Iman Kamal Alex Emma Daniel Grace Leo Chloe Ryan Mia'.split(' ');
const LAST = 'Haddad Khalil Nasser Saleh Fares Hamdan Mansour Aziz Darwish Najjar Rahman Sabbagh Qasim Taha Yassin Zaki Barakat Halabi Jaber Kanaan Matar Nouri Odeh Rizk Shami Tamimi Wahbi Younis Awad Bakri Daher Ghanem Carter Brooks Hayes Ellis Morgan Bennett Foster Reed'.split(' ');
const STREETS = 'Cedar Olive Palm Maple Jasmine River Hill Garden Lake Market Station Harbor Orchard Meadow Valley Spring'.split(' ');
const ROADS = 'Street Road Avenue Lane Way'.split(' ');

export type Faker = (kind: Personal, value: string) => string;

/** A new faker with its own random key: one per template, so the same value is faked the same way everywhere in it. */
export function makeFaker(key: Buffer = randomBytes(32)): Faker {
  const bytes = (kind: Personal, value: string) => createHmac('sha256', key).update(`${kind}\0${value}`).digest();
  const at = (b: Buffer, i: number) => b.readUInt16BE(i % 30);
  return (kind, value) => {
    const b = bytes(kind, value);
    const hex = b.toString('hex');
    switch (kind) {
      case 'first-name':
        return FIRST[at(b, 0) % FIRST.length]!;
      case 'last-name':
        return LAST[at(b, 2) % LAST.length]!;
      case 'name':
        return `${FIRST[at(b, 0) % FIRST.length]} ${LAST[at(b, 2) % LAST.length]}`;
      case 'username':
        return `user_${hex.slice(0, 10)}`;
      case 'email':
        return `user_${hex.slice(0, 12)}@example.com`;
      case 'address':
        return `${1 + (at(b, 4) % 199)} ${STREETS[at(b, 6) % STREETS.length]} ${ROADS[at(b, 8) % ROADS.length]}`;
      case 'phone':
      case 'id-number':
        return sameShape(value, key, kind);
      case 'birth-date':
        return fakeDate(value, b, key);
    }
  };
}

/**
 * Every digit and letter replaced, length, case and separators kept, and no two values ever the same: a keyed
 * shuffle of all values of the same shape (format-preserving encryption, a small Feistel network), so a phone or an ID
 * number that is unique in the source stays unique. A leading 0 stays, and a number never gains one.
 */
function sameShape(value: string, key: Buffer, kind: string): string {
  const slots: { at: number; radix: number; base: number; upper?: boolean }[] = [];
  let firstDigit = true;
  [...value].forEach((ch, at) => {
    if (/\d/.test(ch)) {
      if (firstDigit && ch === '0') slots.push({ at, radix: 1, base: 0 });
      else slots.push({ at, radix: firstDigit ? 9 : 10, base: firstDigit ? 1 : 0 });
      firstDigit = false;
    } else if (/[A-Za-z]/.test(ch)) slots.push({ at, radix: 26, base: 0, upper: ch === ch.toUpperCase() });
  });
  const live = slots.filter((x) => x.radix > 1);
  if (!live.length) return value;
  const chars = [...value];
  let n = 0n;
  let size = 1n;
  for (const x of live) {
    const ch = chars[x.at]!;
    const d = /\d/.test(ch) ? Number(ch) - x.base : ch.toLowerCase().charCodeAt(0) - 97;
    n += BigInt(d) * size;
    size *= BigInt(x.radix);
  }
  n = shuffle(n, size, key, `${kind}:${live.map((x) => x.radix).join(',')}`);
  for (const x of live) {
    const d = Number(n % BigInt(x.radix));
    n /= BigInt(x.radix);
    chars[x.at] = x.radix === 26 ? String.fromCharCode(97 + d)[x.upper ? 'toUpperCase' : 'toLowerCase']() : String(d + x.base);
  }
  return chars.join('');
}

/** A keyed shuffle of the numbers 0 … size-1: a Feistel network on enough bits, walked until it lands inside. */
function shuffle(n: bigint, size: bigint, key: Buffer, tweak: string): bigint {
  if (size <= 1n) return n;
  let bits = (size - 1n).toString(2).length;
  if (bits % 2) bits++;
  const half = BigInt(bits / 2);
  const mask = (1n << half) - 1n;
  const round = (r: number, x: bigint) => BigInt(`0x${createHmac('sha256', key).update(`${tweak}:${r}:${x}`).digest('hex')}`) & mask;
  let v = n;
  do {
    let l = v >> half;
    let r = v & mask;
    for (let i = 0; i < 8; i++) [l, r] = [r, l ^ round(i, r)];
    v = (l << half) | r;
  } while (v >= size);
  return v;
}

/** A day between 1950 and 2005 from the hash. The day of the month is at most 12, so any order of day and month is valid. */
function fakeDay(b: Buffer): { y: number; m: number; d: number } {
  return { y: 1950 + (b.readUInt16BE(10) % 56), m: 1 + (b[12]! % 12), d: 1 + (b[13]! % 12) };
}

const two = (n: number) => String(n).padStart(2, '0');

/** A date in text: the date part changed, the time and the format kept. Anything else keeps its shape. */
function fakeDate(value: string, b: Buffer, key: Buffer): string {
  const { y, m, d } = fakeDay(b);
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return `${y}-${two(m)}-${two(d)}${value.slice(10)}`;
  const dm = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})/.exec(value);
  if (dm) return `${two(d)}${dm[2]}${two(m)}${dm[2]}${y}${value.slice(dm[0].length)}`;
  return sameShape(value, key, 'birth-date');
}

/** A birth date kept as milliseconds (a Mongo date): the day changes, the time of day stays. */
export function fakeDateMs(faker: Faker, ms: number): number {
  const day = 86_400_000;
  const iso = faker('birth-date', new Date(Math.floor(ms / day) * day).toISOString().slice(0, 10));
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t + (((ms % day) + day) % day) : ms;
}
