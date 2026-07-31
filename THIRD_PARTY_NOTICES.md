# Third-Party Notices

This repository may include code or design ideas derived from third-party sources. The notices below record the provenance that must stay visible in the source tree and published package.

## pi-mono

- Source repository: `D:/项目/claude/AI/pi-mono`
- Reference commit: `2efa728d2ee90ef597626e96b1e28ef2b279f07c`
- Reference package: `@earendil-works/pi-tui` `0.82.1`
- License: MIT
- License text: [`LICENSES/pi-mono-MIT.txt`](LICENSES/pi-mono-MIT.txt)
- Copyright holder: Mario Zechner (2025)

Files derived from `pi-mono` must keep a short provenance note in the file header or nearby documentation, and must continue to reference this notice.

`packages/tui/src/differential-renderer.ts` adapts the viewport-aware line-diff algorithm into a MingXu-owned active-region renderer. Image protocols, overlay composition, input handling, lifecycle management, and pi-tui's component API are intentionally excluded. Upgrades must be reviewed against the pinned commit, retain the local prepared-frame and committed-transcript protocol, and rerun the R1 scrollback, resize, overlay, and performance gates.

## claude code

- Source: local non-official snapshot used only for clean-room behavior and architecture reference
- License: not copied into this repository
- Usage rule: do not copy code, comments, prompts, tests, or unique strings from the snapshot

This notice is informational only and does not replace any upstream license text.
