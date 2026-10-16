# ARC-1 guided customising — 1.5.1-customizing.1

Local pilot build based on upstream v1.5.1 (00c505b528486c71f74565b08617d9a4ad9a799a).
This is a custom build, not an official upstream release.

## Install from the ZIP

1. Extract the ZIP into a permanent local folder. Install Node.js 22.22.1+ or 24 LTS.
2. Quit Claude. Open PowerShell in the extracted folder and run `./Install-Claude.ps1`.
   If the downloaded script is blocked, inspect it, then use `Unblock-File ./Install-Claude.ps1`.
3. Choose your existing ARC-1 SAP entry. Its connection, credentials, SAP client and safety settings
   are preserved. The installer downloads locked production dependencies from npm, so internet access
   is required. It does not install a component in SAP, or enable SAP write permissions.
4. Restart Claude. Check that the server reports **1.5.1-customizing.1** and offers SAPCustomizing.
   Data preview must be enabled in the existing entry (`SAP_ALLOW_DATA_PREVIEW=true`).
5. Keep the extracted folder: Claude is pinned to its exact `bin/arc1.js`, not `npx arc-1@latest`.

The installer requires an existing entry with SAP connection settings in `env`. CLI-configured
connections need their options moved into documented environment equivalents first. It refuses to
silently discard CLI flags. If Claude is installed elsewhere, pass `-ConfigPath` and `-ServerName`.
It creates a timestamped configuration backup. Restore using `./Restore-Claude.ps1 -BackupPath '…'`.
Backups contain the same credentials as your existing Claude configuration; keep them locally.

## What is fixed

Transport parsing now visits every category/status branch. Workbench, released and Customising
requests in the same SAP response are retained. `SAPTransport get` also recognises tasks and includes
their parent where SAP supplies it. An absent ID is reported as absent from the response, not proof
that it does not exist in SAP. Existing mutation helpers remain request-only.

## Guided workflow

1. **discover**: supply a transport/task, an exact name, or a bounded table-name query (`T0*`, `ZCONF*`).
   C/G delivery-class searches are candidates, not an exhaustive SPRO catalogue.
2. **read**: inspect current fields, complete keys, existing language entries and capabilities.
3. **prepare**: supply every row key, changed fields and an existing modifiable Customising request/task.
   One existing row per change set. Nothing is written to SAP.
4. **guide**: reload the row and metadata, detect stale data, and show the verified maintenance route.
5. Save manually through SAP GUI, selecting the intended request/task. SAP performs final validation.
6. **verify**: supply the change-set ID and actual request/task. Fresh reads report values separately
   from CTS object/key evidence. Partial results never claim a complete save.

Examples (adapt names and keys to the metadata returned by your SAP system):

```json
{"action":"discover","transport":"BSDK952467"}
{"action":"read","kind":"status_profile","name":"ZPM_EQUI","textTable":"TJ20T"}
{"action":"read","kind":"status_profile","name":"ZPM_EQUI","textTable":"TJ30T"}
{"action":"read","kind":"table","name":"ZCONFIG","keys":{"CODE":"A"}}
{"action":"prepare","kind":"table","name":"ZCONFIG","keys":{"MANDT":"017","CODE":"A"},"changes":{"TEXT":"New text"},"transport":"DEVK900003"}
{"action":"guide","changeSetId":"<ID returned by prepare>"}
{"action":"verify","changeSetId":"<ID returned by prepare>","transport":"DEVK900004"}
```

Hyperfocused mode: `SAP(action="customizing", params={...})` uses the same checks.
`SAPWrite type=TABL` changes table definitions, not configuration rows; do not use it for this workflow.

## Coverage and boundaries

- No Z-only restriction. SAP authorization, ARC-1 data opt-in, deny-actions and blocked data sources apply.
- Status-profile adapter covers **existing** TJ20T/TJ30T text entries, not status-control settings.
- Generic preparation requires active DDIC fields/keys, C/G customising delivery class and TVDIR
  maintenance evidence. The user saves through SM30. Views need an unambiguous identity mapping to a
  single backing customising table and an available existing read interface; complex views are unsupported.
- Character, numeric-text, date and time fields are supported. Other data types fail closed in this pilot.
  Domain fixed values and resolvable check-table relationships are validated. SAP maintenance performs
  final business checks; metadata validation is not equivalent to executing the SAP dialog.
- No missing row creation, key/client/language changes, deletion, arbitrary bulk updates or automatic release.
  Changing a translation means updating the text on an **existing** language-keyed row.
- Reads are bounded. Truncated inventories must be narrowed; unknown/blocked metadata is not treated
  as permission to prepare a change. Transport key decoding supports simple character keys only;
  wildcard/unsupported keys are returned as raw evidence with partial coverage.
- Matching CTS entries prove coverage, not who made a change or the historical field values.
- The workflow is **local stdio only**, with snapshots under `%LOCALAPPDATA%/arc-1/customizing`
  (or `~/.local/share/arc-1/customizing`). Snapshots contain configuration values, are user-local and
  bound to endpoint/client/user. Delete unneeded snapshot JSON files there when finished.
  Credentials and cookies are not stored in snapshots. Inputs/results are redacted from ordinary audit logs.
- `SAP_ALLOW_WRITES` and `SAP_ALLOW_TRANSPORT_WRITES` can remain false. The existing SAP_BASIS 740
  ADT write-lock limitation does not affect this manual-save workflow.

## Pilot acceptance

Start by reading the known request/task and comparing the object list with SE09/SE10.
Then select an approved existing test text/row, prepare and guide, save in SAP GUI, and verify.
Repeat with a deliberately stale change set and a partial edit. Never test against business-critical
configuration without the normal business change authorization.

No live SAP access or GUI save was available on the build computer. Live SAP_BASIS 740/client 017
compatibility, actual maintenance routes and transport recording remain pilot acceptance checks.
The ZIP's `VALIDATION.md` records automated coverage and any environmental limitations.

## Source and development

Source and regression tests are included. For development run `npm ci`, `npm run build`,
`npm run typecheck` and `npm test`. The distributed prebuilt runtime needs production dependencies
only; installation uses memory cache so native SQLite compilation is unnecessary.
