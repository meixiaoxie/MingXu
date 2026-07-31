# Third-Party Notices

## pi-mono / pi-tui

`src/differential-renderer.ts` adapts the viewport-aware differential rendering algorithm from `@earendil-works/pi-tui` 0.82.1 at pi-mono commit `2efa728d2ee90ef597626e96b1e28ef2b279f07c`.

- Copyright (c) 2025 Mario Zechner
- License: MIT
- License text: `LICENSES/pi-mono-MIT.txt`

MingXu retains only active-region line diffing and transcript promotion. Upgrades are reviewed manually against the pinned commit and must preserve MingXu's prepared-frame API.

## marked

Markdown tokenization uses `marked` 18.0.7 without local modifications.

- Copyright (c) 2018+, MarkedJS
- Copyright (c) 2011-2018, Christopher Jeffrey
- License: MIT, with the upstream Markdown license notice

The package is installed as a runtime dependency and carries its upstream `LICENSE` file. Upgrades are reviewed against the token schema consumed by `Markdown` and must preserve GFM table behavior and terminal-text sanitization.
