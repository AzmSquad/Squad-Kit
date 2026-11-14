import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { adfToMarkdown, type AdfNode } from '../src/modules/jira/adf-read.js';
import { markdownToAdf } from '../src/modules/jira/adf-write.js';

/** Jira's ADF read as Markdown for the squad, and squad-kit's Markdown written as ADF for Jira. */

const t = (text: string, ...marks: string[]): AdfNode => ({ type: 'text', text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const li = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content });
const doc = (...content: AdfNode[]) => ({ type: 'doc', version: 1, content });

describe('ADF to Markdown', () => {
  it('reads headings, paragraphs with marks and links, and line breaks', () => {
    const md = adfToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [t('Opening hours')] },
        p(t('Owner sets '), t('hours', 'strong'), t(' for '), t('each', 'em'), t(' day, see '), { type: 'text', text: 'the spec', marks: [{ type: 'link', attrs: { href: 'https://acme.test/spec' } }] }, { type: 'hardBreak' }, t('run '), t('npm test', 'code')),
      ),
    );
    expect(md).toBe('## Opening hours\n\nOwner sets **hours** for *each* day, see [the spec](https://acme.test/spec)\nrun `npm test`');
  });

  it('reads nested bullet and numbered lists, task lists and code blocks', () => {
    const md = adfToMarkdown(
      doc(
        { type: 'bulletList', content: [li(p(t('Guests')), { type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('book'))), li(p(t('pay')))] }), li(p(t('Staff')))] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [t('Ask the owner')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('Write it down')] }] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const open = true;\nexport { open };')] },
      ),
    );
    expect(md).toBe('- Guests\n  3. book\n  4. pay\n- Staff\n\n- [x] Ask the owner\n- [ ] Write it down\n\n```ts\nconst open = true;\nexport { open };\n```');
  });

  it('reads tables, mentions, pictures and files as their names, quotes, panels, dates and status lozenges', () => {
    const md = adfToMarkdown(
      doc(
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('Day'))] }, { type: 'tableHeader', content: [p(t('Hours'))] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('Fri'))] }, { type: 'tableCell', content: [p(t('closed | off'))] }] },
          ],
        },
        p({ type: 'mention', attrs: { id: 'a1', text: '@Sara Ali' } }, t(' please check '), { type: 'status', attrs: { text: 'BLOCKED' } }, t(' by '), { type: 'date', attrs: { timestamp: '1763078400000' } }),
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'uuid-1', type: 'file', collection: 'c', alt: 'hours.png' } }] },
        { type: 'mediaGroup', content: [{ type: 'media', attrs: { id: 'uuid-2', type: 'file', collection: 'c' } }] },
        { type: 'blockquote', content: [p(t('Keep Friday closed.'))] },
        { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Read the policy first.'))] },
        { type: 'rule' },
        { type: 'blockCard', attrs: { url: 'https://acme.atlassian.net/browse/PAY-7' } },
        p(t('See '), { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/PAY-8' } }),
      ),
    );
    expect(md).toBe(
      [
        '| Day | Hours |\n| --- | --- |\n| Fri | closed \\| off |',
        '@Sara Ali please check [BLOCKED] by 2025-11-14',
        '[attachment: hours.png]',
        '[attachment]',
        '> Keep Friday closed.',
        '> Read the policy first.',
        '---',
        'https://acme.atlassian.net/browse/PAY-7',
        'See https://acme.atlassian.net/browse/PAY-8',
      ].join('\n\n'),
    );
  });

  it('gives the text of nodes it does not know, keeps plain text fields, and is empty for nothing', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/jira/issue-adf-complex.json'), 'utf8')) as unknown;
    expect(adfToMarkdown(fixture)).toBe('## Section title\n\n- Alpha bullet\n- Beta bullet\n\nInside unknown wrapper');
    expect(adfToMarkdown('  Given a free slot ')).toBe('Given a free slot');
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown({ type: 'doc', version: 1, content: [] })).toBe('');
  });
});

describe('Markdown to ADF', () => {
  it('writes paragraphs, keeps a single line break as one, and marks bold, italic, code and links', () => {
    expect(markdownToAdf('**Given** a free slot\n*When* I hold `it`, see [the plan](https://acme.test/p)\n\nNext part')).toEqual(
      doc(
        p(t('Given', 'strong'), t(' a free slot'), { type: 'hardBreak' }, t('When', 'em'), t(' I hold '), t('it', 'code'), t(', see '), { type: 'text', text: 'the plan', marks: [{ type: 'link', attrs: { href: 'https://acme.test/p' } }] }),
        p(t('Next part')),
      ),
    );
  });

  it('writes bold inside a link and italic inside bold', () => {
    expect(markdownToAdf('[**Open** it](https://acme.test) and **very _important_**').content).toEqual([
      p(
        { type: 'text', text: 'Open', marks: [{ type: 'link', attrs: { href: 'https://acme.test' } }, { type: 'strong' }] },
        { type: 'text', text: ' it', marks: [{ type: 'link', attrs: { href: 'https://acme.test' } }] },
        t(' and '),
        t('very ', 'strong'),
        { type: 'text', text: 'important', marks: [{ type: 'strong' }, { type: 'em' }] },
      ),
    ]);
  });

  it('writes headings, bullet and numbered lists nested by indent, a list item going on, and code blocks', () => {
    expect(markdownToAdf('### Plan\n- Hold\n  1. pick a slot\n  2. wait\n- Pay\n  by card\n\n3. Third\n\n```ts\nconst a = 1;\n```').content).toEqual([
      { type: 'heading', attrs: { level: 3 }, content: [t('Plan')] },
      {
        type: 'bulletList',
        content: [
          li(p(t('Hold')), { type: 'orderedList', content: [li(p(t('pick a slot'))), li(p(t('wait')))] }),
          li(p(t('Pay'), { type: 'hardBreak' }, t('by card'))),
        ],
      },
      { type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('Third')))] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;')] },
    ]);
  });

  it('writes quotes and rules, leaves snake_case and 2*3 alone, and an empty text is one empty paragraph', () => {
    expect(markdownToAdf('> Keep it\n> short\n\n---\n\nuse open_hours and 2*3*4').content).toEqual([
      { type: 'blockquote', content: [p(t('Keep it'), { type: 'hardBreak' }, t('short'))] },
      { type: 'rule' },
      p(t('use open_hours and 2*3*4')),
    ]);
    expect(markdownToAdf('')).toEqual(doc(p()));
  });

  it('reads back as the Markdown it came from', () => {
    const md = '## Done when\n\n- **Given** a free slot\n- **When** I hold it\n\n1. Open hours\n2. Save\n\n```\nnpm test\n```';
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });
});
