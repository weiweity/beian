---
name: antd
description: >
  Use when the task involves Ant Design components, APIs, tokens, demos,
  changelogs, migration guidance, usage analysis, linting, or diagnostics.
---

# Ant Design read-only knowledge workflow

This repository vendors a reviewed Ant Design skill. Its only executable boundary is:

`node scripts/quality/antd-readonly.mjs`

The wrapper requires the preinstalled `@ant-design/cli@6.6.1`, disables update checks, runs without a shell, accepts only reviewed read-only subcommands, and rejects paths outside this repository. Do not invoke the underlying executable directly and do not change the developer toolchain from a product task.

## Start here

Verify the approved tool before relying on its output:

```bash
node scripts/quality/antd-readonly.mjs --cli-version
```

If the wrapper reports a missing or mismatched version, stop and report that exact blocker. Installing or upgrading developer tools is a separate maintenance change requiring explicit approval.

Prefer JSON whenever the command supports it:

```bash
node scripts/quality/antd-readonly.mjs info Button --format json
node scripts/quality/antd-readonly.mjs demo Button basic --format json
node scripts/quality/antd-readonly.mjs semantic Button --format json
node scripts/quality/antd-readonly.mjs token Button --format json
```

## Approved workflows

Component implementation:

```bash
node scripts/quality/antd-readonly.mjs info Select --format json
node scripts/quality/antd-readonly.mjs doc Select --lang zh
node scripts/quality/antd-readonly.mjs demo Select basic --format json
node scripts/quality/antd-readonly.mjs token Select --format json
```

Project diagnostics:

```bash
node scripts/quality/antd-readonly.mjs env . --format json
node scripts/quality/antd-readonly.mjs doctor --format json
node scripts/quality/antd-readonly.mjs usage apps/web/ui/src --format json
node scripts/quality/antd-readonly.mjs lint apps/web/ui/src --format json
```

Version and migration research:

```bash
node scripts/quality/antd-readonly.mjs changelog 5.0.0 6.0.0 --format json
node scripts/quality/antd-readonly.mjs migrate 5 6 --format json
node scripts/quality/antd-readonly.mjs migrate 5 6 --component Select --format json
```

Migration is guidance-only. The wrapper intentionally rejects auto-fix and confirmation modes. Apply source changes through the normal repository edit and review workflow, then run lint, tests, and build.

## Boundaries

- No automatic package installation or CLI upgrade.
- No setup command, persistent MCP process, external issue submission, or browser-opening report command.
- No command outside the wrapper and no path outside this repository.
- Draft bug reports locally for user review; external submission requires a separate explicit request.
- Treat CLI output as reference evidence. The repository's `DESIGN.md`, installed dependency versions, source code, tests, and user-approved requirements remain authoritative.
