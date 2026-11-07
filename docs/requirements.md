---
title: From a BRD to a built product
description: Upload a requirements document, let the Analyst break it into epics, features and stories, approve it, send it to Azure DevOps, and let the squad build it story by story.
---

Write the requirements once, in the document you already have. squad-kit breaks it down, asks only what it must,
and builds it story by story. You stay in charge: nothing is built or sent before you approve, and you send every
release out yourself.

Everything here has a button on the **Requirements** page (right after Overview in the sidebar) and a terminal
command.

## 1. Add a BRD

Press **Add a BRD** and drop the document: **PDF**, **Word** (.docx), **Markdown** or **text**, up to 10 MB. Or
press **Paste the text instead**. Add mockups and pictures with it if you have them. The breakdown is named after
the document; change the name if you like. Press **Break it down**.

squad-kit keeps the document in `.squad/requirements/BR-1/`. A Word file becomes text, with its pictures kept where
they were; text hidden in Word is left out, as you don't see it either. A PDF is read as it is. A document's text
can be up to 20 MB.

Terminal: `squad requirements add "Case Portal BRD v1.docx" [--name "…"] [--with mockup.png]`, or
`squad requirements add --paste` to read the text from the terminal.

## 2. The Analyst reads it

The page shows the reading live: which page or part it is on, what it found so far, and how long it usually takes.
You can leave the page; the work goes on. **Stop** stops it, and **Try again** carries on.

Terminal: `squad requirements show BR-1`, `squad requirements stop BR-1`, `squad requirements retry BR-1`.

A step that reaches its limit says so and offers **Give it more**: it carries on where it stopped, with twice the room
(`squad requirements more BR-1`). A long document (about 100 PDF pages or more) waits for you before anything is paid: it says
how long the read usually takes, and **Read it** starts it (`squad requirements retry BR-1`). A password-protected PDF is refused
when you add it: add a copy with no password.

## 3. Only the unclear parts come to you

The Analyst asks only about two things:

- **Missing in the BRD**: something the document leaves out that changes what gets built.
- **Two parts clash**: two parts of the document disagree.

Each question shows where it is in the document and what it changes. Pick an answer, type your own, or press **Ask
about this**. **Skip: let the Analyst decide** leaves it to the Analyst.

Everything small the Analyst decides by itself is listed under **Decided for you**, so nothing is hidden. You can
change any of them.

Parts of the document the Analyst left out on purpose (out of scope, already built) are listed under **parts left
out**, each with why. **Ask the Analyst to add it** brings one in.

Terminal: `squad requirements answer BR-1` (asks in the terminal; `--skip` lets the Analyst decide),
`squad requirements ask BR-1 q2 "…"`.

## 4. Review and approve the breakdown

The Analyst writes **epics**, then **features**, then **stories**. A small document may skip features. Each story
has:

- **Story**: "As a …, I want …, so that …".
- **Done when**: its checks, as Given, When and Then.
- **Size**: S, M or L.
- **Needs**: the stories it builds on.
- **From the BRD**: the place in the document it comes from.

Keys stay the same for good: E-1 for epics, F-1 for features, S-1 for stories.

The **tree** is the main view. Select a part to change it in the side panel:

- rename it or rewrite it;
- change its checks, size and needs;
- move it under another feature or epic;
- remove it.

You can also add epics, features and stories. **Ask the Analyst to redo this** rewrites one part with your words.
**Ask the Analyst** at the top works on the whole breakdown. While a redo runs, the stories in that part do not
start, and a story that has started already is never rewritten: change it on its ticket instead.

**Map** shows the same breakdown as boxes and lines, for presenting. On a phone the tree is shown instead.

The top line gives an **estimate**, such as "20 stories, about $140 and 6 hours to build, 2 at a time". It comes
from this project's finished tickets. With no finished tickets yet it is a rough guess from the story sizes. You
see dollars only when you pay per use; on a subscription the work uses your plan.

Press **Approve breakdown** when it looks right. squad-kit checks every story has at least one check, that every need
exists, and that no stories need each other in a loop. Nothing is built or sent before you approve.

Terminal: `squad requirements show BR-1 [--map]`, `squad requirements edit BR-1 S-4 …`,
`squad requirements add-item BR-1 --under F-2 …`, `squad requirements move BR-1 S-4 --under F-3 [--before S-9]`,
`squad requirements remove BR-1 S-4`, `squad requirements redo BR-1 S-4 "…"`, `squad requirements rename BR-1 "…"`,
`squad requirements approve BR-1`.

## 5. Send it to Azure DevOps (optional)

**Send to Azure DevOps** shows what it will create before it sends anything:

- epics, features and stories, in the item types your project uses (User Story, Product Backlog Item or
  Requirement);
- each story under its feature;
- each story's "done when" as its acceptance criteria;
- links between stories that need each other.

Items go into the project's backlog, never into a sprint. Each part keeps its number (AB#139).

- **Send changes** later updates the same items, and only the ones that changed.
- squad-kit **never deletes** anything in Azure DevOps.
- Changes made in Azure DevOps do not come back. The breakdown in squad-kit is the one that counts.
- The progress shows the items first, then the links ("14 of 30 items, then 20 links").
- A send cut off half-way carries on where it stopped, with no doubles.
- A story's ticket moves its Azure DevOps item along as the squad works, as pulled tickets do.

Your Azure DevOps token needs **Work Items (Read & write)**. In a Basic process, features become Issues and stories
become Tasks. Items go into the project's main area.

Terminal: `squad requirements send BR-1` (`--preview` shows what it would send).

## 6. Build continuously

Press **Build continuously**. squad-kit starts the next story as soon as two things are true:

- everything it needs is merged;
- there is a free place. The squad builds as many tickets at once as your parallel setting allows, and all
  projects share those places.

Each story becomes a ticket on the **Builds by itself** track:

- **No questions.** Its story and checks were approved with the breakdown, and its plan is approved by itself.
- **Small choices are made, not asked.** Each one is listed under **Decided for you**, on the ticket and on the
  breakdown. Press **Change** on any of them. Before the story merges, your change becomes a small change on its
  ticket. After it merges, the change becomes a new linked ticket.
- **It merges by itself** once its checks pass, the Reviewer agrees and the screenshots pass. The screenshots are
  still taken and kept. A "done when" that is **Not on a screen** does not hold it, and one that is **Not working
  yet** or **Not shown yet** does: it waits for your check. If the merge clashes with newer work, squad-kit brings in
  the latest main and checks again, up to 3 times while main keeps moving. If main has not moved since it last came
  in, or after the third time, the story stops with the clash card. If your pull requests need a person to approve
  them, the story waits there, shows as waiting for you, and squad-kit checks every 2 minutes whether it merged. That
  is not a failure, and it does not hold a place.
- **It stops only when a person is needed**:
  - **Missing in the BRD**: something is missing that changes what gets built.
  - **Two parts clash**: two requirements disagree, or one disagrees with what is already built.
  - **A check failed** and could not be fixed after the usual tries. Only you can let it go on past a failed
    check.

  Only that story stops, and the stories that need it wait. The others keep building. **Decide** opens the story's
  ticket with the question, where it comes from (**Sources**: the place in the BRD, your earlier answer, or the
  ticket whose work it clashes with) and the Architect's suggestion.

**Pause** stops new stories from starting; stories already running finish their step.

The queue also holds, and says why, when:

- your month budget is used up. Raise it, or press **Build continuously** to go on this month;
- your AI plan's usage limit is reached. It carries on when the limit resets;
- squad-kit is waiting for a story that needs you;
- two stories stopped on a failed check, an app that would not open or an unexpected error, so the next ones do not pay
  to reach the same stop. Settle one of them and it goes on. A question about a gap or a clash never holds it.

**Carry on** on one story's budget card covers that story only. The queue goes past the budget only when you press
**Build continuously** again.

A story the Analyst rewrites after you approved does not start by itself: the queue holds, naming it, until you read it and
press **Build continuously** again. Changing a decision that is about no one part rewrites the whole breakdown, so it says so
first, with the rough cost.

A story whose ticket you deleted does not start again by itself. The queue says so, and **Start this story now** builds it
again.

The Analyst's own work on a breakdown stops at your month budget too, before its next step, never in the middle of one.
**Carry on** lets it go on this month (`squad requirements retry BR-1`), or raise the budget in Settings.

When every story is merged, Build continuously turns itself off. Merged stories wait in the next release, and you
send it out from **Releases** as always.

Terminal: `squad requirements build BR-1 [--pause]`, `squad requirements start BR-1 S-4` (one story now),
`squad decided RO-31` and `squad decided RO-31 d2 "…"`, `squad requirements decided BR-1 d3 "…"`.

## Where it is kept

- `.squad/requirements/BR-1/breakdown.yaml` holds the breakdown. The document, its text and its pictures sit beside
  it. The folder goes into git with each of its stories' changes, so your team has it once the first story merges.
- What only this computer needs (the Analyst's progress, the build switch, the send's progress) is kept in
  squad-kit's folder on this computer.
- Only the person who added a breakdown has their squad read, build and send it. Others see it.

To delete a breakdown and its document, use **Delete** in the **…** menu on the breakdown or its row in the list,
or `squad requirements delete BR-1`. It cannot be deleted while its stories build.

## Not yet

- Uploading a new version of a BRD and comparing it with the old one.
- Bringing changes made in Azure DevOps back into the breakdown.
