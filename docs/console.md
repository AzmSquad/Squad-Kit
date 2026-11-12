---
title: The app
description: A short tour of the squad-kit 1.0 app - Home, the board, the ticket drawer, the Harness page and Settings.
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
- **New project**: for when you have only a BRD or an idea. Give it a name and the BRD or the idea, and squad-kit makes
  the folder (in Documents, unless you pick another place), git and the board. A BRD goes straight to the Analyst, who asks
  only about real gaps. An idea goes to the Architect, who writes first stories from it. With no code yet, the first story
  picks the tools and makes a first version that starts, and the others wait until it merges, so they all build on the same
  start. For a BRD, squad-kit adds that story itself as **Set up the product**, and you approve it with the rest.
- **Add project**: a folder browser inside the page. It says what kind of folder you picked (empty, code,
  several repos, already a squad-kit project) and what will happen. **New folder here** makes a folder for a
  new project.
- **Tickets at once**, at the top: how many tickets the squads work on at the same time, across all projects.
  They share your AI account, so this is one number for all of them.

Terminal: `squad projects`, `squad projects --new "Visitor log" --brd brd.pdf` (or `--idea "what you want"`), `squad inbox`.

## The board

Each project has its own board. The sidebar has the project's pages: **Overview**, **Requirements**, **Board**,
**Backlog**, **Waiting for you**, **Conversations**, **Releases**, **Architecture**, **Bugs**, **Harness** and
**Settings**.

On a project with several repos, one story can change several parts of the product. The Architect names the parts, the story
gets one folder with a copy of each, and each changed part runs its own checks. You still see one story, with one approval.
For the proof and Try it yourself, squad-kit runs everything the change touches, on the parts' usual addresses, one story at a
time. If another program holds one of those addresses, it says so. A part that runs in Docker needs its compose files locked in
Settings: squad-kit then runs its own `docker compose up`, under a project name of its own, and stops it without removing data.

Looks right on a story across parts saves every part and tries every merge first. If one clashes, nothing moves. A release sends the
parts in order, what others rely on first. If one fails to go out, what relies on it waits, and **Send again** finishes it. There is no
undo. A story across parts does not open pull requests yet: it goes out by push.

A "done when" no page shows, like what an API answers, is proved by asking: squad-kit makes the call and saves it, and the proof
shows what was asked and what it answered. squad-kit's own check reads the saved answer, not the Tester's words about it.

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
  **Connect a tracker**, when there is none). Under the track (Full or Express), **Write new tests** is on by default.
  Turn it off for a demo, a small text or colour change, or a project with no tests yet: the plan and the Builder add no
  new tests and the Reviewer does not ask for them, while squad-kit still runs your project's own checks (tests, lint,
  build), the review and the proof, so a break of what already works still shows. The story then says **Built without new
  tests** on its card ("No new tests"), on its proof, in the pull request and in the release notes. An engineer can keep
  new tests on for every story in Settings, and the switch is then gone. Terminal: `squad new --no-new-tests`.
- **The footer**: tickets released and bugs found in the last 30 days, open tickets, what the squad used, and
  **Report a bug**.
- **Show archived**, under the board: archived tickets, each with **Unarchive**.

**Your apps**, in the sidebar: each app of the project with its state (Not running, Starting, Running at its
address, Stopped, Failed with the reason) and **Start**, **Open**, **Restart** and **Stop**. squad-kit runs the
app from its own copy of `main` on this computer, never your own folder, and brings that copy up to date first
(running the setup command when the dependencies or the database changes changed). Your `.env` files come along: squad-kit copies them from
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
steps shows how far it is. Under each finished step is how long the squad itself worked there, from its agents' own
steps: a wait for your answers or approval, for another story, for a free place, and a chat are not counted. A long wait
gets a small second line, like "waited 25 min for you". When the checks used the Builder's own passing run, Test says so,
like "3 s · checked with the Builder's run", or "tests from the Builder's run" when the other checks ran. A ticket built from a breakdown says where it comes from ("From BR-1 › Payments ›
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

**After Looks right.** While the change is saved (with the project's own checks) and merged, the card, the story and
the proof page show a spinner and say so: "Saving the change, then it merges", then the pull request's own line, like
"Merging pull request 15". When newer work in main changed the same lines meanwhile, squad-kit brings in the newest
code by itself: the Builder settles the clash, the checks, the review and the proof run again, and the proof comes
back to you. It does that up to 3 times while main keeps moving. Then, or when main has not moved since it last came
in, the story shows the clash card with its ways out.

**A pull request merged outside squad-kit.** When you accept a story, squad-kit opens its pull request and merges it
at once. When it cannot (the pull request waits for an approver, or it clashes with newer work in main), someone can
settle it and merge it on the code host, such as Azure Repos, instead. squad-kit notices by itself: a few seconds
after the board opens a project, and every 5 minutes while it runs, it asks the code host about each pull request it
opened that is still open. When one was merged there, the story shows as merged, it goes into the next release, your
own copy of main catches up, the tracker item moves on, and the stories that wait for it start. To ask now, press
**Check again**: on the clash card ("Clashes with main"), on a story whose pull request is open or waits, and on the
card of a story that waits for another one ("Waits for AB-46 to merge"). It says in one line what it found: merged,
still open (nothing changes), or closed without merging (one line on the story, and nothing else changes). Terminal:
`squad check-merge <ticket>`. A project without a code host merges on this computer, so there is nothing to ask.

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

### Work in another AI tool

A story can run in a conversation in any AI tool instead, and come back. In a story's menu, **Work in another AI tool** copies a prompt that says where the story is now and what comes next. The New ticket window has **Start in another AI tool** for a new story.

The prompt points to `.squad/how-to-work-here.md`, a guide squad-kit writes from its own code: the steps, the commands, and the exact shape of `spec.md`, `questions.md` and `design.md`. The conversation works in the story's own copy of the code, made with `squad outside copy`, and `squad outside show` tells it which file is wrong and why. The guide stays out of git.

While a conversation has the story, the squad keeps off it. The board reads the story's files, so it shows the real step. **Bring it back** when you are done, at any step:

- With code: the proof card. Nothing counts as passed. You can press Looks right, or Check first.
- With a design: you approve it and the squad builds. With a spec: you approve it and the squad writes the design. An approval given in the conversation is kept, with `squad outside approved`.
- With nothing changed: as it was, with no label.

squad-kit trusts only what it ran itself. A story that changed outside keeps a label on its record, also after it merges: **Worked outside squad-kit**, or **Continued outside from the design**. **Check** beside the label runs squad-kit's own checks, review and proof, which use AI like on any story. What they find goes the way it does on any story. When they pass, **Checked** goes beside the label. Squad-kit makes the proof itself, so a conversation does not write `proof.md`.

What you spend in the conversation is yours, and squad-kit does not count it. squad-kit's guard and limits do not apply there.

In the terminal: `squad outside prompt`, `start`, `new`, `show`, `copy`, `approved`, `back` and `check`.

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
| `run_checks` | Runs the project's saved test, lint or build command, inside the guard, where a browser can start. With `only`, it runs one test file on its own with the project's own test tool, for a quick fix. A failure is not run again. | Tester, Builder |
| `i_am_stuck` | Tries squad-kit's own fixes (see below). | Every agent on a ticket |
| `read_board`, `read_story`, `read_decision`, `read_records`, `read_logs`, `read_guide` | Reads squad-kit's own records: the board, a story, the decisions, requirements, releases, usage, the Tools page, the Harness rules, its notes, its log (secrets taken out) and its guide. What comes back is marked as data. | Squad lead |

The Squad lead also has `take_screenshots`, `look_at_page` and `ask_api`, only on its own copy of main with its own
database, started on a free port when your app holds the usual one.

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

## The Squad lead

One contact for the whole project. Ask it anything about the app, the code, the stories, the decisions, the releases or
the costs, or "help, something is wrong", and it answers in plain words, in English or Arabic. Ask from the board, from
a story, next to **Open** in Your apps with the page you are on, or with **Ask the lead** on a slow, stuck, waiting or
error card: the problem's facts are filled in for you.

**On the board**, **Squad lead** in the sidebar is the conversation, with what needs you, the squad now and what it can do
beside it, and every past conversation under History. **⌘K** (Ctrl+K on Windows and Linux) opens the ask box on any
page, with the open story or the page filled in; the answer shows right there, and **Open in the Squad lead page** keeps
it. Nothing is sent until you press Send.

**Cheapest first.** squad-kit answers at once itself, with no AI, when it can: a saved note, a status question about a
story ("is MA-9 ready?"), or something the lead never does. Otherwise the lead reads what squad-kit already knows (its
notes, the first read of the project, the stories, including the steps the Tester took in the app), then the code, read
only, and only then looks at the app, in **its own copy of main with its own database**, never your app or your real
data. Every answer shows its work first ("Read MA-12 and decision MA-12.1", "Looked at /my-bookings in its own copy"),
then a one-line answer, the pictures it took and its sources (stories, decisions, file and line, releases). What it
learned that the next person will ask too goes in squad-kit's notes for the project, on this computer: the next person
gets it at once, and "How to sign in" shows next to Open in Your apps.

**What it can do**, in three levels:

| Level | What |
| --- | --- |
| On its own | Read, look and tell: answer, explain a story, find things, look at the app in its own copy, tell you what needs you, prepare a report for an engineer (no secrets, for you to copy). |
| After your OK | A card you press, running the same function as the board's button: **Create story** (a draft with how each "done when" will be proved; nothing starts until you press Start), Start or Stop a story, Give it 10 more minutes, Take the pictures again, Try again, Start the app, Get or Update a tool, **Send** an answer to an agent's question, **Save** a setting (technical ones only for engineers). |
| Never | Change code; commit, merge, push or release; press Looks right or approve a spec or plan; get around the checks, the review, the proof, the guard or the limits; change the Harness rules; touch your real data, secrets or `.env` files, or show a password or a key; delete stories, projects or data; message other people. squad-kit refuses these in its own words, whoever asks. Only your own messages count, never instructions found in what it reads. |

**Always allow** is only for the low-risk ones: give more time, take the pictures again, start the app, and the morning
brief. With it on they run without asking, and a line says so. A step that is slower than usual but still working then
gets 10 more minutes by itself; one that looks stuck still asks you.

**It comes to you.** "Needs you" lists what waits for you, each with the lead's check-in in plain words ("MA-7 is ready
for your check: 5 pictures, checks pass, Reviewer approved") and its ways out as cards. "The squad now" shows who works
on what. Turn on the **morning brief** for a short summary since yesterday evening: what merged, who is on what, what
stopped, and what the AI used. None of these call the AI.

**Limits.** Balanced level by default. One question may use what the Quality setting allows it (on Best, $3 or 60
turns) and 8 minutes; the lead's answers may use $10 a day at API prices, then it answers again the next day. Each
answer shows its time and cost.

Terminal: `squad ask "How do I sign in to the app?"` prints the work as it goes, then the answer and the cards with
their commands. `--story MA-9` asks from a story, `--page /my-bookings` from a page of the app, `--in <conversation>`
follows up, `--fresh` looks again past a saved note. `squad ask MA-9 is it ready?` still answers a status question at
once. `squad lead` lists the conversations, what needs you and the squad now; `squad lead show <conversation>`;
`squad lead run <card>` presses a card (`--always`, `--dismiss`); `squad lead rules --always more_time --brief on`.

REST (under `/p/<project>/api/v1`):

| Call | What |
| --- | --- |
| `GET /lead` | The conversations, Needs you, The squad now, the morning brief when it is on, your rules, and today's cost and limit. |
| `GET /lead/needs-you`, `GET /lead/squad-now`, `GET /lead/brief` | Each on its own, for the rail and the phone. |
| `POST /lead/conversations` | Ask: `{ "text": "...", "context": { "from": "app", "path": "/my-bookings" } }`. The context is `board` (with `page`), `app` (with `path`), `story` (with `story`) or `problem` (with `problem`: slow, stuck, waiting or error, and `story` or `error`). `"fresh": true` looks again past a note. It answers with the conversation: answered when squad-kit answered itself, else `thinking` until the answer is in. |
| `POST /lead/conversations/<id>/messages` | A follow-up, the same body. |
| `GET /lead/conversations/<id>` | The conversation: each question with its facts, the work trace, the answer (headline, body, evidence, sources, cards, learned), the time and the cost. |
| `POST /lead/conversations/<id>/stop` | Stop the answer being written. |
| `POST /lead/cards/<id>/run` | Press a card. `{ "always": true }` turns Always allow on first, only for the low-risk ones; `{ "dismiss": true }` is Not now; `{ "edits": { "title": "...", "doneWhen": [...] } }` is Edit before Create. |
| `GET /lead/rules`, `PUT /lead/rules` | Always allow and the morning brief: `{ "always": ["more_time"], "brief": true }`. The never list is shown and cannot change. |
| `GET /lead/can` | The three levels in words, what it reads, and its limits, for "What it can do". |

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
  `squad release --mark-sent --reason "…" [--anyway]`. A team's release check that failed or could not run holds the release;
  go on past it, with the reason on the record: `squad release --go-on "…"`.
- **Architecture**: every decision. **Map** shows how decisions build on each other, **Timeline** shows them per
  ticket (press **Play the history**), **Stack** shows each technology in the code and why it is there, plus
  **All decisions**, **Project map** and **Lessons**.
- **Bugs**: each bug, linked to the release it was found in.

After a merge or a release, `.squad` files can show as changed in `git status`. That is squad-kit saving its own state, and
it stays out of your way: merges and releases keep this computer's newer copy. Leave them out of your own commits. If a hand
`git pull` is refused over one, `git checkout -- <file>` lets the pull through.

## Tools

**Tools** in the sidebar opens "What this project needs": every tool this project uses on this computer, from what
squad-kit reads in its files (a web app, a Flutter or React Native app, an iPhone or Android app, Docker). The first
lines are git and an AI tool, as on the first start. Lines come in three groups: **Required** (some steps can't run
without it), **Recommended** (things work, in a simpler way) and **Optional**. Each line says what the tool gives,
whether it is here (Ready with its version, Missing, Too old, Getting it now, or Not on this computer, like Xcode on
Windows) and what it is used for. Versions count: with Xcode 27, a Flutter older than 3.44.8 is Too old for iPhone
builds.

- **squad-kit gets it**: Maestro, Java when this computer has none, and the **Android phone tools**. **Get it**
  downloads the official release into squad-kit's own folder (`~/.squad-kit/tools/`), checks its published checksum,
  and shows the progress and the time left. No password, no Homebrew. A failed or cut download leaves nothing behind
  and says why.
- **Android phone tools**: Google's own emulator and build tools, so no Android Studio is needed: the command-line tools
  (pinned to one build, by the checksum in Google's own manifest), then Google's sdkmanager installs platform-tools, the
  emulator, Android 16 (API 36), its build tools, the NDK Flutter's template names, and one system image (Arm on a Mac
  with Apple's chip, x86_64 on Intel and AMD computers). Google's license comes first: **Read and accept Google's
  license** shows it in full, as Google's manifest gives it, with **Accept** and **Not now**. squad-kit never accepts it
  for you; Get it waits for your Accept, and sdkmanager is answered yes only to the licenses you accepted. The line says
  how big it is and how long it takes ("about 20 GB on this computer, about 12 minutes the first time"), and Get it looks
  at the free room first: with less than about 20 GB free it says so and gets nothing. A download that gets no new bytes
  for 2 minutes is stopped and tried once more, then the line says so plainly. Java comes first when this computer has
  none (Google's tools run on it), and Maestro with it. An Android SDK of yours (`ANDROID_HOME`, or Android Studio's own
  folder) that has everything is used as it is and never changed; one that lacks something is left as it is, and squad-kit
  gets its own. On Windows and Linux computers with an Arm chip, Google's emulator doesn't run yet: the line says so.
  **Android Studio** shows as Optional: squad-kit doesn't need it.
- **You install it**: the line says why squad-kit can't ("needs your Apple ID"), gives short steps and the official
  page. Press **Check again** after installing. On Mac and Linux, Check again reads your terminal's PATH, so a tool you
  just installed is found without closing squad-kit, and the agents squad-kit starts after find it too.
- **Update Flutter**: when your Flutter is Too old, the line gives the steps to update it yourself (`flutter upgrade`,
  or `brew upgrade --cask flutter` and FVM's own steps for those). When it is safe, squad-kit can also run Flutter's own
  `flutter upgrade` for you (never with `--force`). Safe means: your Flutter folder is a copy of Flutter's own
  repository, on one of its channels (stable, beta, main), with no changes of its own, you can change it without a
  password, and no other tool (Homebrew, FVM, a snap) looks after it. Flutter is shared by every Flutter project on the
  computer, so **Update Flutter** first asks inside the line: "This updates Flutter for every Flutter project on this Mac,
  not only this one. Older projects may need small changes to build again. It downloads about 1 GB and takes about 5
  minutes." **Update Flutter for all projects** starts it; **Not now** leaves it. The line shows each step in plain words
  and the time left; steps that need Flutter wait meanwhile. After it, squad-kit checks again, so the line turns Ready
  and a waiting story goes on. When it fails, the line shows Flutter's last useful words and the steps stay. When it is
  not safe, the line says why in one sentence ("your Flutter folder has changes of its own") and gives the steps.

A missing Required tool stops only the steps that need it. In this version, a story's build and its checks: the story
waits with a plain message, "squad-kit can't build this story yet: Flutter isn't on this computer", with **See what's
needed** linking to the line. It never fails over it, and goes on by itself once the tool is there. squad-kit looks
again when you press Check again, when you open the waiting story, and every few minutes while one waits.

Terminal: `squad tools`, `squad tools check`, `squad tools get maestro`, `squad tools accept android` (prints Google's
license in full and asks yes or no; `--yes` accepts without asking), `squad tools get android`, `squad tools update
flutter` (shows the same warning and asks yes or no; `--yes` says OK without asking).

REST (under `/p/<project>/api/v1`): `GET /tools`, `POST /tools/check`, `POST /tools/<tool>/get`,
`GET /tools/<tool>/license` (the license in full, from its maker), `POST /tools/<tool>/accept` with the body
`{ "licenses": ["android-sdk-license", ...] }` (every license you were shown), and `POST /tools/<tool>/update` with the
body `{ "ok": true }`. Without the OK, the update call answers with the warning and changes nothing; without the Accept,
Get it for the Android phone tools answers why and gets nothing.

### iPhone pictures

For an iPhone app (Flutter, React Native or native, on a Mac), the Tester's pictures come from a real iPhone simulator
that squad-kit runs itself, hidden: no Simulator window opens. squad-kit makes its own **squad-kit iPhone** and
**squad-kit iPad** once, on the newest iOS this Mac has, and uses them again by the id it keeps in
`~/.squad-kit/phones/devices.json`. It touches only those two, by their id: nobody else's simulator is started, stopped
or changed.

- **The app** is built for the simulator in the story's own copy, outside the agents' sandbox: Flutter with
  `flutter build ios --simulator --debug`, React Native and native apps with `xcodebuild` (after `pod install` when there
  is a Podfile), into the copy's `build/squad-kit-ios` folder, which git never sees. It builds again only when the
  copy's code changed.
- **Taking the pictures**: Maestro taps through the app by the words on the screen (the Tester's steps are the same as
  in the browser: click, fill, select, press, wait), one Maestro kept running per booted phone. Each picture starts the
  app fresh, in English or in the language the Tester asks for (`"ar"` opens it in Arabic). A page opens by the app's
  own link when it has one; else every picture starts on the app's start screen. Each picture is labelled with its
  device ("iPhone 16 Pro", "iPad Air 11-inch (M2)") on the Proof page. Maestro's usage numbers stay off, and what it
  writes stays in `~/.squad-kit/phones/`.
- **Times**: every long step says what it does and about how long it takes: building the app (first guess 5 minutes),
  starting the phone (1 minute), putting the app on it (15 seconds), and Maestro's first run on a phone (1 minute).
  After the first time, squad-kit uses the times it measured on this computer (`~/.squad-kit/tools/times.json`).
- **One at a time, gently**: one of squad-kit's phones runs at a time, shared by every story (and by two squad-kits on
  one computer). Before starting one, squad-kit looks at the free memory and the load; when the computer is busy it
  says "The computer is busy. squad-kit waits a moment before starting the iPhone." and waits, without failing the
  story. A phone shuts down after 10 minutes unused, and when the board stops. When something else keeps it open (an
  open Simulator window starts it again), squad-kit leaves it.
- **When the iPhone tools are missing** (Xcode, the simulator, Maestro, Java, or a Flutter too old for this Xcode) and
  the app has a web version squad-kit can start, the pictures are of the web version, labelled "Web version", and the
  story says so in one line, for example "iPhone pictures need Xcode. squad-kit took pictures of the web version
  meanwhile.", with **See what's needed** on the Proof page. With no web version either, the story waits before its
  pictures with the reason, and goes on by itself once the tools are there: it never merges without them. On Windows
  and Linux, an iPhone simulator needs a Mac.

- **Maestro and Java** are got by squad-kit itself the first time phone pictures need them, once Xcode is ready, with
  the same Get as the Tools page: the story waits for that short download with its progress and time left ("Waits for
  Maestro, which squad-kit is getting now (45%, about 40 seconds left). Goes on by itself once it's there"), and the
  Tools line shows the same. A get that did not work is not tried again by itself: the line says why, with Get it.

**Start and Try it yourself on the iPhone.** For an iPhone app on a Mac, **Start** in Your apps opens it on squad-kit's
iPhone: squad-kit's copy of main is brought up to date and set up, the app is built for the simulator, put on the
iPhone, started, and shown in the Simulator window. That window is the one squad-kit ever opens, and only here. Each
step shows with the time left from this computer's times ("Building the app for the iPhone, about 4 minutes left"), and
once it runs, the device ("Open on iPhone 16 Pro"). **Try it yourself** does the same with the story's own copy.

- When the app comes in more than one language (Flutter's `lib/l10n/*.arb` or the folder its `l10n.yaml` names, an
  iPhone app's `*.lproj` folders), a list next to Start picks it, English by default. Not for React Native.
- When it also has a web version, **Use the web version now** shows the whole time: it stops the phone start (or the
  app open on the phone) and starts the web version the way Start does today. When the iPhone tools are missing, the
  line says why with **See what's needed**, and Start opens the web version meanwhile.
- **Stop** closes the app and shuts the iPhone down. When you close the Simulator window yourself, squad-kit sees it
  and marks Start or Try it yourself as stopped ("You closed the iPhone window, so squad-kit stopped the app."). It
  never opens the window again by itself.
- **Sharing the one iPhone**: the Tester's pictures and Start or Try never run on two simulators at once. While you
  have the app open on the iPhone, a story's pictures wait: "squad-kit's iPhone is open in Try it yourself. The
  pictures wait until you close it." After 15 minutes of a story waiting (the same rule as for the running product),
  squad-kit closes the app there, says so ("squad-kit closed the app on its iPhone: a story needs the iPhone for its
  pictures. Press Try it yourself again later."), and the pictures go on.

### Android pictures

For an Android app (Flutter, React Native with or without Expo, or native with Gradle), the Tester's pictures come
from Google's own Android emulator, run by squad-kit itself, hidden: **squad-kit Android phone** (a Pixel 9) and
**squad-kit Android tablet** (a Pixel Tablet), made once with Google's avdmanager in squad-kit's own folder
(`~/.squad-kit/phones/android/`), each started on a fixed port so its serial is known (`emulator-5560`,
`emulator-5562`). The first start is cold and saves a snapshot; every start after loads it in about 5 seconds. Every
emulator and adb call gets squad-kit's folder as its home, so nothing goes to your `~/.android`; your own phones and
emulators are never listed, started or stopped, and your own adb server is never stopped. When no adb server runs,
squad-kit starts its own, writes down its exact process, and stops it again when its phones shut down (after 10 minutes
unused, and when the board stops); one that was running before is yours, and is used as it is.

- **Which phone**: an app for both iPhone and Android uses the iPhone on a Mac when its own tools (Xcode, the simulator,
  CocoaPods) are ready, else Android; on Windows and Linux, Android. **Settings → Phone for pictures** chooses iPhone,
  Android or Automatic for the whole team (`squad config set phone iphone|android|auto`, or `PUT /settings` with
  `{ "phone": "android" }`). Only the chosen phone's tools count: an app for both never waits for the other one's.
- **The app** is built in the story's own copy, outside the agents' sandbox: Flutter with `flutter build apk --debug`,
  native apps with `./gradlew assembleDebug`, React Native with `./gradlew assembleRelease` in `android/` (its debug
  build waits for a dev server the pictures don't have; the release one carries the app's code and signs with the
  debug key, as React Native's template does). An Expo app with no `android/` (or `ios/`) folder gets one made first by
  `npx expo prebuild --platform android --no-install`: that folder stays squad-kit's own, hidden from git in that copy,
  and no commit ever takes it. Gradle keeps one home for all projects (`~/.squad-kit/caches/gradle`), compiles Kotlin
  inside itself, and its helper is stopped after each build (`gradlew --stop`). What the build changes in the story's
  own files (Flutter rewrites `pubspec.lock` and `analysis_options.yaml`) goes back, so the story's changes stay the
  Builder's; the same holds for iPhone builds. It builds again only when the copy's code changed.
- **Taking the pictures**: the same Maestro and the same steps as on the iPhone, on the emulator's serial. Android's
  screen is read by its own rules: its status bar and navigation are left out, and so is the keyboard, whose suggestion
  strip repeats the words just typed; the keyboard is put away only when it shows. Each picture starts the app fresh in
  its language (Android 13 and newer open one app in its own language, set on every launch; older systems switch the
  whole phone), and is taken with `adb exec-out screencap -p`, labelled with its device ("Pixel 9").
- **Checks and the agents' own commands** that build an Android app (`flutter build apk`, `./gradlew …`) get squad-kit's
  Android tools too: the SDK and squad-kit's shared Gradle home read only, Java 17 or newer, and Kotlin inside Gradle. In
  the guard, Android's own folders and Gradle's home are the project's cache home, and Gradle reads what squad-kit's own
  builds downloaded from the shared home (`GRADLE_RO_DEP_CACHE`), so nothing downloads twice and no story can change
  what squad-kit's own phone builds run. A Flutter app's build check is `flutter build web` when it has a web version, and
  none otherwise: when the first read hands in `flutter build apk` (or `appbundle`, `ios`), squad-kit swaps it and says
  so in the log, as squad-kit's own phone build for the pictures already shows the app builds.
- **A missing tool is not the Builder's**: a check that fails only because a tool is missing ("No Android SDK found",
  "JAVA_HOME is not set", "xcrun: error", "command not found") counts no try. squad-kit looks at the tools again and runs
  the checks once more; still missing, the story waits with the Tools page's line, or a card says what to install.
- **Times**: first guesses from a 16 GB Mac: building the app 9 minutes the first time (Gradle fetches its libraries),
  then seconds; starting the phone 40 seconds the first time, then about 5; putting the app on it 5 seconds.
- **Start and Try it yourself** work as on the iPhone. A hidden emulator can't show a window later, so for you it starts
  again from its snapshot with its window (about 5 seconds), and the app goes on after. **Stop** closes the app and
  shuts the phone down by its serial; closing the emulator's window yourself stops it too.
- One phone runs at a time, iPhone or Android, shared through the same queue, and it shuts down after 10 minutes unused
  and when the board stops. On Ctrl-C or a stop signal the board first closes Maestro, then shuts its phones down (the
  emulator by its serial, with the console token in squad-kit's own folder; if the console says no, its exact process),
  then stops the adb server it started, 20 seconds at most, and only then ends.
- `squad phone start android` (or `iphone`, `POST /phone/start` with `{ "phone": "android" }`) brings squad-kit's phone
  up now, hidden, with Maestro ready, so a story's first pictures wait for nothing. It shuts down by itself when unused.

Terminal: `squad phone` shows squad-kit's phones, iPhone and Android, whether each runs and when it shuts down by itself;
`squad phone stop` shuts them all down now (one taking pictures for a story is left, and it says so).
`squad app start <app>` opens a phone app on its phone; `--phone` asks for it, `--web` starts the web version instead,
`--lang ar` opens it in Arabic. `squad try <ticket>` takes the same `--phone`, `--web` and `--lang`.

REST (under `/p/<project>/api/v1`): `GET /phone`, and `POST /phone/stop`, which answers with the same and a `message`.
`POST /apps/<app>/start` and `POST /tickets/<ticket>/try` take `{ "phone": true }`, `{ "web": true }` (Use the web
version now) and `{ "language": "ar" }`; their status has `phone` with the step, the time left and the device.

## Harness

Everything the engine does, with the real values from the engine and what really happened on this project's stories. At
the top: how many gates are working, how many stopped something this week, and how many need you. Press one to filter the
list; with one story waiting, **needs you** opens it. Six tabs:

- **The line**: the stages from Setup to Release for each track, with a red number where a stage stopped something this
  week, and each gate: what it checks, what happens if it fails, which tracks skip it, and how often it passed and stopped.
  One search covers every stage, and each gate has a link of its own. **Details** opens what really runs, and **For
  engineers** opens it on every row and is remembered in this browser.
- **Compare tracks**: what each track does at each gate, made from the engine's own data. **Only what differs** leaves out
  the rest.
- **Limits**: tries, rounds, pictures, refusals, time limits, and the most one run can use on your Quality setting, with
  when a limit was last reached.
- **Safety**: what is hidden, what no agent can change, where agents can go, which questions never reach you and what
  agents can ask squad-kit to do. The project's **network level** is here, in one plain sentence (see below), with
  **Websites the squad may reach**: on top of the package registries, shared by the team, used on Strict. Under **For
  engineers**: the three levels to pick from and the sites refused lately (site, story, level, when). Terminal:
  `squad config set network` and `squad config set hosts`. **Your own database** says in one sentence whether each story
  gets its own copy of the database; the details are under **For engineers** (see Settings, **Each story's own
  database**).
- **Agents**: see below. `/squad` opens this tab, so old links still work.
- **Your additions**: what your team added. See below.

Every number counts stories, from the project's own stories on this computer, in the last 30 days; this week is the last 7.
A gate with no record shows no number.

### Your additions

Add to your harness, and it applies from the next step of every story. Additions can only make the squad stricter, and
squad-kit's own gates have no off switch. They are saved in `.squad/harness.yaml`, shared through git like the settings; no
agent can change that file, and the engine reads it from the project's main folder, never from a story's copy. If it can't
be read (a merge clash, say), the page says so and stories stop and ask at each check instead of going on without your gates.
Your team gets your additions with your next release, and squad-kit puts each person's copy together, so one person's release
never takes away what another added. A project that keeps its board out of git keeps them on that computer, and the page says so.

- **A rule**: words one agent or all agents follow, sent after squad-kit's own and only adding care. On or Off.
- **A checklist**: questions the Reviewer or the Tester answers one by one, with the answers on the story. On Try first a no
  stops nothing. On, a Reviewer's no is a review finding, and a Tester's no goes the same way as a "done when" not shown.
- **A gate**: a command squad-kit runs itself, with the runner of the project's checks, in the guard, in the story's copy. No
  agent is asked if it passed, and what it changes in the copy goes back. **Try it now** runs it once on clean code first: a
  command that can't run can't be saved, and one that fails today stays on Try first or warn only.
  - **With the checks**: a failure takes the road of a failed project check.
  - **Before merge**: it runs when the accepted change is saved. A failure takes the road of a refused commit hook.
  - **Before release**: it runs on a copy of what is about to go out, before anything changes. A failure holds the release
    back; try again, or go on with a reason that stays on the stories and the release notes.
  - **A gate that can't run** (the tool is missing, it ran out of time, the guard refused it, its part is gone) never counts
    against the story. It tries once more by itself, then a card: Try again, Let an engineer look, or Go on without this
    check with a reason. On Builds by itself the story waits for a person.
  - **A story that changes what a must-pass gate runs** stops the way weakened tests stop.
- **From a folder**: pick a folder, tick what comes in and choose the agent. Nothing in the folder runs while squad-kit looks,
  and it reads text files only, with limits, never keys. What repeats squad-kit's own process stays out. A gate from a
  folder still needs its own try. The same name again shows as already added.

Try first, On and Off are on each row; Remove asks once and stays on the record, and **Who did what** lists every change.

squad-kit also runs a project's `scripts/check`, when it has one and no other command runs it, as one more check.

### Agents

The five roles, each its own agent with its own session and tools. For each one you see what it can do, its AI tool, its
model level, your team's rules for it, its core prompts and what it works on now. Below: the limit of tickets at once,
what each role used, and your AI tools (**Ready** or **Not found**).

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
and Go use their own caches, which check every package against the lock file. Every other tool keeps its downloads in
the project's own download folder, which all its stories share (see **Caches** below), never in your own caches, so only
the first story downloads. They can't read your keys and sign-ins (`~/.ssh`,
`~/.aws`, the GitHub and cloud sign-ins, squad-kit's files) or the project's `.env` files. Which websites they reach is
the project's network level (below). A blocked command shows in the Conversation tab with what and why. Where the
sandbox can't run (Windows, some Linux setups), steps run as before, and this page and `squad doctor` say so.

**Network level**: one setting per project, kept in `.squad/config.yaml` with the allowed websites, so the whole team
shares it through git. An engineer picks it on Harness → Safety (under For engineers) or with
`squad config set network standard` (or `strict`, `off`). It applies from the next step and the next command.

- **Standard** (the default): any website but known-bad ones. Your keys stay hidden, so a harmful package has nothing
  to take.
- **Strict**: the official package and download sites of common tools (npm, PyPI, Maven and Gradle, Google's Maven,
  NuGet and .NET, Dart and Flutter, Packagist, Go, crates.io, RubyGems, CocoaPods, Prisma, the browsers for browser
  tests, GitHub downloads and more), plus the websites you allow. Your project's own tests, setup and app still reach any
  site on Strict for now: closing them needs a part that sees site names, planned for a later version.
- **Off**: no internet, only this computer. On a Mac this covers the project's own commands too: they still reach the
  app squad-kit started on this computer, and nothing outside it. On Linux, Off closes the agents' commands only. Pick
  Off only when everything the project needs is already on this computer.

On every level the same sites stay closed: tunnels that open this computer to the internet, paste and file-drop sites,
and request catchers. A build never needs them, and they are a common way to take data out. They cannot be allowed.
squad-kit keeps both lists (`src/engine/network-lists.ts`) and updates them with each release.

**A refused site never stops a story and never asks you anything.** The story gets one plain line, such as "A download
from cdn.example.com was not allowed for this project; the work goes on without it." squad-kit tells the Builder and
Tester up front what their commands reach and that a refused site is closed on purpose, so they get what they need from
an official package site or the copy, or go on without it and say what is missing. Nobody restarts anything for it.
Engineers see each refused site under For engineers on Harness → Safety, and in `squad config set network`, and can
allow a site the project truly needs (on Strict).

Every agent, including the ones that only read, is also refused your keys and sign-ins through its file tools. A push from
an agent or from a story's own command goes nowhere, while squad-kit's own push works. Two limits: a remote with its own push
address set in git keeps it, and a command that clears the setting could push if it found a working key, which is why the
keys stay hidden.

**Guard for the project's own commands**: the Builder writes the code the tests run, so squad-kit runs the project's
own tests, lint, build, setup, app and release pipeline in a guard of its own, on Mac and Linux. They work normally,
browser tests too, and can reach the network for packages and tests. They can't read your keys, sign-ins, browser
profiles or squad-kit's own folder in the places the guard knows, or the `.env` files in your project folder (on Linux, the
ones it finds 3 folders down; the setup after a merge reads your own checkout's), and they start without the AI, cloud and code-host keys. When a project truly needs a file
outside its copy, the check stops with one plain sentence ("A check needed a file outside its copy, and squad-kit blocked
it. An engineer can allow it in Settings."), and the file's path is in the details. On Linux the guard needs bubblewrap, and
this page and `squad doctor` say how to turn it on.

**The guard stops accidents and most bad behaviour, but it is not a wall against code built on purpose to break out.** A
command can still reach the network. On a Mac it can talk to other local services and read the environment of your other
programs, so use squad-kit's sign-ins, not keys exported in a shell. On Linux it can reach your session's bus and gpg agent
under `/run/user`. It can use a key loaded in an ssh agent, though not read it. Use squad-kit on projects and tickets you
trust, and read what the Builder changes. `SECURITY.md` has the full list.

**Caches**: no tool's downloads are blocked. Each project has its own download folder on this computer, which all its stories
share, so only the first story downloads. The project's own commands and the agents' commands both use it. Each tool is
pointed there by its own setting: pip, Poetry and uv, Dart and Flutter, Gradle and Maven, NuGet, Composer, RubyGems and
Bundler, Go's build cache, Deno, Bun, Cypress, Puppeteer, Electron, node-gyp, and every tool that follows `XDG_CACHE_HOME`
(Prisma's engines among them). npm, pnpm, Yarn, Rust and Go's modules keep their package caches, which check every package
against the lock file. What this computer has already is used first: Prisma's engines start as a copy of yours, the browsers
Playwright and Puppeteer downloaded are linked in (`playwright install` downloads only what is missing), the Gradle your
project's wrapper asks for is linked in when this computer has it (yours, read only), your Gradle and Maven settings files are
linked in, and Gradle, NuGet and Maven read the packages you already have without writing in them, so they download only what
is new. All of `~/.cache`, `~/Library/Caches` and each tool's own folder in
your home stay read only, as your own tools run programs from there.

When a tool squad-kit does not know still cannot write in your home, squad-kit runs the command once more by itself (or starts
the app once more), with a home of the project's own: your home seen through links that stay read only, keys and sign-ins left out, and the place the
tool needed made the project's own. The story says so in one line ("A tool could not save its downloads in your home folder,
so squad-kit gave it the project's own folder and ran it again."), the log has which place and which command, and the same
command starts that way from then on, so the next story does not wait for it. It runs once more only once, and only for
that reason: a command that fails for another reason, or still cannot write, stops as before.

Your own checkout's setup after a merge, Your apps and the release pipeline use a second download folder that no story writes
in: what a story left in the shared one never reaches what you run yourself. Programs you installed stay read only, so a
story's code can never change them. Flutter runs from its own folder: squad-kit tells it not to lock that folder (the lock is
only for Flutter's own downloads into it), so a part of Flutter that is missing there, such as a platform you never built
for, gets the blocked-file sentence; run `flutter precache` for it once yourself. Flutter and .NET are told to leave out the
usage reports they keep in your home folder, for the squad's commands only. On a Mac, Chrome's own sandbox cannot start
inside the guard, so a project that opens Chrome through Puppeteer needs `args: ['--no-sandbox']` there; Playwright needs
nothing.

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
get a cache folder of the project's own, so `npx` in a hook works with no packages installed. No other hook runs: squad-kit runs
no `pre-push`, `post-merge` or `post-checkout`, since the project's own checks have run by then. A push from your own
terminal still runs yours. A project that uses Git LFS still gets its large files uploaded when squad-kit pushes.

**Windows: less protected.** On Windows, squad-kit does not guard the agents' own commands or the project's own tests
and app, so they can reach other files on the computer. Screenshots and the app still go through the window. Use it on
projects you trust. Windows is also not fully tested yet. The Agents and Safety tabs say so.

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
- **Also read** and **Also write**, for engineers, where the guard runs: files or folders outside its copy that the
  project's own commands may use. Add one only when a check stopped because squad-kit blocked a file the project truly
  needs. Shared by the team, and agents can't change it. Write the full path, or start it with `~` for your home folder.
  Terminal: `squad config set allow-read <path>`, `squad config set allow-write <path>`, and `--clear` on either.
- **What the product is made of**, for engineers, on a product with several parts: each part that runs by itself, the
  services they share, where each one is, its address and what it cannot run without. The Architect finds these when it
  reads the project, and a new read keeps what you correct. Mark an old app or another product in the same folder
  **Not used**. A project with one part does not show this. Terminal: `squad parts`, `squad parts --set api --needs db`,
  `squad parts --off <part>`, `squad parts --add "PDF service" --repo pdf-service`.
- **Files agents may not touch**, for engineers. **Local files** are files git does not carry, like `.env.dev` or
  `public/config.js`. squad-kit puts them in each story's copy for the project's own tests and app, and no agent can read
  them. A test could still read and send what is in them, so stories use their own values, kept on this computer: start
  from the file in your folder, then change any real values to test values. **Locked files** are in git, like
  `docker-compose.yml`: agents can read them, and squad-kit puts back any change. Only the names are shared with the team.
  Terminal: `squad files`, `squad files --local .env.dev`, `squad files --use-mine .env.dev`, `squad files --lock-docker`.
- **Each story's own database**, for engineers. squad-kit learns the project's database when it first reads the project,
  from the project's own files, never by asking a PM: Prisma's `schema.prisma`, an address in `.env.example` (and the one
  your own `.env` holds), a compose file's database service, `appsettings.Development.json`'s connection strings,
  Spring's `application.properties` or `application.yml`, and the packages the code uses. It shows the kind (SQLite,
  Postgres, MySQL or Mongo; SQL Server comes later), its name, where it runs, the setting that points the app at it
  (`DATABASE_URL` in `.env`, or `ConnectionStrings:Default` in a settings file, with the environment name that stands in
  for it, `ConnectionStrings__Default`), the address with any password shown as `***`, and the files it learned this
  from. **Confirm it**, **Correct it** (kind, name, setting name, settings file and key, address) or **Find it again**.
  The kind, name and setting are shared with the team in `.squad/config.yaml`; an address with a password stays in this
  computer's secrets, never in git.
  - **The template**: made only when you press **Make the template** (later **Make it again**, after the schema changed),
    with the database's own tools, which only read your database: small tables whole, the newest rows of big ones,
    linked rows and indexes kept. It lives in squad-kit's own folder on this computer, with its size and age shown here.
    **Hide personal data**, off by default, makes names, ID numbers, phones, emails and addresses fake in the next
    template. **Sample size**: how many of a big table's newest rows it keeps (1000 by default).
  - **A story's own database**: when a story's copy is set up, before its setup command runs, squad-kit makes
    `<name>_<story>` from the template on the same server and points the copy at it, in the copy's own `.env` when git
    leaves that file out (no agent can read it) and in the environment of every command run in the copy, so a value in
    your own environment never wins. A later step uses the same one; a story that started without one keeps the
    database as before. It goes when the story is merged, released or deleted, and with the leftovers after a restart.
    squad-kit refuses to point a story at the database your own copy uses, and never creates, changes or drops it. A
    SQLite file stays in each copy, from the template's file when there is one.
  - **When new code comes in**: package files or database changes that are new in a story's copy (from main, or from
    the Builder) make its setup run again, before the checks and before the app starts for the Reviewer or the Tester.
    When that setup fails over the database, squad-kit makes the copy's own database again (the story's own from the
    template, or a SQLite file inside the copy, set aside as `<file>.out-of-step` and kept out of commits) and runs the
    setup once more. Your own database is never touched. A setup that still fails goes to the Builder.
  - **When the app chooses its database itself**, a copy under another name would not be used, and the story would write
    to your own database all the same. So squad-kit makes no template and gives no story a copy, and says why, here and
    in `squad db`: the code names the database (`GetDatabase("shop")`, `dbName: 'shop'`, or the name in quotes on a
    database line), the address in the setting names no database, or a compose file builds the setting from other
    settings. Stories use the database as before. Take the name from the setting, and each story gets its own copy.
  - **Story databases now**, and **Notes**: with no template yet, or a database squad-kit cannot reach, the story goes on
    as before and the note says why, once per story, also in the app log. A PM reads at most "The story has its own copy
    of the database."
  - Terminal: `squad db`, `squad db find`, `squad db confirm --env DATABASE_URL --address …`, `squad db template`,
    `squad config set db-hide on|off`, `squad config set db-sample 5000` (or `default`).
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
  **New tests**: each story chooses (the **Write new tests** switch on the new story form, on by default), or always,
  for a project that must always have tests. Shared by the team in the project's settings, and shown on the Harness
  page as the **New tests** gate. Terminal: `squad config set new-tests always`, `squad config set new-tests switch`.
  - **Env file**, for engineers, beside the commands: the file a part's app reads its settings from, like `.env.dev`
    (several with commas), for an app whose daily stack runs in Docker Compose (`env_file: .env.dev` or
    `--env-file .env.dev`) and has no loader of its own. Run on this computer without it, such an app falls back to its
    settings file, which may point at another computer's database. squad-kit gives the file's values to every command it
    runs for the part on this computer (the start, the setup, the checks and the agents' `run_checks`), read the way
    Compose reads it (`KEY=VALUE`, quotes, `#` comments, `export`, empty values, no `$NAME` filled in). Its own go on
    top: a setting that names a Docker service (`mongodb://app.db:27017/shop`) reaches it through the port that service
    publishes here, then the story's own database, its own Redis number, and the port squad-kit picked. A database on
    another computer stays as it is, and no story database is made there. The values come from the file in the copy
    the command runs in: a file git does not carry needs values for stories under **Local files**, so a story never
    gets your own; Your apps runs your own version with your own. A command that runs in Docker Compose gets nothing:
    Compose reads the file itself. No agent can read the file, and the log, the board and the agents get the names
    only, never a value. The first read learns it from a compose file whose app service has `env_file:`, or a compose
    command with `--env-file` in the README or Makefile, when the part starts on this computer. It never saves a
    `docker compose up` start that uses fixed `container_name`s or names its project: squad-kit gives its own compose
    runs a project name of their own, but a container name is the same on the whole computer, so it would clash with
    your own Docker stack. The start for this computer takes its place when its tools are here (for .NET, `dotnet run
    --project <the web project> --urls http://localhost:${PORT:-<its port>}`), and the log says so in one line. Shown
    read only on the Harness page as **A part's env file**. Terminal: `squad config set env-file .env.dev`
    (`--repo <repo>` on a workspace, `--clear` for none).
- **About squad-kit**: your version, when the app last looked for a new one, **Check for updates**, and the
  daily check (turn it off on a network without internet). When a new version is out, Home and every project
  page show it with what is new. **Update now** waits until no agent is in the middle of a step, installs it,
  and restarts the app on the same link. The banner shows what is new in every release since your version.
  **Check for updates** also reads the notes again. Terminal: `squad upgrade`.

## A database per story: the adapters (for engineers)

Each story can get its own database, made from a small template of the project's real database, so a story never
touches the person's own. The adapters are in `src/engine/db/` (one per kind, behind `types.ts`); the rest of squad-kit
reaches them through `index.ts`. They use each database's own command line tools, and say which are missing.

| Kind | Template, on this computer (never in git) | A story's database |
| --- | --- | --- |
| SQLite | A new file made by `sqlite3`: the source attached read-only, its tables, the kept rows, then its indexes, triggers and views. | A copy of the file in the story's folder: `<file>_<story>.db`. |
| Postgres | `pg_dump --schema-only` in two parts (before and after the rows) and the rows from `COPY (SELECT …) TO STDOUT`, in one read-only snapshot. Also kept as a database on the same server, `<name>_sk_template`, closed to connections. | `CREATE DATABASE <name>_<story> TEMPLATE <name>_sk_template`, or loaded from the files when that database is gone. |
| MySQL | `mysqldump --no-data`, the triggers and routines on their own, and the rows a table at a time with `mysqldump --where`. | `CREATE DATABASE` and a load of the files (definers taken out, so it belongs to whoever makes it). |
| MongoDB | A mongodump folder: a small read-only `mongosh` script picks the documents and reads each collection's indexes and options, then `mongodump` reads the documents. | `mongorestore` of the folder under the story's name. |

- **Which rows**: a table with at most `smallRows` rows (default 1000) is kept whole. A bigger one keeps its newest
  `sampleRows` (default 1000), by a time column with a "created" kind of name, else another time column, else its id.
  Then, a pass at a time, the rows that kept rows point at through foreign keys, until nothing is missing. MongoDB does not
  record links: squad-kit follows DBRefs, and ObjectIds in fields named like a collection (`patientId` → `patients`), and
  says so in the template's notes. A chain of links too long to follow (30 passes, or 20 × `sampleRows` added rows in one
  table) is said plainly too: on Postgres, a link to a row that was not kept is emptied, or the row left out when the link
  may not be empty, so the foreign keys still load. MySQL loads with its key checks off.
- **Reading only**: Postgres reads in read-only sessions (`default_transaction_read_only`), MySQL in `READ ONLY`
  sessions, SQLite through a `mode=ro` attach with `query_only`, MongoDB with a script that only reads. A template is made
  in a new folder beside the old one and takes its place when ready.
- **Hiding personal data** (`hidePersonal`, off by default): columns and fields found by name (people's names in tables of
  people, usernames, emails, phones, ID and national numbers, addresses, birth dates) get fake values on the way, so the
  real ones are never written. The same value always becomes the same fake one within a template (a keyed hash with a new
  random key each time, never kept); phones and ID numbers keep their shape and stay unique (a keyed shuffle); dates stay
  dates. A fake only goes where it fits the column's type and length. `template.json` lists each hidden column.
- **Never the person's database**: every create and drop refuses the person's own database (the same name on any host,
  or the same file) and the server's own (`postgres`, `mysql`, `admin`…). A story's database is dropped only when its name
  is the story form and squad-kit's mark is on it: one file per database in `~/.squad-kit/databases/made/`, and on
  Postgres also a comment on the database. Asked again for a story it made, squad-kit keeps the database as it is.
- **Passwords** go to the tools in their environment (Postgres), a private option file (MySQL) or config file (MongoDB
  tools), removed right after, never on a command line. What a tool says is cleaned of them before anyone sees it.
- **Not copied**: MySQL scheduled events (they would run on their own), MongoDB time-series collections, Postgres
  materialized view rows (refresh them in the story). Postgres extensions need the same rights the source's owner had.
- **Tests**: `test/db-adapters.test.ts` runs everywhere; `test/db-{sqlite,postgres,mysql,mongo}.test.ts` start a
  throwaway server each (a `mysqld` and a `mongod` on temp folders and ports, Postgres 16 in a container removed by its
  exact name, when the image is already here) and skip where the tools are missing. `SQUAD_DB_TEST_DIR` moves their
  folders.
