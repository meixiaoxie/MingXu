# Security Policy

## Supported versions

Before `1.0.0`, security fixes are applied on the latest `0.x` release line only.

## Current security boundary

The current `0.x` line runs plugins in the host Node.js process and does not claim strong sandbox isolation. Treat local plugins as trusted code only.

The default `0.4.0` install starts with no built-in file, command, browser, or network tools. Those capabilities must be added explicitly through local plugins or MCP servers, which keeps the default attack surface small.

The interactive TUI is a presentation layer only. It does not add sandboxing, privilege separation, or any additional trust boundary beyond the core runtime.

## Reporting a vulnerability

Please do not open a public issue for undisclosed vulnerabilities.

Until a dedicated security inbox is provisioned, report security issues privately to the project maintainers through the repository hosting platform's private contact channel and include:

- affected version or commit SHA
- impact summary
- reproduction steps or proof-of-concept
- whether secrets, local files, network access, or command execution are involved

The maintainers should acknowledge the report, reproduce it on the latest supported commit, prepare a fix, and publish a changelog entry once disclosure is coordinated.
