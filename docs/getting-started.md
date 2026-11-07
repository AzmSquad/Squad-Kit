---
title: Getting started
description: Your first hour with squad-kit 1.0, from install to a released ticket.
---

This guide takes you from nothing to a released ticket. It takes about an hour, most of it the squad's
work. You need no terminal skills after step 2.

**Coming from squad-kit 0.x, or from an early 1.0 board?** Read [Moving to 1.0](migrating-to-1.0.md) first.

## 1. What you need

- **Node.js** 22 or newer. Check with `node --version`.
- **git**. Check with `git --version`. On a Mac, if it is missing, run `xcode-select --install` once.
- **An AI tool**, installed and signed in once. Today the squad runs on **Claude Code** only. Install it, run
  `claude` once in a terminal and sign in with your own account. squad-kit uses that sign-in, so there is
  nothing new to buy and no key to paste.

There is nothing else to install. squad-kit installs its own browser for the screenshots the first time it needs
one. **Windows** works, but it is less protected and not fully tested yet: use it on projects you trust.

## 2. Install and open squad-kit

```bash
npm i -g squad-kit
squad
```

`squad` opens the app in your browser, at `127.0.0.1:4571`. Only you can open it: it listens on your computer
only, and the link carries a private key.

The first page is **Home**. It has two parts:

- **Projects**: one card for each project, with how many tickets are open, working and waiting for you.
- **Waiting for you**: everything the squads need from you, from every project, in one list.

Keep the terminal open. Press Ctrl-C there when you are done. Run `squad` again later and the squad picks up
where it was. If squad-kit is open already, `squad` just prints its link and opens it.

## 3. Start or add a project

**You have only a BRD or an idea?** On Home, press **New project**. Give it a name and your BRD or your idea. squad-kit makes
the folder for you, and the squad starts from what you gave. A first story, **Set up the product**, picks the tools, and the
others wait for it.

**You already have a project?** Press **Add project**. A folder browser opens inside the page. Go to your project's folder and
press **Add this folder**.

You can also do it from a terminal, in the project's folder:

```bash
cd ~/Workspace/leave-requests
squad console
```

`squad console` adds the folder to the app and opens its board. If the app is not open yet, it starts it.

squad-kit works with any of these folders. The browser says which kind you picked before you add it.

| The folder | What squad-kit does |
| --- | --- |
| **An empty folder** | A new project. squad-kit makes a git repo with a short README in its first commit, then asks "What do you want to build?". The Architect picks the technology itself when your first ticket is planned. |
| **Code with git** | Your repo, branches and history stay as they are. |
| **Code without git** | squad-kit makes a repo, with your files in its first commit. Generated folders (`node_modules`, `dist`, `build` and the like) and `.env` files stay out. |
| **A folder with several code folders** | squad-kit works across them. Each ticket works in one repo, which the Architect picks in the design. |
| **A squad-kit 0.x project** | Your stories, plans and tracker settings stay. Your sign-ins move to this computer. See [Moving to 1.0](migrating-to-1.0.md). |

A project needs its own folder: squad-kit will not set up your home folder or the top folder of the disk.

### What happens next

Before you confirm, squad-kit says what it found in the folder and what will happen next. Press **Add and get to
know it**. A setup page opens with live steps, each with its time:

1. **Project memory**: squad-kit made `.squad/` in the folder.
2. **Your AI tool is ready**: for example "Claude Code is ready". If not, install Claude Code and sign in, then
   press **Start again**.
3. **The Architect reads the code**: what the project is, who uses it, what it can do today, and how its parts fit.
   Press **See what the Architect is reading** to watch.
4. **How to test and run it**: the setup, test, build and start commands.
5. **Trying the tests** and **opening the app once**, in squad-kit's own copy of the code, with a screenshot. If
   one fails, the page says why and offers a way out; the setup carries on.
6. **Your overview**.

You can leave the page: the setup carries on, the board shows where it is, and **Notify me when it is ready** sends
a desktop notice. The page also asks once how strong the squad's models should be (**Quality**: Best, the default,
Balanced or Thrifty).

Then the **Overview** opens, first in the sidebar. It is the project's handover: what it is, who uses it, what it
can do today, how its parts fit together, things worth knowing, the rules the Architect found, the proof (tests
and a screenshot of the app), and three ideas for a first ticket. Read it, then:

- **Looks right, start working** approves the rules. Until you approve them, the squad treats them as proposals.
- **Something is wrong** opens a talk with the Architect, then **Read it again with this**.
- An idea becomes a new ticket with one click.

After that, the Overview is the project's home. It stays up to date after every merged ticket.

**An empty folder has nothing to read yet**, so the steps that test and open the app are skipped, and the Overview
asks **What do you want to build?** Say it in your own words, in English or Arabic. The Architect writes it down with
ideas for your first stories, and you check it and press **Looks right, start working**. Or write your first ticket
yourself. You are not asked about the technology: the Architect picks it when your first ticket is planned, and saves
it as a decision engineers can see. After the first build, squad-kit reads how to test and run the project from its
files, and saves that in Settings. Nobody is asked.

Terminal: `squad setup --follow`, `squad overview`, `squad overview --approve`, `squad overview --build "what you
want"`. To see it all without AI, run `squad demo --first-run`.

## 4. Connect a tracker (optional)

A tracker is where your team keeps its work items, sprints and bugs. You can skip this step and write tickets
on the board instead.

Today squad-kit works with **Azure DevOps**: Azure Boards for the work items, Azure Repos for the code.

1. Open **Settings** and find **Azure DevOps**.
2. Fill in your **Organization** and **Project**. If your code is on Azure Repos, they are filled in already.
3. Paste a personal access token from Azure DevOps. It needs **Work Items** and **Code** (read, write and
   manage).
4. Press **Save and check**. It should say **Connected as** and your name.

Your token stays on this computer. It never goes into the project folder.

Now **Backlog** shows your sprint's stories and bugs, in backlog order.

## 5. Write your first ticket

On the board, press **New ticket**. There are two ways to write it:

- **Write it**: a title and what you want, in plain words. Add what you already know: acceptance criteria,
  business rules, edge cases, screenshots or documents. The Analyst asks you about the rest.
- **From an idea or message**: paste an idea, a chat message or one line of business, with screenshots if you
  have them. The Analyst fills in every field, usually in under a minute, and you see each step it takes. Press
  **Cancel** to stop it. You can close the window: the draft waits for you under **New ticket**. You check each
  field before the ticket is made.

Pick a **track**:

- **Full** (the default): every step, with your approvals.
- **Express**: for a typo or a small urgent fix. No questions, and the plan is approved on its own. The build,
  checks, review and your **Looks right** still run.

To report a bug, pick **Bug**. The form asks what happens, how to see it, what should happen, and how bad it is.

**Or pull it from your tracker.** Press **Pull from Azure DevOps** on the board, or **Start** on a story in
**Backlog**. The ticket gets the tracker's name, for example `AB-46` for work item `AB#46`. It brings the
description, acceptance criteria, feature, epic and attachments with it. On the tracker, the item moves to in
progress.

A project without a tracker names its own tickets from the project name: "Leave requests" gives `LR-1`, `LR-2`.

## 6. From the ask to a release

The ticket's card moves across the board's columns: **Tickets**, **Specs**, **Implement**, **Test**,
**Review**, **Release**, and **Bugs** for bug reports. Each card says what is happening in plain words, for
example "Builder · step 3 of 6 · editing the booking page · 2 min · usually 2 to 4". A card gets a **You** tag
when it needs you. It also shows up in the **Waiting for you** banner at the top of every page, with the button to
press, and the browser tab shows the count. Turn on desktop notices when the banner asks, and you can work on
something else until the squad needs you.

Click a card to open the **ticket drawer** on the right. Its **Now** tab always shows what happens now, what comes
next and what you can do. Type a question under **Ask about this ticket**, like "is there a problem?" or "when will
it be ready?": the answer comes at once, in English or Arabic.

### Answer the questions

The Analyst asks about what to build. The Architect asks about how to build it. Each question has choices.
Click one, or write your own answer. Then press **Send answers**.

- Not sure what a question means? Press **Ask about this** and ask in one line.
- In a hurry? Press **Skip, let the squad guess**. You will see its guesses in the spec.
- Want to talk it over? Press **Talk it through instead** and chat with the Analyst.

With a tracker, your answers are also posted on the work item as a comment.

### Approve the spec

The spec says **what** gets built: the story, a "done when" list (each one something the Tester must prove),
business rules and edge cases. Read it like a document:

- Point at any part to **comment** on it or **edit** it yourself. Your wording stays, even after a rewrite.
- **Send back** sends all your comments at once. The new version shows **What changed**, old and new side by
  side.
- **Start over** writes it again from zero, with a new direction from you.
- When it is right, press **Approve spec**.

### Approve the design

The design says **how** it gets built: the decision (the options, the one chosen and why) and the steps. It
also says which saved decisions it follows. A ticket with screens gets a clickable mockup under **How it will
look**.

This part is technical. A developer can approve it for you. Review it the same way as the spec, then press
**Approve design**. The decision is saved, named after the ticket: `AB-46.1` is the first decision of `AB-46`.
Decisions the Architect found in the existing code are named `STACK.1`, `STACK.2`.

The Analyst and the Architect see the project's other open tickets and the files they change. If this ticket needs
another one that is not merged yet, the design says so ("depends on AB-45"), and before building the ticket waits
with a card: **Build on AB-45's work**, **Build anyway** (from main), or **Wait** (it starts by itself when AB-45
merges). Terminal: `squad build <ticket> --on-branch | --anyway | --wait`.

### Watch the squad build

Now the squad works on its own:

1. The **Builder** writes the code in its own copy of the project. Your own folder is never touched while it
   works. Its commands run in a sandbox where the computer allows it: they can only write in that copy, can't read
   your keys or sign-ins, and can only reach package registries and the websites you allow.
2. squad-kit runs the project's **tests, lint and build** itself, in its own guard on Mac and Linux: they work
   normally, but can't read the usual places for keys and sign-ins. `SECURITY.md` says what the guard stops and what it
   does not. A check that fails runs once more first, as a test can fail once for
   no reason in the code. If it still fails, the Builder fixes it, up to 3 tries, and is told which checks already
   failed before this ticket started. If the change deleted tests, has fewer tests, changed the test setup or skips
   tests, the ticket stops and says so. A project with no tests shows **Not checked** in orange, never a green pass.
3. The **Reviewer** reads the whole change in a fresh session, with the check results, so the work gets a real
   second opinion.
4. The **Tester** shows each "done when" in one or more screenshots, one for each part or case. squad-kit starts the
   ticket's own copy of the app and takes the pictures with its own browser. There is nothing to install: the first
   time, one line says "Setting up squad-kit's screenshot browser. This happens only once." squad-kit checks each
   picture is real and new, then looks at all the pictures of each "done when" together.

While it works, you can:

- See the steps, the activity and the real agent conversation in the drawer's tabs.
- Message an agent in the **Conversation** tab. It reads your message at its next step; the work goes on.
- Press **Ask a question** at the top of the ticket, in any state. Asking never stops the work, and the ticket stays
  where it is.
- Press **Propose a change** to change what gets built. See [Change something](#8-change-something) below.
- Press **Stop**. The agent stops at once, and the work so far is kept. **Try again** carries on from the same
  step.
- Developers can press **Take over** to work in the Builder's own session, then **Give back**.
- Press **Bring in the newest work** to give the Builder what the team merged since.

Only a limited number of tickets run at once (see **Tickets at once** in Settings). A ticket over the limit says
**Next in line: starts when a slot is free** and starts on its own.

A step that takes more than twice its usual time says **Taking longer than usual**, with what it is doing.
**Give it 10 more minutes**, **Stop and try again**, or **Stop**. Only the time a step really runs counts, not the
time it waits for you, for another ticket or for a free place. If Claude's usage limit is reached, the squad pauses
and carries on by itself when the limit resets.

### Check the proof

The **Proof** page shows each "done when" with its screenshots, one or more, one for each part or case, and three
results: the checks, the review and the proof. Nothing ships without all three.

Each "done when" says what its pictures show:

- **Met**: they show it works as written.
- **Not working yet**: a picture shows it does not work.
- **Not shown yet**: the pictures do not show it clearly.
- **Not on a screen**: it cannot be shown at all, like an email or what happens after a restart. Look at these
  yourself: nobody saw them on a screen.

**Also changed, not in the plan** lists anything the change touched beyond its plan, so nothing surprises you.

Before you decide, you can check it yourself:

- **Where to look** lists the pages to open, with what each one shows.
- **Try it yourself** runs this ticket's own copy of the app, with the change in it and nothing merged. Press **Open**
  to click through it, and **Stop** when you are done. Terminal: `squad try <ticket>`.
- **Ask a question**, like "how do I test this?". The ticket keeps waiting for you.

Then:

- If it is right, press **Looks right**. squad-kit saves the change as a commit on the ticket's branch. With a
  code host (Azure Repos today), it opens a pull request with the screenshots and merges it. Without one, it
  merges the branch into your main branch itself. On the tracker, the item moves to resolved.
- If not, press **Something's wrong**, say what in one line, and press **Send back**. The ticket goes back to
  the Builder with your note.

After **Looks right**, press **Run the new version** in **Your apps** in the sidebar. squad-kit starts the app from
the newest `main` and gives you its address.

### Release

Open **Releases**. The squad has prepared the next release: the version, the tickets in it and the release
notes. Edit the notes if you like, then press **Release**.

squad-kit asks you once to confirm, and lists exactly which branch of which repo it will push, and where. Read
it. Then it updates the changelog, sets the version, adds the git tag and pushes. On the tracker, the items
close with the version as a tag.

Need to leave a ticket out? Press **Take out** on it before you release: its code stays in main and joins the next
release. After a release, squad-kit deletes the released tickets' branches on your computer (on the remote only
when you ask). A release cut off by a restart finishes or rolls back cleanly the next time.

If it cannot reach your team's shared copy of the code (no network, or the copy refuses it), the release is made on
your computer only and says **not sent yet**. Fix the problem, then press **Send again** on the release. Terminal:
`squad release <version> --push-again`.

Found a problem later? Press **Report a bug** on the board. The bug becomes a ticket linked to the release, goes
around the same loop, and the Tester adds a check so it cannot come back.

## 7. What each card means

These are the cards that land in **Waiting for you**. Each one names the button to press, and the terminal
command that does the same.

| Card | What it means | What you do |
| --- | --- | --- |
| **Questions** | The Analyst or the Architect needs answers before writing the spec. | **Answer**: pick a choice or write your own. Or skip and let the squad guess. |
| **Spec** | The story and the "done when" list are ready. | **Review spec**: comment, edit, send back, start over, or **Approve spec**. |
| **Design** | The decision and the steps are ready. | **Review design**: the same as the spec, then **Approve design**. |
| **Proof** | The work is built, checked and reviewed, with screenshots. | **Check proof**: **Looks right**, or **Something's wrong**. |
| **An agent asks you** | The Architect, Builder or Reviewer stopped in the middle of its work to ask you something, sometimes with screenshots or a mockup. | **Answer** on the card. |
| **The squad is stuck** | A check keeps failing, or the review stays open, or the change clashes with newer code on main. | **Decide**: **Try again** (with a note), **Fix it yourself**, **Continue anyway** (with a reason that stays on the record), or send it back to the plan. |
| **Looks stuck** or **Taking longer than usual** | A step makes no progress, or runs past twice its usual time. | **End the stuck command**, **Give it 10 more minutes**, **Stop and try again**, or **Stop**. |
| **A newer decision** | A decision approved after this ticket's design changes it. | **Update the plan**, or keep it as it is, with a reason. |
| **A change** | A change you proposed is written into the spec, or its design update is ready. | Approve it or decline it. |
| **You have this ticket** | You took the ticket over. | **Give back** when you are done. The checks, review and proof run again. |
| **A chat is open** | You were talking a waiting ticket through with an agent. | **Open chat**, and finish the talk. |
| **No tests** | The project has no tests, so the checks can't prove the work. Asked once per project. | Use the Architect's suggested test command, go on without tests (the gate shows **Not checked**), or add one in Settings. |
| **Tests weakened** | The change deleted tests, has fewer tests, changed the test setup, or skips tests. | **Send it back to the Builder**, **Fix it yourself**, or **Continue anyway** with a reason. |
| **Needs another ticket** | The design depends on a ticket that is not merged yet. | **Build on its branch**, **Build anyway**, or **Wait**. |
| **A choice about the tests** | The Architect's design changes how the tests run. squad-kit tries the new way itself and keeps it only when it passes and runs at least as many tests. This card shows only when it cannot tell. | **Keep the current way**, or **Use the new way** (`squad test-command <ticket> --keep \| --use`). |
| **Reached its limit** | A step used the turns or the spend its Quality setting allows. The work is kept. | **Give it more**, or **Stop**. |
| **Budget** | With an API key: a ticket or the month reached its budget. | **Carry on**, **Do the rest yourself**, or send it back to the plan. |

Only you can skip a failed check. Your reason shows on the ticket, the pull request and the release notes.

## 8. Change something

You can change your mind at any time, without stopping the squad.

- **Ask** anything with **Ask a question** at the top of the ticket, or open a chat with any agent. The chat says so:
  the work goes on, and asking changes nothing.
- **Change** what gets built with **Propose a change**. The Analyst writes it into the spec, old and new side
  by side, and says whether it is small or big. Nothing changes until you approve it.
  - A **small** change reaches the Builder at the end of its current step. The work does not stop.
  - A **big** change pauses the Builder after its current step. The Architect updates the design, you approve
    it, and the Builder redoes only the steps the change touches.
  - One change at a time per ticket.
  - Changed your mind? **Withdraw change** takes back an approved change the squad has not built yet.
- **Released or accepted work** answers questions only. There the button reads **Ask for a change**, and the
  change becomes a new ticket linked to it, or a bug report.

Don't need a ticket any more? Open the **…** menu at the top of the ticket. **Delete** removes a ticket that is
not merged: its copy of the code, its branch, its files and its chats. The tracker item and the cost stay.
**Archive** takes a finished ticket off the board; its history stays.

## 9. Do it from the terminal

Every button has a terminal command. Turn on **Show commands** in the sidebar to see each one next to its
button. A few to start with:

```bash
squad inbox                  # everything waiting for you
squad board                  # every open ticket, by stage
squad show AB-46             # one ticket: its spec, design, steps, checks, proof and cost
squad answer AB-46           # answer its questions
squad approve AB-46          # approve what it waits on: the spec, the design or the proof
squad propose AB-46 "allow 5 bookings a day, not 3"
squad pull 46                # start a ticket from a work item
squad release                # release the tickets that are ready
```

Commands find the project from the folder you are in. From any other folder, add `--project <name>`. See them
all with `squad --help`.

## 10. When something goes wrong

Every stop says what happened, what is safe, and the ways out, as buttons, in plain words. The exact error is in the
ticket's Developer tab, for engineers. Nothing is lost: the work so far is kept on the ticket's branch.

If you need help, press **Report a problem** (on the error card, at the top of the ticket, or in Settings). It
saves one file in your Downloads folder with the ticket, its conversations, the app log and the versions, and never
your sign-ins or keys. Send that file to whoever helps you with squad-kit. From the terminal: `squad report AB-46`.

## Next

- [The app](console.md): every page, in short.
- [Moving to 1.0](migrating-to-1.0.md): for projects from squad-kit 0.x and from early 1.0 boards.
