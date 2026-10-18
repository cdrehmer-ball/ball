# Validation — ARC-1 1.5.1-customizing.2

Validated 18 October 2026 on Windows, Node 26.5.0. This is a pilot build, not an official upstream release or live-SAP certification. Based on this fork's Customising pilot commit c9472ee54cc0ff0e7867c674e3b55e5f0d2b971d.

## Passed

- Build, source/scripts/tests TypeScript checks, lint, action-policy parity and source/schema size checks.
- Final targeted run: **504 tests passed across seven files**: the four new event suites, existing HTTP/configuration coverage and legacy discovery.
- New event suites: **36 tests** cover operation selection, request classification, concurrent contexts, hyperfocused routing, partial/unknown outcomes, dry runs, disabled writes, opt-in configuration, metadata privacy, local-before-webhook delivery, retry IDs and delivery failures.
- Compiled launcher reports `1.5.1-customizing.2`.
- PowerShell installer syntax and temporary-config fixture passed. Event opt-in preserves SAP client, connection settings, disabled write flags and unrelated settings, and makes a restorable backup. The fixture substituted a supported Node version and skipped dependency installation; real Claude configuration was not changed.

## Full-suite limitations

The broad run reported **7,849 passed and 31 failed tests**, with 14 failed test files including one workflow suite that could not load. Two failing assertions passed in the final targeted run: the event classifier regression (the broad run loaded its earlier implementation) and an existing legacy-discovery assertion updated to accept the parser's explicit invalid-XML error.

Remaining failures are not claimed passed:

- 13 failures correspond to the previously documented upstream/Windows limitations: four POSIX permissions, four Cloud Foundry shell-launcher tests, three Unix-signal shutdown tests, one CLI subprocess timeout and one missing upstream release-note annotation.
- 16 assertions and one suite-load failure require upstream `.github` release/docs/security/dependency workflows intentionally absent from the published fork. This change does not enable upstream publishing workflows.

The broad suite was not rerun after the two targeted fixes; no all-green broad-suite claim is made. Earlier Customising validation is retained separately in VALIDATION.md.

## Boundaries

No live SAP write, client 017 acceptance, actual external webhook or SAP GUI save was tested. HTTP and webhook tests use controlled fixtures. No credentials or SAP source/configuration values are included in the event payload or this package.

Events are opt-in, best-effort operation evidence. Accepted HTTP requests are not verified changes. External GUI/Eclipse changes are outside coverage. Existing SAP session/423 behavior is unchanged. See CODE-CHANGE-EVENTS.md for queue, shutdown and replay limitations.

Source-size ratchets increased only for the HTTP observer wrapper (+2 lines) and server sink registration (+3 lines); event implementations are separate modules. No roadmap impact was found for this local pilot feature.
