# Validation — ARC-1 1.5.1-customizing.1

Built 9 October 2026 from upstream v1.5.1, commit 00c505b528486c71f74565b08617d9a4ad9a799a.
This is a local pilot build, not an official ARC-1 release or a live-SAP certification.

## Passed

- Build, TypeScript checks (source/scripts/tests), lint, action-policy parity and size/schema checks.
- Final targeted suite: **348 tests passed across 10 files**, including transport compatibility,
  parser regression, standalone task lookup, workflow, audit privacy, registry, schemas, docs and manifests.
- New workflow/parser/security coverage: 19 tests. Includes existing standard/customer entries,
  status texts, explicit keys, stale snapshots, partial saves, constraints, ambiguous views,
  bounded reads, local-only/data permissions, transport evidence and redacted audit values/errors.
- Offline replay of the supplied SAP response finds **BSDK952467**, category W, and task
  **BSDK952468**. This is a replay, not a fresh SAP connection. The original response/logs/cookies
  are not included; regression fixtures use synthetic names and numbers.
- PowerShell installer and rollback syntax checks; temporary-config install/restore preserves
  client, connection settings, unrelated settings and disabled write flags. The fixture used a
  stub Node version and skipped dependency installation; it did not modify real Claude settings.

- Clean production dependency installation in the release folder succeeded. The compiled launcher
  reports 1.5.1-customizing.1, the customising module loads, and the production tool registry exposes
  SAPCustomizing with SAP and transport writes disabled. No SAP connection was used.

## Broad-suite limitations

The broad run completed with 7,839 passing and 14 failing tests (7,853 total). The one new-tool
registry expectation was then corrected and passed in the final targeted run. All 13 other
failing cases reproduce in an untouched v1.5.1 checkout on this computer:

- Four POSIX file-permission assertions (SQLite and audit files) on Windows.
- Four Cloud Foundry shell-launcher tests on Windows.
- Three real Unix-signal shutdown tests on Windows.
- One source-CLI subprocess timeout.
- One upstream released-version annotation assertion.

The full suite is therefore not claimed green. Development checks ran on Windows with Node
26.5.0; the portable installer accepts Node 22.22.1+ or 24 LTS for the upstream dependency engines.
The source includes a small pre-existing formatting correction in package-contents.ts.

## Scope and deliberate budgets

Transport parsing is isolated from the shared findDeepNodes helper. SAPCustomizing uses only
existing bounded runTableQuery reads plus read-only ADT transport lookup. It adds no SQL UPDATE,
CTS mutation, automatic GUI operation or release path. Data/source-block policies still apply.
The new schema deliberately raises the full-tool wire budget from 74,000 to 75,000 bytes;
measured full on-prem wire size is 74,252 bytes. The tool-definition file budget rises 10 lines.
Roadmap reviewed: no existing item is completed or removed by this pilot.

## Required live pilot (not run)

No live SAP credentials or SAP GUI saves were available. SAP_BASIS 740/client 017 compatibility,
actual metadata access, BS02/SM30 maintenance routes, authorization and recording need validation
on the destination setup. These checks are not counted as passed automated tests.

1. Confirm the version and read BSDK952467 and BSDK952468; compare with SE09/SE10.
2. Discover approved existing status-text and table/view test rows. Inspect returned capabilities.
3. Prepare explicit keyed edits, request guidance, then save manually in SAP GUI.
4. Verify with the actual request/task. Review values and CTS evidence separately.
5. Test stale and partial saves. Unsupported/blocked/ambiguous objects must remain unsupported.

One row per change set; unsupported types and complex view mappings fail closed. An existing
CTS entry is not proof of a specific field edit or its author. Snapshots are local captured
before/after comparisons, not reconstructed historical transport contents.
