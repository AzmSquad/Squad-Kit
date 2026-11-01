import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AgentName, BoardUsage, ModelLevel, RoleUsage, Ticket, UsageLine, UsageTotal } from '../api/types';
import { Glyph, ROLE_NAME } from './ui';

/**
 * The cost on the board: what each role used, at which model level, as its AI tool reported it. Shown as what it
 * would cost at the AI company's API prices; people's own subscriptions pay for it, so this shows where the cost goes.
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

const AT_API_PRICES = "What it would cost at the AI company's API prices. Your own AI subscription pays for it; this shows where the cost goes.";

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

/** A ticket's cost: the total, then each role. */
export function TicketUsage({ t }: { t: Ticket }) {
  const lines = t.usage ?? [];
  const total = totalOf(lines);
  return (
    <>
      <div className="lbl">
        What it used{lines.length > 0 && <span className="pill">{money(total) ? `${money(total)} at API prices` : 'Cost not reported'}</span>}
      </div>
      {lines.length ? (
        <>
          <UsageTable roles={byRole(lines)} total={total} steps />
          <p className="note" style={{ marginTop: 8 }}>{AT_API_PRICES} Each role's model level can be changed on the Squad page.</p>
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
  if (!t?.runs) return null;
  return (
    <span title={AT_API_PRICES}>
      Used <b>{money(t) ?? 'an unknown amount'}</b> at API prices
    </span>
  );
}

/** Each role across the whole board, and the project's own work, for the Squad page. */
export function SquadUsage() {
  const u = useBoardUsage().data;
  if (!u?.total.runs) return null;
  return (
    <>
      <h2 style={{ marginTop: 30 }}>What the squad used</h2>
      <p className="note" style={{ marginTop: 2 }}>
        Every ticket on this computer ({u.tickets} so far) and the project's own work, like reading the project and filling in new tickets
        {u.project.runs ? ` (${money(u.project) ?? 'cost not reported'})` : ''}. {AT_API_PRICES} Change a role's model level with its Edit button above.
      </p>
      <div style={{ marginTop: 10 }}>
        <UsageTable roles={u.roles} total={u.total} />
      </div>
    </>
  );
}
