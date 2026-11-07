import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Play, Plus, Trash2, X } from 'lucide-react';
import type { BrdRef, BreakdownEpic, BreakdownFeature, BreakdownLevel, BreakdownStory, BreakdownView, Decided, StoryProgress } from '../api/requirements-types';
import type { Criterion, Ticket } from '../api/types';
import {
  changedWords,
  chipKind,
  decidedWho,
  findPart,
  fromWords,
  halfCheck,
  jobBusy,
  keptChecks,
  mergedOf,
  moveTargets,
  needsLeft,
  parentKey,
  placeWords,
  refWords,
  sizeWords,
  storiesUnder,
  type Found,
} from '../lib/requirements';
import { useReqAct } from '../lib/requirementsData';
import { usePrefs } from '../lib/prefs';
import { shellQuote } from '../lib/text';
import { needOptions } from './BreakdownDialogs';
import { Cmd } from './ui';
import { clearDraft, draftKey, readDraft, useDraft, writeDraft } from '../lib/drafts';
import { PROJECT } from '../api/client';

/**
 * The breakdown as a tree: epics, features and stories with their level, needs, place in the BRD and size, and once
 * approved each story's ticket, tracker item and where it is. Beside it, the panel of the chosen part, or the
 * Decided for you list.
 */

const base = (id: string) => `/api/v1/requirements/${encodeURIComponent(id)}`;
const LEVEL_WORD: Record<BreakdownLevel, string> = { epic: 'Epic', feature: 'Feature', story: 'Story' };

export type TreeMode = 'plan' | 'build';

/** The tree can be changed once written, for the owner, and not the part the Analyst is redoing. */
export function canEdit(v: BreakdownView): boolean {
  return v.mine && (v.status === 'ready' || v.status === 'approved');
}

function redoing(v: BreakdownView): string | null {
  const j = v.state.job;
  return jobBusy(j) && j?.step === 'redo' ? (j.item ?? null) : null;
}

/** True while the Analyst redoes this part, the part it sits in, or the whole breakdown. */
export function beingRedone(v: BreakdownView, key: string): boolean {
  const item = redoing(v);
  if (!item) return false;
  if (item === v.id || item === key) return true;
  const target = findPart(v, item);
  if (!target) return false;
  if (target.level === 'story') return false;
  return storiesUnder(target.item as BreakdownEpic | BreakdownFeature).some((s) => s.key === key) || (target.level === 'epic' && target.epic.features.some((f) => f.key === key));
}

interface TreeProps {
  v: BreakdownView;
  mode: TreeMode;
  selected?: string;
  open: Set<string>;
  onToggle(key: string): void;
  /** Left out while the Analyst still writes it: the rows are plain, and only fold. */
  onSelect?(key: string): void;
  onDecide(ticket: string): void;
  onAdd?(level: BreakdownLevel, under?: string): void;
}

export function Tree({ v, mode, selected, open, onToggle, onSelect, onDecide, onAdd }: TreeProps) {
  const progress = useMemo(() => new Map(v.progress.map((p) => [p.key, p])), [v.progress]);
  const sel = findPart(v, selected);
  // "+ Add a story" goes where the person is: under the chosen feature, or beside the chosen story.
  const storyUnder = sel ? (sel.level === 'epic' ? (sel.epic.features[0]?.key ?? sel.epic.key) : (sel.feature?.key ?? sel.epic.key)) : undefined;
  const featureUnder = sel?.epic.key;
  const story = (s: BreakdownStory, depth: number) => <StoryRow key={s.key} s={s} p={progress.get(s.key)} depth={depth} mode={mode} selected={selected === s.key} onSelect={onSelect} onDecide={onDecide} />;
  return (
    <section className={`rq-tree ${mode} ${v.epics.some((e) => storiesUnder(e).some((x) => x.tracker)) ? 'refs' : ''} ${onSelect ? '' : 'still'}`} aria-label="Breakdown">
      {v.epics.map((e) => {
        const eOpen = open.has(e.key);
        return (
          <div key={e.key} className="rq-group">
            <GroupRow level="epic" item={e} depth={0} mode={mode} isOpen={eOpen} selected={selected === e.key} progress={progress} onToggle={onToggle} onSelect={onSelect} />
            {eOpen && (
              <>
                {e.features.map((f) => {
                  const fOpen = open.has(f.key);
                  return (
                    <div key={f.key} className="rq-sub">
                      <GroupRow level="feature" item={f} depth={1} mode={mode} isOpen={fOpen} selected={selected === f.key} progress={progress} onToggle={onToggle} onSelect={onSelect} />
                      {fOpen && f.stories.map((s) => story(s, 2))}
                      {fOpen && !f.stories.length && <div className="rq-none d2">No stories yet.</div>}
                    </div>
                  );
                })}
                {e.stories.map((s) => story(s, 1))}
                {!e.features.length && !e.stories.length && <div className="rq-none d1">Nothing under this epic yet.</div>}
              </>
            )}
          </div>
        );
      })}
      {!v.epics.length && <p className="note rq-none">No epics yet.</p>}
      {onAdd && canEdit(v) && (
        <div className="rq-adds">
          <button className="btn rq-addbtn" onClick={() => onAdd('epic')} title={`squad requirements add-item ${v.id} --title "…"`}>
            <Plus size={14} /> Add an epic
          </button>
          {v.epics.length > 0 && (
            <button className="btn rq-addbtn" onClick={() => onAdd('feature', featureUnder ?? v.epics.at(-1)?.key)}>
              <Plus size={14} /> Add a feature
            </button>
          )}
          {v.epics.length > 0 && (
            <button className="btn rq-addbtn" onClick={() => onAdd('story', storyUnder)}>
              <Plus size={14} /> Add a story
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Bar({ done, of }: { done: number; of: number }) {
  return (
    <span className="rq-pb" aria-hidden="true">
      <b style={{ width: `${of ? Math.round((done / of) * 100) : 0}%` }} />
    </span>
  );
}

function GroupRow({
  level,
  item,
  depth,
  mode,
  isOpen,
  selected,
  progress,
  onToggle,
  onSelect,
}: {
  level: 'epic' | 'feature';
  item: BreakdownEpic | BreakdownFeature;
  depth: number;
  mode: TreeMode;
  isOpen: boolean;
  selected: boolean;
  progress: Map<string, StoryProgress>;
  onToggle(key: string): void;
  onSelect?(key: string): void;
}) {
  const stories = storiesUnder(item);
  const m = mergedOf(stories, progress);
  const live = level === 'feature' ? stories.filter((s) => progress.get(s.key)?.state === 'building').map((s) => s.key) : [];
  const about = level === 'epic' ? (item as BreakdownEpic).goal : undefined;
  return (
    <div className={`rq-row ${level} d${depth} ${selected ? 'sel' : ''}`}>
      <button className="rq-fold" aria-expanded={isOpen} aria-label={`${isOpen ? 'Fold' : 'Open'} ${item.title}`} onClick={() => onToggle(item.key)}>
        {isOpen ? <ChevronDown size={14} strokeWidth={2.4} /> : <ChevronRight size={14} strokeWidth={2.4} />}
      </button>
      <Main onClick={onSelect && (() => onSelect(item.key))} current={selected} label={`${LEVEL_WORD[level]} ${item.key} ${item.title}`}>
        <span className={`rq-lv ${level}`}>{LEVEL_WORD[level]}</span>
        <span className="rq-t" title={item.title}>
          {item.title}
        </span>
        {mode === 'plan' && about && <span className="rq-meta rq-goal">{about}</span>}
        {mode === 'build' && live.length > 0 && <span className="rq-meta rq-live">{live.join(', ')} building</span>}
        <span className="grow" />
        {mode === 'plan' ? (
          <span className="rq-meta">{sizeWords(item)}</span>
        ) : (
          <>
            <Bar {...m} />
            <span className="rq-meta rq-of">
              {m.done} of {m.of}
            </span>
          </>
        )}
      </Main>
    </div>
  );
}

/** A row's main part: a button that opens the part, or plain while the tree is read only. */
function Main({ onClick, current, label, children }: { onClick?: () => void; current: boolean; label: string; children: ReactNode }) {
  if (!onClick) return <div className="rq-main">{children}</div>;
  return (
    <button className="rq-main" onClick={onClick} aria-current={current ? 'true' : undefined} aria-label={label}>
      {children}
    </button>
  );
}

function StateLine({ p }: { p: StoryProgress | undefined }) {
  const kind = chipKind(p?.state);
  return (
    <span className={`rq-st ${kind} ${p?.state ?? 'not-started'}`}>
      {kind === 'm' ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : kind === 'b' ? <span className="live" aria-hidden="true" /> : null}
      <span className="rq-stl">{p?.line ?? 'Not started'}</span>
    </span>
  );
}

function StoryRow({
  s,
  p,
  depth,
  mode,
  selected,
  onSelect,
  onDecide,
}: {
  s: BreakdownStory;
  p: StoryProgress | undefined;
  depth: number;
  mode: TreeMode;
  selected: boolean;
  onSelect?(key: string): void;
  onDecide(ticket: string): void;
}) {
  const you = p?.state === 'needs-you';
  const link = s.tracker;
  return (
    // The whole row picks the story with the mouse; the keyboard uses its main button. Decide stays its own button.
    <div className={`rq-row story d${depth} ${selected ? 'sel' : ''} ${you ? 'you' : ''}`} onClick={onSelect && (() => onSelect(s.key))}>
      <Main onClick={onSelect && (() => onSelect(s.key))} current={selected} label={`Story ${s.key} ${s.title}${p && mode === 'build' ? `: ${p.line}` : ''}`}>
        {mode === 'plan' && <span className="rq-lv story">Story</span>}
        <span className="rq-id">{s.key}</span>
        <span className="rq-t" title={s.title}>
          {s.title}
        </span>
        {mode === 'plan' && (
          <>
            {s.dependsOn.slice(0, 2).map((n) => (
              <span key={n} className="rq-need">
                needs {n}
              </span>
            ))}
            {s.dependsOn.length > 2 && <span className="rq-need">+{s.dependsOn.length - 2}</span>}
            {!s.criteria.length && <span className="rq-warn">No "done when" yet</span>}
            <span className="grow" />
            {s.ref?.section && <span className="rq-meta rq-from">{fromWords(s.ref.section)}</span>}
            <span className="rq-meta rq-size" title={`Size ${s.size}`}>
              {s.size}
            </span>
          </>
        )}
        {mode === 'build' && <span className="rq-tk">{p?.ticket ?? '–'}</span>}
      </Main>
      {/* The tracker item opens in the tracker; without its address it is only its number. */}
      {mode === 'build' &&
        (link?.url ? (
          <a className="rq-ref" href={link.url} target="_blank" rel="noreferrer" title={`Open ${link.ref}`} onClick={(e) => e.stopPropagation()}>
            {link.ref}
          </a>
        ) : (
          <span className="rq-ref">{link?.ref ?? ''}</span>
        ))}
      {mode === 'build' && (
        <span className={`rq-stcol ${you ? 'you' : ''}`}>
          <StateLine p={p} />
          {you && p?.ticket && (
            <button
              className="btn you sm"
              onClick={(e) => {
                e.stopPropagation();
                onDecide(p.ticket!);
              }}
              aria-label={`Decide on ${s.key} ${s.title}`}
            >
              Decide
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/* ── The chosen part's panel ────────────────────────────── */

interface PanelProps {
  v: BreakdownView;
  k: string;
  onClose(): void;
  onSelect(key: string | undefined): void;
  onAsk(key: string): void;
  onOpenRef(ref: BrdRef): void;
  onOpenTicket(id: string): void;
  onAdd(level: BreakdownLevel, under?: string): void;
}

export function ItemPanel(props: PanelProps) {
  const f = findPart(props.v, props.k);
  if (!f) return null;
  // A fresh panel for each part, so nothing typed on one shows on the next.
  return f.level === 'story' ? <StoryPanel key={f.item.key} {...props} f={f} /> : <GroupPanel key={f.item.key} {...props} f={f} />;
}

function PanelHead({ f, onClose }: { f: Found; onClose(): void }) {
  return (
    <div className="rq-ph">
      <span className={`rq-lv ${f.level}`}>{LEVEL_WORD[f.level]}</span>
      <span className="rq-id">{f.item.key}</span>
      <span className="rq-place">{placeWords(f)}</span>
      <span className="grow" />
      <button className="iconbtn" aria-label="Close" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}

interface StoryDraft {
  title: string;
  story: string;
  criteria: Criterion[];
  size: BreakdownStory['size'];
  needs: string[];
}

const draftOf = (s: BreakdownStory): StoryDraft => ({ title: s.title, story: s.story, criteria: s.criteria.map((c) => ({ ...c })), size: s.size, needs: [...s.dependsOn] });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The panel's own copy of a part: it follows the server until the person types, and comes back after Save. What is typed
 * stays on this computer until it is saved or undone, so another row, the cross or a reload lose nothing.
 */
function usePanelDraft<T>(scope: string, key: string, server: T): [T, (d: T | ((x: T) => T)) => void, boolean, () => void] {
  const kept = draftKey(PROJECT, scope, `panel-${key}`);
  const [d, setD] = useState<T>(() => readDraft<T>(kept) ?? server);
  const [from, setFrom] = useState({ key, server });
  const dirty = !same(d, from.server);
  useEffect(() => {
    if (dirty && key === from.key) writeDraft(kept, d);
    else clearDraft(kept);
  }, [kept, d, dirty]);
  useEffect(() => {
    if (key !== from.key) {
      setD(server);
      setFrom({ key, server });
      return;
    }
    if (same(server, from.server)) return;
    // The server changed: take it when nothing was typed, or when what was typed is what it has now (it was saved).
    if (!dirty || same(d, server)) {
      setD(server);
      setFrom({ key, server });
    }
  }, [key, server]);
  return [d, setD, dirty && key === from.key, () => setD(from.server)];
}

function StoryPanel({ v, f, onClose, onSelect, onAsk, onOpenRef, onOpenTicket }: PanelProps & { f: Found }) {
  const s = f.story!;
  const act = useReqAct();
  const { toast } = usePrefs();
  const p = v.progress.find((x) => x.key === s.key);
  // Its ticket on the board: one a person deleted has no ticket, so it can be changed and started again.
  const started = Boolean(s.ticket && p?.ticket);
  const busy = beingRedone(v, s.key);
  const editable = canEdit(v) && !started && !busy;
  const server = useMemo(() => draftOf(s), [s]);
  const [d, setD, dirty, reset] = usePanelDraft(v.id, s.key, server);
  const [removing, setRemoving] = useState(false);
  // A Save found a "done when" check half written: it is marked where it is until it is finished or removed.
  const [tried, setTried] = useState(false);
  const decided = v.decided.filter((x) => x.item === s.key);
  const waits = needsLeft(v, s);
  const approved = v.status === 'approved';
  const titleOf = (k: string) => findPart(v, k)?.item.title ?? '';
  const save = () => {
    // Empty checks go; a half-written one stays marked, and nothing is sent, so no other change is lost.
    const criteria = keptChecks(d.criteria);
    if (criteria.length !== d.criteria.length) setD((x) => ({ ...x, criteria: keptChecks(x.criteria) }));
    if (criteria.some(halfCheck)) {
      setTried(true);
      requestAnimationFrame(() => [...document.querySelectorAll<HTMLTextAreaElement>('.rq-gwt.half textarea')].find((t) => !t.value.trim())?.focus());
      return;
    }
    setTried(false);
    const patch: Record<string, unknown> = {};
    if (d.title !== s.title) patch.title = d.title;
    if (d.story !== s.story) patch.story = d.story;
    if (!same(criteria, s.criteria)) patch.criteria = criteria;
    if (d.size !== s.size) patch.size = d.size;
    if (!same(d.needs, s.dependsOn)) patch.needs = d.needs;
    // Only an empty check was added: it is gone, and nothing else changed.
    if (!Object.keys(patch).length) return;
    act.mutate({ path: `${base(v.id)}/items/${s.key}`, method: 'PATCH', body: patch, done: `Saved ${s.key}.` });
  };
  const setC = (i: number, part: keyof Criterion, value: string) => setD((x) => ({ ...x, criteria: x.criteria.map((c, j) => (j === i ? { ...c, [part]: value } : c)) }));
  const choices = needOptions(v, s.key, d.needs);

  return (
    <aside className="rq-panel" aria-label={`Story ${s.key}`} data-dirty={dirty}>
      <PanelHead f={f} onClose={onClose} />
      <div className="rq-pbody">
        {started && (
          <div className={`rq-started ${chipKind(p?.state)}`}>
            <span>
              <b className="mono">{s.ticket}</b> {p?.line ?? ''}
            </span>
            <button className={`btn sm ${p?.state === 'needs-you' ? 'you' : ''}`} onClick={() => onOpenTicket(s.ticket!)}>
              {p?.state === 'needs-you' ? 'Decide' : 'Open the ticket'}
            </button>
          </div>
        )}
        {started && <p className="note">It started as {s.ticket}, so it changes on its ticket now.</p>}
        {busy && <p className="rq-busy">The Analyst is redoing this part. It shows here when it is done.</p>}
        <div className="field">
          <label htmlFor="rq-st">Title</label>
          {editable ? <input id="rq-st" className="input rq-titlein" value={d.title} onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))} /> : <div id="rq-st" className="rq-ro rq-titlein">{s.title}</div>}
        </div>
        <div className="field">
          <label htmlFor="rq-ss">Story</label>
          {editable ? (
            <textarea id="rq-ss" className="textarea rq-storyin" value={d.story} placeholder="As a …, I want …, so that …" onChange={(e) => setD((x) => ({ ...x, story: e.target.value }))} />
          ) : (
            <div id="rq-ss" className="rq-ro">{s.story || <span className="note">No story text yet.</span>}</div>
          )}
        </div>
        <div className="rq-lab">Done when</div>
        <div className="rq-gwts">
          {d.criteria.map((c, i) => (
            <div key={i} className={`rq-gwt ${tried && halfCheck(c) ? 'half' : ''}`}>
              {(['given', 'when', 'then'] as const).map((part) => (
                <label key={part} className="rq-gwtrow">
                  <b>{part.charAt(0).toUpperCase() + part.slice(1)}</b>
                  {editable ? (
                    <textarea rows={Math.max(1, Math.ceil(c[part].length / 40))} value={c[part]} onChange={(e) => setC(i, part, e.target.value.replace(/\n/g, ' '))} aria-label={`Check ${i + 1}: ${part}`} />
                  ) : (
                    <span>{c[part]}</span>
                  )}
                </label>
              ))}
              {editable && (
                <button className="rq-gwt-x" aria-label={`Remove check ${i + 1}`} onClick={() => setD((x) => ({ ...x, criteria: x.criteria.filter((_, j) => j !== i) }))}>
                  <X size={13} />
                </button>
              )}
              {tried && halfCheck(c) && (
                <p className="rq-halfnote" role="alert">
                  Fill in Given, When and Then, or remove this check. Your other changes are kept.
                </p>
              )}
            </div>
          ))}
          {!d.criteria.length && <p className="rq-warnline">No "done when" yet. A story needs at least one before you approve.</p>}
          {editable && (
            <button className="rq-link" onClick={() => setD((x) => ({ ...x, criteria: [...x.criteria, { given: '', when: '', then: '' }] }))}>
              + Add a check
            </button>
          )}
        </div>
        <div className="rq-two">
          <div className="grow">
            <div className="rq-lab">Needs</div>
            <div className="rq-needs">
              {d.needs.map((n) => (
                <span key={n} className="rq-need big">
                  <button className="rq-needname" onClick={() => onSelect(n)} title={`Open ${n} ${titleOf(n)}`}>
                    <b>{n}</b>
                    <span>{titleOf(n)}</span>
                  </button>
                  {editable && (
                    <button aria-label={`${s.key} does not need ${n}`} onClick={() => setD((x) => ({ ...x, needs: x.needs.filter((y) => y !== n) }))}>
                      <X size={11} />
                    </button>
                  )}
                </span>
              ))}
              {!d.needs.length && !editable && <span className="note">Nothing first</span>}
              {editable && choices.length > 0 && (
                <select
                  className="rq-addneed"
                  aria-label={`Add a story ${s.key} needs first`}
                  value=""
                  onChange={(e) => e.target.value && setD((x) => ({ ...x, needs: [...x.needs, e.target.value] }))}
                >
                  <option value="">+ Add</option>
                  {choices.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div>
            <div className="rq-lab">Size</div>
            <div className="seg rq-sizeseg" role="group" aria-label="Size">
              {(['S', 'M', 'L'] as const).map((z) => (
                <button key={z} className={d.size === z ? 'on' : ''} aria-pressed={d.size === z} disabled={!editable} onClick={() => setD((x) => ({ ...x, size: z }))}>
                  {z}
                </button>
              ))}
            </div>
          </div>
        </div>
        {editable && <MoveTo v={v} f={f} />}
        {s.ref && (
          <div className="rq-fromline">
            From the BRD:{' '}
            <button className="rq-link" onClick={() => onOpenRef(s.ref!)}>
              {refWords(s.ref)}
            </button>
          </div>
        )}
        {decided.length > 0 && (
          <div className="rq-dbox">
            <div className="rq-lab">Decided for you</div>
            {decided.map((x) => (
              <DecidedEntry key={`${x.ticket ?? ''}${x.id}`} v={v} d={x} compact onOpenTicket={onOpenTicket} />
            ))}
          </div>
        )}
        {approved && !started && (
          <div className="rq-startbox">
            <button className="btn" disabled={waits.length > 0 || act.isPending || !v.mine || !s.criteria.length || dirty} onClick={() => act.mutate({ path: `${base(v.id)}/items/${s.key}/start` }, { onSuccess: (r) => toast(`${s.key} started as ${(r as { ticket?: { id: string } }).ticket?.id ?? 'a ticket'}. It builds by itself.`) })} title={`squad requirements start ${v.id} ${s.key}`}>
              <Play size={13} /> Start this story now
            </button>
            <span className="note">
              {waits.length ? `It starts after ${waits.join(', ')} ${waits.length === 1 ? 'merges' : 'merge'}.` : dirty ? 'Save your changes first.' : s.ticket ? 'Its ticket was deleted. This makes a new one that builds by itself.' : 'It becomes a ticket that builds by itself.'}
            </span>
          </div>
        )}
        {!started && <Cmd text={approved ? `squad requirements start ${v.id} ${s.key}` : `squad requirements edit ${v.id} ${s.key} --title ${shellQuote(d.title)}`} />}
      </div>
      {editable && (
        <div className="rq-pf">
          {removing ? (
            <>
              <span className="rq-sure">Remove {s.key}? It goes out of other stories' needs too.</span>
              <button className="btn danger" onClick={() => act.mutate({ path: `${base(v.id)}/items/${s.key}`, method: 'DELETE', done: `Removed ${s.key}.` }, { onSuccess: () => onSelect(undefined) })}>
                Remove
              </button>
              <button className="btn" onClick={() => setRemoving(false)}>
                Keep it
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => onAsk(s.key)} title={`squad requirements redo ${v.id} ${s.key} "<what to change>"`}>
                Ask the Analyst to redo this
              </button>
              {/* One row, Save on the right: while changes are not saved, Undo takes Remove's place. */}
              {dirty ? (
                <button
                  className="btn quiet"
                  onClick={() => {
                    reset();
                    setTried(false);
                  }}
                >
                  Undo
                </button>
              ) : (
                <button className="btn quiet" onClick={() => setRemoving(true)} title={`squad requirements remove ${v.id} ${s.key}`}>
                  Remove
                </button>
              )}
              <span className="grow" />
              <button className="btn pri" disabled={!dirty || act.isPending} onClick={save}>
                Save
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/** Move to another feature or epic: moves at once, like the terminal's `squad requirements move`. */
function MoveTo({ v, f }: { v: BreakdownView; f: Found }) {
  const act = useReqAct();
  const targets = moveTargets(v, f);
  const now = parentKey(f);
  if (targets.length < 2) return null;
  return (
    <div className="field rq-move">
      <label htmlFor={`rq-move-${f.item.key}`}>Move to</label>
      <select
        id={`rq-move-${f.item.key}`}
        className="select"
        value={now}
        title={`squad requirements move ${v.id} ${f.item.key} --under <key>`}
        onChange={(e) => e.target.value !== now && act.mutate({ path: `${base(v.id)}/items/${f.item.key}/move`, body: { under: e.target.value }, done: `Moved ${f.item.key}.` })}
      >
        {targets.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function GroupPanel({ v, f, onClose, onSelect, onAsk, onOpenRef, onOpenTicket, onAdd }: PanelProps & { f: Found }) {
  const act = useReqAct();
  const epic = f.level === 'epic';
  const item = f.item as BreakdownEpic | BreakdownFeature;
  const about = epic ? ((item as BreakdownEpic).goal ?? '') : ((item as BreakdownFeature).summary ?? '');
  const server = useMemo(() => ({ title: item.title, about }), [item.title, about]);
  const [d, setD, dirty, reset] = usePanelDraft(v.id, item.key, server);
  const [removing, setRemoving] = useState(false);
  const busy = beingRedone(v, item.key);
  const stories = storiesUnder(item);
  const progress = new Map(v.progress.map((p) => [p.key, p]));
  const started = stories.filter((s) => s.ticket && progress.get(s.key)?.ticket);
  const editable = canEdit(v) && !busy;
  const m = mergedOf(stories, progress);
  const decided = v.decided.filter((x) => x.item === item.key);
  const save = () =>
    act.mutate({
      path: `${base(v.id)}/items/${item.key}`,
      method: 'PATCH',
      body: { ...(d.title !== item.title ? { title: d.title } : {}), ...(d.about !== about ? (epic ? { goal: d.about } : { summary: d.about }) : {}) },
      done: `Saved ${item.key}.`,
    });
  return (
    <aside className="rq-panel" aria-label={`${LEVEL_WORD[f.level]} ${item.key}`} data-dirty={dirty}>
      <PanelHead f={f} onClose={onClose} />
      <div className="rq-pbody">
        {busy && <p className="rq-busy">The Analyst is redoing this part. It shows here when it is done.</p>}
        <div className="field">
          <label htmlFor="rq-gt">Title</label>
          {editable ? <input id="rq-gt" className="input rq-titlein" value={d.title} onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))} /> : <div id="rq-gt" className="rq-ro rq-titlein">{item.title}</div>}
        </div>
        <div className="field">
          <label htmlFor="rq-ga">{epic ? 'What it is for' : 'What it covers'}</label>
          {editable ? <textarea id="rq-ga" className="textarea rq-storyin" value={d.about} onChange={(e) => setD((x) => ({ ...x, about: e.target.value }))} /> : <div id="rq-ga" className="rq-ro">{about || <span className="note">Nothing written yet.</span>}</div>}
        </div>
        <div className="rq-stats">
          <span>{sizeWords(item)}</span>
          {v.status === 'approved' && stories.length > 0 && (
            <span>
              <Bar {...m} /> {m.done} of {m.of} merged
            </span>
          )}
        </div>
        {editable && f.level === 'feature' && <MoveTo v={v} f={f} />}
        {item.ref && (
          <div className="rq-fromline">
            From the BRD:{' '}
            <button className="rq-link" onClick={() => onOpenRef(item.ref!)}>
              {refWords(item.ref)}
            </button>
          </div>
        )}
        {decided.length > 0 && (
          <div className="rq-dbox">
            <div className="rq-lab">Decided for you</div>
            {decided.map((x) => (
              <DecidedEntry key={`${x.ticket ?? ''}${x.id}`} v={v} d={x} compact onOpenTicket={onOpenTicket} />
            ))}
          </div>
        )}
        {canEdit(v) && (
          <div className="rq-hereadds">
            {epic && (
              <button className="rq-link" onClick={() => onAdd('feature', item.key)}>
                + Add a feature here
              </button>
            )}
            <button className="rq-link" onClick={() => onAdd('story', epic ? ((item as BreakdownEpic).features[0]?.key ?? item.key) : item.key)}>
              + Add a story here
            </button>
          </div>
        )}
        <Cmd text={`squad requirements edit ${v.id} ${item.key} --title ${shellQuote(d.title)}`} />
      </div>
      {editable && (
        <div className="rq-pf">
          {removing ? (
            <>
              <span className="rq-sure">
                {started.length ? `${item.key} has stories that started, so it stays. Move them out first.` : `Remove ${item.key} and the ${stories.length} ${stories.length === 1 ? 'story' : 'stories'} under it?`}
              </span>
              {!started.length && (
                <button className="btn danger" onClick={() => act.mutate({ path: `${base(v.id)}/items/${item.key}`, method: 'DELETE', done: `Removed ${item.key}.` }, { onSuccess: () => onSelect(undefined) })}>
                  <Trash2 size={13} /> Remove
                </button>
              )}
              <button className="btn" onClick={() => setRemoving(false)}>
                {started.length ? 'OK' : 'Keep it'}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => onAsk(item.key)} title={`squad requirements redo ${v.id} ${item.key} "<what to change>"`}>
                Ask the Analyst to redo this
              </button>
              {dirty ? (
                <button className="btn quiet" onClick={reset}>
                  Undo
                </button>
              ) : (
                <button className="btn quiet" onClick={() => setRemoving(true)} title={`squad requirements remove ${v.id} ${item.key}`}>
                  Remove
                </button>
              )}
              <span className="grow" />
              <button className="btn pri" disabled={!dirty || !d.title.trim() || act.isPending} onClick={save}>
                Save
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/* ── Decided for you ────────────────────────────────────── */

/**
 * One small choice the squad made, with Change: on the breakdown before its story starts, on the ticket after. Once
 * changed it says what it became: a small change on its ticket, or a new ticket linked to it, one click away.
 */
export function DecidedEntry({ v, d, compact, onSelect, onOpenTicket }: { v: BreakdownView; d: Decided; compact?: boolean; onSelect?(key: string): void; onOpenTicket?(id: string): void }) {
  const act = useReqAct();
  const { toast } = usePrefs();
  const [text, setText] = useDraft(d.ticket ?? v.id, `decided-${d.id}`, '');
  const [editing, setEditing] = useState(Boolean(text));
  const path = d.ticket ? `/api/v1/tickets/${encodeURIComponent(d.ticket)}/decided/${d.id}` : `${base(v.id)}/decided/${d.id}`;
  const command = d.ticket ? `squad decided ${d.ticket} ${d.id} ${shellQuote(text.trim() || '<text>')}` : `squad requirements decided ${v.id} ${d.id} ${shellQuote(text.trim() || '<text>')}`;
  const change = () =>
    act.mutate(
      { path, body: { text: text.trim() }, ...(d.ticket ? {} : { done: `Changed. The Analyst redoes ${d.item ?? 'the breakdown'} with it.` }) },
      {
        onSuccess: (r) => {
          setEditing(false);
          setText('');
          // On a ticket the reply is the ticket: its entry says what the change became.
          if (d.ticket) toast(changedWords(d.ticket, (r as Ticket | undefined)?.decided?.find((x) => x.id === d.id)?.changed?.ticket));
        },
      },
    );
  const became = d.changed?.ticket;
  const opens = became ? (/^c\d+$/.test(became) ? d.ticket : became) : undefined;
  return (
    <div className={`rq-dec ${compact ? 'compact' : ''}`}>
      {!compact && (
        <div className="rq-dw">
          {onSelect && d.item ? (
            <button className="rq-link mono" onClick={() => onSelect(d.item!)}>
              {decidedWho(d)}
            </button>
          ) : (
            decidedWho(d)
          )}
        </div>
      )}
      {d.changed ? (
        <div className="rq-dt">
          {d.changed.text}
          <span className="rq-was">
            Was: {d.text}
            {became && (
              <>
                {' · '}
                {opens && onOpenTicket ? (
                  <button className="rq-link rq-now" onClick={() => onOpenTicket(opens)} title={`Open ${opens}`}>
                    {/^c\d+$/.test(became) ? `now change ${became} on ${d.ticket}` : `now ${became}`}
                  </button>
                ) : /^c\d+$/.test(became) ? (
                  `now change ${became} on ${d.ticket}`
                ) : (
                  `now ${became}`
                )}
              </>
            )}
          </span>
        </div>
      ) : (
        <div className="rq-dt">
          {d.text}
          {compact && d.by === 'answer' && <span className="rq-was">From your answer</span>}
        </div>
      )}
      {editing ? (
        <div className="rq-dedit">
          <textarea className="textarea" autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="What you want instead" placeholder="What should it be instead?" />
          <div className="rq-dedit-b">
            <button className="btn sm pri" disabled={!text.trim() || act.isPending} onClick={change}>
              Save change
            </button>
            <button className="btn sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <Cmd text={command} />
          </div>
        </div>
      ) : (
        !d.changed &&
        v.mine && (
          <button className="rq-link" onClick={() => setEditing(true)} aria-label={`Change: ${d.text}`}>
            Change
          </button>
        )
      )}
    </div>
  );
}

/** The Decided for you list beside the tree: who decided what, and Change. */
export function DecidedPanel({ v, onSelect, onOpenTicket, onClose }: { v: BreakdownView; onSelect(key: string): void; onOpenTicket?(id: string): void; onClose?(): void }) {
  const [all, setAll] = useState(false);
  const list = v.decided;
  const shown = all ? list : list.slice(0, 5);
  const building = v.status === 'approved' && v.progress.some((p) => p.ticket);
  return (
    <aside className="rq-panel rq-decided" aria-label="Decided for you">
      <div className="rq-pbody">
        <div className="rq-dtop">
          <h2 className="rq-dhead">
            Decided for you <span>{list.length}</span>
          </h2>
          {onClose && (
            <button className="iconbtn rq-dclose" aria-label="Close" onClick={onClose}>
              <X size={15} />
            </button>
          )}
        </div>
        <p className="rq-dlead">
          Small choices the squad made where the BRD says nothing. Change one and {building ? 'it becomes a small change ticket' : 'the Analyst redoes the part it is about'}.
        </p>
        {shown.map((d) => (
          <DecidedEntry key={`${d.ticket ?? ''}${d.id}`} v={v} d={d} onSelect={onSelect} onOpenTicket={onOpenTicket} />
        ))}
        {!list.length && <p className="note">Nothing yet. When the squad decides a small thing itself, it shows here.</p>}
        {list.length > 5 && (
          <button className="rq-link rq-showall" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${list.length}`}
          </button>
        )}
      </div>
    </aside>
  );
}
