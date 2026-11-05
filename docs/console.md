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
and the link carries a private key that every request must send. The key in a link works for reads only, and the app
answers only at its own address: a page on another site, or on another port of this computer, gets nothing. Mockups
the squad makes run sealed off: no network, no access to the board. HTML and SVG from a project download instead of
opening at the board's address.

**If the app stops**, a banner shows over every page within 5 seconds and goes by itself when the app is back. What you
were typing stays. A run whose output goes to files keeps running when its terminal closes.

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

Each project has its own board. The sidebar has the project's pages: **Overview**, **Requirements**, **Board**,
**Backlog**, **Waiting for you**, **Conversations**, **Releases**, **Architecture**, **Bugs**, **Squad and AI** and
**Settings**.

**Overview** is the project's home: what it is, who uses it, what it can do today (with what each merged ticket
added), how its parts fit together, things worth knowing, the rules the Architect found, the proof that squad-kit can
work here, and ideas for tickets. The first time, it is the handover after setup: **Looks right, start working**
approves the rules (until then they are proposals), **Something is wrong** opens a talk with the Architect. A new
project opens on a **setup page** with live steps instead. An empty project has no code to read, so the Overview asks
**What do you want to build?** The Architect writes down your answer with ideas for first stories, and picks the
technology when your first story is planned. Terminal: `squad setup`, `squad overview`, `squad overview --build "what
you want"`. Click the project name or the logo to go back to Home.

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
your project folder into its copy each time, readable by you only. **Show output** has the last lines it printed; when
it failed, **See what failed** has the command and what it printed. After **Looks right**, "RO-6 is in main" offers
**Run the new version**. When another program holds the app's port, squad-kit moves the app to a free port by itself
and shows the new address, as long as its start command or its code takes a port setting (`PORT`, or its own, like
`APP_PORT`). When it cannot move, one plain sentence says what is in the way, and **Stop it and start** is there for a
program squad-kit started itself. With no start command known: **Ask the Architect to find it**, or **Type it**. Closing
or restarting squad-kit stops the apps it started. Terminal: `squad app start|stop|restart|status|set|find`.
`--next-port` is still accepted, and now does nothing.

A new project shows a **Setting up your project** card while the Architect reads it.

## The ticket drawer

Click a card to open it on the right. **Ask a question** is at the top of every ticket, in every state (see
[Chat](#chat)). The button next to Close makes it **Full width** (the choice is remembered in this browser); **Hand
over** and **Propose a change** are in the **⋯** menu, and Propose a change is also on the bottom bar. At the top: the
ticket's name and title, links to its tracker item and
pull request, who made it, its **owner** (when they cannot work on it, **Take it** moves it to you, with a reason;
terminal: `squad take-back <ticket> --reason "…"`), its track (Full, Express or Builds by itself) and its repo. A row of
steps shows how far it is. A ticket built from a breakdown says where it comes from ("From BR-1 › Payments ›
Invoices and refunds › S-14") and lists what the squad **decided for you**, each with **Change**. When it stops
for a gap or a clash, the card says which (**Missing in the BRD**, **Two parts clash**), marks the option the
Architect suggests, and says which stories wait for your answer.

The tabs:

| Tab | What it shows |
| --- | --- |
| **Now** | What happens now in one sentence, how long it has run against the usual time, what comes next, and what you can do: answer, approve, check, decide. **Ask about this ticket**: status questions are answered at once, in English or Arabic, at no AI cost; a question that would change the work offers **Propose a change** or a note the agent reads at its next step. |
| **Story** | The ask as written, the spec, and notes. Add a note, a business rule or a "done when" item; every agent on the ticket reads it. |
| **Plan** | The design: the decision and the steps. |
| **Activity** | Everything that happened, with who and when. |
| **Conversation** | **What happened** (the default): one card per step with its time, a one-line summary and what it handed in (the questions, the spec, the design, the changed files, the review, the screenshots), each with a link to its tab. **Full log**: each agent's real session in plain words, with **Open it in Claude Code** for engineers. Message an agent here, or talk to it. A command the sandbox blocked says what and why, with a link to allow it. |
| **Proof** | Each "done when" with its screenshots, one or more, and what they show: **Met**, **Not working yet**, **Not shown yet** or **Not on a screen**, with why. Also the checks and review results. **Not checked** (orange) means the project has no tests. See [The Tester and the proof](#the-tester-and-the-proof). |
| **Changes** | What the ticket changed against main, file by file, from the squad's copy of the code. |
| **Cost** | Depends on how you pay for Claude. On a subscription: "Included in your Claude plan. No extra charge.", the size of the work against the project's usual ticket, where the work went, and its value at API prices (a value, not a bill). With an API key: real dollars, against a budget per ticket and per month, with a warning at 80% and a pause at 100%. Models and tokens are under **Details for engineers**. Terminal: `squad cost [ticket]`. |
| **Developer** | The branch, the squad's copy of the code, the files it touched, the checks that ran with their commands (a check that failed and then passed says "failed once, passed when run again"), how the tests run, the exact error when a step stopped, and the commands to open it yourself. |

**A slow step** gets a card on the Now tab: **Taking longer than usual** (past twice the usual time) with what it
is doing, its last progress and when squad-kit stops it, and **Give it 10 more minutes**, **Stop and try again**
and **Stop**. The step timer counts only the time a step really runs: it stands still while the ticket waits for you,
for another story or for a free place. **Looks stuck** (no progress for a while) says what squad-kit checked and offers
**End the stuck command**. Terminal: `squad wait <ticket> --more 10m`, `squad stop <ticket> --again`,
`squad unstick <ticket>`.

**A stopped step** gets a card that says what happened, in squad-kit's own plain words, what is safe ("Nothing was
merged or pushed"), and the ways out: **Try again**, **Fix it yourself**, **Continue anyway** (with a reason), **Send
it back to the plan**, and **Report a problem**. A tool's raw error never shows there: the exact words are in the
Developer tab and the app log.

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

## The Tester and the proof

After the checks and the review, the Tester shows that the work does what the spec says. squad-kit starts the
ticket's own copy of the app and opens its own browser. The Tester says which pages to open, which steps to do and at
which size (desktop or phone), and squad-kit takes the pictures. It uses its own browser so an agent's sandbox can't
stop it, and there is nothing to install: no `npx playwright`. squad-kit installs it the first time a proof needs it,
and one line says "Setting up squad-kit's screenshot browser. This happens only once."

Each "done when" gets **one or more pictures**, one for each part or case, up to 6. squad-kit checks each picture is a
real image taken in this step. Then its own check, a separate short Reviewer run, looks at all the pictures of each
"done when" together, and with the Tester's word that gives the verdict:

| Verdict | What it means | What happens next |
| --- | --- | --- |
| **Met** | The pictures show it works as written, and squad-kit's check agrees with the Tester. | Nothing more. |
| **Not working yet** | A picture shows it does not work. | It goes back to the Builder once, and the checks, the review and the screenshots run again. If it still does not work, a plain stop: **Let the Builder try again**, **Continue anyway** or **Send it back to the plan**. |
| **Not shown yet** | The pictures do not show it clearly: it is out of view, still loading, or the same as before the change. | The Tester takes what is missing, up to 2 more times, told exactly what to show. Its good pictures stay. Then a plain stop: **Take the screenshots again**, **Continue anyway** or **Send it back to the plan**. A picture problem never goes to the Builder. |
| **Not on a screen** | It, or a part of it, can't be shown at all: an email, what happens after a restart, an old record the app cannot make. | The Tester and the check agree on this. After the last retake, a "done when" whose pictures show a part of it also ends here, with the Tester's reason. It keeps its pictures and its reason, and does not stop the ticket, unless every "done when" ends this way. The Reviewer checks these in the code and the tests. |

A "done when" that says the screen stays as it was may have the same picture as before. Any other "after" that is the
same as its "before" is Not shown yet.

**Also changed, not in the plan** lists what the change touches that the story and the plan did not ask for, in the
Reviewer's words. It never blocks, as it may well be right. You see it at your check, on a stop, on the ticket and in
the release notes.

### Your check

When the proof is ready, or a check stopped the ticket, the row of steps says **Your turn** and the ticket shows:

- **Where to look**: each page the proof names, with the "done when" it shows. While the ticket's copy runs, each page
  has **Open**. With no page saved, it says so: ask a question, or try it yourself.
- **Not on a screen, so look at these yourself**: each "done when" nobody saw on a screen, with why.
- **Try it yourself**: runs this ticket's own copy of the app, with the change in it. Nothing is merged. It shows
  **Starting…**, then **Running** with **Open** and **Stop**, on a free port when the usual one is taken. One copy per
  project runs at a time: trying another stops the first. It stops by itself when the ticket moves on, when the ticket
  is deleted and when the board closes. Terminal: `squad try <ticket> [--stop] [--status]`. With the board closed, the
  copy runs in that terminal until Ctrl-C.
- **Ask a question**, at the top of the ticket. The ticket keeps waiting for you.

**See what failed**: when something does not start, one plain sentence comes first, and **See what failed** has the
command and what it printed, for engineers. It is on Try it yourself, Your apps, the setup after a merge, and the
tests on the Overview.

## The window

Agents don't get free commands for the app, the browser or the checks. squad-kit gives them a few fixed tools, "the
window". An agent presses a tool and fills in its fields. squad-kit checks every field, does the job itself and hands
back the result. Each run has its own key, which stops working when the run ends.

| Tool | What squad-kit does | Who has it |
| --- | --- | --- |
| `take_screenshots` | Opens its own browser on this story's app, does the steps and takes the pictures. At most 10 in one call and 40 in one step. | Tester, Builder |
| `look_at_page` | Opens a page, does the steps, and gives back the address and what is on the page. It saves no pictures. | Tester, Builder, Reviewer |
| `start_app`, `stop_app`, `app_status` | Starts this story's copy with the project's own start command, on a free port when the usual one is taken. Stops only what squad-kit started. Says whether it runs, with its last lines. | Tester, Builder |
| `run_checks` | Runs the project's saved test, lint or build command, inside the guard, where a browser can start. | Tester, Builder |
| `i_am_stuck` | Tries squad-kit's own fixes (see below). | Every agent on a ticket |

The Builder has the app and browser tools once the project has a start command and an address. Until then it has
`run_checks` and `i_am_stuck`. The Reviewer uses `look_at_page` in its review, to see a page of the app as it is now:
squad-kit starts the app when needed.

**What it refuses**: another website, a command, a program squad-kit did not start, or more pictures than a step may
take. The refusal goes in the ticket's activity, like "The Tester asked to open another website. squad-kit refused."
Three refusals in one step stop the agent: "The Tester kept asking for things it may not do, so squad-kit stopped it."

**`i_am_stuck`**: when something technical is in an agent's way (the app does not start, a port is busy, the browser
does not work, a command or a file is refused), it calls this instead of asking you. squad-kit tries its known fixes:
it starts its browser again or sets it up, deals with what holds the port, starts the app again, or tells the agent
how to run a browser test. One plain line goes in the activity, and the agent carries on with what it can. If there
are no screenshots in the end, you get one plain sentence and **Try again**.

### Who answers an agent's questions

squad-kit reads each question an agent asks, with its choices and everything shown with it, before it reaches you. It
does not trust the agent's own label.

- **The business** (something missing that changes what gets built, or two requirements that clash) comes to you.
- **Anything technical** (ports, commands, files, settings, installs) never does. It goes back to the agent, to decide
  it or call `i_am_stuck`, and one line goes in the activity. An agent that keeps asking stops with a plain message and
  **Try again**.
- **What nobody may ask of you** (changing squad-kit's settings, `.squad/` or the files agents load as instructions,
  handing over a password or a key, changing git history) is refused and logged, never shown as a question.

One choice can still reach you in plain words: when another program on this computer holds what the browser tests need
and going around it did not work, a card offers **Stop it** or **Skip the browser tests**. squad-kit never stops a
program it did not start without your press.

The same rule reads an agent's answer in a chat, where technical words are fine, because you asked. An answer that
asks you to do one of the things nobody may ask is left out, and you read one plain line instead.

## Chat

Open a chat with any agent on a ticket: **Ask the Analyst** on the Now tab, **Talk it through** on a spec or
design, or **Talk to the Builder** (or any agent) in the Conversation tab. Add screenshots, files or a voice
note to a message.

**Ask a question** is at the top of every ticket, in every state: working, in the queue, waiting for another ticket,
stopped at any step, at review, taken over or released. It goes to whoever knows the ticket best at that point: the
Analyst before the build, the Builder during and after it, the Tester once there are screenshots. It answers questions
only, like "how do I test this?" or "where is the new page?", and the ticket stays exactly where it is. To change
something, use the ticket's own buttons. With a chat open already, the button opens that chat.

- **Asking never stops the work.** While the squad works, the chat runs beside it and changes nothing.
- **A change goes through the spec.** Press **Propose a change**: the Analyst writes it into the spec, old
  and new, and you approve it.
- **Released work is for questions only.** A change to it becomes a new linked ticket or a bug report.

A chat opens in a side panel beside the board, and takes the whole screen on a phone. **Conversations** in the sidebar
is a full-screen page with all of them.

Terminal: `squad chat <ticket>`, `squad chat <ticket> --ask`, `squad message <ticket>`, `squad propose <ticket>`.

## Requirements

Upload a requirements document (a BRD) and the Analyst breaks it into epics, features and stories. You review it
as a **tree** (the main view, with a side panel to edit each part) or a **map** (boxes and lines, for presenting),
approve it, send it to Azure DevOps if you like, and press **Build continuously**. A breakdown waiting for your
answers shows in **Waiting for you** and in the sidebar's count. The whole flow is in
[From a BRD to a built product](requirements.md).

## Other pages

- **Backlog**: your tracker's sprint, in backlog order. **Start** puts an item on the board.
- **Waiting for you**: this project's cards, all of them.
- **Releases**: the next release, ready to read and release, and every past release with its notes and the
  bugs found after it. A release whose push was refused says why in plain words. **It reached it another way** closes
  one that was merged by hand: it needs a reason, looks on the remote and asks again if it cannot find it. Terminal:
  `squad release --mark-sent --reason "…" [--anyway]`.
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

Under the picker, once a setting has 3 accepted tickets: the average cost value and squad time per accepted ticket
for each setting on this project.

Each Quality setting also caps every step: a number of agent turns and, where the AI tool supports it, a spend
(Best: the Builder 300 turns and $60, fixes 150 and $30; Balanced and Thrifty less). Reaching a cap keeps the work
and asks: **Give it more** or **Stop**. It never counts as a failed try.

**Sandbox**: on Mac and most Linux computers, the Builder's and Tester's commands run in Claude Code's sandbox. They
can write only in the ticket's copy, its proof folder, temp folders and the package caches. npm, pnpm, Yarn, Rust
and Go use their own caches, which check every package against the lock file. .NET, Java and Ruby packages go into a
download folder for that ticket only, never your own caches; it is removed when the ticket is released or deleted
(the first build of a ticket downloads its packages again). They can't read your keys and sign-ins (`~/.ssh`,
`~/.aws`, the GitHub and cloud sign-ins, squad-kit's files) or the project's `.env` files. They can reach the package
registries and the websites you allow in Settings. A blocked command shows in the Conversation tab with what and
why. Where the sandbox can't run (Windows, some Linux setups), steps run as before, and this page and `squad doctor`
say so.

**Guard for the project's own commands**: the Builder writes the code the tests run, so squad-kit runs the project's
own tests, lint, build, setup, app and release pipeline in a guard of its own, on Mac and Linux. They work normally,
browser tests too, and can reach the network for packages and tests. They can't read your keys, sign-ins, browser
profiles or squad-kit's own folder in the places the guard knows, or the `.env` files in your project folder (on Linux, the
ones it finds 3 folders down), and they start without the AI, cloud and code-host keys. When a project truly needs a file
outside its copy, the check stops with one plain sentence ("A check needed a file outside its copy, and squad-kit blocked
it. An engineer can allow it in Settings."), and the file's path is in the details. On Linux the guard needs bubblewrap, and
this page and `squad doctor` say how to turn it on.

**The guard stops accidents and most bad behaviour, but it is not a wall against code built on purpose to break out.** A
command can still reach the network. On a Mac it can talk to other local services and read the environment of your other
programs, so use squad-kit's sign-ins, not keys exported in a shell. On Linux it can reach your session's bus and gpg agent
under `/run/user`. It can use a key loaded in an ssh agent, though not read it. Use squad-kit on projects and tickets you
trust, and read what the Builder changes. `SECURITY.md` has the full list.

**Caches**: package caches stay open. All of `~/.cache` and `~/Library/Caches` stay read only, as your own tools run programs
from there, and a command's other tools keep their caches with the copy, so a ticket's first build may download again.
Playwright gets a folder with the copy, with the browsers this computer has already linked in, so its tests run and `playwright
install` downloads only what is missing. Puppeteer and Electron download to the copy's cache. On a Mac, Chrome's own sandbox
cannot start inside the guard, so a project that opens Chrome through Puppeteer needs `args: ['--no-sandbox']` there; Playwright
needs nothing. Another tool that installs itself there (Cypress) gets the blocked-file sentence until an engineer allows that
folder.

**Docker in the guard**: a container can mount any folder on this computer, so the project's own commands can't reach
Docker, or colima, lima, Rancher Desktop, OrbStack, Finch or Podman. A check that tries stops with one plain sentence ("A
check tried to use Docker, which is not open to the project's own commands. An engineer can allow it in Settings."), and
the socket is in the details; so does a setup or an app's start. If your project's tests talk to Docker directly, they get
that refusal until a person allows it: allow the socket's folder in Settings, or run `squad config set allow-write <folder>`,
and point the tests at it with `DOCKER_HOST`. That opens everything the guard hides to those tests, so it is a choice for a
project you trust. On a Mac, Docker's own port on this computer (2375 and 2376) is refused too, and has no setting to open
it. On Linux that port stays open. 1.2.0 and 1.2.1 had no such rule.

**The project's own commit hooks** run in that guard too, at one moment only: when a change is saved. They look at it in
a throwaway git folder that squad-kit makes outside the project, so the real one stays read only, all of it. A hook sees
your branch by its real name, the other branches and tags, the repo's own filters and git's stash, as lint-staged uses it;
its stash, its objects and any commit of its own go when the folder goes. Only the files in the copy and the commit's words
come back, and squad-kit stages the files itself and makes the real commit. **So what a hook staged counts for nothing:** a
file it force-adds with `git add -f` stays out if git ignores it, a file it takes out with `git rm --cached` goes back in, and
a report file it leaves in the copy goes in. The folder has none of the repo's other settings, so a hook that needs a remote
or fetches says no, and the ticket gets the usual card with **Save without this check**. A Stop, a hook that runs out of time
or a crash puts the files back as they were staged and removes new ones. What was on disk then is kept in
`refs/squad/on-disk/<ticket>`, so an edit made in that moment is not lost, and the ticket says so after a crash. npm and npx
get a cache folder of the copy's own, so `npx` in a hook works with no packages installed. No other hook runs: squad-kit runs
no `pre-push`, `post-merge` or `post-checkout`, since the project's own checks have run by then. A push from your own
terminal still runs yours. A project that uses Git LFS still gets its large files uploaded when squad-kit pushes.

**Windows: less protected.** On Windows, squad-kit does not guard the agents' own commands or the project's own tests
and app, so they can reach other files on the computer. Screenshots and the app still go through the window. Use it on
projects you trust. Windows is also not fully tested yet. This page and Settings say so.

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
- **Desktop notices**: on or off, for this browser. **Turn on** says at once that the browser is asking; if the
  browser doesn't answer, it says how to allow notices for the page (and, on a Mac, in System Settings ›
  Notifications). When they are on, it sends one test notice.
- **How you pay for Claude**: squad-kit finds out (subscription or API key); change it here if it is wrong. With an
  API key: a budget per ticket and per month. Terminal: `squad config set payment`, `squad config set budget`.
- **Windows: less protected**, on Windows only. See [Squad and AI](#squad-and-ai).
- **Websites the squad may reach**: on top of the package registries, for the sandbox. Shared by the team.
  Terminal: `squad config set hosts`.
- **Also read** and **Also write**, for engineers, where the guard runs: files or folders outside its copy that the
  project's own commands may use. Add one only when a check stopped because squad-kit blocked a file the project truly
  needs. Shared by the team, and agents can't change it. Write the full path, or start it with `~` for your home folder.
  Terminal: `squad config set allow-read <path>`, `squad config set allow-write <path>`, and `--clear` on either.
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
  and restarts the app on the same link. The banner shows what is new in every release since your version.
  **Check for updates** also reads the notes again. Terminal: `squad upgrade`.
