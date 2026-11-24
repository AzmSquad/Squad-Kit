import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import type { OverviewView } from '../api/onboard-types';
import { Cmd, STAGE_NAME, Written } from './ui';
import { langProps } from '../lib/lang';

/** How many stories the card lists. The rest are on the board. */
const SHOWN = 6;

/**
 * The Overview of a project with no code yet, once its work started from stories (pulled from the tracker or written
 * by hand): the stories on the board and where each one is, in place of the ticket ideas. Its real state until there is
 * code to read. Terminal: `squad overview`.
 */
export function OverviewStories({ stories, onWrite }: { stories: NonNullable<OverviewView['stories']>; onWrite(): void }) {
  const n = stories.open.length;
  const more = n - SHOWN;
  return (
    <section className="ob-c" aria-label="Your stories">
      <h3>Your stories</h3>
      <p className="note">
        {n === 1 ? 'One story is on the board' : `${n} stories are on the board`}
        {stories.from ? `, from ${stories.from}` : ''}.{n > 1 ? ' The others wait for the first one: it makes the first code.' : ''}
      </p>
      <ul className="ob-ideas">
        {stories.open.slice(0, SHOWN).map((t) => (
          <li key={t.id}>
            <span {...langProps(t.title)}>
              <Written as="b" text={t.title} />
              <small>{STAGE_NAME[t.stage]}</small>
            </span>
            <Link to="/board" search={{ ticket: t.id }} className="btn sm">
              {t.id}
            </Link>
          </li>
        ))}
      </ul>
      <p className="note">
        {more > 0 ? `And ${more} more on the board. ` : ''}
        <button className="ob-link" onClick={onWrite}>
          Write a new ticket.
        </button>
      </p>
      <Cmd text={'squad new "…"'} />
      <Link to="/board" className="btn sm pri">
        Open the board <ArrowRight size={14} />
      </Link>
    </section>
  );
}
