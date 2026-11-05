import net from 'node:net';

/**
 * Each test worker has its own ports, below the ones the system hands out. Tests run at once in many workers, and a port
 * that was free a moment ago can be another test's by the time its app starts: then one test's app answers for the other.
 */
const PORTS_PER_WORKER = 400;
const FIRST_PORT = 20_000 + ((Number(process.env.VITEST_POOL_ID ?? 1) - 1) % 30) * PORTS_PER_WORKER;
let next = 0;

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** A port nothing listens on right now, and that no test in another worker will pick. */
export async function freePort(): Promise<number> {
  for (let i = 0; i < PORTS_PER_WORKER; i += 1) {
    const port = FIRST_PORT + next;
    next = (next + 1) % PORTS_PER_WORKER;
    if (await isFree(port)) return port;
  }
  throw new Error('This test worker has no free port left');
}

/** The start command and address of the smallest web app: it answers "ok" on a free port, for squad-kit to start. */
export async function tinyApp(): Promise<{ start: string; url: string; port: number }> {
  const port = await freePort();
  return { start: `node -e "require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')"`, url: `http://127.0.0.1:${port}`, port };
}
