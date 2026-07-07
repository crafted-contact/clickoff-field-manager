# Changelog

All notable changes to **ClickOff Field Manager** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses [semantic versioning](https://semver.org/).

## [1.0.1] — 2026-07-08

### Added
- **Self-healing field tags.** Each tagging pass now verifies that a tagged
  custom-field row still matches its recorded field — the row must still carry
  the field's UUID in an attribute *or* still show the field's name as its label.
  If neither holds, the stale tag is cleared and the row is re-tagged to its
  current field. This hardens against a previously reported symptom where two
  fields (e.g. *Client Notes* and *Review Date*) could appear to show/hide each
  other's row. The original trigger was Angular CDK virtual-scroll **row
  recycling** reusing a DOM node for a different field while our tag stuck to the
  node; ClickUp's current v4 layout renders all rows at once and no longer
  recycles, so the bug is not reproducible today — but this check guarantees the
  class of bug cannot recur if ClickUp reuses row nodes again or across task
  navigation. The check is conservative (never clears a valid tag) and idempotent.

## [1.0.0] — 2026-07-05

First public release.

### Fixed
- **Task URL parsing.** ClickUp changed task URLs to `/t/{workspaceId}/{taskId}`.
  The old regex captured the workspace ID instead of the task ID, so every API
  lookup failed and no tab strip rendered. Parsing now handles both the old
  (`/t/{taskId}`) and new formats, and also captures hyphenated **custom task
  IDs** (e.g. `PROJ-123`).
- **Custom task IDs now resolve.** API calls for a custom-ID task automatically
  include `custom_task_ids=true&team_id=…` (derived from the URL). The fetch and
  the cache-invalidate signal share one path builder so they can't drift.
- **Silent API failures.** `handleTaskOpen` swallowed every error, so an expired
  token or a bad response failed invisibly. Failures are now logged
  (`[ClickOff] task setup failed: …`).
- **403 misreported as an expired token.** A 403 (valid token, no access to a
  specific resource) no longer raises the "token expired" banner — only a true
  401 does. This fixes a banner that could not be cleared by re-entering a token.
- **Token re-entry could wipe a working token.** The old flow saved the new
  token before verifying and deleted it on failure — clobbering any previously
  valid token. A new `VERIFY_TOKEN` path validates a candidate against `/user`
  first and only persists on success.
- **`hidden` attribute defeated by `display`.** Elements styled `display: flex`
  (the auth banner, type-context banner, quick-template row, template-edit
  banner) could never be hidden, because an author `display` value overrides the
  UA `[hidden] { display: none }`. Added a global `[hidden] { display: none
  !important }` so the attribute is always authoritative.

### Added
- **Auth-error banner.** When the ClickUp API returns 401, the side panel shows
  a clear "token expired — re-verify" banner with a one-click **Fix token**
  button. It self-heals: on open it silently probes `/user`, and any successful
  API call clears the flag automatically.

### Changed
- **Now free and unrestricted.** Removed the 3-tab free limit and the entire Pro
  licence flow. All features are available to everyone; support is optional via a
  Buy Me a Coffee link in Settings. (The prior HMAC licence system is kept in git
  history on `main` should a paid tier ever return.)
- **API token moved to `chrome.storage.local`.** A ClickUp personal token grants
  full account access; it no longer syncs through the user's Google account.
  A one-time migration moves any token left in `storage.sync` to `local`
  transparently, so existing users are not signed out.

### Removed
- **Dead `popup/` directory** and the `scripting` permission it was the sole user
  of. The extension icon has opened the side panel directly since the popup was
  superseded; permissions are now just `storage` + `sidePanel`.
- **Licence UI, handlers, and the `clickoffext.netlify.app` host permission.** The
  extension now makes no network requests other than to ClickUp.

## [0.1.0] — 2026-05-21

Initial internal build.

- MV3 scaffold: content script, background service worker, options side panel.
- Tabbed task views: group custom fields into named tabs per workspace × task type.
- Conditional field visibility rules (AND/OR).
- Templates and bulk-apply across lists.
- Passphrase-based Pro licence (single shared key).
