import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Check, TriangleAlert, Wallet, X } from 'lucide-react';
import { api } from '../api/client';
import type { AgentName, BoardUsage, ModelLevel, Quality, RoleUsage, Ticket, UsageLine, UsageTotal } from '../api/types';
import type { BudgetState, CostOverview, PaymentInfo, TicketCost } from '../api/tabs';
import { useAct } from '../lib/data';
import { Cmd, Glyph, ROLE_NAME } from './ui';
import { took } from './WhatHappened';
import '../styles/tabs.css';

/**
 * The cost on the board, the way the person pays. On a subscription the work costs nothing extra: the Cost tab shows
 * the size of the work, where it went, and only then its value at the AI company's API prices, as a value and not a
 * bill. On an API key the dollars are real: budgets per ticket and per month, a warning at 80%, and at 100% the ticket
 * waits for the person between two steps. Engineers see the models and tokens under Details.
 */

const STEP_NAME: Record<string, string> = {
  questions: 'Questions',
  spec: 'Spec',
  scan: 'Reading the project',
  design: 'Design',
  blueprint: 'Stack and patterns',
  build: 'Build',
  fix: 'Fixes',
  review: 'Review',
  proof: 'Proof',
  chat: 'Talking it through',
  draft: 'Filling in a new ticket',
};

const ROLES: AgentName[] = ['analyst', 'architect', 'builder', 'reviewer', 'tester'];

/** What the dollars mean, the way the person pays. */
function pricesNote(p: PaymentInfo | undefined): string {
  return p?.payment === 'api-key'
    ? 'What the work cost on your API key, at its prices.'
    : `What the work would cost at API prices. Your ${p?.name ?? 'AI'} plan covers it, so this is a value, not a bill.`;
}

function addTo(t: UsageTotal, l: UsageTotal): void {
  t.runs += l.runs;
  for (const k of ['inputTokens', 'cachedTokens', 'outputTokens', 'costUsd'] as const) if (l[k] !== undefined) t[k] = (t[k] ?? 0) + l[k]!;
  if (l.tokensUnknown) t.tokensUnknown = (t.tokensUnknown ?? 0) + l.tokensUnknown;
  if (l.costUnknown) t.costUnknown = (t.costUnknown ?? 0) + l.costUnknown;
}

function totalOf(lines: UsageLine[]): UsageTotal {
  const t: UsageTotal = { runs: 0 };
  for (const l of lines) addTo(t, l);
  return t;
}

/** Per role, in the squad's order, and per model level inside each role. */
function byRole(lines: UsageLine[]): RoleUsage[] {
  return ROLES.flatMap((role) => {
    const mine = lines.filter((l) => l.role === role);
    if (!mine.length) return [];
    const levels: RoleUsage['levels'] = [];
    for (const l of mine) {
      let row = levels.find((x) => x.level === l.level && x.model === l.model);
      if (!row) levels.push((row = { level: l.level, model: l.model, steps: [], total: { runs: 0 } }));
      if (!row.steps.includes(l.step)) row.steps.push(l.step);
      addTo(row.total, l);
    }
    return [{ role, total: totalOf(mine), levels }];
  });
}

/** "$1.23", "under $0.01", or null when no run reported a cost. */
function money(t: UsageTotal): string | null {
  if (t.costUsd === undefined) return null;
  return t.costUsd < 0.005 ? 'under $0.01' : `$${t.costUsd.toFixed(2)}`;
}

function short(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

const runs = (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`;

function Cost({ t }: { t: UsageTotal }) {
  const m = money(t);
  if (!m) return <span className="note">Not reported</span>;
  return (
    <span title={t.costUnknown ? `${runs(t.costUnknown)} did not report a cost, so the real amount is higher` : undefined}>
      {m}
      {t.costUnknown ? <span className="note"> +{t.costUnknown} not reported</span> : null}
    </span>
  );
}

function Tokens({ t }: { t: UsageTotal }) {
  if (t.inputTokens === undefined && t.outputTokens === undefined) return <span className="note">Not reported</span>;
  const cached = t.cachedTokens ? `, ${short(t.cachedTokens)} of it read again from earlier in the conversation, which costs less` : '';
  return (
    <span title={`Tokens are the pieces of text the AI reads and writes. It read ${short(t.inputTokens ?? 0)}${cached}.`}>
      {t.inputTokens !== undefined && <>{short(t.inputTokens)} read</>}
      {t.inputTokens !== undefined && t.outputTokens !== undefined && ' · '}
      {t.outputTokens !== undefined && <>{short(t.outputTokens)} written</>}
    </span>
  );
}

function Level({ level, model }: { level: ModelLevel; model: string }) {
  return model ? (
    <>
      {model} <span className="note">{level}</span>
    </>
  ) : (
    <>{level}</>
  );
}

/** What each role used, per model level, with the total. With steps, it says what each role did there. */
function UsageTable({ roles, total, steps }: { roles: RoleUsage[]; total: UsageTotal; steps?: boolean }) {
  return (
    <table className="table usage">
      <thead>
        <tr>
          <th>Role</th>
          <th>Model level</th>
          <th>{steps ? 'What it did' : 'Runs'}</th>
          <th>Tokens</th>
          <th className="num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {roles.flatMap((r) =>
          r.levels.map((l, i) => (
            <tr key={`${r.role}-${l.level}-${l.model}`}>
              <td>
                {i === 0 && (
                  <span className="who">
                    <Glyph role={r.role} small /> {ROLE_NAME[r.role]}
                  </span>
                )}
              </td>
              <td>
                <Level level={l.level} model={l.model} />
              </td>
              <td>
                {steps ? (
                  <>
                    {l.steps.map((s) => STEP_NAME[s] ?? s).join(', ')}
                    <span className="note"> · {runs(l.total.runs)}</span>
                  </>
                ) : (
                  l.total.runs
                )}
              </td>
              <td>
                <Tokens t={l.total} />
              </td>
              <td className="num">
                <Cost t={l.total} />
              </td>
            </tr>
          )),
        )}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td />
          <td>{steps ? <span className="note">{runs(total.runs)}</span> : total.runs}</td>
          <td>
            <Tokens t={total} />
          </td>
          <td className="num">
            <Cost t={total} />
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/** The payment and the month, the budgets and the averages per Quality setting: one poll for every screen. */
export function useCost() {
  return useQuery({ queryKey: ['cost'], queryFn: () => api<CostOverview>('/api/v1/cost'), refetchInterval: 10_000 });
}

/** A ticket's cost in short, for its Now tab once it is accepted: the total, then each role. */
export function TicketUsage({ t }: { t: Ticket }) {
  const pay = useCost().data?.payment;
  const lines = t.usage ?? [];
  const total = totalOf(lines);
  const m = money(total);
  return (
    <>
      <div className="lbl">
        What it used
        {lines.length > 0 && <span className="pill">{!m ? 'Cost not reported' : pay?.payment === 'api-key' ? `${m} on your API key` : `Included in your plan · ${m} value`}</span>}
      </div>
      {lines.length ? (
        <>
          <UsageTable roles={byRole(lines)} total={total} steps />
          <p className="note" style={{ marginTop: 8 }}>{pricesNote(pay)} Each role's model level can be changed on the Squad page.</p>
        </>
      ) : (
        <p className="note">Nothing yet. Each run of a role is counted here as the squad works.</p>
      )}
    </>
  );
}

function useBoardUsage() {
  return useQuery({ queryKey: ['usage'], queryFn: () => api<BoardUsage>('/api/v1/usage'), refetchInterval: 5000 });
}

/** The board's total, for its footer. Nothing until the squad has run. */
export function BoardCost() {
  const t = useBoardUsage().data?.total;
  const pay = useCost().data?.payment;
  if (!t?.runs) return null;
  return (
    <span title={pricesNote(pay)}>
      {pay?.payment === 'api-key' ? (
        <>
          Used <b>{money(t) ?? 'an unknown amount'}</b> on your API key
        </>
      ) : (
        <>
          <b>{money(t) ?? 'An unknown amount'}</b> of AI work, included in your plan
        </>
      )}
    </span>
  );
}

/** Each role across the whole board, and the project's own work, for the Squad page. */
export function SquadUsage() {
  const u = useBoardUsage().data;
  const pay = useCost().data?.payment;
  if (!u?.total.runs) return null;
  return (
    <>
      <h2 style={{ marginTop: 30 }}>What the squad used</h2>
      <p className="note" style={{ marginTop: 2 }}>
        Every ticket on this computer ({u.tickets} so far) and the project's own work, like reading the project and filling in new tickets
        {u.project.runs ? ` (${money(u.project) ?? 'cost not reported'})` : ''}
        {u.deleted?.tickets ? `, and ${u.deleted.tickets} deleted ${u.deleted.tickets === 1 ? 'ticket' : 'tickets'} (${money(u.deleted.total) ?? 'cost not reported'})` : ''}. {pricesNote(pay)} Change a role's
        model level with its Edit button above.
      </p>
      <div style={{ marginTop: 10 }}>
        <UsageTable roles={u.roles} total={u.total} />
      </div>
    </>
  );
}

/* ── The Cost tab ──────────────────────────────────────── */

const usd = (n: number) => (n < 0.005 ? 'under $0.01' : `$${n.toFixed(2)}`);
const pct = (share: number) => (share > 0 && share < 0.01 ? 'under 1%' : `${Math.round(share * 100)}%`);

/** The Cost tab: the way the person pays first, then the size of the work, where it went, the money or its value. */
export function CostTab({ t }: { t: Ticket }) {
  const q = useQuery({ queryKey: ['cost', t.id], queryFn: () => api<TicketCost>(`/api/v1/tickets/${t.id}/cost`), refetchInterval: t.live ? 5000 : 20_000 });
  const c = q.data;
  if (!c) return <p className="note">{q.isError ? 'Could not read the cost. It tries again by itself.' : 'Loading…'}</p>;
  if (!c.total.runs) {
    return (
      <div className="costs">
        <PaidCard c={c} />
        <p className="note">Nothing used yet. Each step the squad takes is counted here.</p>
      </div>
    );
  }
  return (
    <div className="costs">
      <PaidCard c={c} />
      <section className="costcard">
        <h3>Size of the work</h3>
        {c.size ? (
          <>
            <div className="sizes" role="img" aria-label={`Size: ${c.size.size}`}>
              {(['small', 'medium', 'large'] as const).map((s) => (
                <span key={s} className={s === c.size!.size ? 'on' : ''}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </span>
              ))}
            </div>
            <p>
              {c.size.words} {c.why}
            </p>
          </>
        ) : (
          <p>
            This is one of the first tickets in {c.project}, so there is no usual size to compare with yet. It shows once two tickets are accepted.
            {c.why ? ` ${c.why}` : ''}
          </p>
        )}
        {c.seconds !== undefined && <p className="note">The squad worked on it for {took(c.seconds)}, not counting the time it waited for you.</p>}
      </section>
      {c.where.parts.length > 0 && (
        <section className="costcard">
          <h3>Where the work went</h3>
          <div className="wbars">
            {c.where.parts.map((p) => (
              <div className="wbar" key={p.name}>
                <span>{p.name}</span>
                <span className="wbarline">
                  <i style={{ width: `${Math.max(2, Math.round(p.share * 100))}%` }} />
                  <small>
                    {pct(p.share)}
                    {c.payment.payment === 'api-key' && p.costUsd !== undefined ? ` · ${usd(p.costUsd)}` : ''}
                  </small>
                </span>
              </div>
            ))}
          </div>
          <p className="note">
            {c.where.by === 'tokens' ? 'By the amount of text the AI read and wrote, because some steps did not report a cost. ' : ''}
            Thinking steps use the strongest model on purpose: a mistake there costs the most to fix later.
          </p>
        </section>
      )}
      {c.payment.payment === 'subscription' ? (
        <section className="costcard">
          <h3>Value of the AI work</h3>
          <p>
            {c.total.costUsd !== undefined ? (
              <>
                <b className="bigusd">{usd(c.total.costUsd)}</b> at API prices, covered by your plan.
              </>
            ) : (
              'The AI tool did not report what this work is worth.'
            )}{' '}
            This month the squad did <b>{usd(c.month.total.costUsd ?? 0)}</b> of AI work for {c.project}.
          </p>
          <p className="note">This is a value, not a bill: what the same work would cost if you paid per use.{c.total.costUnknown ? ` ${c.total.costUnknown} of its steps did not report one.` : ''}</p>
        </section>
      ) : null}
      {c.tip && (
        <section className="costcard tip">
          <h3>Small change next time?</h3>
          <p>
            {c.tip}
            {c.payment.payment === 'subscription' ? " If your plan's usage limit is reached, squad-kit pauses and carries on by itself when it resets." : ''}
          </p>
        </section>
      )}
      <details className="costdetails">
        <summary>Details for engineers</summary>
        <p className="note">
          {c.details.models}
          {c.details.tokens ? `. ${c.details.tokens}.` : '.'}
        </p>
        <UsageTable roles={byRole(t.usage ?? [])} total={totalOf(t.usage ?? [])} steps />
        <div style={{ marginTop: 8 }}>
          <Cmd text={`squad cost ${t.id}`} />
        </div>
      </details>
    </div>
  );
}

/** The first card: how the person pays, and on an API key the money against the budgets. */
function PaidCard({ c }: { c: TicketCost }) {
  if (c.payment.payment === 'subscription') {
    return (
      <section className="costcard paid">
        <div className="paidhead">
          <span className="paidic">
            <Check size={15} strokeWidth={2.6} />
          </span>
          <b>Included in your {c.payment.name} plan. No extra charge.</b>
        </div>
        <p className="muted">
          You pay for {c.payment.name} with a subscription, so this ticket cost you nothing extra.{' '}
          {c.payment.from === 'guess' && 'squad-kit could not tell how you pay, so it shows it this way. '}
          <Link to="/settings">Pay with an API key instead?</Link>
        </p>
      </section>
    );
  }
  const b = c.budget;
  return (
    <section className={`costcard ${b?.over.length ? 'over' : b?.warn.length ? 'warn' : ''}`}>
      <div className="paidhead">
        <span className="paidic money">
          <Wallet size={15} />
        </span>
        <b>
          {!c.total.runs ? '$0.00' : c.total.costUsd !== undefined ? usd(c.total.costUsd) : 'Not reported'} on your API key
          {c.total.costUnknown ? <span className="note"> + {c.total.costUnknown} steps not reported</span> : null}
        </b>
      </div>
      <p className="muted">
        Real money: each step is paid per use{c.payment.found?.kind === 'api-key' ? `, on your ${c.payment.found.label}` : ''}. <Link to="/settings">Pay with a subscription instead?</Link>
      </p>
      {b && <BudgetBars b={b} project={c.project} />}
    </section>
  );
}

function Meter({ share }: { share: number }) {
  return (
    <span className={`meter ${share >= 1 ? 'over' : share >= 0.8 ? 'warn' : ''}`} role="img" aria-label={pct(share)}>
      <i style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
    </span>
  );
}

function BudgetBars({ b, project }: { b: BudgetState; project: string }) {
  if (!b.ticketUsd && !b.monthUsd) {
    return (
      <p className="note">
        This month: {usd(b.monthSpent)} for {project}. No budget yet: <Link to="/settings">set one per ticket and per month</Link>, and squad-kit warns you at 80%.
      </p>
    );
  }
  return (
    <div className="budgets">
      {b.ticketUsd && b.ticketShare !== undefined && (
        <div className="budgetrow">
          <span>
            {pct(b.ticketShare)} of this ticket's {usd(b.ticketUsd)} budget
          </span>
          <Meter share={b.ticketShare} />
        </div>
      )}
      {b.monthUsd && b.monthShare !== undefined && (
        <div className="budgetrow">
          <span>
            This month: {usd(b.monthSpent)} of your {usd(b.monthUsd)} for {project}
          </span>
          <Meter share={b.monthShare} />
        </div>
      )}
      {[...b.over, ...b.warn].map((k) => (
        <p key={k} className="budgetsay">
          <TriangleAlert size={14} />
          {b.over.includes(k)
            ? k === 'ticket'
              ? 'Over its budget. Before its next step the ticket waits for you: carry on, do the rest yourself, or make the plan smaller. No step is cut in half.'
              : "Over this month's budget. Each ticket waits for you before its next step. No step is cut in half."
            : k === 'ticket'
              ? 'At 80% of its budget. At 100% the ticket waits for you before its next step.'
              : "At 80% of this month's budget. At 100% tickets wait for you before their next step."}
        </p>
      ))}
    </div>
  );
}

/* ── Waiting for you style notice ──────────────────────── */

/** On an API key: tickets at 80% of their budget and the month at 80%, on every project page. Hide keeps it away until it grows. */
export function BudgetBanner() {
  const o = useCost().data;
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('squad-budget-hidden') ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem('squad-budget-hidden', JSON.stringify(hidden));
    } catch {
      // Private windows: hidden only until the page reloads.
    }
  }, [hidden]);
  if (!o || o.payment.payment !== 'api-key') return null;
  // A notice comes back once it moves on, from 80% to over.
  const key = (w: CostOverview['warnings'][number]) => `${w.kind}:${w.id ?? o.month.month}:${w.over ? 'over' : 'warn'}`;
  const shown = o.warnings.filter((w) => !hidden.includes(key(w)));
  if (!shown.length) return null;
  const first = shown[0]!;
  const words = (w: typeof first) =>
    w.kind === 'month'
      ? `This month the squad used ${pct(w.share)} of your ${usd(w.limit)} budget for ${o.project}${w.over ? '. Tickets wait for you before their next step' : ''}`
      : `${w.id} ${w.title} used ${pct(w.share)} of its ${usd(w.limit)} budget${w.over ? '. It waits for you before its next step' : ''}`;
  return (
    <section className="upd failed budgetbar" role="status" aria-label="Budget">
      <span className="upd-ic">
        <Wallet size={16} />
      </span>
      <div className="upd-main">
        <b className="upd-title">{words(first)}</b>
        <span className="upd-sub">
          {shown.length > 1 ? `And ${shown.length - 1} more near a budget. ` : ''}At 100% a ticket waits for you between two steps, never in the middle of one.
        </span>
      </div>
      <div className="upd-acts">
        {first.id && (
          <Link to="/board" search={{ ticket: first.id }} className="btn sm">
            Open {first.id}
          </Link>
        )}
        <Link to="/settings" className="btn sm">
          Budgets
        </Link>
        <button className="iconbtn" aria-label="Hide this notice" onClick={() => setHidden([...hidden, ...shown.map(key)])}>
          <X size={14} />
        </button>
      </div>
    </section>
  );
}

/* ── Settings ──────────────────────────────────────────── */

/** How the person pays for the AI, and on an API key the budgets. */
export function PaymentSettings() {
  const o = useCost().data;
  const act = useAct();
  const [ticket, setTicket] = useState('');
  const [month, setMonth] = useState('');
  const budget = o?.budget;
  useEffect(() => {
    setTicket(budget?.ticketUsd ? String(budget.ticketUsd) : '');
    setMonth(budget?.monthUsd ? String(budget.monthUsd) : '');
  }, [budget?.ticketUsd, budget?.monthUsd]);
  if (!o) return null;
  const p = o.payment;
  const pick = (payment: 'subscription' | 'api-key' | 'auto', done: string) => act.mutate({ path: '/api/v1/cost/payment', method: 'PUT', body: { payment }, done });
  const found = p.found ? `${p.tool} is signed in with ${p.found.label}${p.found.kind === 'subscription' ? ', a subscription' : ', paid per use'}.` : `squad-kit could not tell how ${p.tool} is paid.`;
  return (
    <div style={{ margin: '22px 0 26px' }}>
      <h2>How you pay for the AI</h2>
      <p className="note" style={{ margin: '2px 0 10px' }}>
        {found} {p.from === 'you' ? 'You chose below, and your choice wins.' : 'Change it below if that is not right.'} It decides what the Cost tab shows.
      </p>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>You pay with</b>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className={`btn sm ${p.payment === 'subscription' && p.from === 'you' ? 'pri' : ''}`} aria-pressed={p.payment === 'subscription' && p.from === 'you'} onClick={() => pick('subscription', 'A subscription: the Cost tab shows the value of the work, with no extra charge')}>
            A subscription
          </button>
          <button className={`btn sm ${p.payment === 'api-key' && p.from === 'you' ? 'pri' : ''}`} aria-pressed={p.payment === 'api-key' && p.from === 'you'} onClick={() => pick('api-key', 'An API key: the Cost tab shows real dollars and budgets')}>
            An API key
          </button>
          <button className={`btn sm ${p.from !== 'you' ? 'pri' : ''}`} aria-pressed={p.from !== 'you'} onClick={() => pick('auto', 'squad-kit finds out how you pay')}>
            Find out for me
          </button>
          <span className="grow" />
          <Cmd text={`squad config set payment ${p.from === 'you' ? p.payment : 'auto'}`} />
        </span>
      </div>
      {p.payment === 'api-key' && (
        <>
          <div className="maprow" style={{ alignItems: 'center' }}>
            <b>Budget per ticket</b>
            <span className="moneyin">
              $<input className="input" inputMode="decimal" value={ticket} placeholder="No budget" onChange={(e) => setTicket(e.target.value)} aria-label="Budget per ticket, in US dollars" />
            </span>
          </div>
          <div className="maprow" style={{ alignItems: 'center' }}>
            <b>Budget per month</b>
            <span className="moneyin">
              $<input className="input" inputMode="decimal" value={month} placeholder="No budget" onChange={(e) => setMonth(e.target.value)} aria-label="Budget per month, in US dollars" />
              <span className="note">for {o.project}, on this computer</span>
            </span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn pri sm"
              disabled={act.isPending}
              onClick={() => act.mutate({ path: '/api/v1/cost/budget', method: 'PUT', body: { ticketUsd: ticket.trim() || null, monthUsd: month.trim() || null }, done: 'Budgets saved' })}
            >
              Save budgets
            </button>
            <span className="note">At 80% the ticket and the board say so. At 100% the ticket waits for you between two steps, never in the middle of one.</span>
            <Cmd text={`squad config set budget --ticket ${ticket.trim() || 'off'} --month ${month.trim() || 'off'}`} />
          </div>
        </>
      )}
    </div>
  );
}

/* ── Squad and AI ──────────────────────────────────────── */

const QUALITY_NAME: Record<Quality, string> = { best: 'Best', balanced: 'Balanced', thrifty: 'Thrifty' };

/** Per Quality setting, on this project: the average cost and time per accepted ticket, once a setting has 3. */
export function QualityMetrics() {
  const o = useCost().data;
  if (!o) return null;
  const any = o.quality.some((q) => q.tickets > 0);
  return (
    <div className="maprow">
      <b style={{ paddingTop: 2 }}>On {o.project}</b>
      <span className="qstats">
        {!any && <span className="note">Each Quality setting's average cost and time per accepted ticket shows here once {o.qualityAfter} tickets are accepted with it.</span>}
        {any &&
          o.quality.map((q) => (
            <span key={q.quality} className="qstat">
              <b>{QUALITY_NAME[q.quality]}</b>
              {q.tickets >= o.qualityAfter ? (
                <span>
                  {q.costUsd !== undefined ? `${usd(q.costUsd)} ${o.payment.payment === 'api-key' ? '' : 'of AI work '}` : ''}
                  {q.seconds !== undefined ? `${q.costUsd !== undefined ? 'and ' : ''}${took(q.seconds)} of squad time ` : ''}
                  per accepted ticket <span className="note">({q.tickets} tickets)</span>
                </span>
              ) : (
                <span className="note">
                  Shows after {o.qualityAfter} accepted tickets ({q.tickets} so far)
                </span>
              )}
            </span>
          ))}
        {any && o.payment.payment === 'subscription' && <span className="note">Values at API prices, covered by your plan.</span>}
      </span>
    </div>
  );
}
