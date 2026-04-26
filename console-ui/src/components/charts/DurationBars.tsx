import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export function DurationBars({ runs }: { runs: { durationMs: number }[] }) {
  const recent = runs.slice(0, 20).reverse();
  const data = recent.map((r, idx) => ({
    n: idx + 1,
    sec: Math.round((r.durationMs / 1000) * 10) / 10,
  }));

  if (data.length === 0) return null;

  return (
    <div className="h-[140px] w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis dataKey="n" hide stroke="var(--gray-5)" />
          <YAxis hide domain={[0, 'auto']} stroke="var(--gray-5)" />
          <Tooltip
            contentStyle={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border-strong)',
              borderRadius: '8px',
            }}
            labelFormatter={(n) => `Run ${n}`}
            formatter={(v: number) => [`${v}s`, 'Duration']}
          />
          <Bar dataKey="sec" radius={[4, 4, 0, 0]} maxBarSize={28}>
            {data.map((_, index) => (
              <Cell
                key={`cell-${index}`}
                fill={index === data.length - 1 ? 'var(--color-ok)' : 'var(--color-text-muted)'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
