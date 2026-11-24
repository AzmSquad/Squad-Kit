import { Link } from '@tanstack/react-router';
import { Loader2, SkipForward, Wrench } from 'lucide-react';
import { ToolLogo } from './ToolLogo';
import { useAct } from '../lib/data';
import type { ToolBlock } from '../api/types';
import '../styles/tools.css';

/**
 * The one message for a step a missing tool stops: what can't happen, why, and the way out, a link to the tool's line
 * on the Tools page ("/tools#flutter"). Nothing failed: the story goes on by itself once the tool is there. When the
 * person may go around it instead (the checks that build the Android app), the card offers that too, with what it means.
 */
export function ToolBlockCard({ block }: { block: ToolBlock }) {
  const act = useAct();
  const hash = block.link.split('#')[1];
  const many = block.tools.length > 1;
  return (
    <div className="tl-block" role="status">
      {block.checking || !block.tools[0] ? (
        <span className="ring">{block.checking ? <Loader2 size={16} className="spin" /> : <Wrench size={16} />}</span>
      ) : (
        <ToolLogo id={block.tools[0].id} name={block.tools[0].name} size={34} />
      )}
      <div>
        <b>{block.checking ? "Checking this computer's tools" : `Waits for ${many ? 'tools' : 'a tool'} on this computer`}</b>
        <span>
          {block.text} {block.checking ? 'It goes on in a moment.' : `Nothing failed: it goes on by itself once ${many ? "they're" : "it's"} there.`}
        </span>
        {block.steps && (
          <ol className="tl-block-steps">
            {block.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
        {block.skip && <span className="tl-skip-note">{block.skip.label}: {block.skip.note}</span>}
      </div>
      <span className="grow" />
      <span className="tl-block-acts">
        <Link to="/tools" hash={hash} className="btn sm">
          See what's needed
        </Link>
        {block.skip && (
          <button
            className="btn sm"
            title={block.skip.command}
            disabled={act.isPending}
            onClick={() => act.mutate({ path: '/api/v1/tools/android/skip', body: { skip: true }, done: 'Android builds are skipped on this computer. The story goes on in a moment.' })}
          >
            <SkipForward size={14} /> {block.skip.label}
          </button>
        )}
      </span>
    </div>
  );
}
