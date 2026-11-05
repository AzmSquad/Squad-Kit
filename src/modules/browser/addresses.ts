import net from 'node:net';

/**
 * Which addresses squad-kit's browser may load from while it shows the story's app. The app itself, and the internet
 * (fonts, scripts, pictures), yes. Anything else on this computer or a private network, no: the person's other apps,
 * the board itself, a router, a cloud's metadata address. Addresses are read the way the browser reads them, so
 * "2130706433", "0x7f.1" and "[::ffff:7f00:1]" are 127.0.0.1 too. A name that only resolves to such an address
 * through DNS is not looked up here.
 */

/** IPv4 ranges on this computer or a private network, as [network, mask bits]. */
const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
];

function v4Number(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function privateV4(ip: string): boolean {
  const n = v4Number(ip);
  return PRIVATE_V4.some(([net4, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(net4) / 2 ** (32 - bits)));
}

/** The eight 16-bit words of an IPv6 address, or null. An IPv4 tail ("::ffff:1.2.3.4") becomes the last two. */
function v6Words(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4Number(tail[1]!);
    s = `${s.slice(0, -tail[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const a = head ? head.split(':') : [];
  const b = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - a.length - b.length;
  if (fill < 0) return null;
  const words = [...a, ...Array<string>(fill).fill('0'), ...b].map((w) => parseInt(w || '0', 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

function privateV6(ip: string): boolean {
  const w = v6Words(ip);
  if (!w) return true;
  const v4 = (hi: number, lo: number) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  // ::, ::1 and an IPv4 address written as IPv6 (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d).
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0 || w[5] === 0xffff)) return w[5] === 0 && w[6] === 0 ? w[7]! <= 1 : privateV4(v4(w[6]!, w[7]!));
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return privateV4(v4(w[6]!, w[7]!));
  // 6to4 carries an IPv4 address in its second and third words.
  if (w[0] === 0x2002) return privateV4(v4(w[1]!, w[2]!));
  // fc00::/7 (unique local) and fe80::/10 (link local).
  return (w[0]! & 0xfe00) === 0xfc00 || (w[0]! & 0xffc0) === 0xfe80;
}

/** True for a host on this computer or a private network: loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7 and the like. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const kind = net.isIP(h);
  if (kind === 4) return privateV4(h);
  if (kind === 6) return privateV6(h);
  return false;
}

/** The app's own origin, also when it is named another way on this computer: localhost, 127.0.0.1 or [::1], same port. */
export function isAppAddress(url: string, origin: string): boolean {
  let u: URL;
  let o: URL;
  try {
    u = new URL(url);
    o = new URL(origin);
  } catch {
    return false;
  }
  if (u.origin === o.origin) return true;
  const loop = (x: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  return loop(u) && loop(o) && u.protocol === o.protocol && u.port === o.port;
}

/** True when the browser may not load `url` while it shows the app at `origin`: on this computer or a private network, and not the app. */
export function blockedFrom(url: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return false;
  return !isAppAddress(url, origin) && isLocalHost(u.hostname);
}
