import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export function TokenSparkline({
  runs,
}: {
  runs: { inputTokens: number; outputTokens: number }[];
}) {
  const recent = runs.slice(0, 20).reverse();
  const data = recent.map((r, idx) => ({
    n: idx + 1,
    tokens: r.inputTokens + r.outputTokens,
  }));

  if (data.length === 0) return null;

  return (
    <div className="h-[140px] w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis dataKey="n" hide stroke="var(--gray-5)" />
          <YAxis hide domain={['auto', 'auto']} stroke="var(--gray-5)" />
          <Tooltip
            contentStyle={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border-strong)',
              borderRadius: '8px',
            }}
            labelFormatter={(n) => `Run ${n}`}
            formatter={(v: number) => [`${v.toLocaleString()} tokens`, 'Total']}
          />
          <Line
            type="monotone"
            dataKey="tokens"
            stroke="var(--color-text)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: 'var(--color-text)' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
