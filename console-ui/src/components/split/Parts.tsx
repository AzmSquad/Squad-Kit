import type { SplitSuggestion } from '../../api/types';
import { areasTotal, partMeta, type Words } from '../../lib/split';
import { Written } from '../ui';
import '../../styles/split.css';

/**
 * The Analyst's suggestion, as every card shows it: the parts in the order to build them, each with its size in words
 * and what it needs, or for a whole requirements document its areas with a rough count. `ids`: after Split, each part's
 * story in place of its number.
 */
export function PartsList({ s, w, ids }: { s: SplitSuggestion; w: Words; ids?: string[] }) {
  return (
    <ol className="parts">
      {s.parts.map((p, i) => {
        const m = partMeta(p, w);
        const id = ids?.[i];
        return (
          <li key={i} className="part" style={{ ['--i' as string]: i }}>
            <span className={`num ${id ? 'sid' : ''}`}>{id ?? i + 1}</span>
            <div className="pt">
              <Written as="b" text={p.title} />
              {p.line && <Written as="small" text={p.line} />}
            </div>
            <div className="meta">
              <span className="size">{m.size}</span>
              {m.needs && <span className="needs">{m.needs}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** "About 25 stories in 6 parts", the areas, why Requirements is the better way, and the three plainest facts squad-kit counted. */
export function AreasList({ s, w }: { s: SplitSuggestion; w: Words }) {
  const { total, parts } = areasTotal(s);
  return (
    <div className="brd">
      {parts > 0 && (
        <>
          <p>{w.brd.lead(total, parts)}</p>
          <div className="areas">
            {s.areas!.map((a, i) => (
              <span key={i} className="area" style={{ ['--i' as string]: i }}>
                <bdi>{a.name}</bdi>
                <small>
                  {a.stories} {w.brd.unit(a.stories)}
                </small>
              </span>
            ))}
          </div>
        </>
      )}
      <p>{w.brd.why}</p>
      <p className="also">{w.brd.also}</p>
      {s.found.length > 0 && <p className="found">{w.found(s.found.slice(0, 3))}</p>}
    </div>
  );
}
