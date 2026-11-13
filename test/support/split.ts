import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Texts for the size check and the split: the agreed design's payments paste, in English and Arabic, and longer ones. */

/** The four-part payments text from the agreed design. */
export const PAYMENTS = 'Customers should pay by card when they book, get a receipt by email and SMS, and be able to ask for their money back up to a day before. Staff need to see all payments in a report.';
export const PAYMENTS_AR = 'العميل يدفع بالبطاقة وقت الحجز، ويوصله إيصال بالإيميل والرسائل، ويقدر يطلب فلوسه ترجع لحد قبل الميعاد بيوم. والموظفين محتاجين يشوفوا كل المدفوعات في تقرير.';

/** The Analyst's four parts for it, in the order to build them. */
export const PAYMENT_PARTS = [
  { title: 'Pay by card when booking', line: 'The last booking step takes the card and confirms', size: 'M', needs: [] },
  { title: 'Receipt by email and SMS', line: 'Sent right after the payment', size: 'S', needs: [1] },
  { title: 'Ask for a refund', line: 'Up to a day before; staff approve it', size: 'M', needs: [1] },
  { title: 'Payments report for staff', line: 'Every payment by day, with refunds', size: 'S', needs: [1] },
];

/** A long business text with no requirement numbers (test/fixtures/size). */
export function businessPaste(): string {
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'size', 'business-paste.md'), 'utf8');
}

/** A requirements document in the usual shape: numbered sections, requirement numbers and "shall" lines. */
export function brdLike(sections = 8, each = 6): string {
  const out = ['# RoomFlow: meeting rooms, release 2', '', '## 1. Purpose', 'This document lists what RoomFlow must do for members, reception and building managers.'];
  let n = 1;
  for (let s = 2; s <= sections + 1; s += 1) {
    out.push('', `## ${s}. Area ${s}`, `${s}.1 Overview`, 'Members, reception staff and managers use this part every day from the web and from a phone.');
    for (let i = 0; i < each; i += 1) out.push(`FR-${n++} The system shall let a member book, move or cancel a room in this area, with an email to confirm and a reminder before it starts.`);
  }
  return out.join('\n');
}
