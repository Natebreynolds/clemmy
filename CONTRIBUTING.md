# Contributing to Clementine

Thank you for helping make Clementine safer, calmer, and more reliable. Focused bug fixes, tests, documentation improvements, accessibility work, and well-scoped feature proposals are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are provided under the repository's [MIT License](LICENSE).

## Before you begin

- Search existing issues and pull requests before starting duplicate work.
- Open an issue before a large architectural change so the scope can be discussed.
- Keep pull requests narrow enough to review and verify.
- Never report a vulnerability publicly. Follow [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Node.js `>=22.15.0`;
- npm;
- macOS for native desktop, permission, Recall, signing, and notch work;
- credentials only when a test explicitly requires a live provider.

Install the core dependencies:

```bash
git clone https://github.com/Natebreynolds/clemmy.git
cd clemmy
npm ci
```

Install only the additional surfaces you plan to change:

```bash
npm --prefix apps/console-web ci
npm --prefix apps/mobile-web ci
npm --prefix apps/desktop ci
npm --prefix apps/web ci
```

Copying `.env.example` is optional for offline tests. Never commit a populated `.env` file.

## Running checks

For daemon and runtime changes:

```bash
npm run check:public-hygiene
npm run typecheck
npm test
```

For release or packaging changes:

```bash
npm run test:release-assets
```

For an app you changed, run its local typecheck and build:

```bash
npm --prefix apps/console-web run typecheck
npm --prefix apps/console-web run build

npm --prefix apps/mobile-web run typecheck
npm --prefix apps/mobile-web run build

npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run build

npm --prefix apps/web run build
```

Run the smallest relevant test set while iterating, then the broader affected suite before requesting review. Live-provider tests must fail safely when credentials are absent and should not mutate external data unless the test is explicitly designed and isolated for that purpose.

## Code and test expectations

- Preserve TypeScript ESM conventions already used by the package.
- Add or update tests for behavioral changes and failure paths.
- Prefer explicit state transitions and fail-closed behavior at trust boundaries.
- Keep secrets, raw provider errors, filesystem paths, and meeting identifiers out of renderer-facing payloads and logs.
- Update user-facing documentation when commands, configuration, data locations, permissions, or privacy boundaries change.
- Avoid unrelated formatting or refactors in the same pull request.

## Public-repository hygiene

This repository is public. Before every commit, review the exact staged diff and confirm that it contains none of the following:

- `.env` files, API keys, tokens, cookies, signing material, or OAuth grants;
- anything from `~/.clementine-next/` or another user's app-data directory;
- real meeting transcripts, customer names, client domains, CRM records, emails, or prospect lists;
- screenshots captured from a live personal profile without complete redaction;
- local absolute paths, private operational runbooks, or generated run artifacts.

Use synthetic names and fixture data in examples and tests. A `.gitignore` rule is a guardrail, not permission to keep sensitive data inside the repository directory.

`npm run check:public-hygiene` scans existing Git-tracked files only and reports
prohibited files or sensitive-content categories without printing matched values.

## Pull requests

A strong pull request includes:

1. a concise explanation of the user-visible problem;
2. the chosen behavior and important tradeoffs;
3. tests or other evidence that cover success and failure paths;
4. screenshots or recordings for meaningful UI changes, using synthetic data;
5. documentation and migration notes when compatibility changes;
6. a clean diff without unrelated user or generated files.

Maintainers may ask for a change to be split, simplified, or deferred when its security or maintenance cost is unclear.
