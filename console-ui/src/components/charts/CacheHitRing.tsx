import { Cell, Pie, PieChart } from 'recharts';

export function CacheHitRing({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const data = [
    { name: 'hit', value: pct },
    { name: 'miss', value: 100 - pct },
  ];
  return (
    <div className="relative" style={{ width: 140, height: 140 }}>
      <PieChart width={140} height={140}>
        <Pie
          data={data}
          dataKey="value"
          cx="50%"
          cy="50%"
          innerRadius={48}
          outerRadius={62}
          startAngle={90}
          endAngle={-270}
          stroke="none"
        >
          <Cell fill="var(--color-ok)" />
          <Cell fill="var(--gray-5)" />
        </Pie>
      </PieChart>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[20px] font-semibold tabular text-[var(--color-text)]">{pct}%</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">cache hit</span>
      </div>
    </div>
  );
}
