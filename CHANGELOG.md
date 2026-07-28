# Changelog

All notable changes to `mingxu` will be documented in this file.

The project follows a practical pre-1.0 compatibility policy:

- `0.x` releases may refine APIs when the architecture is still settling.
- Public changes that affect CLI flags, config schema, emitted session/audit shapes, or exported SDK types must be documented here.
- When a previously documented public behavior is going away, the deprecation will be called out here before removal.

## 0.1.0

- Added named-model CLI selection with `--model`.
- Added runtime budgets, artifact-backed large tool results, usage accounting, and stable termination reasons.
- Added versioned runtime events, JSONL audit output, `env:` secret references, and redaction coverage.
- Added core Policy / Approval flow for tool execution.
- Added versioned local Session documents with recovery, `resume`, and `sessions`.
- Added trusted local Tool plugin trust settings, config-relative plugin resolution, load warnings, and setup rollback.
- Added `mingxu init` and `mingxu doctor` along with offline package smoke coverage for the new workflow.
