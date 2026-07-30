# MingXu Agent Guide

## Project Facts

- This is a TypeScript ESM project managed as a pnpm workspace.
- Use Node.js `>=22.19.0` and pnpm `>=10.0.0`; the repository pins pnpm `10.12.1`.
- Runtime code lives in `src/`; workspace packages live in `packages/`; tests live in `tests/`.
- Keep `.js` extensions in TypeScript relative imports because emitted code uses ESM.
- Do not edit generated `dist/` output directly.

## Setup And Commands

Run commands from the repository root.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:dry-run
```

For a focused test, run the affected Vitest file directly:

```powershell
pnpm exec vitest run tests/<name>.test.ts
```

## Change Rules

- Read the owning source, its tests, and any linked design document before changing a runtime boundary.
- Preserve existing public exports and CLI behavior unless the task explicitly changes them.
- Keep source and test changes together. Add negative or recovery coverage for failure-path changes.
- Keep `package.json`, workspace package manifests, and `pnpm-lock.yaml` consistent when dependencies change.
- Preserve Windows, macOS, and Linux behavior; avoid shell assumptions in shared code and tests.
- Do not treat README examples or planning documents as proof that runtime behavior works.

## Validation And Handoff

- After the final edit, run the smallest relevant test and `pnpm typecheck`.
- Run `pnpm test` for shared runtime, policy, session, plugin, or CLI behavior changes.
- Also run `pnpm build` for exports or packaging changes, and `pnpm test:smoke` plus `pnpm pack:dry-run` for install or CLI package changes.
- If a check fails, keep the reproduction and diagnosis, repair it, and rerun the same check after the final edit.
- In the final handoff, list the exact checks and results. Never claim success for an unrun, unrelated, or pre-final-edit check.

## Safety Boundaries

- Never commit credentials or print resolved API keys, tokens, or secret-bearing configuration.
- Publishing packages, creating releases or tags, changing CI secrets/environments, and modifying production services require explicit user approval.
- Global installs and changes to user-level configuration, plugins, sessions, or Memory require explicit user approval.
- Avoid destructive Git or filesystem operations unless the user explicitly requests them and the exact target is verified.
