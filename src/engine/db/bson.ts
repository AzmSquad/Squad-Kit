import { Transform } from 'node:stream';
import { fakeDateMs, type Faker, type Personal } from './hide.js';

/**
 * Hiding personal data in a MongoDB dump on its way to the template's files. mongodump writes documents in BSON, one
 * after another; this reads each one, makes the personal strings (and birth dates) fake, and writes it back. Every other
 * value is copied byte for byte, so numbers, ids and dates keep their exact types.
 */

/**
 * What personal data a field holds: its name, the name of what it is in (the collection, or the parent field), and
 * where it is from the collection down (`patients.contact.phone`), for engineers to see.
 */
export type FieldKind = (field: string, inside: string, where: string) => Personal | null;

/** The size in bytes of a value of this BSON type at this place. */
function valueSize(buf: Buffer, type: number, at: number): number {
  switch (type) {
    case 0x01:
    case 0x09:
    case 0x11:
    case 0x12:
      return 8;
    case 0x02:
    case 0x0d:
    case 0x0e:
      return 4 + buf.readInt32LE(at);
    case 0x03:
    case 0x04:
    case 0x0f:
      return buf.readInt32LE(at);
    case 0x05:
      return 5 + buf.readInt32LE(at);
    case 0x06:
    case 0x0a:
    case 0x7f:
    case 0xff:
      return 0;
    case 0x07:
      return 12;
    case 0x08:
      return 1;
    case 0x0b: {
      const a = buf.indexOf(0, at);
      return buf.indexOf(0, a + 1) + 1 - at;
    }
    case 0x0c:
      return 4 + buf.readInt32LE(at) + 12;
    case 0x10:
      return 4;
    case 0x13:
      return 16;
    default:
      throw new Error(`A document in the dump has a value of a kind squad-kit does not know (${type}).`);
  }
}

function element(type: number, name: Buffer, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), name, value]);
}

function stringValue(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(4);
  len.writeInt32LE(body.length + 1);
  return Buffer.concat([len, body, Buffer.from([0])]);
}

/**
 * One document with its personal values made fake, or null when nothing in it changed. `asField` names the elements
 * of an array by the array's own name, so `phones: ['…']` is read as phones.
 */
export function fakeDocument(doc: Buffer, inside: string, kindOf: FieldKind, faker: Faker, asField?: string, where = inside): Buffer | null {
  const parts: Buffer[] = [];
  let changed = false;
  let i = 4;
  const end = doc.readInt32LE(0) - 1;
  while (i < end) {
    const type = doc[i]!;
    const nameEnd = doc.indexOf(0, i + 1);
    const name = doc.toString('utf8', i + 1, nameEnd);
    const nameBuf = doc.subarray(i + 1, nameEnd + 1);
    const at = nameEnd + 1;
    const next = at + valueSize(doc, type, at);
    const field = asField ?? name;
    let out: Buffer | null = null;
    const here = asField ? where : `${where}.${name}`;
    if (type === 0x02) {
      const kind = kindOf(field, inside, here);
      if (kind) out = element(type, nameBuf, stringValue(faker(kind, doc.toString('utf8', at + 4, next - 1))));
    } else if (type === 0x09) {
      if (kindOf(field, inside, here) === 'birth-date') {
        const v = Buffer.alloc(8);
        v.writeBigInt64LE(BigInt(fakeDateMs(faker, Number(doc.readBigInt64LE(at)))));
        out = element(type, nameBuf, v);
      }
    } else if (type === 0x03 || type === 0x04) {
      // A document's fields are read as being inside it; an array's items as the array itself.
      const sub = type === 0x03 ? fakeDocument(doc.subarray(at, next), asField ?? name, kindOf, faker, undefined, here) : fakeDocument(doc.subarray(at, next), inside, kindOf, faker, field, here);
      if (sub) out = element(type, nameBuf, sub);
    }
    if (out) changed = true;
    parts.push(out ?? doc.subarray(i, next));
    i = next;
  }
  if (!changed) return null;
  const body = Buffer.concat(parts);
  const size = Buffer.alloc(4);
  size.writeInt32LE(body.length + 5);
  return Buffer.concat([size, body, Buffer.from([0])]);
}

/** A transform over a stream of BSON documents that makes their personal values fake. */
export function fakeBson(collection: string, kindOf: FieldKind, faker: Faker): Transform {
  let held: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      try {
        held = held.length ? Buffer.concat([held, chunk]) : chunk;
        const out: Buffer[] = [];
        let i = 0;
        while (held.length - i >= 4) {
          const size = held.readInt32LE(i);
          if (size < 5) throw new Error('The dump is not in the form squad-kit expects.');
          if (held.length - i < size) break;
          const doc = held.subarray(i, i + size);
          out.push(fakeDocument(doc, collection, kindOf, faker) ?? doc);
          i += size;
        }
        held = held.subarray(i);
        cb(null, out.length ? Buffer.concat(out) : undefined);
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      cb(held.length ? new Error('The dump ended in the middle of a document.') : null);
    },
  });
}
