<p align="center">
  <a href="https://squad-kit.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://squad-kit.com/readme/header-dark.png">
      <source media="(prefers-color-scheme: light)" srcset="https://squad-kit.com/readme/header-light.png">
      <img src="https://squad-kit.com/readme/header-light.png" alt="squad-kit: Your AI Engineering Squad. One Unified Harness." width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/squad-kit"><img src="https://img.shields.io/npm/v/squad-kit.svg" alt="npm version"></a>
  <a href="https://github.com/AzmSquad/Squad-Kit/actions/workflows/ci.yml"><img src="https://github.com/AzmSquad/Squad-Kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://squad-kit.com"><img src="https://img.shields.io/badge/site-squad--kit.com-7cffa0?labelColor=0a0a0c" alt="Website"></a>
</p>

squad-kit is an agent harness for the whole software cycle. You describe what you need in plain words. A
squad of AI agents takes it from that ask to a release: the Analyst, the Architect, the Builder, the Tester
and the Reviewer. You stay in control. The squad asks you when it needs you, and nothing important moves on
without your approval.

## Who it is for

- **Business analysts and project managers** who want to turn tickets into working software, and always see
  where each ticket is. No terminal skills needed after the first step.
- **Developers** who want the squad to do the routine work, while they approve designs and read the code.
- **Teams** who want specs, decisions and releases kept with the project, in files anyone can read.

## How a ticket goes

1. You write a ticket on the board, or pull one from your tracker (the tool where your team keeps its work
   items).
2. The Analyst asks you questions. You answer with a click.
3. The Analyst writes the **spec**: the story and a "done when" list. You approve it.
4. The Architect writes the **design**: the decision and the steps. You, or a developer, approve it.
5. The Builder writes the code in its own copy of the project. Your own folder stays as it is.
6. squad-kit runs the tests, lint and build itself. The Reviewer checks the work with fresh eyes. The Tester
   shows each "done when" in one or more screenshots, one per part or case, taken with squad-kit's own browser.
7. You check this **proof**: each "done when" says **Met**, **Not working yet**, **Not shown yet** or **Not on a
   screen**. **Where to look** names the pages, and **Try it yourself** runs the ticket's own copy of the app, with
   nothing merged. Then press **Looks right**.
8. You press **Release**. squad-kit writes the changelog, sets the version and adds the git tag.

When the squad needs you, a banner shows on every page with the button to press, the browser tab shows how many
things wait, and a desktop notice can tell you too. Everything else, the squad handles. Every button also has a
terminal command, so developers can do the same from the terminal.

## What you need

- **Node.js** 22 or newer.
- **git**.
- **An AI tool**, installed and signed in once with your own account. Today that is **Claude Code**, the only
  AI tool the squad runs on. squad-kit uses your existing sign-in, so there is nothing new to buy. squad-kit
  also finds Codex, but cannot run it yet.

There is nothing else to install. squad-kit installs its own browser for the screenshots the first time it needs
one, so there is no `npx playwright` to run. **Windows** works, but it is less protected and not fully tested yet:
use it on projects you trust.

## Install

```bash
npm i -g squad-kit
```

## Open squad-kit

```bash
squad
```

This opens squad-kit in your browser. It runs on your computer only, at `127.0.0.1:4571`. It is one app for
all your projects:

- **Home** lists your projects, and one **Waiting for you** list for all of them.
- Each project has its own **board**, with its tickets in columns, from a new ticket to its release.

Keep the terminal open while you work. Press Ctrl-C there to stop squad-kit. The squad picks up where it was
the next time you run `squad`.

## Add a project

On Home, press **Add project** and pick a folder in the folder browser. Or open a terminal in the folder and
run:

```bash
squad console
```

Any folder works:

| The folder | What squad-kit does |
| --- | --- |
| An empty folder | Makes a new git repo and asks "What do you want to build?". The Architect picks the technology when your first ticket is planned, and squad-kit finds how to test and run it after the first build. |
| Code with git | Keeps your repo and its history as they are. |
| Code without git | Makes a repo, with your files in its first commit. Generated folders like `node_modules` and `dist`, and `.env` files, stay out. |
| A folder with several code repos | Works across them. Each ticket works in one repo. |
| A squad-kit 0.x project | Keeps your stories, plans and tracker settings. Moves your sign-ins to this computer. |

Then a setup page shows each step live while the Architect reads the project, finds how to test and run it, and
squad-kit tries the tests and opens the app once. It takes a few minutes, and you can leave the page. Then the
**Overview** opens: what the project is, who uses it, how its parts fit, the rules found, and ideas for a first
ticket. Approve it with **Looks right, start working**, and the squad follows those rules.

## Your first ticket

1. On the board, press **New ticket**.
2. Write what you want in plain words. Add business rules, examples or screenshots if you have them. Or paste
   an idea or a chat message, and the Analyst fills in the ticket for you to check.
3. Press create. The card moves across the board as the squad works.
4. Answer, approve and check when the **Waiting for you** banner asks you.

The step-by-step guide is in [Getting started](docs/getting-started.md).

## While the squad works

- **Every card says what is happening**, for example "Builder · step 3 of 6 · editing the booking page", with how
  long it has run and how long that step usually takes on this project. A ticket waiting for a free place says so.
- **Ask about a ticket** on its **Now** tab: "is there a problem?", "when will it be ready?". Status questions are
  answered at once, in English or Arabic, at no AI cost. Terminal: `squad ask`, `squad status`.
- **A slow step says so**, with what it is doing and three ways out: **Give it 10 more minutes**, **Stop and try
  again**, or **Stop**. A step that makes no progress says what squad-kit checked.
- **Run your app** from **Your apps** in the sidebar: Start, Open, Restart and Stop, from squad-kit's own copy of
  `main`. If another program holds its port, it moves to a free one by itself. After **Looks right**, **Run the new
  version** shows the change. Terminal: `squad app start`.
- **Tickets that need each other**: when a design depends on a ticket that is not merged yet, it waits with
  **Build on its branch**, **Build anyway** or **Wait**.
- **Remove a ticket** you no longer want with **Delete**, and take finished ones off the board with **Archive**.
  The dialog lists what goes and what stays; the cost stays in Usage. Terminal: `squad delete`, `squad archive`.

## Checks you can trust

- **Not checked, never a fake pass**: a project with no tests shows "Not checked" in orange.
- **Weakened tests stop the ticket**: deleted or skipped tests, fewer tests, or a changed test setup.
- **Proof is checked**: each screenshot must be a real, new picture, and squad-kit's own check looks at all the
  pictures of each "done when" together before it says **Met**.
- **The Builder works in a sandbox** where the computer allows it: its copy only, no keys or `.env` files, and only
  the package registries and websites you allow.
- **The project's own commands run in a guard** on Mac and Linux: the tests, the setup and the app work normally, but
  can't read your keys, your sign-ins or squad-kit's own files.
- **Agents get fixed tools, no free commands**, for screenshots, the app and the checks. squad-kit checks each
  request and does the job itself.

## When something goes wrong

- **Every stop says what happened, what is safe, and the ways out**, as buttons: Try again, Fix it yourself,
  Continue anyway, or Report a problem. The exact error is one click away in the ticket's Developer tab.
- **Claude's usage limit pauses the squad** for every project, shows when it resets, and the squad carries on by
  itself, from the same step. **Try now** carries on at once.
- **Report a problem** saves one `.zip` to send to whoever helps you: the ticket, its conversations, the last day
  of the app log and the versions. It never holds sign-ins, tokens or `.env` files. Terminal: `squad report`.
- **The app log** is in `~/.squad-kit/logs/`, one file a day, kept 14 days. Terminal: `squad logs --tail`.

## Where your files live

squad-kit keeps files in two places. The test is simple: does another person need it to carry on?

**Yes: in the project folder, in `.squad/`.** This is the project's memory. It is plain Markdown and YAML that
people can read and edit.

```
.squad/
  config.yaml        the project's settings
  tickets/AB-46/     one folder per ticket: ticket.md, spec.md, questions.md,
                     design.md, notes.md, proof.md, and files people attached
  decisions/         what the squad decided, and why: AB-46.1.md, STACK.1.md
  releases/          what each release carried
  rules/             house rules for each role
  knowledge/         what the squad learned about the project
```

**No: on this computer, in `~/.squad-kit/`.** Live progress, agent chats, screenshots, sign-ins (tokens) and
cost belong to you and this computer. They never go into the project folder.

For a project whose `.squad/` sits inside its code repo, squad-kit commits each ticket's documents on the
ticket's own branch, so they reach `main` with the code. `.squad/` stays out of your own `git status`.

## Work with your team

- **Tracker.** Connect your tracker in Settings, then pull work items onto the board. Tickets keep the tracker's
  name, like `AB-46`. squad-kit moves the item along as the squad works, posts the answers and the plan as
  comments, and opens a pull request for each finished ticket. Today this works with **Azure DevOps** (Azure
  Boards and Azure Repos).
- **Hand over.** Give a ticket to a teammate with **Hand over**. squad-kit pushes the ticket's branch with its
  code and documents, and names the new owner. Their squad carries on from there.
- **A new computer or a new teammate.** Clone the project and add it. The board comes back from `.squad/`:
  every ticket with its spec, answers, design, stage and owner, and every decision.

Hand over and clones work for a project whose `.squad/` sits in its one code repo.

## Talk to the squad

**Ask a question** is at the top of every ticket, in every state: working, in the queue, waiting for another ticket,
stopped, at review, taken over or released. Whoever knows the ticket best answers: the Analyst before the build, the
Builder during and after it, the Tester once there are screenshots. It answers questions only, like "how do I test
this?" or "where is the new page?", and the ticket stays exactly where it is. Terminal: `squad chat <ticket> --ask`.

You can also open a chat with any agent on a ticket. **Asking never stops the work**: the squad keeps working while
you talk. To change what gets built, press **Propose a change**. The Analyst writes the change into the spec, old
and new side by side, and you approve it. A released ticket answers questions only. A change to it becomes a new
linked ticket or a bug report.

**The squad asks you only about the business.** Technical questions stay with the agent and squad-kit. Nobody may ask
you for a password or a key, to change squad-kit's settings, or to change git history: squad-kit refuses it and
writes one line in the ticket's activity.

## Cost and models

- squad-kit picks a **model level** for each role and step from the project's **Quality** setting: **Best**
  (the default) builds and reviews on the strongest model, **Balanced** builds on it at medium effort, and
  **Thrifty** builds on a lighter one. **Fast** stays for screenshots and small helpers. The team or each person
  can change single steps on the **Squad and AI** page.
- The board shows **what each ticket and each role used**, the way you pay. On a Claude subscription it says the
  work is included in your plan, and shows its size and its value at API prices (a value, not a bill). With an API
  key it shows real dollars, against a budget per ticket and per month.
- One **limit of tickets at once** (2 by default, up to 5) is shared by all your projects, because they use the
  same AI account.

## Docs

- [Getting started](docs/getting-started.md): your first hour, from install to a release.
- [Moving to 1.0](docs/migrating-to-1.0.md): from squad-kit 0.x, and from early 1.0 boards.
- [The app](docs/console.md): Home, the board, the ticket drawer, Squad and AI, and Settings.
- [From a BRD to a built product](docs/requirements.md): upload a requirements document, approve the breakdown,
  send it to Azure DevOps and let the squad build it.
- [CHANGELOG](CHANGELOG.md): what changed in each version.

The 0.x planner commands (`squad new-story`, `squad new-plan`, `squad auth` and others) still ship. Their docs
are kept as they were: [auth](docs/auth.md), [customization](docs/customization.md),
[philosophy](docs/philosophy.md), [squad-kit vs Spec-Kit](docs/vs-spec-kit.md) and
[migrating from 0.1](docs/migrating-from-0.1.md).

## License

MIT. Contributions welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
