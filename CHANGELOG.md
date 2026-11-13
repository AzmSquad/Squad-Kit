# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **squad-kit opens the pull request on GitHub.** With GitHub's own tool, gh, signed in on your computer, Looks right
  pushes the story's branch and opens its pull request, in your own repo or your team's fork. squad-kit merges it with a
  merge commit once GitHub allows it, deletes the branch and brings your main up to date, as on Azure Repos. While the
  checks run or a branch rule waits for an approval, nothing is held up: squad-kit looks again every few minutes and
  merges it then. A failed check or a clash is said plainly, and squad-kit never goes around a rule. Can't push to the
  repo? It merges on your computer instead, and says why. Without gh, the work merges on your computer as before.
- **Sending your work to squad-kit itself.** On squad-kit's own code, the pull request goes to squad-kit's main repo,
  with the review in its text, and its owners merge it: squad-kit never does. The story waits for them and squad-kit
  watches the pull request. Their notes come back to the story: **Fix these** has the Builder fix them, then the fix
  goes to the same pull request and each note the fix really changed is answered "Fixed in" its commit. Merged by the
  owner: the story is done. Closed: the story says so, with Send it again or Leave it closed. `squad pr <story>` shows
  it all.
- **The contribution checklist** on squad-kit's own code (`squad contribute`): signed in to GitHub, your own copy (Make
  my copy makes your fork), up to date with squad-kit (Bring it up to date, only ever forward), the rules the checks
  hold, and Tell the maintainers first for a big idea, as a filled-in page you send yourself.
- **GitHub's tool on the Tools page**, Recommended for a project kept on GitHub, with the steps to install it and sign in.
- **GitHub as a tracker.** Stories and bugs can come from a repo's Issues (with the labels and the assignee you pick)
  or from a GitHub Project, with an optional view or Status. Pull `#40`, or `owner/repo#40` for another repo's issue on
  the board; it becomes ticket `GH-40`. Labels are tags, the `bug` label or the Bug issue type makes a bug, a Project's
  iteration field gives the sprints, and its Priority and Points fields are read. Parents come from sub-issues, and
  what a story needs from "blocked by". Uploads in the issue come with it.
- **The squad keeps the issue up to date.** On a Project, each step moves the Status that fits it best (you can pick
  another in Settings), only forward; merged and released close the issue. Questions, answers, the plan and the pull
  request link are comments on the issue, and a release adds its version as a label. A bug you report becomes an issue
  with the bug label.
- **Send a breakdown to GitHub:** epics, features and stories as issues (your organization's issue types when it has
  them, else the labels `epic`, `feature`, `story`), each under its parent as a sub-issue, with "blocked by" for the
  order.
- **Connect it in Settings, no token to paste.** The tracker part of Settings now has a choice: Azure DevOps or GitHub.
  GitHub signs in with GitHub's own tool, `gh`; when it is missing or not signed in, Settings shows the steps
  (install it, `gh auth login`, and `gh auth refresh -s project` for a Project). Pick the repository and Issues or a
  Project from lists. Terminal: `squad config set tracker --type github --field repo=owner/name from=project board=2`.
- **The Pull dialog and the Backlog page name your tracker,** and how its items are written.
- **Only your team's issues reach the squad.** Issues written by the repo's owner, the organization's members and
  collaborators; a stranger's issue on a public repo never steers the agents. **Stories from anyone** under More turns
  that off.
- **A project set up with GitHub before only reads it** until you press Save and check once: pulling works, and the
  moves, comments and bugs wait until then. Settings says so in one line.
- **The Backlog opens on the sprint running now,** else the next one, else the newest, never an old finished one. It
  reads at most 500 items and says so when there are more.
- **`squad doctor` checks GitHub's sign-in** the way Settings does: gh found, signed in, and the Projects right for a
  Project, with the same steps.

## [1.3.20] — 2026-11-13

### Fixed

- **Arabic no longer turns the whole chat around.** A popup, its buttons, the sources and the cards stay where the
  board has them, and your messages stay on your side, whatever language you or the squad write in. Only each
  message's words run their own way inside their bubble: Arabic right to left, English left to right. The same in
  **Ask about this ticket**.
- **A mockup opens big, over the whole page.** Open the mockup on a design card in a popup opened it inside the small
  popup, cut off. Now every mockup, from a card, a chat or a story's plan, opens in one viewer that fills nearly the
  whole window: Close or Esc, and the focus goes back to where you were. Approve stays on the card. Every other
  window does the same: opened from a popup, a card or a message, it covers the whole page and is never cut off.

## [1.3.19] — 2026-11-13

### Added

- **The review written into the pull request.** The Reviewer now writes each note with its file and line, and squad-kit
  keeps every round on the story: when, approved or not, and each note numbered across the rounds. Before the
  Builder fixes a round, squad-kit saves the work as the Reviewer read it, then saves the fix, and git says which notes'
  own lines it changed: those are **Fixed in** that commit, and the Reviewer's next round can reopen them. The rest,
  and notes about a whole file, are fixed only when the Reviewer's next round says so.
- **Only you go past a note, with a reason.** Go past… on an open note, or Continue anyway on a review that stopped.
  Your reason stays on the record, in the pull request too.
- **The pull request is the full record.** Its description has what was asked, each "done when" with how it is proved
  and a link to its proof, the review in short, the notes you went past with your reason, and "<you> approved: Looks
  right, <date time>". Each note is a thread on its file and line, Fixed, Went past or Open. One more thread says who
  pressed Looks right: squad-kit never votes as you. On Azure Repos the threads have Azure's own status.
- **Writing it never holds up the merge.** The threads go in only once the pull request is merged, also when someone
  merges it on the code host. If the code host says no, the story says so plainly, and Write it again adds what is
  missing. What the squad and you wrote goes in as plain text, never as links, pictures or mentions.
- **No pull requests? The merge commit carries it,** in short under its title, and the board keeps the whole record.
- **The Changes tab starts with the review:** each round, each note on its file and line with where it stands, as the
  pull request shows it. A note in Arabic reads right to left. Stories from before keep their notes as round 1.
- **Every button has its call and its command:** `squad review <ticket>`, `--past <n> --reason "…"` and `--write`.
- **The right proof for each "done when".** Not every story needs pictures. In the spec, each line has a chip that says
  how it will be proved, with one plain line on why: Screen (pictures before and after), Data (the rows of the story's
  own database before and after, read only), API call (the call and its answer), Test (the test that proves it, in
  plain words) or Not on a screen (with a reason the Reviewer checks). The Analyst proposes them; change any of them
  with the chip's menu before you approve the spec.
- **squad-kit keeps a picture where one is needed.** Its own rules lock a line to Screen when it is about what someone
  sees, and when the story changes screen files and no other line has a picture. No agent can move a locked line
  away from Screen, and a planned picture the Tester cannot take is a problem on the card, never a quiet Not on a
  screen.
- **A test must fail on main.** squad-kit runs the test that proves a line on main's code and on the story's: "It
  failed before the change and passes now". A test that also passes on main goes back to the Builder, to write a real
  one. squad-kit runs only that one test, by its whole name on every version of Vitest and Jest (each case of a test
  written for `each`), and on Vitest 3 and later by its file and line too. The Tester names it from the story's own
  test files, which squad-kit lists for it.
- **Test · stays as it is.** A line that keeps something that already works ("Paid bookings stay as they are") passes
  before and after the change: "Stays as it is: passes before and after". The Analyst proposes it, and you turn it on
  or off in the chip's menu before you approve the spec (`squad prove <ticket> <line> test --keeps`, `--no-keeps`).
- **Data proof.** A new tool for the Tester, `read_rows`, reads a few rows of one table of the story's own database
  before and after its action. squad-kit builds the one query itself: it never writes, and it hides secrets. The
  Proof tab marks the cells that changed.
- **A backend-only story takes no pictures.** With no Screen line, no browser starts and nothing is built for the phone;
  the app starts headless only when an API or Data line needs it. A command-line tool or a library, with no app to
  start, is proved by tests: no lock, and only Test or Not on a screen can be picked.
- The Proof tab and the proof page show one block per line with its kind, and a chat card shows each line's kind with a
  short form of its proof. Right to left in Arabic, light and dark. Old specs are proved exactly as before.
- **Every button has its call and its command:** `squad prove <ticket> [line] [kind] [--why "…"] [--keeps]` and
  `POST /tickets/<id>/prove`.
- **The design card shows the design.** The Architect's mockup is a small picture inside the card, with Open the
  mockup for the full one. The Squad lead knows a story's mockup and brings its card when you ask to see a design.
- **"Hello" gets an answer at once,** with no AI run and no cost: the stories open, what needs you and who is working,
  in your language, Arabic too. The lead also reads the board's own numbers first, so it no longer calls a project
  with many stories "new" from an old first read.

### Changed

- **Chats scroll like a modern chat, everywhere.** A talk opens at its newest message, or at the first unread one under
  a "New" line, a popup brought back from its bar too. Your own message goes to the bottom; new words follow only
  while you are at the bottom; scrolled up, the talk stays put and a chip counts the new messages. Late pictures and
  cards no longer move what you read.
- **One talk in one place.** While a page shows a talk (the Squad lead page, the Conversations page, a story's
  Conversation tab, which now shows the talk itself), its popup hides and its head says "on this page".
- **"Needs you" counts only what needs your press,** with one number in the top bar, the side menu, the lead's head,
  its popup and its answers. News such as "MA-3 is released" goes to a small "What's new" list.
- **The Squad lead page is one centred chat.** The Needs you column is gone (the top bar has it); who is working is one
  line under the lead's name; What it can do is under the box. Answers that bring cards stay short.
- **Your question to the lead** has one small line under it: its time and where you asked, in full on hover.
- **Buttons name the action:** "Take the pictures again" and "Always take them again", never a bare Allow once. A
  check-in for a story with no pictures says how it was proved ("proved by a test") instead of "0 pictures".
- **The chat heads keep a gutter of their own,** so they never cover a card. The "Ask the lead ⌘K" pill moved into the
  lead head's tooltip.

## [1.3.18] — 2026-11-13

### Added

- **A story too big for one is caught before any questions.** squad-kit counts it first, with no AI, leaving out code,
  tables and logs: the words, the pages of an attached Word or PDF file, requirement numbers, headings and "must"
  lines, separate asks, and the roles, screens and flows it names. A short story goes on as before. The Analyst judges
  the rest, with the breakdown's sizes in plain words: About a day, A few days, A week or more. Bugs and stories pulled
  from a tracker are never split.
- **The Analyst suggests a split.** Its parts come in the order to build them, each with its size and what it needs.
  On a story, the card waits in the Analyst's popup and the Now tab: Split into N, Keep as one, or Change the split
  (your note goes in the chat box). After Split the story keeps the first part, the Analyst asks part 1's questions,
  and the other parts wait in Tickets with "depends on". Each part has its own "done when" lines. Nothing changes until
  you press.
- **New ticket shows the same suggestion before anything is created:** Create N stories, Create as one story, Cancel.
- **A whole requirements document goes to Requirements.** "Too big for one story", with a rough count by part, then
  Send to Requirements (your text and files go with it), Make one story anyway (with a short warning), or Cancel.
- **The Squad lead never drafts one giant story.** Its draft goes through the same count and offers the split or Send
  to Requirements. A requirements document pasted to the lead gets that card at once, with no AI. A big text pasted
  into a story's talk gets a hint under it.
- **Every button has its call and its command:** `squad split <ticket> --yes | --keep | --change "…" | --requirements`,
  `squad new --from "…" --split | --one | --requirements`, `squad lead run <card> --split | --one | --requirements`.
- The cards speak the language you wrote in, right to left in Arabic. The Harness page shows the size rules.

## [1.3.17] — 2026-11-12

### Added

- **Chat heads and popups on every page.** Round heads sit at the bottom right of every project page: the Squad lead
  first, with how many things need you, then one per open talk with the agent's letters, the story under it, an unread
  badge and a live dot while it writes. A press opens the talk in a popup over the page, up to three side by side
  (fewer on a narrow window, one full-screen sheet on a phone). Each popup minimises to a bar, closes, or opens its
  full page. They stay open after a page change or a reload. ⌘K or Ctrl+K opens the lead; with nothing open, a small
  "Ask the lead" sits beside the heads. A head gives a small nudge when its talk gets a new message or a new decision.
- **The lead's popup starts with what needs you** (each one opens its story's popup) and a few questions to ask.
- **Decide in the chat.** When a story waits for you, its card closes the story's talk and comes with the lead's
  answers about it: the proof with its pictures and "done when" ticks (Looks right, Something's wrong, Full proof), the
  spec, plan or design in short (Approve, Ask for changes, Read it all), the Analyst's questions as answer chips, an
  agent's question with its answers, or Open with the board's own reason. The buttons are the board's own; the card is
  drawn from the board as it is now, and a press is checked again: decided already, or changed since, the card says so.
  After your press it turns green with what really happened, and the board, heads and badges update at once.
- **The lead brings the card; only you press it.** "Approve" stays on the lead's never list, its can and can't rules
  are the same, and it still gives at most 4 cards. "Accept it for me" is refused with the story's card next to the
  refusal, in Arabic too ("ممتاز، اقبلها لي"), with no AI.

### Changed

- **Words appear as they are written.** The lead's headline and body show as the AI tool hands them in, then the words
  come in at a reading pace; its working line shimmers, its steps tick in, and it folds to one line when done. An
  agent's reply does the same. Your message pops in, cards and answer chips rise in one after another, and Send gives
  a small push. With reduced motion there is no motion and the words show at once. A talk in Arabic reads right to left.
- **The board keeps its whole width.** The chat panel docked beside it and the ⌘K box are gone: the popups do both.

## [1.3.16] — 2026-11-12

### Added

- **squad-kit knows when it works on its own code.** Add a clone of squad-kit's repo as a project and Add project, the
  setup, the Overview and the Releases page say so in one plain note: "This is squad-kit's own code. Each story runs its
  own separate squad-kit, with sample data, so this board and your other projects are never touched." Every agent and
  the Squad lead are told too. It goes by the package (named squad-kit, with the `squad` command), never the folder's name.
- **squad-kit's own way to check and run itself.** Both packages install from their lock files. The checks are the
  engine's and the board's type checks, the tests your change reaches plus the board's server test, the build and the
  npm size limit. The whole suite (about 9 minutes) stays with CI. The app for pictures is a sample board (`squad demo`)
  built from the story's code, on the story's own port and home folder, with no AI and no sign-in.
- **Send it as a pull request.** On squad-kit's own code, a merged story shows the one command that pushes its branch
  (shown even with commands turned off), and a button that opens GitHub's page for the pull request into the repo it
  came from. squad-kit pushes nothing to GitHub by itself. The story says "Merged into main · send it as a pull request",
  and the first-story screen offers the same button. Other projects, forks too, go out with their own releases as
  before.
- CONTRIBUTING.md has a short "Build squad-kit with squad-kit" section.

### Changed

- **A squad-kit that a project's command or an agent starts gets a home folder of its own copy**, with update checks and
  the browser off. It never reads or reaches your board, its token, its lock or its port. The guard also hides your usual
  `~/.squad-kit` when the board runs with its home elsewhere.
- **Inside the guard, a command knows it** (`SQUAD_KIT_IN_GUARD=1`). squad-kit started there runs no guard of its own (the
  system refuses a sandbox inside a sandbox), and squad-kit's tests that need one skip there; they still run in CI.
- On squad-kit's own code, Release is refused with plain words and the Releases page explains why: a release on GitHub
  publishes squad-kit to npm, so its maintainers make them. Its project documents stay out of git, so a pull request
  carries code only. The Settings switch says why it stays off, and so does a hand over.

## [1.3.15] — 2026-11-12

### Changed

- **The Squad lead gives buttons, not "tell me".** When an answer sends you to the board, the button comes with it:
  **Open MA-17's proof** (or its spec, plan or questions), the same place as the board's own buttons. It changes
  nothing, so it needs no OK. A board action that does not fit the story now (more pictures on a proof that waits for
  Looks right) becomes the story's Open button instead.
- **When the lead refuses what only you may do** (Looks right, approving a spec or plan, merging, releasing), it keeps
  its refusal and gives you the Open button for each story it names, so you are one press from doing it yourself.
  squad-kit's own refusals, with no AI, do the same.
- **An answer that offers to do something later** ("tell me and I'll request them") is asked for again once, with its
  card. The lead acts only through the cards in its answer, still at most 4, and its can and can't rules are the same.
- **The lead can show a story's own proof pictures** when it talks about them, read only, marked "From MA-17's proof".
  Only the pictures the board already keeps on a story, never anything else.
- **squad-kit's own refusals answer in Arabic** when you write in Arabic. The board's button names stay as they are.

## [1.3.14] — 2026-11-12

### Fixed

- **A part's env file fills in `${NAME}` the way Docker Compose does,** so a line like
  `ConnectionStrings__Db=mongodb://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:27017/shop` gives the app the real address:
  from names set earlier in the same files, with `${NAME:-default}`, `$$` for a `$`, and single quotes kept as written.
  A name nothing sets is empty, as in Compose. squad-kit's own keys never fill a value, the log still shows names only,
  and an address squad-kit writes into an env file with a `$` in it reads back as written.
- **`squad db find` learns the database from the part's env file** when it sets the same setting as `appsettings.json`
  (.NET and Compose read it first). The setting is that name in that file, and a Compose service in its address is
  reached through the port it publishes here. Before, it learned the settings file's address, often another computer's.
- **Test code no longer stops stories from getting their own database.** A database named in tests, .NET test projects
  like `Orders.Tests/` or `Shop.IntegrationTests/` included, is the tests' own; app code that names it still counts.
- **A Mongo story's address always says where its user signs in:** no stray `&` after a `?` at the end, and `admin`
  for an address with no database name.
- When a story cannot get its own copy and uses the project's database on this computer, engineers read plainly that
  it is their own database, which the story's app and tests can change.

## [1.3.13] — 2026-11-11

### Added

- **The Squad lead.** One place to ask about the whole project: the app, the code (read only), stories, decisions,
  releases, costs, or what went wrong. Each answer shows its work first (what it read and searched), then a short
  answer, pictures from its own copy of the app, and its sources. It drafts a story or a bug from the conversation, with
  how each "done when" will be proved, and you press **Create story**. It saves what it learns, so the same question is
  answered at once the next time, and Your apps shows "How to sign in" when it knows.
- **What it can and can't do:** it reads and looks on its own, in its own copy of the app with its own database, never
  yours. Everything else is a card you press. It never changes code, merges, releases, presses Looks right, touches
  your real data or secrets, or deletes anything, whoever asks; it says so in plain words at no cost. **Always allow**
  is only for low-risk actions: more time, the pictures again, starting the app, the morning brief.
- **Ask from anywhere:** the Squad lead page in the sidebar (with Needs you, The squad now and What it can do),
  ⌘K / Ctrl+K on any page, **Ask the lead** on a stopped, slow or waiting story, and **Ask about it** in Your apps.
- **A part's env file:** a part's setting (for example `.env.dev`) gives its values to every command squad-kit runs for
  that part on this computer, with the story's own database, Redis and port on top. squad-kit learns it from a Compose
  file on the first read. Only the names are ever shown.
- Terminal: `squad ask "<question>"`, `squad lead`, `squad lead run <card>`, `squad lead rules`,
  `squad config set env-file`. `squad ask MA-9 is it ready?` still answers status questions at once, at no cost.

### Changed

- A first read never saves a `docker compose up` start whose containers have fixed names (it could replace your own
  running containers); it uses the local start when the program is on this computer.
- A .NET API's start is found as `dotnet run` on the address squad-kit picks.
- The Harness page shows the Squad lead: what it reads, its three levels, Always allow and its limits.
- Decision links like `RO-1.1` open the decision on the Architecture page.
- squad-kit's guide now ships with the package, so the Squad lead can read it.
- **Faster checks:** when the Builder runs one test file after all the tests passed, on the same code, the checks step
  no longer runs all the tests again (about 5 minutes on a Mawid story). A failing file still makes them run.

## [1.3.12] — 2026-11-11

### Added

- **Phone apps on Android.** For a Flutter, React Native or native Android app, the Tester's pictures come from
  squad-kit's own Android phone and tablet (Google's own emulator, started hidden), tapped through by their visible
  words, in English and Arabic, each labelled with its device ("Pixel 9"). Start and Try it yourself open the app on
  the Android phone in its window. One phone at a time, shared with the iPhone; it shuts down after 10 minutes unused
  and when the board stops.
- **squad-kit gets the Android tools itself.** The Tools page shows Google's license in full; after you press Accept,
  **Get it** downloads Google's command-line tools, the emulator, a phone system and the build tools into squad-kit's
  own folder (about 20 GB on disk, checked first), with the time left. No Android Studio needed; an Android SDK you
  already have is used as it is.
- **Which phone:** a project setting picks the iPhone, Android, or automatic (the iPhone on a Mac when it is ready).
- Terminal: `squad tools accept android`, `squad tools get android`, `squad config set phone`, `squad phone start`.

### Changed

- **A missing tool is not the Builder's.** A check that fails because a tool is missing ("No Android SDK found", no
  Java…) no longer goes to the Builder as a code fix: squad-kit checks its tools and runs it again, and the story waits
  for the tool with a plain line.
- **Phone builds stay out of the checks.** A first read's `flutter build apk` or `ios` check becomes the web build (or
  none): squad-kit's own phone build for the pictures already proves the app builds.
- **A story's own database stays on this computer.** squad-kit makes a story's own copy of the database only on a
  server on this computer, says so plainly when the project's database is on another one, and tells when a missing
  local settings file would send the app to a remote database. Addresses that name a Docker Compose service work for
  apps squad-kit starts on this computer.
- **Each story gets its own Redis number,** so cache keys and locks never mix with your own app's; they are cleared
  when the story's copy goes.
- Deleting a story writes a line to squad-kit's log.

### Fixed

- **Stopping the board stops the phones,** Maestro and squad-kit's own adb, within 20 seconds.

## [1.3.11] — 2026-11-11

### Changed

- **A slow step says why, and calmly.** When a step takes longer than usual, the card says what is happening ("fixing a
  failed test") and "still working", in the card's normal color; amber only when nothing has moved for 3 minutes. The
  story's Now tab gives the reason (a failed test or check the Builder is fixing, a second review round, a setup
  running, a busy computer), the last progress, the time limit and what squad-kit does then, and that you don't need to
  do anything. The activity line and the answer to "is it stuck?" say the same.
- **The card's words follow the real work.** A step writing tests no longer reads "building the app" because the
  Builder's own build check ran last.
- **CocoaPods out of date** shows on the Tools page as a recommended update, with steps. It stops nothing.
- **Settings says when a start command would open a window,** and which start squad-kit uses instead.

### Fixed

- **Flutter inside the guard on Linux.** Flutter writes its version stamps on every run; on Linux each command now writes
  them in a throwaway copy, so your Flutter folder stays as it was.

## [1.3.10] — 2026-11-11

The first build of this work was tagged 1.3.9 and never published: its package went over the size limit then.

### Added

- **Phone apps, iPhone first.** For a Flutter, React Native or native iPhone app on a Mac, the Tester's pictures come
  from squad-kit's own iPhone and iPad, started hidden, with the app tapped through by its visible words (Maestro), in
  English and Arabic. Each picture says its device ("iPhone 16 Pro", "Web version"). squad-kit starts one phone at a
  time, waits when the computer is busy, shuts it down after 10 minutes unused and when the board stops, and never
  touches anybody else's simulator.
- **Start and Try it yourself on the iPhone.** Your apps and Try it yourself open a phone app on squad-kit's iPhone:
  each step with the time left, measured on your computer, **Use the web version now** at any moment, and the language
  to open it in when the app has more than one.
- **The web version stands in.** With the iPhone's tools missing, the pictures and Start use the app's web version and
  say so. With no web version either, the story waits for the tools and goes on by itself: it never merges unseen.
- **Tools: what this project needs.** A page per project with every tool it needs, each with its logo, its state
  (Ready, Missing, Too old, Getting it now) and what it is for. squad-kit gets Maestro and Java itself, into its own
  folder, the first time they are needed or with **Get it**. **Update Flutter** updates your own Flutter when it is
  safe, after a warning that it changes Flutter for every project. **Check again** finds a tool you just installed, with
  no restart (Mac and Linux). A missing tool stops only the actions that need it.
- **Commands for phone projects.** Flutter (`flutter analyze --no-fatal-infos`, `flutter test`, a headless web start),
  Dart, React Native and Expo, native iPhone (`xcodebuild`) and Swift packages. Flutter's own downloads happen once,
  outside the guard; packages and CocoaPods go to the project's own cache.
- **A new phone project from a requirements document** is a Flutter app (React Native with Expo when the document or
  the team asks), made with the tool's own create command.
- Terminal: `squad tools`, `squad tools check | get <tool> | update <tool>`, `squad phone status | stop`, and
  `--phone`, `--web`, `--lang` on `squad app start` and `squad try`.

### Changed

- **The Reviewer gets the plan.** Every review round now has the plan's steps and the decision, as written, so the
  review checks the change against what was asked. The board no longer calls every review round "a fresh session".
- **iPhone builds run under Xcode's own protections.** Xcode can't start inside squad-kit's guard, so squad-kit runs its
  own Xcode builds and tests outside it; agents never run Xcode themselves. Everything else stays inside the guard.
  Both show on the Harness page, with Flutter's own version stamps, the only files the guard opens in your Flutter.
- **squad-kit never opens a window to start an app.** A start command that would open a browser, a desktop window or a
  phone (`flutter run -d chrome`) is swapped for the headless web start, from a first read or from Settings.

### Fixed

- **Update Flutter ends when Flutter ends.** Something Flutter starts may keep running; it no longer holds the update
  open until its time limit, and an update that did finish is never reported as failed.

## [1.3.8] — 2026-11-09

### Fixed

- **The screenshots step sets up the copy too.** In 1.3.7 the setup ran again before the checks and when an agent
  started the app, but the screenshots step starts the app itself, so a retake still ran on the old database. Now that
  step sets up the copy again first, and an app kept from before does not stand.

## [1.3.7] — 2026-11-09

### Fixed

- **A story's app no longer runs on an old database.** When the newest main came into a story's copy, or the Builder
  added packages or database changes, the copy's setup did not run again: the checks passed on their own test
  databases, while the app the Reviewer and the Tester used still had the old database, and signing up failed with
  "missing newer migrations". Now the setup runs again before the checks and before the app starts, whenever package
  files or database changes (Prisma, Rails, Django, Alembic, EF Core and other migration folders) are new since it last
  ran. **Your apps** runs the setup again for database changes too, not only new packages.
- **A database out of step is made again.** When that setup fails over the database (the newest code renamed a change
  the copy's database already had), squad-kit makes the copy's own database again and runs the setup once more: a
  story's own database from the template, or a SQLite file inside the copy, set aside and kept out of commits. Never
  your own database. A setup that still fails goes to the Builder like a failed check.

### Changed

- The Test stage says "passed earlier on the same code" when squad-kit's own run of the checks during the build stands,
  instead of "checked with the Builder's run", which read as if the Builder had graded its own work.

## [1.3.6] — 2026-11-09

### Changed

- **A clash at the merge no longer stops you.** When newer work in main changed the same lines while you looked at the
  proof, Looks right gave the red "The change clashes with newer code" card, and you pressed **Let the Builder bring
  in the newest code** yourself. Now squad-kit does that by itself, on every track, as it already did on Builds by
  itself: the Builder settles the clash, the checks, the review and the proof run again, and the proof comes back to
  you. The same when the pull request clashes on the code host. Up to 3 times while main keeps moving; then, or when
  main has not moved since it last came in, the clash card with its ways out. A story about to bring in main waits up
  to 3 minutes for another one that is merging right now, so it takes that work in too.

### Fixed

- **Saving and merging shows it is working.** After Looks right, the button says **Saving…** with a spinner, and the
  card, the story and the proof page say "Saving the change, then it merges", then the pull request's own line
  ("Merging pull request 15"), with a spinner. Before, they said "Your turn" or "Ready for v0.3.0" while it still ran.

## [1.3.5] — 2026-11-09

### Added

- **Each story gets its own copy of the database.** A story no longer works on your own database. squad-kit learns the
  project's database when it first reads the project, from the project's own files: Prisma's `schema.prisma`, a
  database address in `.env.example`, a compose file's database service, the connection strings in
  `appsettings.Development.json`, Spring's `application.properties`, and the packages the code uses. It finds the kind
  (a SQLite file, Postgres, MySQL or Mongo), where it runs, its name, and the setting that points the app at it, like
  `DATABASE_URL`, `MONGO_URL` or `ConnectionStrings:Default`. The kind, name and setting are shared with the team in the
  project's settings; an address with a password stays on this computer only. An engineer confirms it once and makes a
  small template of it. From then on, when a story's copy is set up, squad-kit makes the story's own database from the
  template, on the same server, before the copy's setup runs, and points the copy at it: in the copy's own `.env` (when
  git leaves that file out) and for every command run in the copy, so a value in your own environment never wins. The
  story's database goes when the story is merged, released or deleted, and a leftover goes with the other leftovers.
  squad-kit refuses to point a story at the database your own copy uses, and never creates, changes or drops it. With
  no template yet, or a database it cannot reach, the story goes on as before and engineers get one plain note; nobody
  is asked anything. A SQLite file stays in each copy, as before, and a story's own file never goes in its commit. A PM reads at most "The story has its own copy of the
  database." SQL Server comes in a later version.
- **Only when the app would really use it.** Some apps choose their database themselves: the code opens it by name
  (`GetDatabase("shop")`, `dbName: 'shop'`), the address in the setting names no database, or a compose file builds the
  setting from other settings. A copy under another name would be ignored there, and the story would write to your own
  database all the same. squad-kit sees this from the code, makes no template and gives no story a copy, and tells
  engineers why, with the file and line. Stories use the database as before.
- **For engineers, on Harness → Safety and in Settings:** the database squad-kit found (confirm it, correct it or find it
  again), the template (its size, when it was made, **Make it again**), **Hide personal data** (off by default: names,
  ID numbers, phones, emails and addresses become fake in the template), the sample size for big tables, and the story
  databases there are now. Terminal: `squad db`, `squad db find`, `squad db confirm` (with `--kind`, `--env`, `--file`,
  `--key`, `--address` to correct it), `squad db template`, `squad config set db-hide on|off`,
  `squad config set db-sample <rows>`.
- **A small copy of your database for each story, for SQLite, Postgres, MySQL and MongoDB.** squad-kit can make a
  template of a project's database with the database's own tools, only reading yours: the schema and indexes, small tables
  whole, the newest rows of big ones, and the rows those point at. Each story then gets its own database from it on the
  same server, named after the story, and it is removed when the story is done. squad-kit never makes, changes or drops
  your own database, or one it did not make. Hiding personal data is a switch, off by default: names, ID numbers, phones,
  emails, addresses and birth dates become consistent fake values while the template is made. Passwords are never shown.

## [1.3.4] — 2026-11-09

### Added

- **squad-kit notices a pull request merged outside it.** A story whose pull request clashed with main waited at
  "Clashes with main" for good, even after someone settled the clash and merged it on Azure Repos, and the stories that
  waited for it kept waiting. Now squad-kit asks the code host about each pull request it opened that is still open: a
  few seconds after the board opens a project, and every 5 minutes while it runs, with one question per open pull
  request and none when there are none. When one was merged there, squad-kit records it as its own merge: the story
  is merged and in the next release, your own copy of main catches up, the tracker item moves on, the story says
  "Pull request 14 was merged on Azure Repos. squad-kit saw it and marked the story as merged", and the stories that
  wait for it start. A pull request closed without merging gets one plain line on the story and nothing else. Nothing
  else adds a line. **Check again** asks now: on the clash card, on a story whose pull request is open or waits, and on
  the card of a story that waits for another one. Terminal: `squad check-merge <ticket>`.
- **"Write new tests", a switch on every new story.** On by default, on any track. Turn it off for a demo, a small
  text or colour change, or a project with no tests yet: the plan and the Builder add no new tests, and the Reviewer does
  not ask for them. squad-kit still runs your project's own checks (tests, lint, build), the review and the proof, so a
  break of what already works still shows. The story says "Built without new tests" on its card, its proof, its pull
  request and the release notes. An engineer can keep new tests on for every story of a project in Settings, shared with
  the team; the switch is then gone. Terminal: `squad new --no-new-tests`, `squad config set new-tests always` (or
  `switch`).

### Changed

- **Stage times count only the squad's own work.** The times under a story's title counted every wait: "Specs 45 min"
  when the agents worked 3 minutes and the rest was waiting for your answers and approval. Each stage now shows the time
  of its agents' own steps; a wait for you, for another story or a free place, and a chat are not counted. A long wait
  gets a small second line, like "waited 25 min for you". When the checks used the Builder's own passing run, Test says
  so: "3 s · checked with the Builder's run".
- **The checks use the Builder's passing test run on its own.** When squad-kit ran only the tests for the Builder, and
  they passed on exactly the same code, the checks step no longer runs those minutes of tests again. Each check counts on
  its own: the ones the Builder's run did not cover (lint, build) run as usual, in seconds. A run of one test file, an
  edit after the run, or a run from an earlier round of the Builder still never counts.

### Fixed

- **Every "done when" keeps its picture in the pull request.** One picture often proves two "done when"s. squad-kit
  uploaded it once for each, Azure Repos refused the second upload of the same file, and that row had no picture in the
  pull request. Each picture now goes up once, and its link shows in every row it proves.
- **The Builder's step on the card follows a numbered to-do list.** When the Builder's to-do list has an item of its own
  besides the plan's steps ("Check everything"), the card stayed on its step. squad-kit now reads the step numbers on the
  list ("1. …", "Step 2: …", "2) …"), and follows the list item by item, as before, when it has none.

## [1.3.3] — 2026-11-08

### Added

- **A network level for each project: Standard, Strict or Off.** It says how much of the internet the squad's commands
  reach, in one sentence on Harness → Safety. An engineer picks it there (under For engineers) or with
  `squad config set network`, and the whole team shares it through git, like the allowed websites.
  - **Standard**, the default: any website but known-bad ones. Your keys stay hidden, so a harmful package has nothing
    to take. Setups that download their own tools (Prisma, Gradle, Flutter, .NET, browsers for tests) now just work.
  - **Strict**: only the official package and download sites of common tools, a much longer list than before, plus the
    websites you allow. Your project's own tests and app still reach any site on Strict for now.
  - **Off**: no internet, only this computer. On a Mac this covers your project's own setup, tests and app too, which
    still reach the app on this computer. On Linux it covers the agents' commands only.
  - On every level, tunnels, paste and file-drop sites and request catchers stay closed. A build never needs them.

### Changed

- **A refused website no longer asks you anything.** The story used to say "Allow it on the Harness page, under Safety."
  Now it says the download was not allowed for this project and that the work goes on without it, and nothing stops.
  The Builder and Tester are told up front that a refused site is closed on purpose, so they work around it instead
  of trying again. Engineers find each refused site, with its story, level and time, under For engineers on
  Harness → Safety and in `squad config set network`.
- **No tool's downloads are blocked any more, and only a project's first story downloads.** Each project now has one
  download folder of its own on this computer, which all its stories share. The project's setup, checks, app and gates and
  the agents' own commands all use it, with each tool pointed there by its own setting: Prisma, Python, Dart and Flutter,
  Gradle and Maven, .NET, PHP, Ruby, test browsers and more. What this computer downloaded already is used first, so even
  the first story often downloads little: Prisma's engines, Playwright's and Puppeteer's browsers, the Gradle a project asks
  for, and the Gradle, NuGet and Maven packages you already have. Your own download folders stay as they are, and nothing
  of the squad's is written in them. Before, a story's copy of a Prisma project could not be set up, and the Builder spent
  minutes finding a way around it; .NET, Java and Ruby stories each downloaded everything again.
- **A tool squad-kit does not know sorts itself out.** When one still cannot save its downloads in your home folder,
  squad-kit gives it the project's own folder and runs the command once more, by itself, only once. The story says so in
  one line, the log says which place and which command, and that command starts that way from then on.
- **What you run yourself never takes what a story downloaded.** Your own copy's setup after a merge, Your apps and the
  release pipeline use a second download folder that no story writes in.

### Fixed

- **Flutter projects run in the guard.** Flutter stopped at once: it could not lock a file in its own folder, which stays
  read only, nor write its usage reports in your home folder. squad-kit now tells it, by its own settings, not to take that
  lock and to leave the reports out of the squad's commands. .NET leaves them out too.
- **Composer's and RubyGems' keys stay hidden.** Composer's `auth.json` (its tokens for GitHub and private packages) and
  RubyGems' `credentials` file were readable by the squad's commands; like `.pypirc`, they now never are.

## [1.3.2] — 2026-11-08

### Fixed

- **The Builder's step on the card now moves with it.** The card often stayed on "step 1" while the Builder was on step 5,
  then jumped, and "Taking longer than usual" came for a step it had finished long before. squad-kit now follows the
  Builder's own to-do list, one item per plan step, step by step, and still reads its "step N" lines, also when one comes
  in two pieces or through a command. Until the Builder says which step it is on, "Taking longer than usual" looks at the
  whole build, not at the first step.

## [1.3.1] — 2026-11-08

### Changed

- **The app starts once for the review and the proof.** The app squad-kit starts for the Reviewer keeps running into the proof,
  so the Tester's screenshots and a retake of a screenshot use it instead of starting it again (30 to 60 seconds each on a big
  app). It starts again only when it stopped answering or the story's code changed. It stops when the review sends the story
  back to the Builder, when the story is stopped, and when the proof ends, as before. A product with several parts starts as
  before. The Harness page shows how long a kept app waits.
- **An old bug no longer slows a story down.** When a test fails in a part of the app the story did not touch, squad-kit runs
  that test on its own on main's code, without the story's change. If it fails there too, it is not the story's: the story
  goes on to review, the checks say so in plain words ("1 old test also fails on main"), the proof and the release show it,
  and squad-kit makes one new story to fix that test. That story waits on the board until you press Start, so it costs
  nothing until then. If the test passes on main, the story's change broke it, and the Builder fixes it as before. A story only ever goes past a test that main already fails, so main never gets worse.
- **A failed test runs again on its own first.** When a test fails, squad-kit first runs only the failed tests, each on its own.
  If one still fails, the checks fail at once, without minutes of running every test again. If they pass on their own, all
  the tests run once more and that decides, as a test can fail only next to the others. When squad-kit cannot tell which
  tests failed, all the tests run again, as before.
- **The Builder fixes a failed test faster.** While fixing, the Builder runs only the failing test file, and a failure is not run
  a second time. squad-kit still runs all the checks itself at the end.
- **The checks no longer run twice on the same code.** When squad-kit ran all the checks for the Builder at the end of its work,
  every one passed, and nothing changed after, the checks step uses that result instead of running them again: minutes saved on
  a big suite of browser tests. The story says so in one line, and your team's gates still run. After any change to the code, a
  check that failed, a run of only some of the checks, other commands, or a new round of fixes, the checks run as before.

### Fixed

- **"Your copy could not be set up" after every merge**, on a project whose setup needs your `.env` file, as Prisma does.
  The setup squad-kit runs in your own folder after a merge now reads that folder's `.env` files, as it does when you run
  it yourself. It still reads no other `.env` file, and no key or sign-in.
- **The tests and the app no longer get in each other's way.** When the Builder ran the tests and asked for the app at the same
  moment, some apps refused to start, and the story lost minutes. Now, in each story's copy, the tests and the app take turns:
  the one that waits says so ("The tests are running in this copy. The app starts when they finish."), and the wait has a
  limit, shown on the Harness page. Stories never wait for each other. What a finished test run left running in the copy stops
  before the app starts, and when the app says another copy of it already runs in that folder, squad-kit stops that one if it
  is its own leftover there, and tries once more. The other way round too: before the tests run in a story's copy, the app
  squad-kit started there stops, so the tests can start their own. The agent is told, and starts it again when it needs it.
  Nothing squad-kit did not start is stopped, and a product with several parts runs as before.

## [1.3.0] — 2026-11-08

### Added

- **The squad writes in your language.** A story asked in Arabic gets its questions, spec, design, notes and proof in Arabic. Code,
  file names and commands stay in English. The check that keeps technical questions and requests for passwords away from you
  reads Arabic too.
- **A first start for new people.** The first time squad-kit opens: meet the squad, a check that this computer is ready with one
  clear step for what is missing, and What do you have (a BRD or an idea, a project you already have, or Just show me, the sample
  project with no AI and no cost). In English or Arabic. Then a small checklist on the board follows your first story, and when
  it merges a page shows what really happened: how long it took, what was checked, and what it cost.
- **Work in another AI tool.** Copy a prompt from any story, or start a new one, and paste it in a conversation in any AI tool.
  It runs the story by the project's own structure, from where the story is now, and the board shows it at its real step
  whenever you open it. Bring it back at any step. squad-kit trusts only what it ran itself: the story keeps a label on its
  record ("Worked outside squad-kit", "Continued outside from the design"), and a small **Check** button runs squad-kit's own
  checks, review and proof, and shows **Checked** when they pass. What you spend there is yours, and squad-kit's guard and limits
  do not apply there. If nothing changed outside, the story is just as it was, with no label.
- **Your additions** on the Harness page: add a rule, a checklist or a gate, type it or bring it in from a folder, and try it
  first. Saved in `.squad/harness.yaml`, shared through git. Additions only make the squad stricter; squad-kit's own gates have
  no off switch. Gates run by squad-kit itself in the guard, with the checks, before merge or before release.
- **A project's `scripts/check`** runs as one more check, and every agent is told squad-kit runs the process, so a repo's own
  rule like "open your own pull request" can't stall a step.
- **The Harness page** shows everything the engine does, with the real values from the engine and what really happened: how
  often each gate passed and stopped, the last story it stopped, and what needs you now, counted from the project's own stories.
  Search it, compare the tracks, and open what really runs behind each row. It replaces Squad and AI: all of that is on its
  Agents tab, and `/squad` opens it. The allowed websites moved from Settings to Safety.
- **New project**, on Home and with `squad projects --new`: give a name and a BRD or an idea, and squad-kit makes the folder,
  git and the board. A BRD goes straight to the Analyst. An idea goes into the first read, so you are not asked again.
- **Set up the product**, on a project with no code: squad-kit adds this first story to the breakdown. It picks the tools and
  makes a first version that starts, in one repo, with a folder for each part when the BRD needs several. Nothing else starts
  until it merges, so two stories never pick different tools. The first merge, not the first release, ends "no code yet", and
  the next read of the code finds the product's parts.
- GitHub's checks run on a Mac as well as Linux.
- **One story across the parts of a product.** On a project with several repos, the Architect names the parts a story changes.
  The story gets one folder with a copy of each, side by side, and one Builder session works in it. Each changed part runs
  its own checks ("API ✓, Web app ✓"), and the Reviewer reads all of it. If the Builder finds it needs another part, squad-kit
  adds its copy without asking you. A project with one repo works as before.
- **The whole product runs for a story.** On a product with several parts, the proof, the agents and Try it yourself start
  everything the change touches, in the order the parts need each other, on their usual addresses. The parts a story changed
  run from its copies, the others from a copy of the newest main, with the values kept for stories. One story at a time runs
  it, and the next waits with a plain line. Your apps waits its turn too.
- **Proof for what no page shows.** The Tester can ask the product's API through squad-kit, which reaches only the product's own
  addresses and saves exactly what was asked and answered. Your proof says "Asked" and "It answered", with the raw answer for
  engineers. An answer that is a file, like an Excel sheet, is saved for you to open. A picture still comes first when a page
  shows it.
- **Accept and release across parts.** Looks right saves every part and tries every merge first: if one clashes, nothing moves, and
  one card says which. A release sends what others rely on first. If a part fails to go out, what relies on it waits, the release
  stays open, and Send again finishes it, in order. Nothing is undone. Parts of another product in the same folder are not held back.
- **How work goes out,** in Settings and with `squad parts --delivery`: by pull request, or pushed to the branch as one plain commit
  per story, with the story's id first and no story branch on the remote. A story across parts goes out by push for now, with no pull
  request.
- **Stories at once, per project,** in Settings and with `squad parts --at-once`, for a product too heavy to run twice.
- A part can run in Docker: squad-kit opens Docker for its own `docker compose up` only, when an engineer locked every compose
  file it names, under a project name of its own so it never touches a stack you run yourself.
- **What the product is made of:** the first read now finds the parts that run by themselves and the services they share.
  On a product with several parts, the Overview says so in one sentence. An engineer corrects the list in Settings or with
  `squad parts`, and a new read keeps it. A project with one part sees no change.
- **Files agents may not touch**, in Settings and with `squad files`. A local file, like `.env.dev`, goes in each story's copy
  for the project's own tests and app, with values kept for stories, and no agent can read it. A locked file, like
  `docker-compose.yml`, can be read and never changed.

### Changed

- Agents can no longer read a project's untracked `.env` files in the project folder with their own file tools. Before, only
  their shell commands were refused.
- The ticket drawer, the release dialog and Your apps name the parts of the product. Repo names stay in the engineer details.
- A part marked Not used leaves the Overview picture and Your apps, and the first run does not install or test a repo with nothing else in use.

- A folder that is a git repo around other code repos, with no code of its own, is a workspace: squad-kit finds the repos
  inside and leaves its documents out of the outer repo.
- A release on a project with no remote says "Saved on this computer only", not a git command.
- When the project's setup command fails in a story's copy, the story no longer stops and asks you to press Try again. The
  Builder gets what the command printed and fixes it in the project.
- On a project with no code, the Architect picks technology that installs with no compiler.

### Fixed

- A project with commit rules (commitlint): squad-kit's own commits now follow them too, also where no hook checks them.
- Arabic reads right to left across the board, a ticket, a breakdown, its map and the other pages, not only in chat. Each piece of
  text a person or an agent wrote follows its own language, and the app's own frame stays as it is.
- One person's release no longer takes away a teammate's change to the team rules or notes. If only one of you changed a file,
  that change goes out. If you both did, the team's stays, the release says so, and yours is kept for an engineer.
- **A project of any size.** The long git steps run beside everything else, so no page waits for them: a first copy of the
  code, removing a copy, every git over the network, and the steps that read every file. Worst page wait through a whole
  story on a project of 300,000 files: 38 seconds before, about 2 seconds now, while your own copy of the code moves. Half
  a copy can never be worked in: a copy reaches its place only whole. Stop works during a first copy. Too little room on
  the disk says how much is needed and how much is free. Add project says the true number of files, and a big folder with
  no git yet gets its first save as a setup step you can see.
- While Looks right saves and merges, the other buttons on that ticket wait, so work you rejected can no longer go in by
  itself. Moves of your own copy of the code go one at a time and in one piece, so your settings and tickets stay real
  while it moves, and a restart cannot cut it off half way.
- **An agent's whole answer reaches you.** An answer to "ask about this question" could show only its last few words.
- **No agent reads your keys or sign-ins, and a push is refused.** The rule used to cover a step's shell commands only, so an agent that only reads could open a file in `~/.ssh` with its file tools. Now it goes on every run. A push goes nowhere from any agent or story command, while squad-kit's own push works as before.
- Build continuously holds once two stories stopped on a failed check or an app that would not open, so the next ones do
  not pay to reach the same stop. A question about a gap or a clash still never holds it.
- Carry on at the budget on one story covers that story only. The queue goes past the budget only when you press Build
  continuously again.
- A story whose ticket you deleted no longer starts again by itself, and pays again. The queue says so, and Start builds it.
- A breakdown's Analyst steps stop at the month's budget too, between two steps, with Carry on.
- A ticket file that cannot be read (merge marks, a broken edit) shows on the board and in the terminal, with its name, and is
  never written over. It no longer leaves the board with no word. Settings that cannot be read say so instead of "No board
  yet", and settings are written whole or not at all, so a full disk cannot empty them.
- Arabic "Decided for you" entries are all kept. They all counted as the same entry.
- Arabic wiki pages and attachments pulled from Azure DevOps keep their names, and no longer overwrite each other.
- A merge that waits for your own copy of the code is tried again on Full and Express too, in plain words.
- A project taken out of the app stays out after a Restart or an Update.
- `squad demo` opens the sample board alone. Real projects' squads do not start, and it stays off Home.
- One update the tracker refuses for good (a deleted item, a rule of its own) no longer blocks that ticket's later updates.
- An agent's error that names a file like `login.tsx` no longer reads "signed out".
- Report a problem also takes out `DB_PASSWORD=...`, `sk_live_...` and the values in the project's own `.env` and local files.
- Enter no longer sends twice while the answer is on its way: Pull, Add a part, notes, messages to an agent, hand over.
- On a narrow window, a long error message no longer breaks its words letter by letter.
- After you say what you want to build, Home and the setup page no longer ask you the same question.

## [1.2.2] — 2026-11-05

A patch about the guard. It closes what a review of 1.2.1 found open, moves commit hooks to a throwaway git folder, and says
plainly what the guard is and is not. Nothing changes in how you work with the squad.

### What the guard promises

- **1.2.1 and earlier promised too much.** The guard stops accidents and most bad behaviour, but it is not a wall against
  code built on purpose to break out. `SECURITY.md` now says what it stops and what it does not. Use squad-kit on projects and
  tickets you trust, read what the Builder changes, and use squad-kit's sign-ins, not keys exported in a shell.
- **It closes more.** A command can no longer move its copy or the folders above git's own. It can no longer write in
  all of `~/.cache` or `~/Library/Caches`, where your own tools run programs from. On a Mac it can no longer signal other
  programs, or swap the guard's rules for a later command. A `.env` in your own checkout stays hidden, and so do sockets
  under `~/.ssh` and `~/.gnupg` and the keys into a runtime's virtual machine. On Linux the guard ran for real for the first
  time: a `.env` is hidden 3 folders down, and a socket behind `/var/run` no longer stops every command.
- **A project's own browsers still work.** Playwright gets a folder with the copy, with the browsers this computer has already
  linked in, so `playwright install` no longer waits on a read-only folder. Puppeteer and Electron download to the copy's
  cache. On a Mac, Puppeteer's Chrome needs `args: ['--no-sandbox']`, as it did before: its own sandbox cannot start inside
  the guard. Cypress gets a card until an engineer allows its folder.

### The guard and Docker

- **The project's own commands can no longer reach Docker.** In 1.2.0 and 1.2.1, a command in the guard could connect to
  Docker's socket, start a container with a hidden folder mounted in it, and read what the guard hides. Now the sockets of
  Docker Desktop, colima, lima, Rancher Desktop, OrbStack, Finch and Podman are refused, and on a Mac so is Docker's own
  port on this computer. On Linux that port stays open.
- **A project whose tests talk to Docker directly now gets a refusal** until a person allows it. The card says Docker is
  not open to the project's own commands, in a check, a setup or an app's start, and an engineer can allow its socket's
  folder in Settings.

### The project's commit hooks

- **They run on a throwaway git folder.** squad-kit makes it outside the project for each run, and on Mac and Linux the real
  git folder is now read only to them, all of it. Only the files in the copy and the commit's words come back, and
  squad-kit stages the files itself and makes the real commit from those. So **what a hook staged counts for nothing**: a
  file it force-adds stays out if git ignores it, a file it takes out of the commit goes back in, and a report file it
  leaves goes in.
- **The limits 1.2.1 listed are gone.** A hook sees your branch by its real name, not a stand-in's. lint-staged's backup
  stays out of your `git stash list`, even when a Stop cuts it off. A hook can no longer change a file in git's store of
  objects.
- **A Stop, a hook that runs out of time and a crash** put the files back as they were staged and remove new ones. What was
  on disk then is kept in `refs/squad/on-disk/<ticket>`, so no work is lost half-way through a formatter.
- **A hook's folder has only the repo's filters of its settings.** A hook that needs a remote, or fetches, gets the usual card
  with **Save without this check**.
- **What a hook leaves in its group ends when the commit does**, or at the next start after a crash.
- **A hook's "no" on a merge being finished holds.** Try again runs the hook again, instead of passing it by.

## [1.2.1] — 2026-11-05

A patch about not losing work and never reaching a dead end. It also moves the project's commit hooks into the guard.
Nothing changes in how you work with the squad.

### What you type stays

- **Text you type survives** a reload, a closed tab or a dialog closed by mistake: answers, comments, new tickets, bugs
  and the BRD box are kept for each project, ticket and field, and cleared once sent.
- **Skip** asks first. Dialogs with files in them ask before closing. Enter works in an **Other** answer.

### When something goes wrong

- **The app going down shows at once.** Within 5 seconds a banner sits over every page, nothing pulses as if it were
  still working, and the banner goes by itself when the app is back. An update that does not come back gets it after 2
  minutes.
- **One error no longer takes the app down.** Each squad turn is guarded, and an error in the screens shows a page with
  a way back. A full disk or a moved folder holds that project with one banner, and it carries on by itself.
- **A network blip waits and tries again**, 4 times over about 15 minutes, and never lowers the model level. A merge cut
  off by a blip is tried again too.
- **A moved folder is found.** The story copies' links are repaired when the squad starts, at **Looks right** and when a
  step opens a copy. Home follows a folder moved while the app runs.
- **A refused release has a way out.** A teammate's push is merged and sent, never forced. A real clash gets the clash
  card, and a protected main gets plain words and an engineer's steps.
- **It reached it another way**: a new button on the Releases page, for a release merged by hand. It needs a reason and
  looks on the remote first. If the release is not there, it warns and asks a second time. Terminal:
  `squad release --mark-sent --reason "…" [--anyway]`. `squad release` also takes the version with or without the `v`.
- **Take it**: a new button on a ticket whose owner cannot work on it. Terminal: `squad take-back <ticket> --reason "…"`.
- **A ticket is never overwritten** by another with the same id, and new ids skip the ones already pushed.
- **The home folder is refused** by `squad init`, setup and the first commit, and a leftover `~/.squad` is ignored.
- **The link lasts across tabs.** With no key in the link, the page says to run `squad`.
- **Stop and closing the board** end a running hook, and closing takes seconds. `squad | tee` stops cleanly, and a run
  whose output goes to files keeps running when its terminal closes.
- **An agent's tool calls** no longer fail with a dropped connection after 5 quiet seconds.

### The project's commit hooks

- **They run once, when a change is saved, in the guard, on a stand-in branch.** A hook cannot move a real branch, plant
  a hook or change a git setting. The real commit is made after, outside the guard, with your signature if your git
  signs. A crash or a failed signature no longer moves a branch or leaves an unsigned commit.
- **Every refusal gets a card**: **Let the Builder fix it**, **Fix it yourself**, **Try the save again**, or **Save
  without this check**. Saving without it needs a reason, which stays on the ticket, the pull request and the release
  notes. Builds by itself never skips a hook.
- **Refused code cannot slip through.** Work saved past a refusal is checked whole at **Looks right**, and the branch
  goes back as it was if the hook still says no.
- **The Builder cannot change the check to pass it.** Hook files, their settings and their `package.json` keys go back,
  with one plain line. What a hook calls, like lint rules and tests, stays the Builder's, and the Reviewer reads it.
- **husky 9 now runs in a story's copy.** Before, its hooks silently never ran there.
- **squad-kit runs no other hook**: no `pre-push`, `post-merge` or `post-checkout`, since the project's own checks have
  run by then. Your own terminal still runs them. Git LFS files still upload when squad-kit pushes.
- **A hook folder with a common name** (`hooks`) no longer costs you work in `src/hooks`. `npx` works in a hook with no
  packages installed.

### Security

- **`.git` and git's own folder are read only** for the project's commands and for agents.
- **squad-kit's own git starts nothing a repo names by itself**: no file monitor, no diff program, and nothing from a
  nested repo, which also stays out of commits.
- **The app answers only at its own address.** Host and Origin are checked on every route, a key in the link works for
  reads only, and HTML and SVG from a project download instead of opening at the board's address.

### Known limits

- **A hook built to do harm could change a file in git's store of objects.** A project with no commit hooks is not
  affected. The next patch closes this by running hooks in a throwaway git folder. See [SECURITY.md](SECURITY.md).
- A hook that reads the branch name sees the stand-in, `squad/saving/<branch>/now`. A strict one says no, and you get
  the card.
- Setup in your own checkout no longer installs husky's hooks. On a fresh clone they stay off until you install them.
- Stop in the middle of lint-staged leaves its backup in `git stash list`. Your work is safe.

## [1.2.0] — 2026-11-05

squad-kit 1.2 is about trust: squad-kit shows that it understands your project, says what the work really cost, and
makes the squad's work harder to fake. It also takes a whole requirements document and builds it, story by story.
Windows is less protected and not fully tested yet (see What's safer).

### What's new

#### From a BRD to a built product

- **A new Requirements page** (after Overview). **Add a BRD**: a PDF, Word or Markdown file, or pasted text, with
  mockups if you have them. The Analyst reads it live and asks only about what is **missing in the BRD** or where
  **two parts clash**. Then it writes epics, features and stories, each with its checks (Given, When, Then), size,
  needs and its place in the document.
- **Review it as a tree or a map.** Rename, rewrite, move, add or remove any part, or ask the Analyst to redo one.
  An estimate from this project's own tickets: "20 stories, about $140 and 6 hours, 2 at a time". Nothing is built
  or sent before **Approve breakdown**.
- **Send to Azure DevOps**: epics, features and stories with parent and dependency links, into the backlog. **Send
  changes** updates only what changed. squad-kit never deletes there, and a cut-off send makes no doubles.
- **Build continuously**: each story becomes a ticket on the new **Builds by itself** track, in the order its needs
  allow, within the parallel limit and the budgets. No questions, the plan is approved by itself, small choices are
  listed under **Decided for you** (press **Change** on any), and it merges by itself once the checks, the review
  and the screenshots pass. It stops only for a gap, a clash or a failed check, and then only that story and the
  ones that need it wait. Releases stay your button.
- Terminal: `squad requirements add|show|answer|edit|move|approve|send|build|start|…`, `squad decided`. See
  [From a BRD to a built product](docs/requirements.md).

#### Proof you can read

- **squad-kit takes the screenshots itself, with its own browser.** The Tester says which pages, steps and sizes.
  squad-kit opens the story's own copy of the app, does the steps and takes the pictures.
- **One or more pictures for each "done when"**: one per part or case, up to 6.
- **Each "done when" gets a verdict**, from the Tester and squad-kit's own check of all its pictures together:
  **Met**, **Not working yet** (a picture shows it does not work), **Not shown yet** (the pictures do not show it
  clearly) or **Not on a screen** (it cannot be shown at all, like an email or what happens after a restart). Not
  working yet goes back to the Builder once, then it is a plain stop. Not shown yet goes back to the Tester up to 2
  more times, keeps the good pictures and never reaches the Builder. Not on a screen keeps its reason and does not
  stop the story, unless every "done when" ends that way.
- **Also changed, not in the plan**: what the change touches beyond its plan, in the Reviewer's words. It never
  blocks. You see it at your check, on a stop, on the ticket and in the release notes.

#### Your turn

- **Where to look**: each page the proof names, with the "done when" it shows.
- **Try it yourself**: runs the story's own copy of the app, with the change in it and nothing merged, so you can
  click through it before **Looks right**. It stops by itself when the story moves on. Terminal: `squad try <ticket>`.
- **Ask a question** on every story, in every state: working, in the queue, waiting for another story, stopped, at
  review, taken over or released. Whoever knows the story best answers: the Analyst before the build, the Builder
  during and after it, the Tester once there are screenshots. It answers questions only, and the story stays exactly
  where it is. Terminal: `squad chat <ticket> --ask`.

#### First run and Overview

- **Add project says what it found** (code with or without git, an empty folder, several repos, an older
  squad-kit) and what happens next, before you confirm.
- **A setup page with live steps**: project memory, the AI tool, the Architect reading the code, how to test and run
  it, trying the tests, opening the app once with a screenshot, and your overview. Each step has its time; a failure
  has a way out and never stops the setup. **Notify me when it is ready**. Quality is asked once here.
- **The Overview page**, first in the sidebar: what the project is, who uses it, what it can do today, how its parts
  fit together, things worth knowing, the rules found, the proof, and three ideas for a first ticket. It stays up to
  date after every merged ticket.
- **The rules the Architect found are proposals until you approve them** with **Looks right, start working**. They
  used to be saved as approved without being shown. **Something is wrong** opens a talk with the Architect.
- **An empty project asks "What do you want to build?"**, in your own words, in English or Arabic. The Architect
  writes down what you want with first stories for it, and picks the technology itself when your first story is
  planned. Terminal: `squad overview --build "what you want"`.
- **squad-kit finds the commands of a project that started empty.** After the first build it reads how to test and
  run the project from its files, and saves that. Nobody is asked.
- Terminal: `squad setup`, `squad overview`, `squad demo --first-run`.

#### Conversation and Cost

- **Conversation opens on "What happened"**: one card per step with its time, a one-line summary and what it handed
  in, drawn as the real thing. **Full log** keeps the detail, in plain words, with **Open it in Claude Code**.
- **Cost follows how you pay.** On a subscription: "Included in your Claude plan. No extra charge.", the size of the
  work and where it went, with the API-price figure shown as a value, not a bill. With an API key: real dollars, a
  budget per ticket and per month, a warning at 80% and a pause at 100%.
- **Averages per Quality setting** (cost and squad time per accepted ticket) on the Squad and AI page.
- Terminal: `squad cost`, `squad config set payment`, `squad config set budget`.

#### Tickets that depend on each other

- **The Analyst and the Architect see the other open tickets** and the files they change.
- **A design can depend on another ticket.** The ticket then waits before building: **Build on its branch**, **Build
  anyway**, or **Wait** (it starts by itself when the other one merges). Terminal: `squad depends`, `squad build`.
- **Bring in latest main** is a button on a ticket being built (`squad bring-in`).

#### Releases

- **Take a ticket out of the next release** before you release it (`squad release --without`).
- **Released tickets' branches are cleaned up** on this computer, and on the remote when you ask (`squad branches`).
  A branch with unmerged work is never deleted.
- **A release cut off by a restart finishes or rolls back** cleanly on the next start.

#### Also

- **The ticket can go full width** (the button next to Close; remembered in this browser). **Hand over** and
  **Propose a change** moved to the ⋯ menu, and Propose a change is also on the ticket's bottom bar, so the header is
  one row at any width.
- **The Waiting for you banner is one slim, calm row**, and stays readable beside a docked chat.
- **The update banner shows what is new in every release since your version**, and **Check for updates** reads the
  notes again.
- **Free the port and try again** on a stuck Tester step, for programs squad-kit itself started.

### What's safer

- **Agents get fixed tools, "the window"**: `take_screenshots`, `look_at_page`, `start_app`, `stop_app`, `app_status`,
  `run_checks` and `i_am_stuck`. An agent fills in the fields, squad-kit checks them, does the job itself and hands
  back the result. There is no free command: only this story's app on this computer, only the project's saved
  commands, only what squad-kit started. A request outside that is refused and written in the activity, and three
  refusals in one step stop the agent.
- **`i_am_stuck`**: when something technical is in an agent's way, squad-kit tries its own fixes (its browser, a free
  port, starting the app again) and writes one plain line. It is never a question to you.
- **Technical questions never reach you.** squad-kit reads each question an agent asks, with its choices and
  everything shown with it, and does not trust the agent's label. A question about ports, commands, files or settings
  goes back to the agent to decide. An agent that keeps asking stops in plain words. When another program holds a
  port and going around it did not work, you get one plain card with no port in it: **Stop it** (with a confirm) or
  **Skip the browser tests**.
- **Some asks are refused and logged.** Asking you to change squad-kit's settings or protected files, to hand over a
  password or a key, or to change git history never reaches you. One plain line goes in the activity. A reply in a
  chat that asks for any of these is left out too.
- **A second guard for the project's own commands.** The tests, lint, build, setup, the app's start and the release
  pipeline run in squad-kit's own guard on Mac and Linux. They work normally, browser tests too, and can reach the
  network, but they can't read your keys, sign-ins, browser profiles, squad-kit's own folder or the `.env` files in
  your project folder. If a project truly needs a file outside its copy, one plain sentence says so, and an engineer
  can allow it in Settings or with `squad config set allow-read <path>` and `squad config set allow-write <path>`.
  `squad doctor` shows whether the guard runs here.
- **Windows is less protected and not fully tested yet.** There, the agents' own commands and the project's own
  commands have no guard, so they can reach other files on the computer. Use it on projects you trust. Settings and
  the Squad and AI page say "Windows: less protected".
- **"Not checked" instead of a green pass** when a project has no tests. You are asked once per project, with the
  Architect's suggested test command. A project without tests also checks that the app starts.
- **Weakened tests stop the ticket**: deleted tests, fewer tests, a changed test setup, or new skip/only markers, in
  the common languages. **Continue anyway** needs a reason that stays on the record.
- **Proof is verified**: each screenshot must be a real image taken in this step, and "after" must differ from
  "before", unless the "done when" says the screen stays as it was.
- **The Reviewer sees the whole change and the check results** in every round, not only the fix. In its review it can
  also look at a page of the app itself (`look_at_page`).
- **A change to the test command is tried first.** squad-kit runs the new command and the current one in the ticket's
  copy, and keeps the new one only when it passes and runs at least as many tests. You choose only when it cannot
  tell. Terminal: `squad test-command <ticket> --use | --keep`.
- **The Builder's and Tester's commands run in Claude Code's sandbox** where the computer allows it: they write only
  in the ticket's copy, its proof folder and a private package cache, can't read your keys, sign-ins or `.env`
  files, and reach only package registries and the websites you allow (Settings, `squad config set hosts`). A
  blocked command says what and why. `squad doctor` shows whether the sandbox runs here.
- **Turn and spend caps per step** from the Quality setting. Reaching one keeps the work and offers **Give it more**
  or **Stop**.
- **Every command squad-kit suggests you copy quotes your text safely**, on the board and in the terminal.
- **zod 4, the AI SDK 5 and diff 8** for the 0.x planner commands. This closes the last high alert. The planner's
  file-read tool on the Claude Agent SDK path now works with ranged reads.

### What's fixed

- **Plain stop messages.** A stop says what happened in squad-kit's own plain words, with **Try again**. A tool's raw
  error never reaches you: the exact words are in the ticket's Developer tab and the app log.
- **A failed check runs once more** before anyone is sent to fix it, so a flaky test costs no Builder run. If it passes
  then, the activity and the Developer tab say "failed once, passed when run again". Not after a Stop, a command
  squad-kit had to end, or a file the guard blocked.
- **The Builder is told about old failures**: the checks that already failed on the first run, before any story
  touched the code. It fixes what its story broke and leaves other screens alone. The checks must still pass.
- **A clash no longer stops a story too soon on Builds by itself.** While main keeps moving, squad-kit brings it in
  again by itself, up to 3 times, with the checks, the review and the proof each time. If main has not moved, or after
  the third time, you get the clash card. Other tracks show the card at the first clash, as before.
- **Apps move to a free port by themselves** when another program holds the usual one: Your apps, the story's own copy
  and Try it yourself. In Your apps this works when the start command or the app's code takes a port setting; if not,
  one plain sentence says what is in the way. `--next-port` on `squad app start` and `squad app restart` is still
  accepted, and now does nothing.
- **squad-kit installs its own screenshot browser.** No `npx playwright`, and nothing to install by hand. The first
  time, one line says "Setting up squad-kit's screenshot browser. This happens only once."
- **The step timer counts only running time.** It stands still while a ticket waits for you, for another story or for
  a free place, so "Taking longer than usual" no longer shows on a step that was only waiting.
- **A restart is not a failure.** Restarting the board, Stop or the computer sleeping no longer counts as a failed
  try or raises the model's effort. The Builder carries on with the same step in the same conversation, instead of
  starting the work again, and the step's clock keeps its time ("resumed after a restart").
- **Nothing is left behind.** When a step ends, on Stop, and when the board restarts or quits, squad-kit stops every
  program it started for the ticket, including test servers that left their process group. It finds them by where
  they run: inside squad-kit's own copy of the code, never your folders or Your apps.
- **squad-kit clears its own leftovers before the checks** and says so in one activity line. If an agent asks about a
  busy port that squad-kit caused, squad-kit answers it and you never see the question.
- **Desktop notices: Turn on always answers.** It says when the browser is asking, explains how to allow notices
  when the browser stays silent (for example in Arc), and sends one test notice.
- **A ticket a teammate deleted** shows "Deleted by <owner>" with **Remove from my board**.
- **A chat message sent during Claude's usage limit waits** and is answered when the squad carries on.
- **On a phone**, the banners fold into one slim row while a ticket is open, and the website's docs pages fit.

## [1.1.1] — 2026-11-03

A security update. Nothing changes in how squad-kit works.

### Security

- **Packages with known security problems are updated.** The app's web server (hono 4.13, @hono/node-server 2), the
  parts of the MCP SDK's server it pulls in (proxy-addr, body-parser, qs, ip-address), @modelcontextprotocol/sdk
  1.32, fast-uri and js-yaml; in the app's screens, seroval and js-yaml; and the test tools (vitest 4, vite 6).
- **The website's build tools** move to Astro 7.
- **Still open:** zod 3, used only by the 0.x planner commands (`squad new-plan` with an API key). Its fix needs
  zod 4, which those commands' AI library does not read yet. It is planned.

## [1.1.0] — 2026-11-03

squad-kit 1.1 is about never wondering what the squad is doing, and always having a way out.

### Always know what is happening

- **Every card says what is happening** in plain words: "Builder · step 3 of 6 · editing the booking page", how
  long it has run, and how long that step usually takes on this project. squad-kit learns the usual times from the
  project's own history. A ticket over the limit says "Next in line: starts when a slot is free".
- **The Now tab** says in one sentence what happens now and what comes next. The stage tracker shows how long each
  stage took. Terminal: `squad status <ticket>`, and `squad show` prints the same.
- **Ask about a ticket**: "is there a problem?", "when will it be ready?", "what is it doing?". Status questions are
  answered at once from the live record, in English or Arabic, at no AI cost. A question that would change the work
  offers Propose a change or a note, and says when the note will be read. Terminal: `squad ask <ticket> "..."`.

### Waiting for you, loud

- **A banner on every page** when something needs you, with the button to press on each item.
- **The browser tab shows the count**: "(2) roomflow".
- **Desktop notices**, asked for once: one notice per new question, approval, proof or stop. No sound. Settings ›
  Desktop notices turns them on or off.

### Time limits you can see

- **"Taking longer than usual"** past twice a step's usual time, with what it is doing, its last progress and when
  squad-kit stops it: **Give it 10 more minutes**, **Stop and try again**, **Stop**. Terminal:
  `squad wait <ticket> --more 10m`, `squad stop <ticket> --again`.
- **"Looks stuck"** says what squad-kit checked, and keeps **End the stuck command**.

### Your apps

- **Start, Open, Restart and Stop** your app from the sidebar. squad-kit runs it from its own copy of `main` (never
  your folder), brings the copy up to date first, copies your `.env` files into it, and says Running only when the
  address answers. **Show output**
  has the last lines.
- **Run the new version** after Looks right.
- **A busy port** gets a plain message, and the fix when there is one. No start command: **Ask the Architect to find
  it**, or **Type it**.
- Terminal: `squad app start|stop|restart|status|set|find`.

### Delete and Archive

- **Delete** a ticket that is not merged: squad-kit stops the squad on it, then removes its copy of the code, its
  branch, its files, its unmerged decisions, its chats and screenshots. The tracker item and the cost stay. A delete
  cut off half-way finishes with **Delete again**.
- **Archive** a merged or released ticket to take it off the board; **Show archived** and **Unarchive** bring it
  back.
- Terminal: `squad delete <ticket>`, `squad archive <ticket> [--undo]`, `squad board --archived`.

### When something goes wrong

- **Every stop says what happened, what is safe, and the ways out** as buttons. The exact error is in the
  Developer tab and the app log.
- **Claude's usage limit pauses the squad** for every project, shows when it resets, and carries on by itself from
  the same step, without counting a failed try. **Try now** carries on at once (`squad try-now`).
- **Report a problem** saves one `.zip` to send for help: the ticket, its conversations, the last day of the app
  log and the versions. Never sign-ins, tokens or `.env` files. Terminal: `squad report [ticket]`.
- **An app log** in `~/.squad-kit/logs/`, one file a day, kept 14 days. Terminal: `squad logs --tail`.

### Also

- **On a phone**, the sidebar folds away behind a menu button, and the ticket drawer takes the whole screen.
- **`squad inbox`** names a newer decision that changes a plan correctly (it said "Looks stuck").
- **Copied terminal commands quote pasted text safely.** A note or answer with `$(…)`, backticks or a trailing `\`
  could run or break when the command beside its button was pasted into a terminal.
- **Tracker text is decoded once.** A written `&amp;lt;` in a Jira or Azure DevOps item no longer turns into `<`.
- **Security**: GitHub code scanning, secret scanning with push protection and Dependabot are on, the release
  workflow's Actions are pinned to exact versions, npm publishing runs only from release tags, and `SECURITY.md`
  describes 1.0. The issues code scanning found are fixed.

## [1.0.1] — 2026-11-03

squad-kit 1.0.1 makes the squad steadier and easier to follow, from what we saw in the first trials. To get it
from 1.0.0, run `squad upgrade` once. From now on the app updates itself with one button.

### Easier to follow

- **"From an idea or message" works and shows its progress.** The dialog no longer disappears behind a blurred
  board. The Analyst works in the background with three steps and a clock, and you can press Cancel. You can
  close the window: the draft waits for you under New ticket.
- **Errors stay on screen** until you close them.
- **The Conversation tab reads in plain words.** "Handed in its answer" replaces the raw answer, and a command
  the step may not run shows in grey as skipped, not in red as a failure.
- **A ticket waiting for a free place says so**: "Waiting for a free place", with the limit, instead of
  looking as if it runs.
- **"Resumed after sleep"** shows when the computer slept in the middle of a step.

### The Update button

- **The app looks for a new version** on start and once a day. When one is out, Home and every project show
  it with what is new. **Update now** waits until no agent is in the middle of a step, installs, and restarts
  the app on the same link. Every ticket carries on where it was.
- **Settings › About squad-kit** shows your version, when it last checked, and a switch for the daily check.
  Terminal: `squad upgrade`.

### Quality

- **A new Quality setting** on the Squad and AI page: **Best** (the default), **Balanced** or **Thrifty**.
  On Best, the strongest model builds and reviews at high effort. On Claude Code that is Opus. Terminal:
  `squad config set quality best`.
- **A new "extra high" effort.** On Best, a Builder run that fails moves the next one up to extra high.
- **The Reviewer is never weaker than the Builder** on Best and Balanced.
- **Reading the project after a merge is cheaper.** The project map is only read again when files are added,
  moved or removed, and that read runs on a lighter model.

### No silent hangs

- **Stop works at every moment**, also between two runs, and it ends the agent with everything it started. A
  step that runs out of time ends the same way.
- **Git that talks to a remote has a time limit**, and never waits for a password prompt nobody sees.
- **Starting an agent has a time limit.** If it cannot start, the step says why instead of waiting.
- **The Builder no longer waits for the "before" screenshots.** They are taken beside it, with their own time
  limit.
- **A test, lint or build command with no output for 5 minutes is stopped**, and the ticket says which one.

### Agents stay in their lane

- **Every agent runs with the permissions of its step.** The Tester can run the app but cannot change the code;
  what it changes anyway, squad-kit puts back.
- **No agent can change the instruction files** the next session would follow, such as `CLAUDE.md`, or
  squad-kit's own `.squad/` folder. Agents read copies of the project's rules, never your own folder.
- **No agent can rewrite git history.** squad-kit checks after each Builder and Tester step.
- **Every answer is checked.** An incomplete answer is asked for once more, then the step says so plainly.
- **Text from outside**, such as a tracker item or a pasted message, reaches the agents as data, never as
  orders.
- **Test, setup and release commands no longer get the AI and tracker keys.**

### No lost work

- **A release and a "Looks right" at the same moment** no longer get in each other's way.
- **Stop keeps the step the ticket was at.**
- **"Bring in the latest main"** uses the remote's main, not an old local copy.
- **Only a real clash counts as a clash.** Other git errors say what went wrong. `squad doctor` checks the git
  version.
- **Tracker updates are kept until they are sent**, and retried when the tracker is down.
- **A release whose push failed** says "not pushed yet", with **Push again** on the Releases page. Terminal:
  `squad release <version> --push-again`.
- **Withdraw change** takes back an approved change the squad has not built yet, and puts the spec back to how
  it was. Terminal: `squad propose <ID> --withdraw`.

### Fixes

- **The Architect writes the stack**, with each part's role, from the code it reads. `stack.md` was empty.
- **The Reviewer is told the checks already ran**, so it does not run them again.

## [1.0.0] — 2026-11-02

squad-kit 1.0 is an agent harness for the whole software cycle. You write a ticket in plain words. A squad of
AI agents (Analyst, Architect, Builder, Tester and Reviewer) takes it from that ask to a release, and you stay
in control through buttons and approvals. It needs Node.js 22 or newer, git, and an AI tool installed and
signed in: Claude Code today. Moving an existing project: [Moving to 1.0](docs/migrating-to-1.0.md).

### The one app

- **Plain `squad` opens one app for all your projects**, from any folder, in your browser at `127.0.0.1:4571`.
  It runs on your computer only, behind a private link.
- **Home** lists your projects and one **Waiting for you** list across all of them.
- **Add project** opens a folder browser inside the page. It says what kind of folder you picked, and can make
  a new one.
- **`squad console`** in a folder adds that project to the app and opens its board, starting the app if needed.
- Every project has its own board, at its own address. Every button has a terminal command, and commands take
  `--project <name>` from any folder. New: `squad projects`, and `squad inbox` across every project.
- `squad --restart` and **Restart the board** start a fresh app on the same link. Running work picks up where it
  stopped.

### Projects and files

- **Any folder can be a project**: an empty folder (a new repo), code with git (kept as it is), code without git
  (a new repo with your files in its first commit, without `node_modules`, `dist` or `.env`), or a folder with
  several code repos.
- **The project keeps its own memory in `.squad/`**, as Markdown people can read and edit: `config.yaml`, and
  `tickets/<ID>/` with `ticket.md`, `spec.md`, `questions.md`, `design.md`, `notes.md`, `proof.md` and attached
  files, plus `decisions/`, `releases/`, `rules/` and `knowledge/`.
- **This computer keeps its own part in `~/.squad-kit/projects/<id>/`**: live progress, agent chats,
  screenshots, voice notes, sign-ins and cost. Nothing secret, personal or big goes into the project folder.
- **Git stays quiet.** `.squad/` goes in git's local ignore list, never in `.gitignore`. For a project whose
  `.squad/` sits in its one repo, squad-kit commits each ticket's documents on the ticket's branch, and the
  release commit carries the rest. `git log .squad/tickets/<ID>` shows each big moment of a ticket.

### Tickets and the squad

- **Write a ticket on the board** in plain words, with criteria, business rules, edge cases and files. Or paste
  an idea or a chat message and the Analyst fills in the ticket for you to check. Bugs have their own form.
- **Pull a ticket from your tracker.** Azure DevOps today: the backlog by sprint, comments, states, bugs, pull
  requests on Azure Repos, and items closed with the version on release. Tickets keep the tracker's name, like
  `AB-46`; a project without a tracker names its own (`LR-1`).
- **The squad's loop**: questions, spec, design, build, checks, review, proof, release. You answer, approve the
  spec, approve the design (a developer can do this part), check the proof and release.
- **Full and Express tracks.** Express is for small fixes: no questions and the plan approved on its own; the
  build, checks, review and your **Looks right** still run.
- **squad-kit is the boss.** It runs the tests, lint and build itself, starts a fresh Reviewer, and does the git
  and tracker work. Agents never merge, push or grade their own work. The Builder works in its own copy of the
  code; your folder is never touched while it works.
- **Decisions are saved and linked**, named by the ticket that made them (`AB-46.1`), or `STACK.1` for what the
  Architect found in the existing code. The Architecture page shows how they build on each other.
- **Every stop has a way out**: try again, fix it yourself, continue anyway (only you can, with a reason that
  stays on the record), or go back to the plan. Nothing hangs silently.
- **Model levels per role and step**: strongest, balanced or fast, with an effort. squad-kit sets the defaults;
  the team and each person can change them on the Squad and AI page.
- **One limit of tickets at once** (2 by default, up to 5), shared by all projects, because they share your AI
  account.
- AI tools plug in as modules. Claude Code runs every role today; Codex is found but cannot run yet.

### Chat

- **Talk to any agent** on a ticket, with screenshots, files and voice notes.
- **Asking never stops the work.** While the squad works, the chat runs beside it and changes nothing.
- **A change goes through the spec.** **Propose a change**: the Analyst writes the old and new wording and says
  if it is small or big, and you approve. A small change reaches the Builder at the end of its current step. A
  big one pauses it, the Architect updates the design for your approval, and the Builder redoes only what
  changed. One change at a time per ticket. Terminal: `squad propose`.
- **Released work is for questions only.** A change to it becomes a new linked ticket or a bug report.
- A new chat window is coming in this release: a side panel with tabs, a full-screen page, a phone layout, and
  Arabic and English shown the right way.

### Teams

- **An owner on each ticket**, kept in `ticket.md`, so two squads never build the same ticket.
- **Hand over** (button and `squad hand-over`) pushes the ticket's branch with its code and documents, and names
  the new owner. Their squad carries on from the branch, with a fresh session from the spec, design and code.
- **A fresh clone shows the same board**: every ticket with its spec, answers, design, stage and owner, and
  every decision. Live progress, chats and screenshots stay on the computer that made them.
- Hand over and clones work for a project whose `.squad/` sits in its one repo.

### Cost

- **What each ticket and each role used**: runs, tokens, and the cost at the AI company's API prices, per role
  and step. On the ticket's Cost tab, the Squad and AI page, the board's footer and in `squad show`.
- Your own AI subscription pays for it. The numbers show where the cost goes, so the team can tune the levels.

### Moving from 0.x

- **Open a 0.x project** with `squad console` or Add project. Its `stories/`, `plans/` and tracker settings in
  `config.yaml` stay as they are; `config.yaml` gains a `board:` section.
- **Sign-ins move** from `.squad/secrets.yaml` to `~/.squad-kit/projects/<id>/secrets.yaml`. The 0.x commands
  find them there.
- **A board from an early 1.0 build** (`.squad/board/`) moves to the new layout on its own, once, with a backup
  in `~/.squad-kit/backups/` and a field-by-field check. Tickets and decisions keep their names. It waits until
  no board runs.
- The 0.x commands (`new-story`, `new-plan`, `auth`, `config`, `doctor` and others) still ship. The 0.x console
  pages are replaced by the 1.0 app.

## [0.12.4] — 2026-08-26

### Bug fixes

- **"Open" on a freshly generated plan 404'd in the console.** After a run finished, the *Plan
  saved* callout's **Open** link — and the **Open plan** button on the run report — resolved to
  `/plans/<feature>/.squad%2Fplans%2F<feature>%2F<file>.md`, and the page rendered
  `404 Not Found: {"error":"not_found"}`. Reported as
  [#9](https://github.com/AzmSquad/Squad-Kit/issues/9).

  Run records and the `done` event carry `planFile` as a path relative to the workspace root
  (`.squad/plans/<feature>/<file>.md`) — that is the form shown to the user, and what both
  `squad new-plan` and the console runs API have always written. The `/plans/$feature/$planFile`
  route and `GET /api/plans/:feature/:planFile` want the **file name** only, because the API
  resolves it under `.squad/plans/<feature>/`. Both link sites now normalise the value.

  Normalising in the UI rather than at the writers also repairs every run record already on disk,
  which all store the long form — so the run report's link works for historical runs too, not just
  new ones.

  The existing test asserted the correct href but fed the component a bare file name the server
  never sends, so it passed while the real link was broken. The fixture now matches the actual
  payload, and reverting the fix makes it fail.

## [0.12.3] — 2026-08-25

### Bug fixes

- **The console's Doctor page was unreachable.** `/doctor` was defined as a route but never added to
  the router's child list, so the sidebar link, the breadcrumb, and the Cmd+K entry all resolved to a
  bare "Not Found". Introduced in 0.11.0 (`46519fd`, the runs-pages work) and shipped in every
  release since. The CLI's `squad doctor` was unaffected throughout, which is why it went unnoticed.

  The route is registered again, and `console-ui/src/router.test.ts` now asserts that **every**
  sidebar destination resolves to a registered route. Neither the type checker nor the existing
  tests could catch this: a defined-but-unregistered route is valid unused code, and a link to a
  non-existent path is just a string.

## [0.12.2] — 2026-08-25

### Bug fixes

- **The planner never read any project files, then hung.** On the Agent SDK runtime a run reported
  `reads 0/N`, the scout exhausted its turns without reaching `respond_with_scout_result`, the draft
  produced a plan with no repo context, and the session then stalled indefinitely — the plan file was
  written but the CLI and the console both kept spinning. Reported as
  [#8](https://github.com/AzmSquad/Squad-Kit/issues/8). Two causes, both fixed:

  1. **Every tool call is gated on a permission decision**, and the runtime supplied no handler. The
     model emitted `tool_use` for `read_file` / `grep` / `list_dir` and nothing ever executed them.
     The runtime now grants its own `mcp__squad-kit-*` tools and denies everything else, so a tool
     the planner did not register can never run during planning.
  2. **A claude.ai login carries the account's connectors into the session** as extra MCP servers
     (Google Drive and friends), crowding the tool namespace the planner depends on — measured at 12
     tools where the planner registers a handful. Planning now runs with `strictMcpConfig`, so it
     sees only the tools squad-kit registers.

  Verified on a real subscription run: `reads 0/25` and an indefinite hang before, `scout ✓` with
  `reads 8/8` and a clean exit after.

  **Scope.** Cause 2 needs a Claude subscription login and so only affects 0.12.x. Cause 1 is
  auth-independent and dates to the Agent SDK runtime landing in **0.10.0**, so API-key users on
  `planner.runtime.anthropic: agent-sdk` (the default for Anthropic) were most likely getting
  context-free plans too. That inference follows from the mechanism; it has not been reproduced
  against an API-key run.

### Internal

- Pinned `packageManager` to `pnpm@9.15.9` and removed the duplicate pin from the CI workflow.
  Corepack had been resolving pnpm 11 locally, which re-added a `packageManager` field on every
  invocation, generated a stray `pnpm-workspace.yaml`, and failed `pnpm install` on unapproved
  esbuild build scripts — breaking `pnpm build`, `pnpm test`, and `npm publish` (whose
  `prepublishOnly` runs all three). The lockfile has always been `lockfileVersion 9.0`.

## [0.12.1] — 2026-08-24

### Bug fixes

- `squad auth login` ended a **successful** browser login with
  `could not verify the login (unknown)` and a warning that the credential "may
  be invalid or expired". The token was fine. `accountInfo()` resolves from the
  Agent SDK's `initialize` response, and for `CLAUDE_CODE_OAUTH_TOKEN` auth that
  response carries `{tokenSource, apiProvider}` and **never** an account — for a
  valid token exactly as much as for a bogus one. 0.12.0 treated a missing
  account as a failed credential, which flagged every healthy login through the
  primary documented flow.

  The probe now separates three outcomes instead of two: an account came back
  (verified, shown); a credential *source* came back without an account
  (reported as resolved, with the honest caveat that token validity can only be
  confirmed by an actual planning run); or nothing came back at all (still
  treated as unverified). `squad auth login`'s summary and `squad doctor`'s
  planner credential row both reflect which applies, and neither claims a
  verification the SDK cannot perform.

  Workspaces that authenticate through the OS credential store are unaffected —
  those do report an account and are still verified as before.

## [0.12.0] — 2026-08-24

### What's new

- **Plan on your Claude subscription.** The Anthropic planner can authenticate
  with the Claude login you already have (Pro, Max, or Team/Enterprise) instead
  of an API key. `squad new-plan --api` and the console Generate page both run
  on it. No per-token API bill. OpenAI and Google are unchanged and remain
  API-key only.
- **`squad auth login | status | logout`.** `login` runs the Anthropic browser
  authorization flow and stores the resulting token in `.squad/secrets.yaml`;
  `--token <value>` consumes a `claude setup-token` value on a headless machine,
  and `--print-only` runs the flow, prints the token, and stores nothing.
  `status` reports the resolved mode, the credential behind it, and the
  signed-in account (`--json` for a stable scripting shape, `--offline` to skip
  the live check). `logout` removes only the token squad-kit stored.
- **`planner.auth.anthropic`** in `.squad/config.yaml` — `subscription`,
  `api-key`, or `auto`. The merged default is **`auto`**: prefer a detected
  Claude login, fall back to a resolvable API key, otherwise fail naming both
  recovery paths. `squad init` offers the subscription as the first and default
  choice for new workspaces and writes it explicitly.
- **`planner.anthropicOauthToken`** is a new secrets-only key. `.squad/config.yaml`
  rejects it by name at load time.
- **Subscription runs withhold the API key.** In subscription mode
  `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed (case-insensitively)
  from the planner subprocess environment. Both outrank the login credential
  inside Claude Code, so an inherited one would silently bill API credits. The
  parent shell is untouched.
- **No new runtime dependency.** `squad auth login` shells out to the `claude`
  binary that `@anthropic-ai/claude-agent-sdk` already ships through
  `optionalDependencies`. A separate Claude Code install is never required.
- **Auth-aware `squad doctor`.** New `planner auth mode` (resolved mode, why,
  and the credential — naming any API key it is ignoring) and
  `planner auth vs. runtime` (subscription auth requires the Agent SDK runtime)
  checks. `planner model resolves at provider` and `planner tier vs. model` now
  **skip** on subscription auth: there is no API key to list models with and no
  API rate tier to warn about.
- **Console auth surface.** An Authentication control on Config (with a
  hard-conflict callout that disables Save), a Claude Account card on Secrets
  with a live "Check again" probe and a masked stored token, an auth badge and
  branched billing copy on Generate, a dedicated recovery callout for
  `auth_unavailable` failures, and an Auth column on the runs index. The console
  guides the login and never performs it — it cannot complete an OAuth callback
  on your behalf.
- **Run records carry `authMode`**, and the planner stream gained one additive
  `auth_info` event. Older clients ignore unknown event kinds.
- **Cost copy branches on auth mode.** `printPlannerApiCostNotice()` and the
  limit explanations no longer describe per-token billing on a subscription run.

### Bug fixes

- Planner model-list probe (`src/core/probes.ts`): a network-level `fetch`
  rejection (offline, DNS failure, proxy refusal) or a non-JSON response body
  threw out of `fetchProviderModelIds` instead of returning a failure result, so
  `squad doctor`'s `planner model resolves at provider` check surfaced an
  unexpected error rather than a clean diagnosis. Both are now caught and
  reported as `status: 0` with the message, and long error bodies are truncated.
  Shipped to GitHub after v0.11.0 (`d2d67a1`) and missed the 0.11.0 changelog.

### Upgrade notes

Zero-config. A `config.yaml` with no `planner.auth` block merges to `auto` and
keeps loading; every existing `planner.*` key, including `maxOutputTokens`, is
unaffected. An untouched 0.11.0 API-key workspace resolves to `api-key` and
behaves identically — **provided the machine has no Claude login**.

Under `auto`, a detected Claude login **outranks** a stored API key. So on a
machine that has both, an upgraded workspace switches to subscription billing.
Nothing errors, and the change is announced rather than silent: `squad doctor`'s
`planner auth mode` row reads `subscription (auto — Claude login detected) → …
· ignoring the API key from .squad/secrets.yaml`. Set
`planner.auth.anthropic: api-key` to pin the previous behaviour.

`squad doctor --fix` deliberately does **not** pin an implicit `auto` to
`api-key`. `auto` exists so that a Claude login takes over once one appears;
pinning would silently prevent that forever.

### Notes / limitations

- **Usage draws on your Claude plan's limits.** Per Anthropic's
  [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
  Agent SDK, `claude -p`, and third-party usage consumes the subscription's
  usage limits, and the separately announced monthly SDK credit is not currently
  available. The claim this release makes is **"no per-token API bill"** — not
  free, and not unlimited. Opus planning against a **Pro** plan consumes a usage
  window noticeably faster than against **Max**. Hitting the ceiling means
  waiting for the reset window or switching to an API key.
- **Enterprise managed-settings `apiKeyHelper` still wins.** squad-kit runs the
  Agent SDK with `settingSources: []`, so user, project, and local settings are
  not read and an ordinary user-level `apiKeyHelper` cannot hijack a
  subscription run. **Policy settings are always merged regardless**, so a
  managed-settings `apiKeyHelper` deployed by MDM is still honoured and still
  outranks the login credential — on a managed device, `auth: subscription` may
  resolve through the organization's helper. This was established by reading the
  credential resolver in the bundled `claude` binary, **not** on a live managed
  device. `squad auth status` reports the `apiKeySource` the SDK actually
  resolved.
- **`auth: subscription` requires the Agent SDK runtime.** `@ai-sdk/anthropic`
  authenticates with `x-api-key`, and an OAuth credential is not an API key.
  `auth: subscription` with `planner.runtime.anthropic: vercel`, or with a
  non-Anthropic provider, is a hard failure before any network call — never a
  silent downgrade to API billing.
- **Account details are never persisted.** Email, organization, and plan are
  fetched live for display in `squad auth status`, `squad doctor`, and the
  console. `.squad/runs/` records the resolved **mode** and `apiKeySource` only —
  no token, key, email, or organization. Asserted by a test.
- **A successful SDK handshake does not prove the credential works.**
  `accountInfo()` resolves from the subprocess's `initialize` response, which
  succeeds whether or not the credential is valid. Subscription auth that
  reports no account **and** no `apiKeySource` is therefore treated as
  unverified rather than signed in.
- `docs/auth.md` is not shipped inside the npm tarball. It is served at
  <https://squad-kit.com/docs/auth> and lives in the repo under `docs/`.

## [0.11.0] — 2026-05-04

### What's new

- API `new-plan` can append planner events to `.squad/runs/<id>.events.jsonl`
  (thinking text redacted on disk; retention rotates old files).
- Agent SDK runs emit richer events (tool lifecycle, thinking deltas, caps,
  runtime metadata) for the CLI and console.
- API-mode `new-plan` prints stage pipeline, budget meters, and thinking
  activity; the plan summary cites the events file path.
- `squad console` HTTP API lists persisted runs and serves stored event streams.
- Console UI adds a runs index, run report page, and a reworked Generate view
  with live panels and navigation.

### Bug fixes

- `squad doctor` skips live external probes when `CI` is set and surfaces
  planner probe errors cleanly.
- Vitest timeouts increased for slow config loads and console API tests.

## [0.10.0] — 2026-05-04

### What's new

- Anthropic planning defaults to the Claude Agent SDK so Opus 4.7 can use
  adaptive thinking and effort; OpenAI and Google stay on the Vercel AI SDK.
- Planner YAML and CLI cover runtime choice, thinking mode, effort, and
  per-phase effort (`--anthropic-runtime`, `--effort`, `--scout-effort`,
  `--no-thinking`).
- The planner summary shows which runtime ran; run JSON may record runtime and
  a provider-options snapshot for dashboards and tooling.
- `squad doctor` checks runtime wiring, model vs runtime fit, and the Agent SDK
  binary.
- Published CLI no longer bundles `cli.js.map`; set `SQUAD_TSUP_SOURCEMAP=1`
  when running `tsup` locally if you need a source map.
- On the Agent SDK path, cache token counts are not surfaced in telemetry
  (caching still applies); live usage stays aggregate-only until the run ends;
  cancel may not stop the upstream HTTP request immediately.

## [0.9.1] — 2026-05-04

### Bug fixes

- Anthropic scout and draft attach extended thinking so Opus 4.7+ avoids
  failed calls when the SDK would send incompatible temperature overrides.

## [0.9.0] — 2026-05-04

### What's new

- Scout precedes the draft planner in API `new-plan` for a cheaper first pass.
- Validation verifies citations offline and suggests typo fixes for paths.
- New planner tools: `grep`, `list_dir`, and `read_file` with offset/limit.
- Scout sees a bullet list of `.squad/plans/` markdown (caps at ~30 files).
- Anthropic/OpenAI/Google run through Vercel AI SDK (`ai`, `@ai-sdk/*`).
- Tool outputs keep `toolName`/`isError` metadata across turns where supported.
- Scout snippets use separate user-role cache blocks for stabler prompts.
- Generate-plan template adds edge-case, failure-mode, and test-plan sections.
- Disable scout or validation via flags or YAML (`planner.stages.*`).

### Bug fixes

- Jira Tracker broke on blank search (HTTP 400); bounded JQL restores results.
- Atlassian JSON errors surface in tracker messages again (snippet capped).

### Breaking changes

- Dropped `planner.budget.maxCostUsd` and `cost_cap` limits (never enforced).
- Remove lingering keys from `config.yaml` if they are still declared.

## [0.8.0] — 2026-05-03

### What's new

- Generate page shows provider rate limits: countdown, auto-retry banner,
  and rerun when the planner aborts over the wait cap.
- Planner emits richer `rate_limit` stream events (`retrying` vs `aborted`,
  cap seconds, provider, short error snippet). CLI `new-plan` only shows the
  “waiting to retry” spinner for the retrying phase.
- Run SSE ends a rate-limit abort with `done` (partial) only — no extra
  `error` line repeating the same message.

### Bug fixes

- Jira issue search called deprecated `/rest/api/3/search` (Atlassian returns
  HTTP 410). Search now uses `/rest/api/3/search/jql` with clearer 410 errors
  if an old client hits removed endpoints.

## [0.7.2] — 2026-04-28

### Bug fixes

- The console sidebar and dashboard still reported `v0.6.0` after 0.7.1
  because `/api/meta` and `/api/dashboard` had the version hardcoded.
  Both now read from `package.json` (matching the CLI and `/healthz`
  fix in 0.7.1).
- `squad config set tracker --type github` was a no-op stub: it set
  `tracker.type = github` without prompting for owner/repo or PAT and
  skipped the connectivity probe. It now matches the Jira and Azure
  flows — interactive credential prompt, secrets written to
  `.squad/secrets.yaml`, post-config GitHub probe, and an updated
  next-steps hint with `--id <github-issue-number>`.

## [0.7.1] — 2026-04-28

### Bug fixes

- `squad --version` printed `0.6.0` on 0.7.0 — the version string was
  hardcoded in the CLI and the console `/healthz` endpoint. Both now
  read from `package.json` and stay in sync with the installed package.

## [0.7.0] — 2026-04-28

### What's new

- GitHub Issues works as the issue tracker: set owner/repo in config, PAT (or
  `GITHUB_TOKEN` / `GITHUB_HOST`) in secrets, search and import like Jira or
  Azure. Console Secrets page has GitHub host and token fields plus a
  connectivity test; `squad doctor` probes the GitHub REST API.

### Breaking changes

- Linear is no longer a tracker type. Use GitHub Issues, Jira, or Azure, or
  set tracker to `none`. Update `.squad/config.yaml` if you had `linear`.

## [0.6.1] — 2026-04-26

### Bug fixes

- Azure DevOps console tracker search was failing on first load and on text
  search with HTTP 400. WIQL queries now require the team project (`@project`)
  in the WHERE clause; HTTP 400 responses include a clearer hint about
  org/project or WIQL scoping.

## [0.6.0] — 2026-04-29

### Why this release

squad-kit 0.5.0 shipped the console end-to-end. Real users found the visual layer hostile for an admin/console surface — too marketing-y, glow orbs everywhere, dialog positioning glitches under our overflow rules — so 0.6.0 is a redesign-only release. Zero CLI behaviour changes, zero API contract changes. The console adopts a Vercel/Geist-inspired palette: flat near-black surfaces, white text, accent green reserved for status (live planner dot, focus rings, active sidebar, success badges). Every dialog is now portal-rendered and centred reliably. The signature Vercel/Linear move — Cmd+K command palette — is in.

### Added

- console-ui: Cmd+K command palette (powered by `cmdk`) — searches stories, plans, and actions; Linear-style chord shortcuts (`g s` for Stories, `g p` for Plans, `n s` for new story, `?` for the cheatsheet, etc.).
- console-ui: portal-rendered Dialog primitive with focus trap, body scroll lock, ESC + backdrop close, focus restore. Replaces the native `<dialog>` element (and fixes its positioning bugs).
- console-ui: Toast system (`useToast()`) with bottom-right stack, tone-coloured icons, auto-dismiss, manual dismiss, optional inline action.
- console-ui: Confirm provider (`useConfirm()`) — promise-based ergonomics for destructive actions.
- console-ui: Callout component for inline alerts (default / info / success / warning / danger). Replaces every ad-hoc tone block sprinkled through pages.
- console-ui: Density toggle (Comfortable / Compact) in the topbar; persists to `localStorage`, applies via `[data-density]` on `<html>`.
- console-ui: Breadcrumbs in the topbar, derived from the route match tree.
- console-ui: New primitives — `Page`, `Spinner`, `IconButton`, `Tooltip`, `Kbd`, `Field`. All density-aware.
- console-ui: Internal design playground at `/__design` for primitive sanity checks.
- console-ui: `lucide-react` for icons; sidebar letter-icons (`D / S / P …`) replaced with proper Lucide icons.

### Changed

- console-ui: complete design-token rewrite — Geist-inspired graphite scale (12 steps from `--gray-1` to `--gray-12`), accent green reserved for status only. The marketing-site palette stays on the marketing site; the console diverges. CSS variable names that pages already used (`--color-bg`, `--color-surface`, `--color-text`, `--color-accent`, etc.) keep working — their values changed.
- console-ui: layout shell rewritten — sidebar is sectioned (Workspace / Run / Settings) with Lucide icons, project switcher moved into the sidebar header, topbar shows breadcrumbs + density toggle + Cmd+K hint. The decorative `grid-bg` and `glow-orb` divs were removed from the working surface.
- console-ui: every page rewritten through the new `<Page>` wrapper. Inline tone classes (`bg-emerald-…`, `bg-red-…`, etc.) replaced with `<Badge>`, `<Callout>`, and `<Toast>`. Destructive actions go through `useConfirm()`.
- console-ui: charts read CSS variables instead of hard-coded hex codes; near-monochrome palette with green only for the most-recent / success series.
- console-ui: shimmer Skeleton replaces the static `animate-pulse` block.
- console-ui: Markdown viewer adopts a near-monochrome prism theme matching the new tokens.

### Fixed

- console-ui: dialog positioning bugs caused by the native `<dialog>` element interacting with our layout's overflow rules. Now portal-rendered and reliably centred.

### Migration

No breaking changes for CLI users. The `.squad/` file formats, command flags, planner output, tracker integration, and config schema are byte-identical to 0.5.0. If you've installed `squad-kit@0.5.0` globally and run `squad console`, simply `npm i -g squad-kit@0.6.0` and your next `squad console` opens the new look. No `.squad/config.yaml` changes.

### Internal

- console-ui: `cmdk`, `lucide-react` added to `console-ui/package.json` (consumed at build-time only; the CLI runtime dependency tree is unchanged).
- console-ui: extensive primitive coverage with vitest — tests grew by ~25 cases across `Button`, `Badge`, `Spinner`, `Field`, `Page`, `Dialog`, `Toast`, `Callout`, `Confirm`, `Breadcrumbs`, `useDensity`, `CommandPalette`, `useGlobalShortcuts`.

## [0.5.0] — 2026-04-25

### Why this release

squad-kit 0.4.0 made the planner reliable and the partial-plan recovery flow first-class. 0.5.0 makes the whole product **shareable**: a local-first, dark-modern web console that exposes every CLI capability with a UI a teammate can use without learning the commands.

The console isn't a hosted dashboard. It binds to `127.0.0.1`, gates every API request behind a per-session token, and reads/writes the same `.squad/` files the CLI already uses. Open it with `squad console`, share a screenshot of a streaming planning run on Slack, close the tab, keep working in the terminal.

### Added

- `squad console` — open `http://127.0.0.1:4571` (configurable) for a dashboard, stories CRUD, plans browser with diff, live planner streaming via SSE, visual editors for `config.yaml` and `secrets.yaml`, tracker issue search and import, graphical `squad doctor`. Token-gated and loopback-only.
- Persistent run history in `.squad/runs/<runId>.json` (last 20 retained). Dashboard reads from it for cache-hit ratio, token spend sparkline, and run-duration bars.
- `~/.squad/recent-projects.json` — per-user list of project roots you've opened the console against; surfaces in the topbar dropdown.
- Internal: `PlannerEventBus` + `runPlanner({ events, runId, abort })` lets multiple consumers share one run; CLI rendering becomes a bus subscriber.
- Internal: `core/story-mutations.ts` (`createStoryRecord`, `deleteStoryRecord`, `createStoryRecordFromIssue`) is now the single implementation behind the CLI new-story / rm-story commands and the console.
- Internal: `commands/doctor-engine.ts` extracts `gatherContext` and `runAllChecks` so the doctor logic is reusable from the API.
- Internal: `TrackerClient.searchIssues` for Jira (REST `/search`) and Azure (WIQL).
- Build: `pnpm size:guard` — fails CI if the published tarball exceeds 2.5 MB unpacked. Wired into `prepublishOnly`.

### Changed

- `pnpm build` now runs the SPA build (`pnpm -C console-ui build`) before the CLI build (`tsup`) and verifies `dist/console-ui/index.html` was emitted.
- The npm tarball gains a `dist/console-ui/` tree (~700–900 KB gzipped).

### Migration

No breaking changes. CLI commands behave byte-identically. The `.squad/runs/` directory and `~/.squad/recent-projects.json` are added on first console run; `.squad/runs/` is gitignored automatically (managed block).

## [0.4.0] — 2026-04-24

### Added

- `planner.maxOutputTokens` in merged config (default **16384** tokens per model round).
- Interactive `squad new-plan --api` prompt when a planner limit is hit: continue (extends read/context/time/round/output budgets for that run) or stop, with a short billing note up front.
- Incomplete API plans save as `*.partial.md` plus YAML `squad-kit-plan-status: partial`; the CLI exits with code **2** when planning did not finish cleanly (no stack trace for that path).

### Changed

- New plan files are named from the **story folder id** (`NN-story-<id-slug>.md`) instead of slugging the title hint, so paths stay short; `00-overview.md` still carries the human title.
- Intake scaffolding fills more fields from fetched tracker issues (Azure / Jira) when `squad new-story` pulls work item data.
- Agent `squad-plan` templates remind editors not to overwrite the first-line `<!-- squad-kit: … -->` plan metadata comment.

### Fixed

- `squad list` reads `generated by` metadata from the first matching `<!-- squad-kit: … -->` line in the first lines of a plan file, not only line 1.
- `findPlanFor` prefers a non-`.partial.md` plan when both exist for the same story id.

### Site

- Added `robots.txt` and small head metadata tweaks on the Astro site.

## [0.3.0] — 2026-04-24

### Why this release

squad-kit 0.2.2 stabilised rate-limit handling with retries and a softer `squad doctor` warning.
That made failures loud but didn't reduce the underlying token spend: every planning turn
re-sent the cumulative transcript, so costs scaled roughly quadratically with the number of
tool calls. On Anthropic Tier 1 with Opus, that made non-trivial plans structurally infeasible.

0.3.0 adds **prompt caching end-to-end** across Anthropic, OpenAI, and Google. Expected savings
on a typical 10-turn run: ~70% fewer billed input tokens, and — critically on Anthropic —
cached reads don't count the same against your per-minute quota. Tier 1 Opus users should find
moderate plans work where they previously hit 429 from turn 7 onward.

### Added

- Anthropic explicit prompt caching via `cache_control: { type: 'ephemeral' }` on the system
  prompt and the most recent tool-result block each turn (cache TTL rolls forward).
- OpenAI and Google implicit prefix caching (no config required; activated by the stable-prefix
  refactor below).
- `planner.cache.enabled` config knob (default `true`). Configure via `squad config set planner`.
- Run-summary line: `cache hit 68% (22.4k read / 32.9k total)` every `squad new-plan --api` run.
- `squad doctor` now checks `planner cache effectiveness`, reading `.squad/.last-run.json`.
- `.squad/.last-run.json` persistence of planner run stats (git-ignored, per-user).
- `Usage.cacheCreationTokens` and `Usage.cacheReadTokens` on every provider response.
- Deterministic request-body builders (`buildAnthropicBody`, `buildOpenAIBody`, `buildGoogleBody`)
  exposed for testing; dev-mode warning when a turn mutates the cacheable prefix.
- Copy-paste mode (`squad new-plan --copy`) now writes the composed prompt to
  `.squad/.last-copy-prompt.md` and prints a compact summary (mode · story · file · size · est
  tokens · clipboard status) instead of dumping the full 5–10 KB prompt into the terminal.
- Clipboard fallbacks for Linux (`xsel` in addition to `xclip`) and Termux
  (`termux-clipboard-set`). Headless Linux / SSH sessions now surface an actionable reason in
  the summary ("no display server detected — install xclip or xsel, or use the saved file")
  instead of silently skipping.
- `squad config set planner` and `squad config set tracker` print a "▸ Next:" block so users
  know what to run next (`squad doctor` → `squad new-story` → `squad new-plan`).
- `squad tracker link` and `squad migrate` also print "▸ Next:" guidance.
- Managed `.gitignore` block now covers `.squad/.last-run.json` and `.squad/.last-copy-prompt.md`.

### Changed

- System prompt no longer embeds timestamps, random IDs, or absolute host paths (these
  cache-busted the prefix on every turn).
- `squad doctor` Anthropic Tier 1 Opus warning softened from "you will hit ITPM" to "tight but
  viable with caching on."
- `squad config set planner` no longer prompts for `planner.modelOverride`. The interactive
  flow is shorter and less intimidating; power users can still set the override directly in
  `.squad/config.yaml` (documented in `docs/customization.md`).
- `copyToClipboard()` now returns a structured `{ ok, tool?, reason? }` result instead of a
  bare boolean, so callers can explain failures to the user.

### Known limitations

- Google `cachedContents` explicit API not implemented (implicit caching is sufficient for
  single-run CLI use).
- No cross-run persistence of cache stats yet — doctor only reads the most recent run.
- No automatic context compression when transcripts exceed ~50 KB. Caching helps but doesn't
  solve the long-horizon case. 0.4.0 candidate.
- Anthropic 1-hour cache TTL (`ttl: "1h"`) not used — default 5-minute TTL covers single-run.

### Migration

See `docs/migrating-from-0.1.md` §9 "Upgrading from 0.2.x to 0.3.0" for the full path. Short
version: `squad upgrade` and you're done. Caching is on by default; no config edits required.

## [0.2.2] - 2026-04-22

### Fixed

- **Rate-limit retry no longer burns a doomed request.** 0.2.1 capped the auto-retry wait at 30 s. When a provider asked for longer than that (common on Anthropic Tier 1, which regularly asks for 60–180 s), squad-kit would retry *inside the same throttle window* and fail a second time. 0.2.2:
  - Raises the retry cap from 30 s to **90 s**, which comfortably covers the provider-suggested wait for most Tier 1 / free-tier 429s.
  - **Skips the retry entirely** when `Retry-After` is longer than the 90 s cap, and surfaces a dedicated message explaining the decision (`squad-kit did not auto-retry: the provider's 132s wait is longer than our 90s cap, so retrying would just burn another request inside the same throttle window.`) instead of wasting a request and showing the "already retried" variant.

### Added

- **`squad doctor` now reports planner tier vs. model awareness** (check id `planner-tier`). When `planner.provider === 'anthropic'` and the resolved plan model id contains `opus`, the check emits a **warn** with a fix hint suggesting `squad config set planner` to pick Sonnet or Haiku, which live in separate per-model rate-limit buckets on Anthropic Tier 1 (10 k input tokens / minute). For non-Anthropic providers and non-Opus models, the check is `skip` or `ok` — no noise for users who aren't affected.
- `rateLimitMessage` gained a `retrySkippedReason` + `maxRetrySec` field, so the error text can distinguish "we retried and got throttled again" (firm over-quota) from "we did not retry because your wait is longer than our cap" (retry would be pointless). Both cases still surface the same four recovery options.

## [0.2.1] - 2026-04-22

### Fixed

- **`squad new-plan --api` now handles provider rate limits (HTTP 429) properly.** Previously a 429 surfaced the generic `Run \`squad doctor\` to verify models and credentials.` hint, which is misleading — the credentials are fine, the org is just over its per-minute quota. `runPlanner` now:
  - Detects 429s across Anthropic, OpenAI, and Google (new `errorKind: 'rate_limit'` on `ProviderResponse`).
  - Parses `Retry-After` (seconds or HTTP-date) and Google's body-level `retryDelay` field.
  - Retries **once** automatically, waiting the provider-requested time capped at 30 seconds. A new `onRateLimit(waitSec)` callback lets the UI show a "retrying in Ns" notice.
  - When the retry also fails, throws a dedicated error that names the provider, summarises the wait time, and lists four concrete recovery paths: wait and retry, switch planner model (`squad config set planner`), tighten `planner.budget`, or upgrade tier (with a deep-link to each provider's limits page).
- The generic (non-429) provider-error hint now reads `Run \`squad doctor\` to diagnose, or retry — most 5xx errors are transient.`, which is accurate for the actual 5xx / network cases it covers.

### Added

- `detectRateLimit()` and `rateLimitMessage()` in `src/planner/provider-errors.ts`. Both cover all three supported providers and are unit-tested with real-shaped 429 fixtures.

## [0.2.0] - 2026-04-22

### tracker-intake-fetch

**Added**

- `squad new-story --id <ID>` auto-fetches title, description, labels, and attachments (≤ 10 MB each) from the configured tracker. Supported: Jira Cloud, Azure DevOps Services.
- `.squad/secrets.yaml` as a second credential source (after environment variables) for planner keys and tracker tokens. Created with mode `0600` on POSIX; auto-added to `.gitignore`.
- `squad init` now prompts for tracker credentials when a supported tracker is chosen, and offers to save the planner key inline as an alternative to exporting an env var.
- `squad status` shows tracker type, workspace, and credential source (`env` / `secrets.yaml` / `missing`).
- `squad new-story` flags: `--no-fetch`, `--no-attachments`, `--attachment-mb <n>`.
- `squad new-story --no-tracker` — skip tracker id and fetch for a single story in a workspace that normally requires tracker ids. Interactive mode now offers "skip tracker for this story" alongside "enter id" when required.

**Changed**

- `squad new-story` accepts the feature slug as an optional positional; prompts when it is omitted in a TTY (including a picker for existing feature folders). Passing `-y` / `--yes` keeps fail-fast behaviour when the slug is missing. `CI=1` forces non-interactive mode even in a TTY.
- `squad tracker link` accepts both the story path and the tracker id as optional positionals; prompts with a story picker and id input when omitted. `-y` / `--yes` and `CI=1` force non-interactive fail-fast.
- CLI-wide: commands treat missing required input as promptable in a TTY; `-y` / `--yes` and `CI=1` opt out.
- Credential resolution order documented: env var → `.squad/secrets.yaml` → prompt → fail. Applies to both planner and tracker credentials.

**Security**

- `.squad/config.yaml` continues to reject secret-shaped keys (`apiKey`, `token`, …). Secrets live in `.squad/secrets.yaml` only.
- Auto-managed `.gitignore` block covers `.squad/secrets.yaml`, `.squad/stories/**/attachments/`, and `.squad/.trash/`.

### Added

- `squad config` command group with `show`, `set planner`, `set tracker`, `unset planner`, `unset tracker`, and `remove-credential <section>` subcommands. Every field in `.squad/config.yaml` and `.squad/secrets.yaml` can now be edited interactively without opening a text editor.
- `squad init` on an existing workspace now offers **Reconfigure planner / Reconfigure tracker / Overwrite / Cancel** instead of silently bailing. `--force` keeps the old overwrite behaviour for scripts.

- `squad upgrade` self-update command. Detects the package manager used to install squad-kit, fetches the latest version from npm, and runs the appropriate global-install command after confirmation. Refuses dev installs and major version bumps (print-manual-guide instead).
- `squad migrate` command applies one-shot 0.1.x → 0.2.0 structural migrations (delete legacy prompts, gitignore, secrets perms, planner budget defaults, config normalisation). Idempotent; destructive by design; gated behind a confirmation prompt unless `--yes` is passed.
- `squad doctor` command: a full health check covering planner config, tracker credentials, model list probes (no completion calls), `.gitignore` managed block, `secrets.yaml` permissions, legacy `.squad/prompts/`, and `.squad/` layout. `--fix` applies non-destructive repairs only; destructive fixes belong in `squad migrate`.
- `planner.modelOverride` (per-provider) lets you pin a different plan-phase model id without editing squad-kit source.
- `pnpm verify:models` (`scripts/verify-models.ts`) probes provider model list APIs before publish so pinned ids cannot drift unnoticed.
- Clear, actionable error when the planner model returns 404 (upgrade, config override, or `squad doctor`).
- `squad status` marks the planner row with `(override)` when `modelOverride` is active for the current provider.
- Direct planner API (optional): Anthropic, OpenAI, Google. Squad calls the planner for you and writes the plan file.
- Demand-driven context: planner reads files on request via a bounded budget (file count, bytes, wall-clock).
- Interactive picker in `squad new-plan` over un-planned intakes.
- Already-planned guard with `--yes` override.
- `--api`, `--copy`, `--feature`, `--all` flags on `new-plan`.
- `squad init` asks about planner setup; `--planner <provider>` for non-interactive.
- `squad status` shows planner provider, model, and env-var presence.
- `squad list` shows which plans were generated by the API vs copy-paste.
- Visual identity: mint-green brand, custom spinner frames, banner, summary boxes, consistent prefixes across all commands.
- `squad rm` command group: `rm story`, `rm plan`, `rm feature`, each with `--dry-run`, `--trash`, `-y`, and interactive pickers. Deleting a story cascades to the matching plan file and overview row. `.squad/.trash/<timestamp>/` is now git-ignored automatically.

### Changed

- Every user-facing error now ends with a recommended next command (for example, `Run \`squad doctor\` to diagnose`). Failures no longer dead-end users at an error string.
- `ensureGitignore` now includes `.squad/.trash/` in the managed block. Existing users will see the line appended on the next `squad doctor --fix` or any command that calls `ensureGitignore`.
- Anthropic plan model pinned to the versioned Claude API id `claude-opus-4-7` (replacing the prior alias default) and execute remains dated `claude-haiku-4-5-20251001`, per Anthropic’s model overview — run `pnpm verify:models` after changes.
- `new-plan <intake>` is now optional; omit to pick interactively.
- `--no-copy` renamed to `--no-clipboard` (old flag removed). `--copy` now forces copy-paste mode.
- Prompts (`generate-plan.md`, `intake.md`, `story-skeleton.md`) now ship entirely within the squad-kit package. Fresh installs no longer create a `.squad/prompts/` directory. Stale `.squad/prompts/` from 0.1.x installs is ignored at runtime and cleaned up by `squad migrate`.

### Breaking changes for 0.1.x users

- 0.1.x users who upgrade should run `squad migrate` once per repo. A `.squad/prompts/` folder left from 0.1.x is deleted outright (prompts are now bundled in the squad-kit package).
- If you customised `.squad/prompts/*.md`, those customisations are no longer used. The canonical prompts are in the installed squad-kit package. To customise, fork squad-kit and patch `templates/prompts/`. (This is intentional: behaviour was inconsistent before — some commands ignored the user copy — and silent version drift was breaking workflows.)

### Security

- Config loader rejects any YAML entry whose key looks like `apiKey`, `token`, `secret`, or `credential`.

### Known limitations

- OpenAI and Google planner model ids in squad-kit remain provider “latest”-style names for 0.2.0; dated snapshots for those providers are planned for 0.2.1 once verified.

### Non-goals (still deferred)

- OpenAI-compatible generic endpoint (OpenRouter, Ollama, local). Targeted for 0.3.
- `squad implement` command. Targeted for 0.3.
- MCP server, telemetry.

## [0.1.0] - 2026-04-21

First public release.

### Added

- `squad init` — scaffolds `.squad/` with `config.yaml`, prompt templates, and agent slash commands.
- `squad new-story <feature-slug>` — creates `.squad/stories/<feature>/<id>/intake.md` with `attachments/`.
- `squad new-plan <intake-path>` — composes the plan-generation meta-prompt inline with the intake, prints to stdout, and copies to clipboard.
- `squad status` — reports story / plan counts and next global `NN`.
- `squad list [--feature <slug>]` — table of stories and their plan state.
- `squad tracker link <story> <id>` — upserts a tracker id on an existing intake.
- Agent slash-command templates for **Claude Code**, **Cursor**, **GitHub Copilot**, and **Gemini CLI**.
- Tracker id validators for **GitHub**, **Linear**, **Jira**, and **Azure DevOps** (no API calls; format validation only).
- Plan-generation meta-prompt (`generate-plan.md`), intake template (`intake.md`), and plan skeleton reference (`story-skeleton.md`).
- Documentation: `docs/philosophy.md`, `docs/getting-started.md`, `docs/customization.md`, `docs/vs-spec-kit.md`.

[Unreleased]: https://github.com/AzmSquad/squad-kit/compare/v1.3.15...HEAD
[1.3.15]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.15
[1.3.14]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.14
[1.3.13]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.13
[1.3.12]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.12
[1.3.11]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.11
[1.3.10]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.10
[1.3.8]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.8
[1.3.7]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.7
[1.3.6]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.6
[1.3.5]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.5
[1.3.4]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.4
[1.3.3]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.3
[1.3.2]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.2
[1.3.1]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.1
[1.3.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.3.0
[1.2.2]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.2.2
[1.2.1]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.2.1
[1.2.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.2.0
[1.1.1]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.1.1
[1.1.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.1.0
[1.0.1]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.0.1
[1.0.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v1.0.0
[0.6.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v0.6.0
[0.5.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v0.5.0
[0.3.0]: https://github.com/AzmSquad/Squad-Kit/releases/tag/v0.3.0
[0.2.2]: https://github.com/AzmSquad/squad-kit/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/AzmSquad/squad-kit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AzmSquad/squad-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v0.1.0
