import net from 'node:net';

/** A port nothing listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** The start command and address of the smallest web app: it answers "ok" on a free port, for squad-kit to start. */
export async function tinyApp(): Promise<{ start: string; url: string; port: number }> {
  const port = await freePort();
  return { start: `node -e "require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')"`, url: `http://127.0.0.1:${port}`, port };
}
