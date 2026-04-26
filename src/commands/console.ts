import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import open from 'open';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { startConsoleServer, type ConsoleServer } from '../console/server.js';

export interface ConsoleOptions {
  port?: number;
  /** Commander negates `--no-open` to `open: false`. */
  open?: boolean;
  token?: string;
}

const DEFAULT_PORT = 4571;

export async function runConsole(opts: ConsoleOptions): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  // loadConfig also validates the YAML — surface schema problems before binding a port.
  loadConfig(paths.configFile);

  const portOpt = opts.port;
  const requestedPort =
    portOpt !== undefined && !Number.isNaN(portOpt) && portOpt >= 0 ? portOpt : DEFAULT_PORT;
  const token = opts.token ?? randomBytes(32).toString('hex');

  const server: ConsoleServer = await startConsoleServer({ paths, requestedPort, token });

  const url = `http://127.0.0.1:${server.port}/?t=${token}`;

  ui.banner();
  ui.divider('squad console');
  ui.summaryBox(' squad console ', [
    { key: 'project', value: resolve(paths.root) },
    { key: 'url', value: url },
    { key: 'token', value: `${token.slice(0, 8)}…` },
    { key: 'port', value: String(server.port) },
  ]);
  if (server.port !== requestedPort) {
    ui.warning(`port ${requestedPort} was busy — bound to ${server.port} instead`);
  }
  ui.blank();
  ui.step('Next:');
  ui.info('1) Pick a story in the Stories tab.');
  ui.info('2) Click "Generate plan" to start a planning run live.');
  ui.info("3) Press Ctrl-C in this terminal to stop the server when you're done.");

  if (opts.open !== false) {
    try {
      await open(url);
    } catch {
      ui.warning('Could not open a browser automatically. Copy the URL above into your browser.');
    }
  } else {
    ui.info('Browser auto-open disabled (--no-open). Copy the URL above into your browser.');
  }

  // Block until SIGINT/SIGTERM. The server attaches its own listeners that resolve `done`.
  await server.done;
  ui.info('console stopped');
}
