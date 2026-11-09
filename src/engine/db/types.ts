/**
 * A database per story (1.3.5). squad-kit learns a project's database once, makes a small template of it, and gives
 * each story its own database made from that template, on the same server. The person's own database is only ever
 * read, to make the template, and never created, changed or dropped.
 *
 * One adapter per kind of database, in this folder. This file is the interface the rest of squad-kit builds to.
 * `index.ts` has the way in:
 *   - `dbAdapter(kind): DbAdapter`
 *   - `kindOfAddress(address): DbKind | null`, a guess from the address's form
 *   - `readTemplate(folder, source): DbTemplate | null`, a template made earlier, read back from its folder
 *
 * An address is what the app's setting holds: a link (`postgres://…`, `mysql://…`, `mongodb://…`), a key=value
 * connection string (`Host=…;Database=…`), or for SQLite a file's path (`file:`, `sqlite:` and `Data Source=` forms
 * too). It may hold a password: squad-kit never prints one, and takes it out of every error and log.
 */

/** The kinds of database squad-kit can copy. SQL Server comes later. */
export type DbKind = 'sqlite' | 'postgres' | 'mysql' | 'mongo';

/** How small a template is, and whether personal data is hidden. */
export interface TemplateOptions {
  /**
   * The folder on this computer for the template's files: inside squad-kit's own project folder, never in git. Made
   * when missing; a template already there is replaced once the new one is ready.
   */
  folder: string;
  /** A table or collection with at most this many rows is kept whole. Default 1000. */
  smallRows?: number;
  /** A bigger one keeps its newest this many rows, by a time or id column where it has one. Default 1000. */
  sampleRows?: number;
  /**
   * Names, ID and national numbers, phones, emails, addresses and birth dates become consistent fake values while the
   * template is made, found by column or field name. The source is never changed. Off by default.
   */
  hidePersonal?: boolean;
}

/** One table or collection in a template. */
export interface TemplateTable {
  name: string;
  /** Kept whole (it is small), or sampled (it is big). */
  kept: 'whole' | 'sampled';
  /** The rows or documents kept, linked ones included. */
  rows: number;
  /** When sampled: the column or field the newest rows were picked by. None means any rows. */
  newestBy?: string;
  /** Rows kept only because a kept row elsewhere points at them. */
  linked?: number;
}

/** What engineers see about a template. Saved beside its files as `template.json`. */
export interface TemplateInfo {
  kind: DbKind;
  /** The database it was made from, without any password. */
  source: string;
  /** That database's name, or the file's name for SQLite. */
  sourceName: string;
  /** When it was made (ISO time). */
  madeAt: string;
  /** The size of the template's files on this computer, in bytes. */
  bytes: number;
  smallRows: number;
  sampleRows: number;
  hidePersonal: boolean;
  /** Every table or collection: kept whole or sampled. */
  tables: TemplateTable[];
  /** The columns or fields whose values were made fake, as `table.column`. */
  hidden: string[];
  /** True when every row a kept row points at is kept too, as far as the database records how its rows link. */
  linksComplete: boolean;
  /** Plain words for engineers: what the template could not keep, and why. */
  notes: string[];
}

/** A template, as makeTemplate made it or readTemplate read it back. */
export interface DbTemplate {
  kind: DbKind;
  /** Its folder on this computer. */
  folder: string;
  /** The person's own database it was made from, as given: with any password, kept in memory only, never written. */
  source: string;
  info: TemplateInfo;
}

/** The story a database is for. */
export interface StoryRef {
  /** The story's id, such as `CLINIC-12`. Part of the database's name, in a safe form. */
  id: string;
  /** The story's copy of the code. SQLite puts the story's database file here; the other kinds do not use it. */
  folder?: string;
}

/** A story's own database. */
export interface StoryDb {
  kind: DbKind;
  /** Its name on the server, `<source name>_<story id>` in a safe form; for SQLite, the file's full path. */
  name: string;
  /** The address to point the story's copy at: the person's address with the name changed, in the same form. */
  address: string;
  /** True when squad-kit had made it for this story before, and it was kept as it was. */
  existed: boolean;
}

/** Why an adapter said no or could not finish. The message is plain words, with any password taken out. */
export type DbErrorReason =
  /** It is the person's own database, or one the server itself needs. Never created, changed or dropped. */
  | 'persons-own'
  /** squad-kit did not make it for a story, so it is left alone. */
  | 'not-ours'
  /** A tool this kind needs (pg_dump, mysqldump, mongodump, sqlite3…) is not on this computer. */
  | 'missing-tool'
  /** The address could not be read, or names no database. */
  | 'bad-address'
  /** The database or a tool said no; the message says what it said. */
  | 'failed';

export class DbError extends Error {
  constructor(
    message: string,
    readonly reason: DbErrorReason,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

/** One kind of database. Every method refuses the person's own database with a DbError ('persons-own'). */
export interface DbAdapter {
  readonly kind: DbKind;
  /** The tools this kind needs that are not on this computer, by name. Empty when it is ready. */
  missingTools(): string[];
  /**
   * Makes a template of the source with the database's own tools, reading it with read-only commands: schema and
   * indexes kept, small tables whole, big ones sampled, linked rows kept where the database records the links.
   * Postgres also keeps a template database on the same server (`<source name>_sk_template`) to make story databases
   * from quickly.
   */
  makeTemplate(source: string, opts: TemplateOptions): Promise<DbTemplate>;
  /**
   * Makes the story's own database from the template, on the template's server: `storyAddress(template.source, story)`.
   * When squad-kit made it for this story before, it is kept as it is (`existed`). Refuses a database squad-kit did
   * not make, and the person's own.
   */
  createStoryDb(template: DbTemplate, story: StoryRef): Promise<StoryDb>;
  /**
   * Drops a story's database: only when squad-kit made it for a story (its name has the story form and squad-kit's
   * mark is on it), and never the person's own. False when it was not there.
   */
  dropStoryDb(address: string, personsAddress: string): Promise<boolean>;
  /** The story's database's address: the source's, with the name `<source name>_<story id>`, in the same form. */
  storyAddress(sourceAddress: string, story: StoryRef): string;
  /** The database's name in an address (the file's full path for SQLite). */
  nameOf(address: string): string;
  /** True when the address is the person's own database (the same database, by address or by name). */
  isPersonsOwn(address: string, personsAddress: string): boolean;
  /** Removes a template: its folder, and for Postgres its template database on the server. */
  removeTemplate(template: DbTemplate): Promise<void>;
}
