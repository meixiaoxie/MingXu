# Changelog

All notable changes to `mingxu` will be documented in this file.

The project follows a practical pre-1.0 compatibility policy:

- `0.x` releases may refine APIs when the architecture is still settling.
- Public changes that affect CLI flags, config schema, emitted session/audit shapes, or exported SDK types must be documented here.
- When a previously documented public behavior is going away, the deprecation will be called out here before removal.

## Unreleased

- Consolidated CLI, `AgentSession`, and `Agent` execution onto `runAgentLoop`, including streaming, hooks, compaction, governed parallel tool execution, audit events, and terminal session persistence.
- Added optional `AgentLoopResult.sessionId`; new sessions return their generated ID and resumed sessions load their saved message history.
- Changed approval matching to include `principalId` in both lookup and request fingerprints. Approval fingerprints created by earlier builds are intentionally invalidated.
- Hardened file-backed session and memory identifiers against path traversal, reserved names, and symbolic-link write targets.
- Builds now clean `dist` before compilation, and package smoke tests fail when npm cannot be launched instead of reporting skipped success.
- Added the staged runtime-rewrite roadmap and architecture ADRs for the unique runtime chain, append-only session history, permissions and sandbox boundaries, memory/resource loading, and third-party provenance.
- Added third-party provenance notices and MIT license text for `pi-mono` reuse.
- Added a current-runtime characterization test to pin the existing CLI/session/public API baseline before the rewrite stages start.
- Added stage 6 compaction plumbing for long contexts, including automatic summary compression, overflow recovery, and branch-aware context rebuilding.

## 0.1.0

- Added named-model CLI selection with `--model`.
- Added runtime budgets, artifact-backed large tool results, usage accounting, and stable termination reasons.
- Added versioned runtime events, JSONL audit output, `env:` secret references, and redaction coverage.
- Added core Policy / Approval flow for tool execution.
- Added versioned local Session documents with recovery, `resume`, and `sessions`.
- Added trusted local Tool plugin trust settings, config-relative plugin resolution, load warnings, and setup rollback.
- Added `mingxu init` and `mingxu doctor` along with offline package smoke coverage for the new workflow.
