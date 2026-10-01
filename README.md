# My IT Process → LMX Migration Assistant

The My IT Process → LMX Migration Assistant is a Chromium extension that reads My IT Process Alignment reviews and creates corresponding Lifecycle Manager X (LMX) assessments.

Current release: `1.0.71`

## What the tool does today

### Alignment review discovery

- Reads Alignment reviews from the My IT Process Alignment list.
- Supports paginated review lists and displays 20 reviews per popup page.
- Shows the My IT Process client, assessment name, Engineer Review status, and vCIO Review status.
- Simplifies duplicated client names when displaying or creating assessments.
- Preserves the source review ID and opens the direct assessment route for extraction.

### Client matching

- Loads the LMX client directory through the ScalePad API.
- Automatically matches clients by normalized name.
- Allows manual LMX client search and mapping when no automatic match exists.
- Allows an existing mapping to be changed or removed before migration.

### Review filtering and selection

- Filters reviews by migration state:
  - All reviews
  - Ready to migrate
  - Needs client match
  - Needs retry
  - Migrated
- Provides a minimum Engineer completion slider from 0% to 100%.
- Defaults to 0%, so all reviews remain available.
- Updates review counts, table rows, and pagination as the slider changes.
- Saves checkbox selections by source review ID while moving between pages.

### Assessment and template migration

For each selected, mapped review, the extension:

1. Opens the direct My IT Process assessment page.
2. Reads the rendered categories and questions.
3. Reads Engineer responses, vCIO/alignment responses, and Technical Analysis text.
4. Verifies the expected question count before writing to LMX.
5. Finds or creates a mirrored LMX assessment template.
6. Reuses an existing matching assessment when possible to avoid duplicates.
7. Creates the LMX assessment for the mapped client.
8. Applies responses to LMX in batches.
9. Writes source-context internal comments.
10. Leaves the assessment in progress when source reviews are incomplete.
11. Marks the LMX assessment complete only when both source reviews are complete and no migration warnings remain.

### Template layout

Mirrored Alignment items are rendered in LMX as:

```text
FS - Share Names | Do we have the names of each share documented?
```

The question is part of the item title instead of appearing as a separate description. LMX still receives a required neutral description so the API accepts the template.

### Response mapping

| My IT Process response | LMX criterion |
| --- | --- |
| Yes / Aligned | Satisfactory |
| Marginal | Needs Attention |
| No / Vulnerable | At Risk |
| N/A | Not Applicable |

The mirrored template also supports the My IT Process labels where the LMX template permits them.

### Internal comments

Assessment-level comments include the source reviewers when available:

```text
Engineer Review: Kevin Jones
vCIO Review: David Jarrett
```

Question-level comments include only selected source context, for example:

```text
How well aligned is this answer with your best practices? Aligned
Technical Analysis: Cloud-based environment
```

Unselected options such as Marginal, Vulnerable, and N/A are not copied into comments.

### Migration progress and recovery

- Displays a migration progress page with the selected client table, live log, and migration summary.
- Shows per-assessment success, warnings, failed creation, and retryable states.
- Allows failed or partial migrations to be retried.
- Expands migration summaries to show extracted counts, written answers, warnings, and unmatched items.
- Leaves failed extraction tabs open for inspection.
- Does not delete the source My IT Process review.

## Settings

The popup settings area supports:

- LMX API key entry and connection status.
- LMX evaluating-user selection.
- Current mirrored-template status.
- Extension version display.
- Author attribution: Tulsie Narine | Sr. Solutions Engineer | ScalePad

The API key is stored in Chrome extension storage and sent to the ScalePad API using the `x-api-key` header.

## Installation for development

1. Open `chrome://extensions` in Chromium.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `extension/` directory.
5. Open My IT Process Alignment and reload the extension after code changes.

## Project structure

```text
extension/
├── manifest.json          Chrome extension manifest
├── src/popup.html         Popup interface
├── src/popup.js           Filtering, selection, matching, and migration launch
├── src/background.js      API calls, migration orchestration, retries, and storage
├── src/content-script.js  My IT Process DOM extraction
├── src/mapping.js         Shared migration mapping helpers
├── migration.html         Migration progress interface
├── migration.js           Progress and summary rendering
└── icons/                 Application icons
```

## Current limitations

- The extension depends on the rendered My IT Process Alignment DOM and may need updates if My IT Process changes its page structure.
- The completion slider filters on Engineer Review completion because Engineer responses are the primary response source for migration.
- Existing LMX comments and assessments are not automatically rewritten when a later extension version changes formatting.
- The tool requires an authenticated My IT Process browser session and a valid LMX API key.
- Roadmap/IT Plan migration is present in the codebase but is not currently exposed in the popup workflow.

## Validation

The project currently validates JavaScript and manifest syntax with:

```bash
node --check extension/src/popup.js
node --check extension/src/content-script.js
node --check extension/src/background.js
jq empty extension/manifest.json
```
