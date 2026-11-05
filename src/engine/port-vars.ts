import fs from 'node:fs';
import path from 'node:path';

/**
 * The app's own port settings. When squad-kit starts a ticket's copy of the app on a free port, PORT alone does not
 * move an app that reads a variable of its own (RoomFlow reads ROOMFLOW_PORT). A quick look through the code, with
 * firm limits, finds the names ending in PORT it reads from the environment: in JavaScript and TypeScript, Python,
 * Ruby, Go, PHP and shell, and in package.json scripts. Ports of other services (a database, mail) are left alone.
 */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.squad',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  'vendor',
  'Pods',
  '.gradle',
  '.idea',
  '.vscode',
]);

const CODE = /\.(m?[jt]sx?|c[jt]s|py|rb|go|rs|php|sh|bash|zsh)$/i;
const SHELLISH = /(^|[\\/])(package\.json|Procfile|Makefile|[^\\/]+\.(sh|bash|zsh))$/i;
const LIMITS = { depth: 6, files: 3000, fileBytes: 256 * 1024, totalBytes: 12 * 1024 * 1024 };

const NAME = '([A-Z][A-Z0-9_]*PORT)';
/** Reads of a variable from the environment, in the languages squad-kit sees most. */
const readsOf = (name: string) => [
  new RegExp(`process\\.env\\.${name}\\b`, 'g'),
  new RegExp(`process\\.env\\[\\s*['"\`]${name}['"\`]\\s*\\]`, 'g'),
  new RegExp(`(?:os\\.environ\\.get|os\\.getenv|environ\\.get|getenv|os\\.Getenv|os\\.LookupEnv|Deno\\.env\\.get|ENV\\.fetch|env::var)\\(\\s*['"]${name}['"]`, 'g'),
  new RegExp(`(?:os\\.environ|ENV|\\$_ENV|\\$_SERVER)\\[\\s*['"]${name}['"]\\s*\\]`, 'g'),
];
/** "$APP_PORT", "${APP_PORT:-8000}" and "%APP_PORT%", in scripts. */
const shellReadsOf = (name: string) => [new RegExp(`\\$\\{?${name}\\b`, 'g'), new RegExp(`%${name}%`, 'g')];
const READS = readsOf(NAME);
const SHELL_READS = shellReadsOf(NAME);
/** The same reads of plain PORT. */
const PORT_READS = readsOf('PORT');
const PORT_SHELL_READS = shellReadsOf('PORT');
/** The default given right after the name: `, "8000"`, `|| 3000`, `?? 3000`, `:-8000`, `or 8000`. */
const DEFAULT = /^['"`\]\s)]*(?:,|\|\||\?\?|:-|:=|\bor\b|\{)\s*['"]?(\d{2,5})\b/;
/** Names of ports that belong to other services, never the app's own web address. */
const OTHER =
  /(^|_)(DB|DATABASE|POSTGRES|POSTGRESQL|PG|MYSQL|MARIADB|MSSQL|MONGO|MONGODB|REDIS|MEMCACHED?|CACHE|SMTP|MAIL|EMAIL|IMAP|POP3?|AMQP|RABBIT|RABBITMQ|KAFKA|NATS|MQTT|QUEUE|ELASTIC|ELASTICSEARCH|OPENSEARCH|SOLR|CASSANDRA|NEO4J|CLICKHOUSE|INFLUX|INFLUXDB|LDAP|SSH|SFTP|FTP|GRPC|DEBUG|INSPECT|INSPECTOR|HMR|LIVERELOAD|WS|WEBSOCKET|METRICS|PROMETHEUS|OTEL|STATSD|JAEGER|ZIPKIN|MINIO|S3|VAULT|CONSUL|ETCD)(_|$)/;

export interface PortVariable {
  name: string;
  /** Default ports the code gives it, when it says. */
  defaults: number[];
}

/** Every name ending in PORT the project reads from the environment, with the defaults seen for it. PORT is left out. */
export function findPortVariables(root: string): PortVariable[] {
  return readPorts(root).vars;
}

/** The app's own port settings, and whether it can be moved at all: it reads PORT, or a setting of its own. */
export function portSettings(root: string, usualPort: number | null): { vars: string[]; reads: boolean } {
  const { vars, plain } = readPorts(root);
  const own = chooseVariables(vars, usualPort);
  return { vars: own, reads: plain || own.length > 0 };
}

function readPorts(root: string): { vars: PortVariable[]; plain: boolean } {
  const found = new Map<string, Set<number>>();
  let plain = false;
  let files = 0;
  let bytes = 0;
  const visit = (dir: string, depth: number) => {
    if (depth > LIMITS.depth || files >= LIMITS.files || bytes >= LIMITS.totalBytes) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A Python virtual environment, whatever its folder is called.
    if (entries.some((e) => e.name === 'pyvenv.cfg')) return;
    for (const e of entries) {
      if (files >= LIMITS.files || bytes >= LIMITS.totalBytes) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const shell = SHELLISH.test(p);
      if (!shell && !CODE.test(e.name)) continue;
      let size: number;
      try {
        size = fs.statSync(p).size;
      } catch {
        continue;
      }
      if (size > LIMITS.fileBytes) continue;
      files += 1;
      bytes += size;
      let text: string;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes('PORT')) continue;
      const scripted = shell || /\.(sh|bash|zsh)$/i.test(e.name);
      const patterns = scripted ? [...READS, ...SHELL_READS] : READS;
      plain ||= (scripted ? [...PORT_READS, ...PORT_SHELL_READS] : PORT_READS).some((re) => text.search(re) >= 0);
      for (const re of patterns) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          const name = m[1]!;
          if (name === 'PORT' || OTHER.test(name)) continue;
          const seen = found.get(name) ?? new Set<number>();
          const d = DEFAULT.exec(text.slice(m.index! + m[0].length, m.index! + m[0].length + 40));
          if (d) seen.add(Number(d[1]));
          found.set(name, seen);
        }
      }
    }
  };
  visit(root, 0);
  return { vars: [...found].map(([name, d]) => ({ name, defaults: [...d] })).sort((a, b) => a.name.localeCompare(b.name)), plain };
}

/**
 * The variables to move along with PORT when the app's usual port is taken. The ones whose default is that port, when
 * the code says; else the ones that give no default at all. A variable with another default is another server's.
 */
export function appPortVariables(root: string, usualPort: number | null): string[] {
  return chooseVariables(findPortVariables(root), usualPort);
}

function chooseVariables(vars: PortVariable[], usualPort: number | null): string[] {
  const usual = usualPort ? vars.filter((v) => v.defaults.includes(usualPort)) : [];
  if (usual.length) return usual.map((v) => v.name);
  return vars.filter((v) => !v.defaults.length).map((v) => v.name);
}
