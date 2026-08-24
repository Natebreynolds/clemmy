/** Run: node scripts/run-tests-isolated.mjs src/runtime/cli-subcommands.test.ts
 *
 * Fixtures are REAL `--help` output captured from programs on a live machine,
 * trimmed but not reshaped. Invented fixtures would only prove the parser
 * matches the regex I wrote; real ones prove it matches what programs emit.
 *
 * The governing rule under test is conservatism. A missing subcommand costs a
 * capability that fails closed and asks; an invented one binds and then runs
 * something the user never had. Where the two trade off, these pins choose
 * missing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliSubcommands } from './cli-subcommands.js';

/** Two-space-gap entries under prose headings, plus a usage block to ignore. */
const GAP_STYLE = `usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]
           [--exec-path[=<path>]] [--html-path] [--man-path] [--info-path]
           <command> [<args>]

These are common Git commands used in various situations:

start a working area (see also: git help tutorial)
   clone      Clone a repository into a new directory
   init       Create an empty Git repository or reinitialize an existing one

work on the current change (see also: git help everyday)
   add        Add file contents to the index
   mv         Move or rename a file, a directory, or a symlink
   rm         Remove files from the working tree and from the index
`;

/** Colon-style entries under ALL-CAPS headings. */
const COLON_STYLE = `Work seamlessly with GitHub from the command line.

USAGE
  gh <command> <subcommand> [flags]

CORE COMMANDS
  auth:          Authenticate gh and git with GitHub
  browse:        Open repositories, issues, pull requests, and more in the browser
  issue:         Manage issues
  pr:            Manage pull requests
  repo:          Manage repositories

GITHUB ACTIONS COMMANDS
  run:           View details about workflow runs
  workflow:      View details about GitHub Actions workflows
`;

/** A bare comma list — real, common, and deliberately NOT supported. */
const LIST_STYLE = `npm <command>

Usage:

npm install        install all the dependencies in your project
npm test           run this project's tests

All commands:

    access, adduser, audit, bugs, cache, ci, completion,
    config, dedupe, deprecate, diff, dist-tag, docs, doctor,
`;

test('gap-separated entries are read with their descriptions', () => {
  const found = parseCliSubcommands(GAP_STYLE);
  const byName = new Map(found.map((entry) => [entry.name, entry.description]));
  assert.equal(byName.get('clone'), 'Clone a repository into a new directory');
  assert.equal(byName.get('init'), 'Create an empty Git repository or reinitialize an existing one');
  assert.ok(byName.has('add') && byName.has('mv') && byName.has('rm'));
});

test('colon-separated entries are read with their descriptions', () => {
  const byName = new Map(parseCliSubcommands(COLON_STYLE).map((e) => [e.name, e.description]));
  assert.equal(byName.get('auth'), 'Authenticate gh and git with GitHub');
  assert.equal(byName.get('pr'), 'Manage pull requests');
  assert.ok(byName.has('workflow'), 'entries under a second heading are still entries');
});

test('usage syntax and flags are never mistaken for capabilities', () => {
  const names = parseCliSubcommands(GAP_STYLE).map((entry) => entry.name);
  // The continuation lines of the usage block are indented and start with '[',
  // which is exactly the trap: indentation alone must not qualify a line.
  assert.ok(!names.some((name) => name.startsWith('-')), `flags leaked: ${names.join(',')}`);
  assert.ok(!names.includes('usage'), 'the usage heading is not a subcommand');
  assert.ok(!names.includes('command'), 'a syntax placeholder is not a subcommand');
});

test('a description-free command list is refused rather than guessed at', () => {
  // These names are real subcommands, and the parser still declines them: with
  // no description there is nothing to retrieve on, and the comma-list shape is
  // ambiguous with ordinary prose. Refusing is the honest answer — the failure
  // mode of accepting is an index full of unfindable name-only rows.
  const found = parseCliSubcommands(LIST_STYLE);
  assert.ok(
    !found.some((entry) => ['access', 'adduser', 'audit', 'dedupe'].includes(entry.name)),
    `comma-list names must not be accepted: ${found.map((e) => e.name).join(',')}`,
  );
});

test('an indented bare URL is not a capability', () => {
  // Regression, found by running the parser over real programs rather than
  // fixtures: this exact line contributed a subcommand named `https`.
  const help = `Further help:
  brew commands
  brew help [COMMAND]
  https://docs.brew.sh
`;
  const names = parseCliSubcommands(help).map((entry) => entry.name);
  assert.ok(!names.includes('https'), `a URL scheme is not a subcommand: ${names.join(',')}`);
});

test('a program with no subcommands yields nothing, not noise', () => {
  const plain = 'jq - commandline JSON processor [version 1.7]\n\nUsage:\tjq [OPTIONS] FILTER [FILES...]\n';
  assert.deepEqual(parseCliSubcommands(plain), []);
});

test('output is bounded and deduplicated', () => {
  const noisy = Array.from({ length: 200 }, (_, i) => `   cmd${i}    Does thing number ${i}`).join('\n');
  assert.equal(parseCliSubcommands(noisy, { max: 10 }).length, 10);

  const repeated = '   build    Compile the project\n   build    See also: compile the project\n';
  const found = parseCliSubcommands(repeated);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.description, 'Compile the project', 'first mention wins');
});
