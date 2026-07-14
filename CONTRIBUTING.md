# Contributing

Thanks for your interest in improving Notification Service! Contributions of all
kinds are welcome — bug reports, docs, and code.

## Getting started

1. Fork and clone the repo.
2. Install the toolchain (see the [README](README.md#prerequisites-from-scratch)):
   Node ≥ 18, pnpm `10.14.0` (`corepack enable`), and Git.
3. Install dependencies:
   ```sh
   pnpm install
   ```
4. Run the test suite and type-checks:
   ```sh
   pnpm test
   pnpm -r typecheck
   ```
5. For a live instance, deploy your own with `pnpm run setup` (needs a free
   Cloudflare account) and tear it down with `pnpm run teardown`.

## Project layout

This is a pnpm + Turborepo monorepo. See the
[Repo layout](README.md#repo-layout) section of the README for a map.

## Pull requests

- Keep PRs focused; one logical change per PR.
- Match the existing code style — the repo is TypeScript with strict settings.
- Add or update tests for behavior changes.
- Update the README when you change setup, the REST API, or the MCP tools.
- Make sure `pnpm test` and type-checks pass before opening the PR.

## Reporting bugs

Open an issue with steps to reproduce, what you expected, and what happened.
For anything security-sensitive, please disclose privately rather than opening a
public issue.

## Code of conduct

Be respectful and constructive. We want this to be a welcoming project for
everyone.
