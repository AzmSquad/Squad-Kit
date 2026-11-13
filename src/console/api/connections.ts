import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths } from '../../board/store.js';
import { cancelSignIn, connectionsOf, disconnect, signInNow, startSignIn } from '../../engine/connections.js';
import type { SignInFlow } from '../../modules/connection/types.js';
import { act } from './app.js';

/** The board never gets the tool's process id: Cancel names the sign-in, and the engine stops the process it started. */
const plain = ({ pid: _pid, ...f }: SignInFlow) => f;

/**
 * The Connections page (engine/connections.ts): the rows, and one POST per button, each the same as a terminal command.
 * Sign in gives the tool's one-time code at once; the board then follows the sign-in until the person approves it on the
 * tool's page, or presses Cancel.
 */
export function mountConnectionsApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);

  // `squad connect --status`. `?again=1` is Check again: each tool is asked afresh.
  app.get('/api/v1/connections', (c) =>
    act(c, async () => {
      const { rows } = await connectionsOf(bp, { again: c.req.query('again') === '1' });
      return { rows: rows.map((r) => (r.flow ? { ...r, flow: plain(r.flow) } : r)) };
    }),
  );

  // `squad connect github`: starts the tool's own sign-in, and answers with its one-time code and page.
  app.post('/api/v1/connections/:name/sign-in', (c) => act(c, async () => plain(await startSignIn(bp, c.req.param('name')))));

  // Where the sign-in stands, while the code waits on the tool's page.
  // `none`: no sign-in was started, or squad-kit restarted since: the board offers Try again.
  app.get('/api/v1/connections/:name/sign-in', (c) =>
    act(c, () => {
      const f = signInNow(c.req.param('name'));
      return f ? plain(f) : { state: 'none' };
    }),
  );

  // Cancel: stops the tool's sign-in process this board started. In the terminal, Ctrl-C stops `squad connect`.
  app.post('/api/v1/connections/:name/sign-in/cancel', (c) => act(c, () => plain(cancelSignIn(c.req.param('name')))));

  // `squad disconnect github`: signs the tool out on this computer, for every app that uses it.
  app.post('/api/v1/connections/:name/disconnect', (c) => act(c, () => disconnect(bp, c.req.param('name'))));
}
