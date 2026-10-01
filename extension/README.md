# My IT Process to LMX

Current extension version: `1.0.71`.

For the complete workflow, current feature list, installation instructions,
project structure, mappings, and limitations, see the project-level
[`README.md`](../README.md).

A migration utility for Chromium-based browsers that migrates My IT Process
Alignment reviews into Lifecycle Manager X (LMX) assessments.

## Current workflow

1. Open My IT Process Alignment at `https://new.live.myitprocess.com/alignment`.
2. Open the extension popup. It reads all Alignment review pages and presents
   them 20 at a time, including client name, review title, Engineer status, and
   vCIO status.
3. The extension loads the accessible LMX client directory and displays exact
   automatic matches.
   If a match is not found, search LMX manually and choose the correct client.
4. Select one or more matched reviews across the popup pages and start migration.

Successfully migrated reviews are remembered by review ID and skipped on later
migration attempts to prevent duplicate LMX assessments.
5. The extension opens each selected review, extracts its categories, questions,
   responses, and Technical Analysis comments, then creates an LMX assessment.

All reviews can be migrated:

- If both Engineer and vCIO reviews are complete, the LMX assessment is marked
  completed.
- If either review is incomplete, the LMX assessment remains in progress.

## Alignment mapping

| My IT Process | LMX |
| --- | --- |
| Yes | Satisfactory |
| No | AtRisk |
| N/A | NotApplicable |
| Technical Analysis | Private question comment |

The Alignment template is reused when its stored structure fingerprint matches
the current Alignment question structure. If My IT Process changes the
questionnaire, the extension creates a new versioned mirrored template instead
of silently using an outdated template.

## LMX API

The extension requires an LMX API key, stored locally in Chrome and sent only
to `https://api.scalepad.com` using the `x-api-key` header.

The assessment workflow uses the Lifecycle Manager API to:

- Search clients
- List, retrieve, and create assessment templates
- Create assessments
- Set question responses in bulk
- Save private question comments
- Set assessment completion status

The Roadmap/IT Plan migration is currently hidden from the popup while the
Alignment migration is being rebuilt.

## Install for testing

1. Open `chrome://extensions` in Chromium.
2. Enable Developer mode.
3. Select **Load unpacked** and choose this `extension/` folder.
4. Open My IT Process Alignment and reload the extension after code changes.

## Implementation notes

- The extension reads rendered Alignment DOM content; it does not access My IT
  Process authentication or private browser storage.
- The Alignment list is paginated. The content script walks the available pages
  and returns the review records to the popup, which displays 20 per page.
- Review selections are saved by review ID, so changing popup pages does not
  clear earlier selections.
- An individual review can render categories incrementally. The extractor walks
  the category navigation so the mirrored template includes the full review.
- Before migration, the extracted question count is checked against the counts
  shown in the Alignment category navigation; incomplete extractions are stopped.
- Selected reviews are opened in background tabs during migration, extracted,
  and closed after their data is read.
