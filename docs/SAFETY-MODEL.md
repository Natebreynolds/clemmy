# What Clem may do on this machine, and what stops her

This document describes the guards that are in the code, where each one runs,
and what each one does not cover. It is written from the source at the commit
named at the end and is kept beside the tests that pin each guard. Where a
capability is not built yet, it says so.

It is not a claim that Clem is a sandbox. See "What these guards are not".

## The order a call crosses the guards

Every action Clem takes is a tool call. A call crosses these in order, and any
one of them can stop it:

1. **What the turn can reach.** A chat turn holds a small set of tools
   directly and reaches the rest through two carriers: one for controls and
   reads, one for work that changes something. A tool neither carrier takes
   cannot run on that turn.
2. **What the call would do.** The call is classified from its own arguments:
   read, computation, local change, change outside the machine, or
   administration. A shell command is classified per command, not per tool.
3. **Consent.** A call that changes something must belong to work the owner
   asked for, and its risk decides whether it runs, asks the owner on one card,
   or is sent back to be corrected.
4. **Guards inside the tool.** Hard blocks, credential refusal, protection of
   Clem's own stores, and the path rule run when the tool executes, whatever
   the steps above decided.
5. **After the call.** A write leaves a receipt. A file write keeps the bytes
   it replaced. A finished answer is reviewed against what was actually read
   and done.

## Files

| Action | Rule |
| --- | --- |
| Read a file | Allowed inside the allowed folders. A credential file is refused, never asked about |
| List a folder | Allowed inside the allowed folders |
| Write a file | Create, append or overwrite inside the allowed folders. The bytes that were replaced are kept for recovery. A write to a credential or authority file always asks |
| Look at a page | Renders an `.html` file in a hidden browser and returns the image. Reads only; follows the file-read rule |

**Allowed folders.** The owner's home folder, Clem's own folder, the folder the
service runs in, and the folders named in `WORKSPACE_DIRS`. The owner's
approval setting decides how far this reaches: at its widest setting
(the default) any path the owner's account can reach is allowed.

**Credential files** are recognised by name and location: `.env`, `auth.json`,
the secrets vault and its index, the desktop tool-server configuration, Clem's
own tool-server file, and any `mcp/servers.json`.

## The shell

A shell command is sorted into one class by what it does.

| Class | Examples | On a chat turn |
| --- | --- | --- |
| Reads and computation | `ls`, `cat`, `grep`, `git status`, builds, tests, running a script, a web GET | Runs through the work carrier |
| Local change | `cp`, `mv`, `mkdir`, `rm`, `git commit`, package installs, output redirected to a file, a wrapped script that cannot be inspected | NOT YET: refused. No path exists to ask the owner |
| Leaves the machine | a web POST, `git push`, a deploy, a publish | NOT YET: refused. No card is raised |

Inside the tool, on every path, these always apply:

| Guard | What it refuses |
| --- | --- |
| Hard blocks | Recursive forced delete of the root or home folder; `sudo` and `su -`; shutdown and reboot; disk erase; `dd` to a device; `mkfs`; a fork bomb; recursive permission or owner change on the root or home folder |
| Credential reads | Any command that reads tokens, `.env`, vault or auth files, or dumps the keychain. Refused, never asked |
| Clem's own stores | Deleting or destroying her memory, event log, audit ledger, secrets, workflow definitions or their backups; changing approval or receipt state by hand |
| Waiting | A command whose whole job is to sleep ten seconds or more |
| Starting folder | The folder a command starts in must be an allowed folder. It is a starting point, not a wall: a command can name paths outside it |

**Shapes that ask first.** On the paths where the shell's own approval rule is
consulted, a command asks the owner when it has one of these shapes: deleting,
moving, recursive copy, permission changes, links; stopping processes; system
settings; package installs and script runners; git operations that lose or
publish work; container and cluster changes; writes through the Salesforce,
GitHub, cloud and infrastructure command-line tools; web requests that send
data; deploys; `eval`, `exec` and `source`; and any output redirected to a
file. Whether that question reaches the owner depends on the owner's approval
setting, which can approve inside an approved plan, inside the workspace, or
everywhere.

## Changes outside the machine

A change in a connected app (mail, calendar, a CRM, a sheet) is made through a
connection the owner authorised. It must belong to work the owner asked for.
A send, a delete, an irreversible or administrative change, or one sealed bulk
change asks on one card that shows the exact content. A change the provider
declares ordinary and non-destructive runs without a card. The owner's pending
cards are never decided by Clem.

## Pages made in a project

| Surface | How a page is shown | What the page can do |
| --- | --- | --- |
| Desktop | The document itself, framed | Run its own scripts; load scripts, styles, fonts and images from public https addresses. It has no origin: no cookie, no storage, no reach into the app. It cannot call anything, submit a form, frame another page or start a worker |
| Phone | Pictures rendered on the Mac | Nothing. Nothing a page contains runs on the phone |

A page is listed only when the record says work wrote it, its real path lies
inside a folder the owner linked to the project, and it is not under a hidden
folder or a credential path. It is found again from the project each time it
is read. Only the desktop, on the machine itself, is sent the document or
opens it in the browser.

## Linked local projects

Linking a folder to a project records where the work happens. It grants no
access by itself: every rule above applies as it does anywhere else.

What a linked folder offers is read as names only: its instruction files, the
commands it names, and the tool servers it declares. A declared tool server's
command, arguments and keys are never read out of its file, and declaring one
connects nothing.

## Coding work handed to a coding agent

Work handed to a coding agent runs in its own copy of the repository on its
own branch, so the owner's checkout is not touched. There it may read, edit,
build, test and commit. It may not push, open a request for review, publish or
deploy, change files outside its copy, move refs other checkouts share, use
tool servers, or read credentials. Its environment is built from an allow-list
and carries none of Clem's keys.

## What these guards are not

- **Not a sandbox.** The lists of command shapes recognise commands by how
  they are written. A script can do what its command line does not show.
- **Not a wall around a folder.** A command that starts in a folder can name
  any path the owner's account can reach.
- **Not proof that a command is harmless.** A script that writes to the
  network is sorted as computation unless its command line shows the write.
- **Not a replacement for the owner's own care** with skills, plugins, tool
  servers and scripts from other publishers: those are code and run as code.

## What a coding tool can do, and where Clem stands

| Ability | Clem | State |
| --- | --- | --- |
| Read, list and search files | `read_file`, `list_files`, shell `grep` and `find` | Works |
| Create or replace a file | `write_file`, prior bytes kept | Works |
| Change part of a file | Only by replacing the whole file | Gap |
| Shell: reads, builds, tests | Through the work carrier | Works |
| Shell: local changes | | Not yet |
| Shell: push, deploy, publish | | Not yet |
| Look at a rendered page | `page_preview` | Works |
| Drive a real browser | | Not reachable on a chat turn |
| Fetch a web page | `http_read` | Works |
| Helpers and background work | Workers, background tasks | Works |
| Plans and task lists | Plan and task tools | Works |
| A project's own commands and instructions | Named to the turn from the linked folder | Works |
| Tool servers | The owner's connected servers | Works; a project's declared servers are shown, not connected |
| Hand code changes to a coding agent | Own copy and branch, verified by Clem | Works |
| Confinement enforced by the system | | Not yet |

## Where each guard is pinned

| Guard | Test |
| --- | --- |
| Hard blocks and shapes that ask | `src/tools/computer-tools.danger.test.ts` |
| Clem's own stores | `src/tools/shell-state-protection.red.test.ts` |
| What leaves the machine | `src/runtime/harness/destination-gate.test.ts` |
| A read-class shell command runs under its own envelope and nothing else does | `src/tools/work-call.foreground-compute.test.ts` |
| The shell is disclosed truthfully | `src/tools/tool-search-relevance.test.ts`, `src/tools/call-tool.test.ts` |
| A file write without a card keeps its receipt | `src/runtime/harness/normal-native-write.integration.test.ts` |
| Pages: listing, reading, policy, surfaces | `src/projects/local-pages.test.ts` |
| A framed page's sandbox | `apps/console-web/src/screens/ProjectPageViewer.test.ts` |
| Page preview follows the file-read rule | `src/tools/page-preview-tools.test.ts` |
| What a linked folder offers is names only | `src/projects/local-project-offers.test.ts` |
| Coding agent policy | `src/execution/coding-run-policy.test.ts` |

Written from the source at `84e1c5149` on branch `claude/local-page-viewer`,
2026-09-29. A guard that changes is changed here in the same commit.
