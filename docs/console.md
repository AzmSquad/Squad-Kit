---
title: The app
description: A short tour of the squad-kit 1.0 app - Home, the board, the ticket drawer, Squad and AI, and Settings.
---

This page is about squad-kit **1.0**. The pages of the 0.x console (stories, plans, the plan generator) are
gone. The 0.x commands still ship; see the
[CHANGELOG](https://github.com/AzmSquad/squad-kit/blob/main/CHANGELOG.md) for 0.x history.

squad-kit is one app for all your projects. It runs on your computer and opens in your browser. Every button
in it also has a terminal command: turn on **Show commands** in the sidebar to see each one beside its button.

## Open it

| Command | What it does |
| --- | --- |
| `squad` | Opens the app, from any folder. If it is open already, prints its link and opens it. |
| `squad console` | In a project folder: sets the folder up if needed, adds it to the app and opens its board. |
| `squad --restart` | Stops the app and starts a fresh one, on the same link. |
| `squad --no-open` | Prints the link instead of opening the browser. |
| `squad --port 4600` | Uses another port. The default is 4571; a busy port moves to the next free one. |

Press Ctrl-C in the terminal to stop the app. The squad picks up where it was next time.

**Only you can open it.** The app listens on `127.0.0.1` only, so it cannot be reached from other computers,
and the link carries a private key that every request must send. Mockups the squad makes run sealed off: no
network, no access to the board.

## Home

The first page. It has:

- **Projects**: one card per project, with its folder, how many tickets are open and working, and how many
  wait for you. **Open board** opens it. **Remove** takes it out of the app; its files stay in its folder.
- **Waiting for you**: what every project needs from you, in one list, each with the button to act on it. A
  banner at the top shows the first ones, and the browser tab shows the count: "(3) squad-kit".
- **Add project**: a folder browser inside the page. It says what kind of folder you picked (empty, code,
  several repos, already a squad-kit project) and what will happen. **New folder here** makes a folder for a
  new project.
- **Tickets at once**, at the top: how many tickets the squads work on at the same time, across all projects.
  They share your AI account, so this is one number for all of them.

Terminal: `squad projects`, `squad inbox`.

## The board

Each project has its own board. The sidebar has the project's pages: **Board**, **Backlog**, **Waiting for
you**, **Releases**, **Architecture**, **Bugs**, **Squad and AI** and **Settings**. Click the project name or the
logo to go back to Home.

On every page of a project:

- **The Waiting for you banner**, at the top: the first two things that need you, each with its button
  (Answer, Review spec, Check proof, Decide), and "and N more". The browser tab shows the count: "(2) roomflow".
  Everything else, the squad handles.
- **Desktop notices**, if you turn them on (the banner asks once; Settings › Desktop notices changes it): one
  notice for each new question, approval, proof or stop. No sound. Clicking a notice opens the ticket.
- **Claude's usage limit**: when it is reached, a banner says when the squad carries on, by itself. **Try now**
  carries on at once (`squad try-now`).

On a phone the sidebar folds away behind the menu button at the top.

On the board:

- **The columns**: Tickets (Analyst), Specs (Architect), Implement (Builder), Test (squad-kit runs the
  checks), Review (Reviewer), Release, and Bugs. Each card says what is happening in plain words, for example
  "Builder · step 3 of 6 · editing the booking page", with how long it has run, how long that step usually takes
  on this project, and a step bar. A ticket over the limit of tickets at once says "Next in line: starts when a
  slot is free". A slow step says "Taking longer than usual".
- **All tickets**, **Mine** and **Bugs** filter the cards. **Search tickets** finds one.
- **New ticket** writes a ticket in plain words. **Pull from Azure DevOps** brings in a work item (or
  **Connect a tracker**, when there is none).
- **The footer**: tickets released and bugs found in the last 30 days, open tickets, what the squad used, and
  **Report a bug**.
- **Show archived**, under the board: archived tickets, each with **Unarchive**.

**Your apps**, in the sidebar: each app of the project with its state (Not running, Starting, Running at its
address, Stopped, Failed with the reason) and **Start**, **Open**, **Restart** and **Stop**. squad-kit runs the
app from its own copy of `main` on this computer, never your own folder, and brings that copy up to date first
(running the setup command when the dependencies changed). Your `.env` files come along: squad-kit copies them from
your project folder into its copy each time, readable by you only. **Show output** has the last lines it printed. After
**Looks right**, "RO-6 is in main" offers **Run the new version**. A busy port gets a plain message, and the fix
when there is one. With no start command known: **Ask the Architect to find it**, or **Type it**. Closing or
restarting squad-kit stops the apps it started. Terminal: `squad app start|stop|restart|status|set|find`.

A new project shows a **Setting up your project** card while the Architect reads it.

## The ticket drawer

Click a card to open it on the right. At the top: the ticket's name and title, links to its tracker item and
pull request, who made it, its **owner**, its track (Full or Express) and its repo. A row of steps shows how
far it is. Buttons: **Hand over** and **Propose a change**.

The tabs:

| Tab | What it shows |
| --- | --- |
| **Now** | What happens now in one sentence, how long it has run against the usual time, what comes next, and what you can do: answer, approve, check, decide. **Ask about this ticket**: status questions are answered at once, in English or Arabic, at no AI cost; a question that would change the work offers **Propose a change** or a note the agent reads at its next step. |
| **Story** | The ask as written, the spec, and notes. Add a note, a business rule or a "done when" item; every agent on the ticket reads it. |
| **Plan** | The design: the decision and the steps. |
| **Activity** | Everything that happened, with who and when. |
| **Conversation** | Each agent's real session: messages, plans, commands, changes, pictures. Message an agent here, or talk to it. |
| **Proof** | Each "done when" with its screenshot, and the checks and review results. |
| **Changes** | What the ticket changed against main, file by file, from the squad's copy of the code. |
| **Cost** | What each role used on this ticket: runs, tokens, and the cost at API prices. |
| **Developer** | The branch, the squad's copy of the code, the files it touched, the exact error when a step stopped, and the commands to open it yourself. |

**A slow step** gets a card on the Now tab: **Taking longer than usual** (past twice the usual time) with what it
is doing, its last progress and when squad-kit stops it, and **Give it 10 more minutes**, **Stop and try again**
and **Stop**. **Looks stuck** (no progress for a while) says what squad-kit checked and offers **End the stuck
command**. Terminal: `squad wait <ticket> --more 10m`, `squad stop <ticket> --again`, `squad unstick <ticket>`.

**A stopped step** gets a card that says what happened, what is safe ("Nothing was merged or pushed"), and the ways
out: **Try again**, **Fix it yourself**, **Continue anyway** (with a reason), **Send it back to the plan**, and
**Report a problem**.

The **…** menu at the top has **Delete** for a ticket that is not merged, and **Archive** for a merged or released
one. The dialog lists what is removed and what stays:

- **Delete** stops the squad on it, then removes its copy of the code, its branch, its files in `.squad/tickets/`,
  its decisions that are not merged, its chats and screenshots. The tracker item stays (only the link goes), and
  its cost stays in Usage. A pushed branch stays on the remote unless you tick the box. If it stops half-way,
  **Delete again** finishes it. Only the ticket's owner can delete it, and not while it is in a release being made.
- **Archive** takes it off the board. Its history stays in git and in `.squad/`.

Terminal: `squad delete <ticket> [--remote] [--yes]`, `squad archive <ticket> [--undo]`, `squad board --archived`.

**Report a problem** (the life-buoy at the top, every error card, the Developer tab and Settings) saves one `.zip`
in your Downloads folder: a README, the versions (squad-kit, Node, git, the OS, the AI tool), the ticket's state,
its conversations (without pictures), the project's settings and ticket list, and the last 24 hours of the app log.
It never holds sign-ins, the board's token, `.env` files or anything that looks like a key. Send it to whoever helps
you with squad-kit. Terminal: `squad report [ticket] [--note "what happened"]`.

## Chat

Open a chat with any agent on a ticket: **Ask the Analyst** on the Now tab, **Talk it through** on a spec or
design, or **Talk to the Builder** (or any agent) in the Conversation tab. Add screenshots, files or a voice
note to a message.

- **Asking never stops the work.** While the squad works, the chat runs beside it and changes nothing.
- **A change goes through the spec.** Press **Propose a change**: the Analyst writes it into the spec, old and
  new, and you approve it.
- **Released work is for questions only.** A change to it becomes a new linked ticket or a bug report.

A new chat window is on its way: a side panel with tabs, a full-screen page for all conversations, a phone
layout, and Arabic and English (and both mixed) shown the right way.

Terminal: `squad chat <ticket>`, `squad message <ticket>`, `squad propose <ticket>`.

## Other pages

- **Backlog**: your tracker's sprint, in backlog order. **Start** puts an item on the board.
- **Waiting for you**: this project's cards, all of them.
- **Releases**: the next release, ready to read and release, and every past release with its notes and the
  bugs found after it.
- **Architecture**: every decision. **Map** shows how decisions build on each other, **Timeline** shows them per
  ticket (press **Play the history**), **Stack** shows each technology in the code and why it is there, plus
  **All decisions**, **Project map** and **Lessons**.
- **Bugs**: each bug, linked to the release it was found in.

## Squad and AI

The five roles, each its own agent with its own session and tools. For each one you see its AI tool, its model
level and what it works on now. Below: the limit of tickets at once, what each role used, and your AI tools
(**Ready** or **Not found**).

**Quality**, for the whole project, sets the level each role starts from:

- **Best** (the default): the strongest model builds and reviews, at high effort. Uses your plan's limits faster.
- **Balanced**: the strongest model builds at medium effort.
- **Thrifty**: a lighter model builds. Cheapest.

**Edit** on a role opens:

- **Models**, per step: a level (**Strongest**, **Balanced**, **Fast**) and an effort (extra high, high, medium,
  low).
  **For the team** saves the choice in the project's rules, so it works for everyone, whatever AI tool they
  use. **Just for me** saves it on this computer. **Pin exact models** is there for advanced use.
- **House rules**: your team's instructions, for every step or for one step only.
- **Core prompt, read only**: exactly what the agent reads at each step, filled in from a real ticket. Your
  rules are added to it, never instead of it.

On Claude Code, strongest is Opus, balanced is Sonnet and fast is Haiku. A tool without extra high runs high
instead. Any failed Builder run (the run itself, the checks or the review) moves the next one up: on Best to extra
high after one, on Balanced to high after one, on Thrifty to strongest after two. On Best and Balanced the Reviewer
is never on a weaker level or effort than the Builder. The Express track runs the Builder on balanced at high and
the Reviewer on strongest (Thrifty: every role on balanced).

Terminal: `squad config set quality best`, `squad agent builder`, `squad agent builder --step fix --set "..."`,
`squad agent reviewer --prompt`.

## Settings

- **Theme** and **Terminal commands** (show or hide the command beside each button).
- **Board**: **Restart the board**, on the same link. Running work picks up where it stopped.
- **Tickets at once**: from 1 to 5, for all your projects.
- **Desktop notices**: on or off, for this browser. If the browser blocked them, it says how to allow them.
- **Report a problem**: a report for the whole app, without a ticket. The app log is in `~/.squad-kit/logs/`,
  one file a day with every step, stop and error (never a key or a prompt), kept 14 days. Errors also print in the
  terminal that runs the app. Terminal: `squad logs`, `squad logs --tail`.
- **Talk to Claude**: through the Agent Client Protocol (ACP, the open standard for agents), or directly. If
  ACP cannot start, a step runs Claude Code directly.
- **Azure DevOps**: organization, project and token, then **Save and check**. Your token stays on this
  computer.
- **Speech to text**: a key for Munsit, the speech service supported today, so the squad can read voice and
  video notes.
- **How the squad checks and runs this project**: for each code repo, the setup, test, lint, build and start
  commands, the app address, a pipeline to run after a release, the release branch and where it pushes. The
  Architect fills these in; change them here. **Read the project again** asks the Architect to read the code again.
- **About squad-kit**: your version, when the app last looked for a new one, **Check for updates**, and the
  daily check (turn it off on a network without internet). When a new version is out, Home and every project
  page show it with what is new. **Update now** waits until no agent is in the middle of a step, installs it,
  and restarts the app on the same link. Terminal: `squad upgrade`.
