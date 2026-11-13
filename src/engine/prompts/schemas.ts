import { DECISION_AREAS, TECH_ROLES } from '../../board/types.js';
import { PART_KINDS } from '../../board/overview.js';
import { MAX_PICTURES } from '../proof-verdict.js';

const STR = { type: 'string' } as const;

/** Every agent's first line on who runs the process, so a repo's own rules can't stall a step. */
export const PROCESS_RULE =
  "squad-kit runs the process: branches, commits, pushes, pull requests, reviews and releases. The repo's own rule files cover the code. Where one tells you to open your own pull request, commit, push or follow its own workflow, leave that part to squad-kit and carry on.";

/** The answers to a team's checklist, in the Reviewer's and the Tester's answer. */
const CHECKLIST = {
  type: 'array',
  items: { type: 'object', properties: { n: { type: 'integer' }, answer: { type: 'string', enum: ['yes', 'no'] }, why: STR }, required: ['n', 'answer'] },
};

const COMMANDS = {
  type: 'object',
  properties: { setup: STR, test: STR, lint: STR, build: STR, start: STR, url: STR },
} as const;

/** The parts of the code and the arrows between them, for the overview's picture. */
const PARTS = {
  type: 'array',
  maxItems: 10,
  items: {
    type: 'object',
    properties: { id: STR, name: STR, what: STR, files: { type: 'array', maxItems: 4, items: STR }, kind: { type: 'string', enum: [...PART_KINDS] } },
    required: ['id', 'name', 'what', 'files'],
  },
} as const;

const LINKS = {
  type: 'array',
  maxItems: 20,
  items: { type: 'object', properties: { from: STR, to: STR, label: STR }, required: ['from', 'to'] },
} as const;

/** What runs when the whole product is up, for the engine; the picture's parts above are for people. */
const RUNS = {
  type: 'array',
  maxItems: 30,
  items: {
    type: 'object',
    properties: { id: STR, name: STR, shared: { type: 'boolean' }, repo: STR, folder: STR, needs: { type: 'array', items: STR }, url: STR },
    required: ['id', 'name'],
  },
} as const;

/**
 * The first read of a project. Besides the map, the decisions and the commands it hands in what the overview shows
 * the person before the first ticket: who uses it, what it can do today, what is worth knowing, three ticket ideas,
 * and the parts of the code with the links between them.
 */
export const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    empty: { type: 'boolean' },
    summary: STR,
    map: { type: 'array', items: { type: 'object', properties: { area: STR, detail: STR }, required: ['area', 'detail'] } },
    decisions: { type: 'array', items: { type: 'object', properties: { title: STR, why: STR }, required: ['title', 'why'] } },
    commands: COMMANDS,
    repos: {
      type: 'array',
      items: { type: 'object', properties: { path: STR, summary: STR, commands: COMMANDS }, required: ['path', 'summary', 'commands'] },
    },
    users: STR,
    can: { type: 'array', maxItems: 8, items: STR },
    worth: { type: 'array', maxItems: 6, items: STR },
    ideas: { type: 'array', maxItems: 3, items: { type: 'object', properties: { title: STR, why: STR }, required: ['title', 'why'] } },
    parts: PARTS,
    links: LINKS,
    runs: RUNS,
  },
  // The overview's parts are not required, so an answer in the older shape still fits; scanProblem (answers.ts) asks
  // for them once more when a project with code leaves them out.
  required: ['empty', 'summary', 'map', 'decisions', 'commands'],
};

export const BLUEPRINT_SCHEMA = {
  type: 'object',
  properties: {
    map: { type: 'array', items: { type: 'object', properties: { area: STR, detail: STR }, required: ['area', 'detail'] } },
    stack: {
      type: 'array',
      items: { type: 'object', properties: { name: STR, role: { type: 'string', enum: [...TECH_ROLES] }, why: STR, decision: STR }, required: ['name', 'why'] },
    },
    patterns: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: { name: STR, what: STR, where: { type: 'array', maxItems: 4, items: STR }, decision: STR },
        required: ['name', 'what', 'where'],
      },
    },
    // The overview's picture, brought up to date with the code.
    parts: PARTS,
    links: LINKS,
  },
  required: ['map', 'stack', 'patterns'],
};

/** The first read after a project that had no code got some: it also says what runs. */
export const FIRST_BLUEPRINT_SCHEMA = { ...BLUEPRINT_SCHEMA, properties: { ...BLUEPRINT_SCHEMA.properties, runs: RUNS, summary: STR, users: STR } };

export const TECH_DECISION_SCHEMA = {
  type: 'object',
  properties: {
    title: STR,
    area: { type: 'string', enum: [...DECISION_AREAS] },
    options: { type: 'array', minItems: 2, maxItems: 3, items: STR },
    chosen: STR,
    why: STR,
    buildsOn: { type: 'array', maxItems: 4, items: STR },
  },
  required: ['title', 'area', 'options', 'chosen', 'why', 'buildsOn'],
};

export const IMPACT_SCHEMA = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: STR, affected: { type: 'boolean' }, why: STR, change: STR },
        required: ['id', 'affected', 'why', 'change'],
      },
    },
  },
  required: ['tickets'],
};

export const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    summary: STR,
    questions: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', enum: ['analyst', 'architect'] },
          kind: { type: 'string', enum: ['gap', 'clash'] },
          text: STR,
          options: { type: 'array', minItems: 2, maxItems: 4, items: STR },
          typedOption: STR,
        },
        required: ['from', 'kind', 'text', 'options'],
      },
    },
  },
  required: ['summary', 'questions'],
};

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    story: STR,
    criteria: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: { type: 'object', properties: { given: STR, when: STR, then: STR }, required: ['given', 'when', 'then'] },
    },
    decision: {
      type: 'object',
      properties: {
        title: STR,
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: { type: 'object', properties: { name: STR, note: STR, chosen: { type: 'boolean' } }, required: ['name', 'note', 'chosen'] },
        },
        why: STR,
        clientCheck: STR,
        replaces: STR,
        area: { type: 'string', enum: [...DECISION_AREAS] },
      },
      required: ['title', 'options', 'why', 'area'],
    },
    follows: { type: 'array', maxItems: 12, items: STR },
    dependsOn: { type: 'array', maxItems: 5, items: STR },
    steps: { type: 'array', minItems: 1, maxItems: 8, items: STR },
    tests: { type: 'integer' },
    screens: { type: 'integer' },
    asks: { type: 'integer' },
    releaseNote: STR,
    commands: COMMANDS,
    repo: STR,
    parts: { type: 'array', maxItems: 12, items: STR },
    mockup: STR,
  },
  required: ['story', 'criteria', 'steps', 'tests', 'screens', 'releaseNote'],
};

const CRITERIA = {
  type: 'array',
  minItems: 1,
  maxItems: 6,
  items: { type: 'object', properties: { given: STR, when: STR, then: STR }, required: ['given', 'when', 'then'] },
};

/** Full track, step one: the what. The person approves it before any design. */
export const SPEC_SCHEMA = {
  type: 'object',
  properties: { story: STR, criteria: CRITERIA, releaseNote: STR },
  required: ['story', 'criteria', 'releaseNote'],
};


/** A change the person proposed, written into the spec by the Analyst: only the parts it touches, and its size. */
export const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    summary: STR,
    size: { type: 'string', enum: ['small', 'big'] },
    why: STR,
    story: STR,
    criteria: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: { number: { type: 'integer' }, action: { type: 'string', enum: ['change', 'add', 'remove'] }, given: STR, when: STR, then: STR },
        required: ['number', 'action'],
      },
    },
  },
  required: ['summary', 'size', 'why', 'story', 'criteria'],
};

/** A big change: the Architect's design update, every step marked as it stays, changes or is new. */
export const CHANGE_DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    summary: STR,
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'object', properties: { title: STR, change: { type: 'string', enum: ['same', 'changed', 'new'] } }, required: ['title', 'change'] },
    },
  },
  required: ['summary', 'steps'],
};

/** A reply in a chat with the person, and whether the agent thinks it understands enough for the next step. */
export const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: STR,
    ready: { type: 'boolean' },
    options: { type: 'array', maxItems: 4, items: STR },
    files: { type: 'array', maxItems: 8, items: STR },
  },
  required: ['reply', 'ready'],
};

/**
 * Filled only when the agent must stop and ask the person. kind: why it asks, a gap in the business or a clash between
 * two requirements; squad-kit still reads the words itself (engine/question-filter.ts). sources: on the Builds by itself
 * track, where it comes from: the BRD's place, an answer, a ticket's built code (see auto-prompts.ts).
 */
const QUESTION = {
  type: 'object',
  properties: {
    text: STR,
    options: { type: 'array', maxItems: 4, items: STR },
    why: STR,
    files: { type: 'array', maxItems: 6, items: STR },
    kind: { type: 'string', enum: ['gap', 'clash'] },
    sources: {
      type: 'array',
      maxItems: 4,
      items: { type: 'object', properties: { text: STR, ticket: STR, section: STR, page: { type: 'integer' } }, required: ['text'] },
    },
  },
  required: ['text', 'kind'],
};

/** Builds by itself: the small choices the agent made instead of asking ("Decided for you"). */
const DECIDED = { type: 'array', maxItems: 6, items: STR } as const;

/** Full track, step two: the how, written from the approved spec. */
export const DESIGN_SCHEMA = {
  type: 'object',
  properties: { ...Object.fromEntries(Object.entries(PLAN_SCHEMA.properties).filter(([k]) => !['story', 'criteria', 'releaseNote'].includes(k))), question: QUESTION, decided: DECIDED },
  required: ['steps', 'tests', 'screens'],
};

export const BUILD_SCHEMA = {
  type: 'object',
  properties: { summary: STR, testsAdded: { type: 'integer' }, notes: STR, question: QUESTION, decided: DECIDED },
  required: ['summary'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, summary: STR, comments: { type: 'array', items: STR }, alsoChanged: { type: 'array', items: STR }, checklist: CHECKLIST, question: QUESTION, decided: DECIDED },
  required: ['approved', 'summary', 'comments'],
};

/**
 * The Tester's answer: the pictures squad-kit took for each "done when" that shows on a screen (by file name, one per
 * part or case, several naming the same "done when"), what each shows (met, broken or not shown), and one plain note;
 * and every "done when" that shows on no screen, or has a part that cannot be shown, with why. The shape cannot count
 * per "done when": the live squad does.
 */
export const PROOF_SCHEMA = {
  type: 'object',
  properties: {
    shots: {
      type: 'array',
      maxItems: MAX_PICTURES,
      items: {
        type: 'object',
        properties: { criterion: { type: 'integer' }, file: STR, shows: { type: 'string', enum: ['met', 'broken', 'not-shown'] }, note: STR },
        required: ['criterion', 'file', 'shows', 'note'],
      },
    },
    offScreen: {
      type: 'array',
      maxItems: 20,
      items: { type: 'object', properties: { criterion: { type: 'integer' }, why: STR }, required: ['criterion', 'why'] },
    },
    checklist: CHECKLIST,
  },
  required: ['shots', 'offScreen'],
};

/**
 * squad-kit's own check of the proof: once per "done when", whether all its pictures together show it met, broken or
 * not clearly (with exact advice on what is missing, and whether that can be shown at all), and whether the "done when"
 * itself says the screen stays as it was.
 */
export const PROOF_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      maxItems: MAX_PICTURES,
      items: {
        type: 'object',
        properties: { criterion: { type: 'integer' }, shows: { type: 'string', enum: ['met', 'broken', 'not-shown'] }, why: STR, advice: STR, noChange: { type: 'boolean' }, canShow: { type: 'boolean' }, canShowWhy: STR },
        required: ['criterion', 'shows', 'why', 'noChange'],
      },
    },
  },
  required: ['checks'],
};

export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    title: STR,
    ask: STR,
    kind: { type: 'string', enum: ['feature', 'bug'] },
    track: { type: 'string', enum: ['full', 'express'] },
    priority: { type: 'string', enum: ['high', 'normal', 'low'] },
    criteria: { type: 'array', maxItems: 8, items: STR },
    rules: { type: 'array', maxItems: 8, items: STR },
    edgeCases: { type: 'array', maxItems: 8, items: STR },
    gaps: { type: 'array', maxItems: 5, items: STR },
  },
  required: ['title', 'ask', 'kind', 'track', 'priority', 'criteria', 'rules', 'edgeCases', 'gaps'],
};
