import { ExternalLink, GitPullRequest } from 'lucide-react';
import type { Ticket } from '../api/types';
import { shellArg } from '../lib/text';
import { Cmd } from './ui';

/**
 * A merged story on squad-kit's own code, whose work goes on by pull request (engine/send-as-pr.ts). It merged on this
 * computer; the person pushes its branch with their own sign-in, then opens the request on the host's page. The push is
 * the step itself, so it shows even with commands turned off.
 */
export function SendAsPr({ s }: { s: NonNullable<Ticket['sendAs']> }) {
  const where = s.into ? `${s.into} on ${s.host}` : s.host ? `your repo on ${s.host}` : 'your code host';
  return (
    <div className="ob-card sendas">
      <span className="ob-ring">
        <GitPullRequest size={16} />
      </span>
      <span className="grow">
        <b>Send it as a pull request</b>
        <span>
          It is merged on this computer, on branch <code>{s.branch}</code>. Push the branch to your copy ({s.remote}), then open the pull request to {where}.
        </span>
        <Cmd text={`cd ${shellArg(s.dir)} && ${s.push}`} keep={s.push} always />
      </span>
      {s.page && (
        <a className="btn pri" href={s.page} target="_blank" rel="noreferrer">
          Open the pull request page <ExternalLink size={14} />
        </a>
      )}
    </div>
  );
}
