import { describe, expect, it } from 'vitest';
import { detect, firstWords, isolated, langLabel, langProps, langTree, majority, runs, tableDir, textClass, typedDir, wordCount, type HNode } from '../console-ui/src/lib/lang.js';

describe('language per paragraph', () => {
  it('tells Arabic, English and mixed apart by counting letters', () => {
    expect(detect('تمام. نحتفظ بالرسائل 30 يوم فقط، وبعدها تنحذف تلقائيًا.')).toMatchObject({ lang: 'ar', dir: 'rtl' });
    expect(detect('Here is what I understand so far.')).toMatchObject({ lang: 'en', dir: 'ltr' });
    // Mostly Arabic with a ticket number and a version: mixed, right to left.
    expect(detect('MA-10 لازم يخلص قبل release v0.2.0 الأسبوع الجاي.')).toMatchObject({ lang: 'mixed', dir: 'rtl' });
    // Mostly English with an Arabic label: mixed, left to right.
    expect(detect('Please put the Arabic label «تم إرسال الرمز» on the button, under the code field.')).toMatchObject({ lang: 'mixed', dir: 'ltr' });
  });

  it('leaves code, links and numbers out of the count', () => {
    expect(detect('سأجعل المدة إعدادًا واحدًا اسمه `OUTBOX_KEEP_DAYS_FOR_EVERY_MESSAGE` حتى يمكن تغييرها لاحقًا.').lang).toBe('ar');
    expect(detect('افتح https://example.com/some/very/long/english/path هنا').lang).toBe('ar');
    expect(detect('12:30 — 45%')).toEqual({ lang: 'none', dir: 'ltr', share: 0 });
  });

  it('gives Arabic its own type size, and says the language in words', () => {
    expect(textClass(detect('واضح، شكرًا.'))).toBe('t-ar');
    expect(textClass(detect('Please put the Arabic label «تم إرسال الرمز» on the button.'))).toBe('t-mx');
    expect(textClass(detect('Plain English.'))).toBe('t-en');
    expect(langLabel(detect('واضح'))).toBe('Arabic · right to left');
    expect(langLabel(detect('MA-10 لازم يخلص قبل release v0.2.0 الأسبوع الجاي.'))).toBe('Mixed · right to left');
    expect(langLabel(detect('123'))).toBe('');
  });
});

describe('the other language kept in order', () => {
  it('wraps an English phrase inside Arabic as one run', () => {
    expect(runs('المدة قبل release v0.2.0 الأسبوع الجاي.', 'rtl')).toEqual([
      { text: 'المدة قبل ' },
      { text: 'release v0.2.0', dir: 'ltr' },
      { text: ' الأسبوع الجاي.' },
    ]);
  });

  it('wraps Arabic inside English, and leaves the paragraph language alone', () => {
    expect(runs('Put «تم إرسال الرمز» on the button.', 'ltr')).toEqual([{ text: 'Put «' }, { text: 'تم إرسال الرمز', dir: 'rtl' }, { text: '» on the button.' }]);
    expect(runs('Plain words, 30 days.', 'ltr')).toEqual([{ text: 'Plain words, 30 days.' }]);
  });

  it('keeps a number with the words around it, so a phrase never splits in two', () => {
    expect(runs('نحتفظ بالرسائل 30 يوم فقط. And the owner searches, مثل 0551234567.', 'ltr')).toEqual([
      { text: 'نحتفظ بالرسائل 30 يوم فقط', dir: 'rtl' },
      { text: '. And the owner searches, ' },
      { text: 'مثل', dir: 'rtl' },
      { text: ' 0551234567.' },
    ]);
    expect(runs('نحذفها بعد 30 days تلقائيًا', 'rtl')).toEqual([{ text: 'نحذفها بعد ' }, { text: '30 days', dir: 'ltr' }, { text: ' تلقائيًا' }]);
  });

  it('leaves the full stop or colon after an English word to the sentence', () => {
    expect(runs('كما في SK-9.', 'rtl')).toEqual([{ text: 'كما في ' }, { text: 'SK-9', dir: 'ltr' }, { text: '.' }]);
    expect(runs('اضغط Save: ثم v0.2.0.', 'rtl')).toEqual([{ text: 'اضغط ' }, { text: 'Save', dir: 'ltr' }, { text: ': ثم ' }, { text: 'v0.2.0', dir: 'ltr' }, { text: '.' }]);
    expect(runs('تعلم C# أولا', 'rtl')).toEqual([{ text: 'تعلم ' }, { text: 'C#', dir: 'ltr' }, { text: ' أولا' }]);
  });

  it('a list or table follows most of its items', () => {
    expect(majority(['rtl', 'rtl', 'ltr'])).toBe('rtl');
    expect(majority(['ltr', 'ltr', 'rtl'])).toBe('ltr');
    expect(majority(['rtl', 'ltr'])).toBe('rtl');
    expect(majority([])).toBe('ltr');
  });
});

const p = (...children: HNode[]): HNode => ({ type: 'element', tagName: 'p', properties: {}, children });
const li = (...children: HNode[]): HNode => ({ type: 'element', tagName: 'li', properties: {}, children });
const t = (value: string): HNode => ({ type: 'text', value });
const root = (...children: HNode[]): HNode => ({ type: 'root', children });

describe('on a Markdown tree', () => {
  it('sets direction, language and size per paragraph, and isolates the other language', () => {
    const tree = langTree(root(p(t('تمام. نحتفظ بالرسائل 30 يوم فقط.')), p(t('Here is what I understand.')), p(t('المدة قبل release v0.2.0 الأسبوع الجاي.'))));
    const [a, b, c] = tree.children!;
    expect(a!.properties).toMatchObject({ dir: 'rtl', lang: 'ar', className: ['t-ar'] });
    expect(b!.properties).toMatchObject({ dir: 'ltr', lang: 'en', className: ['t-en'] });
    expect(c!.children![1]).toMatchObject({ tagName: 'bdi', properties: { dir: 'ltr' }, children: [{ value: 'release v0.2.0' }] });
  });

  it('keeps code left to right and out of the count', () => {
    const code: HNode = { type: 'element', tagName: 'code', properties: {}, children: [t('OUTBOX_KEEP_DAYS')] };
    const tree = langTree(root(p(t('سأجعل المدة إعدادًا اسمه '), code, t(' حتى يمكن تغييرها.'))));
    const para = tree.children![0]!;
    expect(para.properties!.dir).toBe('rtl');
    expect(code.properties!.dir).toBe('ltr');
    expect(code.children).toEqual([t('OUTBOX_KEEP_DAYS')]);
  });

  it('gives each list item its own direction and the list the direction of most items', () => {
    const ul: HNode = { type: 'element', tagName: 'ul', properties: {}, children: [li(t('تُحذف الرسائل بعد 30 يومًا.')), li(t('الأحدث في الأعلى.')), li(t('Works on a phone.'))] };
    langTree(root(ul));
    expect(ul.properties!.dir).toBe('rtl');
    expect(ul.children!.map((x) => x.properties!.dir)).toEqual(['rtl', 'rtl', 'ltr']);
  });

  it('puts an Arabic table first column on the right', () => {
    const cell = (tag: string, v: string): HNode => ({ type: 'element', tagName: tag, properties: {}, children: [t(v)] });
    const table: HNode = {
      type: 'element',
      tagName: 'table',
      properties: {},
      children: [{ type: 'element', tagName: 'tr', properties: {}, children: [cell('th', 'القناة'), cell('th', 'الرقم'), cell('th', 'الوقت')] }, { type: 'element', tagName: 'tr', properties: {}, children: [cell('td', 'SMS'), cell('td', '0551234567'), cell('td', '10:40')] }],
    };
    langTree(root(table));
    expect(table.properties!.dir).toBe('rtl');
  });

  it('while writing, wraps each word so it fades in, and adds the cursor after the last word', () => {
    const tree = langTree(root(p(t('Words fade in'))), { stream: true, caret: true });
    const para = tree.children![0]!;
    expect(para.children!.filter((x) => x.tagName === 'span' && (x.properties!.className as string[])[0] === 'fx')).toHaveLength(3);
    expect(para.children!.at(-1)!.properties!.className).toEqual(['caret']);
  });
});

describe('outside the chat', () => {
  it('gives an element the direction and language of its words', () => {
    expect(langProps('راجع SK-12 قبل البدء؟')).toEqual({ dir: 'rtl', lang: 'ar' });
    expect(langProps('Export the list')).toEqual({ dir: 'ltr', lang: 'en' });
    expect(langProps('SK-12')).toEqual({ dir: 'ltr', lang: 'en' });
  });

  it('a box follows what is typed; empty, it follows its hint', () => {
    expect(typedDir('')).toBe('auto');
    expect(typedDir('  ')).toBe('auto');
    expect(typedDir('SK-12 طلب حجز موعد جديد')).toBe('rtl');
    expect(typedDir('A new request')).toBe('ltr');
  });

  it('a table sits on the side most of its cells read from, leaving out cells with no letters', () => {
    expect(tableDir([['القناة', 'الرقم', 'الوقت'], ['SMS', '0551234567', '10:40']])).toBe('rtl');
    expect(tableDir([['Channel', 'Number'], ['SMS', '0551234567']])).toBe('ltr');
    expect(tableDir([])).toBe('ltr');
  });

  it('keeps a name in order inside plain text', () => {
    expect(isolated('الدفع')).toBe('\u2068الدفع\u2069');
  });
});

describe('writing word by word', () => {
  it('cuts the text after a number of words, keeping line breaks', () => {
    const text = 'One two\n\nthree four';
    expect(wordCount(text)).toBe(4);
    expect(firstWords(text, 3)).toBe('One two\n\nthree');
    expect(firstWords(text, 0)).toBe('');
    expect(firstWords(text, 9)).toBe(text);
  });
});
