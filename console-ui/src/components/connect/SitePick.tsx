import type { ConnectionRow } from '../../api/contribution-types';
import { CONNECT } from '../../lib/connect-words';
import { useAct } from '../../lib/data';
import type { Lang } from '../../lib/first-story';
import { Cmd } from '../ui';

/**
 * The sign-in reaches several places (the Jira sites Atlassian gave, the Azure DevOps projects a Microsoft account
 * reaches) and this project has none of its own yet: a small list on the same row, one button each, the only one in the
 * list as the main button. The same as `squad connect <tool> --site <site>`.
 */
export function SitePick({ row, lang }: { row: ConnectionRow; lang: Lang }) {
  const act = useAct<{ line: string }>();
  return (
    <>
      <ul className="gh-pick">
        {(row.pick ?? []).map((p, _i, all) => (
          <li key={p.site}>
            <div>
              <b dir="auto">{p.name}</b>
              <small dir="auto">{p.where ?? p.site}</small>
            </div>
            <button
              className={all.length === 1 ? 'btn sm pri' : 'btn sm'}
              disabled={act.isPending}
              onClick={() => act.mutate({ path: `/api/v1/connections/${encodeURIComponent(row.name)}/site`, body: { site: p.site }, done: (r) => r.line })}
            >
              {CONNECT[lang].use}
            </button>
          </li>
        ))}
      </ul>
      <div className="gh-row">
        <Cmd text={`squad connect ${row.name} --site <site>`} />
      </div>
    </>
  );
}
