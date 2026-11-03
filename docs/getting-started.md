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

## 3. Add a project

On Home, press **Add project**. A folder browser opens inside the page. Go to your project's folder and press
**Add this folder**. To start something new, press **New folder here**, give it a name, and add it.

You can also do it from a terminal, in the project's folder:

```bash
cd ~/Workspace/leave-requests
squad console
```

`squad console` adds the folder to the app and opens its board. If the app is not open yet, it starts it.

squad-kit works with any of these folders. The browser says which kind you picked before you add it.

| The folder | What squad-kit does |
| --- | --- |
| **An empty folder** | A new project. squad-kit makes a git repo with a short README in its first commit. On your first ticket, the Architect picks the stack with you. |
| **Code with git** | Your repo, branches and history stay as they are. |
| **Code without git** | squad-kit makes a repo, with your files in its first commit. Generated folders (`node_modules`, `dist`, `build` and the like) and `.env` files stay out. |
| **A folder with several code repos** | squad-kit works across them. Each ticket works in one repo, which the Architect picks in the design. |
| **A squad-kit 0.x project** | Your stories, plans and tracker settings stay. Your sign-ins move to this computer. See [Moving to 1.0](migrating-to-1.0.md). |

A project needs its own folder: squad-kit will not set up your home folder or the top folder of the disk.

### What happens next

The board opens with a **Setting up your project** card:

1. **Project files and board**: squad-kit made `.squad/` in the folder.
2. **Your AI tool is ready**: for example "Claude Code is ready". If it says "An AI tool" in red, install
   Claude Code and sign in, run `squad --restart`, then press **Try again** on the card.
3. **The Architect reads the project**: it maps the code and finds how to install, test, build and run it.
   This takes a few minutes. You can watch what it reads.
4. **Ready for your first ticket**.

Check what the Architect found in **Settings**, under **How the squad checks and runs this project**. These are
the commands squad-kit runs itself before anything ships. Fix any that look wrong.

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

### Watch the squad build

Now the squad works on its own:

1. The **Builder** writes the code in its own copy of the project. Your own folder is never touched while it
   works.
2. squad-kit runs the project's **tests, lint and build** itself. If they fail, the Builder fixes them, up to
   3 tries.
3. The **Reviewer** reads the changes in a fresh session, so the work gets a real second opinion.
4. The **Tester** starts the app and takes a screenshot for each "done when".

While it works, you can:

- See the steps, the activity and the real agent conversation in the drawer's tabs.
- Message an agent in the **Conversation** tab. It reads your message at its next step; the work goes on.
- Ask any agent a question. Asking never stops the work.
- Press **Propose a change** to change what gets built. See [Change something](#8-change-something) below.
- Press **Stop**. The agent stops at once, and the work so far is kept. **Try again** carries on from the same
  step.
- Developers can press **Take over** to work in the Builder's own session, then **Give back**.

Only a limited number of tickets run at once (see **Tickets at once** in Settings). A ticket over the limit says
**Next in line: starts when a slot is free** and starts on its own.

A step that takes more than twice its usual time says **Taking longer than usual**, with what it is doing.
**Give it 10 more minutes**, **Stop and try again**, or **Stop**. If Claude's usage limit is reached, the squad
pauses and carries on by itself when the limit resets.

### Check the proof

The **Proof** page shows each "done when" with its screenshot, and three results: the checks, the review and
the proof. Nothing ships without all three.

- If it is right, press **Looks right**. squad-kit saves the change as a commit on the ticket's branch. With a
  code host (Azure Repos today), it opens a pull request with the screenshots and merges it. Without one, it
  merges the branch into your main branch itself. On the tracker, the item moves to resolved.
- If not, press **Something's wrong**, say what in one line, and press **Send back**. The ticket goes back to
  the Builder with your note.

To try the change yourself, press **Run the new version** in **Your apps** in the sidebar. squad-kit starts the
app from the newest `main` and gives you its address.

### Release

Open **Releases**. The squad has prepared the next release: the version, the tickets in it and the release
notes. Edit the notes if you like, then press **Release**.

squad-kit asks you once to confirm, and lists exactly which branch of which repo it will push, and where. Read
it. Then it updates the changelog, sets the version, adds the git tag and pushes. On the tracker, the items
close with the version as a tag.

If the push fails (no network, or the remote refuses it), the release is made on your computer only and says
**not pushed yet**. Fix the problem, then press **Push again** on the release. Terminal:
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

Only you can skip a failed check. Your reason shows on the ticket, the pull request and the release notes.

## 8. Change something

You can change your mind at any time, without stopping the squad.

- **Ask** any agent anything. Open a chat from the ticket. The chat says so: the work goes on, and asking
  changes nothing.
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

Every stop says what happened, what is safe, and the ways out, as buttons. Nothing is lost: the work so far is
kept on the ticket's branch.

If you need help, press **Report a problem** (on the error card, at the top of the ticket, or in Settings). It
saves one file in your Downloads folder with the ticket, its conversations, the app log and the versions, and never
your sign-ins or keys. Send that file to whoever helps you with squad-kit. From the terminal: `squad report AB-46`.

## Next

- [The app](console.md): every page, in short.
- [Moving to 1.0](migrating-to-1.0.md): for projects from squad-kit 0.x and from early 1.0 boards.
