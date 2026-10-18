# ARC-1 enhanced Customising MCP server

**Version 1.5.1-customizing.2 — local pilot build.** Based on [ARC-1 v1.5.1](https://github.com/arc-mcp/arc-1/tree/v1.5.1); this is a custom distribution, not an official upstream release.

[Download the installation ZIP](https://github.com/cdrehmer-ball/ball/releases/download/v1.5.1-customizing.2/Enhanced-Arc1-Events.zip) · [Installation and workflow guide](CUSTOMIZING-README.md) · [Validation and limitations](VALIDATION.md)

## Code-change event support

Version `1.5.1-customizing.2` adds local JSON logging and optional HTTPS webhook delivery. See [CODE-CHANGE-EVENTS.md](CODE-CHANGE-EVENTS.md) for configuration, event outcomes and delivery limits. Events are disabled by default; SAP permissions are unchanged.

## What it adds

- Fixes transport discovery across Workbench and Customising category/status branches.
- Resolves a transport request or its task, retaining the parent relationship when SAP supplies it.
- Adds `SAPCustomizing`: `discover`, `read`, `prepare`, `guide`, and `verify`.
- Prepares explicit updates to existing supported configuration rows and translations.
- Checks current values and transport evidence separately after the user saves in SAP GUI.

**Saving remains a manual SAP GUI action.** This build does not automatically update configuration tables, automate SAP GUI, create/delete rows, or release transports. Discovery does not imply editing support. No new SAP-side component is required.

## Install in Claude Desktop on Windows

1. Download **Enhanced-Arc1-Events.zip** from the release above. Use this asset, rather than GitHub's automatically generated source ZIP: it includes the compiled runtime.
2. Extract it to a permanent folder. Open the inner folder containing `Install-Claude.ps1`.
3. Install Node.js 24 LTS or Node.js 22.22.1+ within major version 22.
4. Fully quit Claude, including its system-tray process.
5. Open PowerShell in that folder and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Claude.ps1
```

6. Select the existing ARC-1 SAP entry. The installer backs up Claude's configuration, downloads pinned production dependencies and points that entry at this build. Existing SAP connection details and write restrictions are preserved.
7. Restart Claude and confirm version `1.5.1-customizing.2` and the `SAPCustomizing` tool.

An existing SAP MCP connection with settings in `env` is required; the installer does not invent connection details. `SAP_ALLOW_DATA_PREVIEW=true` is needed for the new tool. SAP and transport writes can remain disabled. Keep the extracted folder in place. Installation requires internet access to npm.

Rollback instructions and alternate configuration locations are in [CUSTOMIZING-README.md](CUSTOMIZING-README.md).

## Validation status

See [EVENTS-VALIDATION.md](EVENTS-VALIDATION.md) for this version’s build and test results. The earlier Customising pilot results are retained in [VALIDATION.md](VALIDATION.md).

SAP_BASIS 740/client 017 live validation and manual GUI-save acceptance remain outstanding. Automated tests and offline response replay are not live SAP certification.

## Develop from source

```powershell
npm ci
npm run build
npm run typecheck
npm test
```

The Git repository contains source and tests; the release asset includes precompiled files. The [upstream README](README-UPSTREAM.md) documents the base project, but its upstream npm/latest installation commands do not install this custom build.

## License and provenance

[MIT license](LICENSE), retaining upstream copyright notices. Based on upstream commit `00c505b528486c71f74565b08617d9a4ad9a799a`. No roadmap impact: this pilot adds optional code-change event delivery to the existing Customising build.
