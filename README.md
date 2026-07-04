# ClickOff Field Manager

A Chrome extension (Manifest V3) that brings tabbed task views and conditional field visibility to ClickUp. Group custom fields into named tabs per task type — only the fields assigned to the active tab are shown. Presets are stored per workspace × task type, so every task type can have a completely independent layout.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [File Structure](#file-structure)
3. [Storage Schema](#storage-schema)
4. [Content Script — `content/content.js`](#content-script)
5. [Options Panel — `options/options.js`](#options-panel)
6. [Service Worker — `background/service-worker.js`](#service-worker)
7. [Popup — `popup/popup.js`](#popup)
8. [Licensing (Pro)](#licensing-pro)
9. [Pre-publish Checklist](#pre-publish-checklist)

---

## Architecture Overview

```
Chrome icon click
      │
      ▼
Side panel opens (options/options.html)   ◄──── chrome.sidePanel.setPanelBehavior
      │
      │  reads/writes chrome.storage.sync
      │  sends cfm_active_type / cfm_active_tab via chrome.storage.local
      │
      ▼
Content script (content/content.js)       ◄──── injected on app.clickup.com/*
  • Detects task open via URL polling + MutationObserver
  • Reads task type from DOM
  • Loads preset from chrome.storage.sync
  • Injects CFM tab strip into ClickUp task panel
  • Hides/shows fields using CSS classes + inline styles
  • Applies visibility rules on top of tab visibility
      │
      │  chrome.runtime.sendMessage (CLICKUP_API)
      ▼
Service worker (background/service-worker.js)
  • Proxies ClickUp REST API calls (auth token in storage, never in content)
  • Caches responses for 60 s
  • Validates Pro licence key (local passphrase check, no external API)
```

---

## File Structure

```
clickup-field-manager/
├── manifest.json                   MV3 manifest
├── background/
│   └── service-worker.js           API proxy + licence handler
├── content/
│   ├── content.js                  Core extension logic (injected into ClickUp)
│   └── content.css                 CFM styles injected into ClickUp page
├── options/
│   ├── options.html                Side panel + settings UI
│   ├── options.js                  Side panel logic
│   └── options.css                 Side panel styles
├── popup/
│   ├── popup.html                  Legacy popup (kept for reference; not used)
│   ├── popup.js
│   └── popup.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

> **Note:** The popup is no longer used. Clicking the extension icon opens the side panel directly via `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. The popup files are retained but `"default_popup"` is not set in the manifest.

---

## Storage Schema

### `chrome.storage.sync` (synced across Chrome profiles)

| Key | Type | Description |
|-----|------|-------------|
| `apiToken` | `string` | ClickUp Personal API Token |
| `accentColor` | `string` | Hex colour for CFM UI accent (`#7b68ee` default) |
| `licence` | `{ valid: boolean }` | Pro licence state |
| `preset_{workspaceId}_{typeKey}` | `PresetConfig` | Tab/rule preset for one task type in one workspace |
| `fields_{listId}` | `Field[]` | Cached field list for a ClickUp list |
| `cfm_templates` | `Template[]` | Named reusable tab layout templates |

#### `PresetConfig`

```jsonc
{
  "tabs": [
    {
      "id": "tab-abc123",        // UUID
      "name": "Finance",
      "fields": ["field-id-1", "field-id-2", "__s_description"]
    }
  ],
  "rules": [
    {
      "targetFieldId": "field-id-3",
      "action": "hide",          // "hide" | "show"
      "logic": "AND",            // "AND" | "OR"
      "conditions": [
        {
          "fieldId": "field-id-1",
          "operator": "equals",  // "equals" | "not_equals" | "contains" | "is_empty" | "is_not_empty"
          "value": "Approved"
        }
      ]
    }
  ],
  "defaultTab": "tab-abc123"     // null = "All Fields" is default
}
```

#### `Field`

```jsonc
{
  "id": "abc123",                // ClickUp custom field ID, or "__s_*" for structural fields
  "name": "Budget",
  "type": "currency"             // ClickUp field type, or "structural" for built-in sections
}
```

### `chrome.storage.local` (device-only, used for cross-component signalling)

| Key | Type | Description |
|-----|------|-------------|
| `cfm_active_type` | `{ workspaceId, typeKey, typeName, listId }` | Written by content script when a task opens; read by options panel to auto-follow the active task type |
| `cfm_active_tab` | `{ tabId, ts }` | Written by content script when user clicks a CFM tab; options panel auto-selects that tab for field assignment |
| `cfm_notify` | `{ workspaceId, typeKey, ts }` | Written by options panel after saving; triggers content script `onChanged` listener to re-apply config |
| `task_meta_{taskId}` | `{ listId, workspaceId, typeKey, typeName }` | Phase-1 task cache; avoids API round-trip on revisit |

---

## Content Script

**File:** `content/content.js`  
**Injected at:** `document_idle` on `https://app.clickup.com/*`

### Key Constants

| Name | Value | Purpose |
|------|-------|---------|
| `STRUCTURAL_SELECTORS` | array | ClickUp built-in sections (Title, Description, Status, etc.) that can be assigned to tabs |
| `STRUCTURAL_FIELDS` | derived | `STRUCTURAL_SELECTORS` mapped to `Field` objects with `type: 'structural'` |

### State Variables

| Variable | Description |
|----------|-------------|
| `taskCache` | `Map<taskId, { listId, workspaceId, fields }>` — in-memory session cache |
| `activeWorkspaceId` | Workspace ID of the currently open task |
| `activeTaskTypeKey` | Normalised type key, e.g. `"project"`, `"email"` |
| `activeTaskTypeName` | Display name, e.g. `"Project"` |
| `activePresetConfig` | `PresetConfig` for the current task type |

### Core Functions

#### `handleTaskOpen(taskId, panel)`
Main entry point when a ClickUp task is opened.

**Phase 1 (instant):** Reads `task_meta_{taskId}` from local storage → loads preset → renders tab strip immediately with cached data.

**Phase 2 (async):** Calls `fetchTaskFields(taskId)` → calls `getTaskTypeFromDom()` (with 400 ms retry) → normalises type key → loads full preset → rebuilds tab strip → tags all field DOM elements → applies active tab + visibility rules.

#### `fetchTaskFields(taskId)`
Sends `CLICKUP_API` message to service worker for `/task/{id}`. Returns `{ listId, workspaceId, fields }`. Writes result to `task_meta_{taskId}` and `fields_{listId}` in local storage.

#### `getTaskTypeFromDom()`
Reads task type name from the DOM selector `[data-test="cu-task-view-task-label__task-type"]`. The ClickUp API does not expose custom task types — DOM is the only reliable source.

#### `normalizeTypeKey(name)`
Converts a display name to a stable storage key: lowercase, non-alphanumeric runs replaced with `_`, leading/trailing underscores stripped. E.g. `"Client Email"` → `"client_email"`.

#### `presetKey(workspaceId, typeKey)`
Returns `preset_{workspaceId}_{typeKey}` — the `chrome.storage.sync` key for a preset.

#### `loadPreset(workspaceId, typeKey)`
Reads preset from `chrome.storage.sync`. Returns `{ tabs: [], rules: [] }` if none saved.

#### `buildTabStrip(panel, tabs, currentTabId)`
Injects the CFM tab bar into the task panel `<head>` (appended last to win CSS source-order). Renders "All Fields" + one button per tab. Each tab button:
- Has `data-cfm-tab` attribute for click delegation
- Writes `cfm_active_tab` to local storage on click so the options panel auto-follows
- Reads `defaultTab` from config to mark the default with a subtle indicator

#### `tagFieldElements(panel, fields)`
Iterates over every field in the preset and locates its DOM row(s) using `findFieldRow()`. Tags matched rows with `data-cfm-field-id` and records their natural height for CDK viewport clamping.

#### `applyTab(panel, activeTabId, tabs)`
Shows fields belonging to `activeTabId` by removing `cfm-hidden` class; hides all others by adding it. For `__all`, all fields are shown. Also handles structural elements via `applyStructuralVisibility()`.

#### `applyVisibilityRules(panel, fields, rules)`
Evaluates each rule in `activePresetConfig.rules`. Reads current field values from the DOM via `findFieldRow()`, evaluates conditions with AND/OR logic, then hides or shows the target field by toggling `cfm-rule-hidden` class. Runs after `applyTab` — rules apply on top of tab visibility.

#### `scheduleRetries(panel, fields, config)`
Re-runs `tagFieldElements` + `applyTab` + `applyVisibilityRules` at 500 ms, 1500 ms, and 3000 ms after task open, to catch fields that ClickUp renders late via virtual scroll.

#### `reapplyConfig(config)`
Called by the `onChanged` listener when the options panel saves a new preset. Updates `activePresetConfig` and re-renders the tab strip and field visibility without re-fetching the API.

#### `ensureTabStripSpacing(panel)`
Inserts a fixed-height spacer div immediately after the tab strip so the first visible field has breathing room. **Idempotent** — checks whether the spacer already exists before inserting. This is critical: the function is called on every `applyTab` invocation, which is itself triggered by the `MutationObserver`. If the spacer were removed and re-added each call it would create an infinite observer loop (new node added → observer fires → applyTab → spacer re-added → observer fires…). The idempotency check breaks this cycle.

#### `collapseEmptyWrappers(panel)` / `clampCdkViewport(panel)`
Post-tab-switch cleanup that forces ClickUp's CDK virtual scroll viewport to the correct height and hides any section wrappers that contain only hidden fields.

---

## Options Panel

**Files:** `options/options.html`, `options/options.js`, `options/options.css`  
**Opened via:** Chrome side panel (icon click)

### UI Sections

| Section | ID | Description |
|---------|----|-------------|
| Settings | `#settings-section` | Collapsed by default behind ⚙ toggle. Contains token, licence, accent colour. |
| Task Type | `#list-select-section` | Shows active task type banner. Contains field-source list picker (in `<details>`). |
| Tabs | `#tabs-section` | Add/rename/delete tabs. Per-tab default checkbox. "All Fields" default checkbox. |
| Visible in … | `#field-assignment-section` | Field checklist for the selected tab. |
| Visibility Rules | `#rules-section` | Rule builder: target field + action + AND/OR conditions. |
| Templates | `#templates-section` | Save/load/edit/bulk-apply named presets. |

### State Variables

| Variable | Description |
|----------|-------------|
| `currentWorkspaceId` | Workspace ID of the task type being edited |
| `currentTypeKey` | Normalised key for the task type being edited |
| `currentTypeName` | Display name for the task type being edited |
| `currentListId` | List used to fetch available fields (the "field source") |
| `currentFields` | `Field[]` — all fields available for the current list |
| `currentConfig` | `PresetConfig` — the live in-memory preset being edited |
| `selectedTabId` | ID of the tab currently selected in the field-assignment section |
| `isPro` | Boolean — whether Pro licence is active |

### Core Functions

#### `loadTypeContext({ workspaceId, typeKey, typeName, listId })`
Primary function for switching the panel to a new task type. Loads the preset, fetches fields from the list, updates all UI sections.

#### `loadFieldSource(listId)`
Changes the field source list without changing the preset key. Used via the `<details>` field-source picker when the auto-detected list doesn't have all the fields.

#### `savePreset(workspaceId, typeKey, config)`
Writes `PresetConfig` to `chrome.storage.sync` under `presetKey(workspaceId, typeKey)`.

#### `notifyContentScripts(workspaceId, typeKey)`
Writes `cfm_notify` to `chrome.storage.local` so the content script's `onChanged` listener picks up the new preset and re-applies it to any open task.

#### `autoSave()`
Calls `savePreset` + `notifyContentScripts` debounced — triggered after any change to tabs, field assignments, rules, or default checkbox.

#### `renderTabs()`
Re-renders the tabs list. Each tab item includes:
- Tab name (click to select for field assignment)
- Default radio checkbox (mutually exclusive with "All Fields" and other per-tab defaults)
- Delete button

#### `showLicenceState(isPro)`
Toggles `#s-licence-free` / `#s-licence-pro` visibility and updates the module-level `isPro` flag (which gates the 3-tab limit).

### Tab Limit (Free tier)
Free users are limited to **3 tabs per task type**. The `+ Add Tab` button and template-load paths check `isPro` and show an upgrade badge with a link to `https://buymeacoffee.com/dmonahu` when the limit is reached.

### Auto-follow Behaviour

The panel listens to `chrome.storage.onChanged`:

- **`cfm_active_type` changed** → calls `loadTypeContext()` with the new task type. The panel automatically switches to the preset for whatever task is open in ClickUp.
- **`cfm_active_tab` changed** → if `tabId === '__all'`, deselects the active tab. Otherwise, finds the matching tab in `currentConfig.tabs` and opens its field-assignment view.

---

## Service Worker

**File:** `background/service-worker.js`

### Responsibilities

1. **Side panel on icon click** — `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`
2. **ClickUp API proxy** — handles `CLICKUP_API` messages from content script and options panel. Reads `apiToken` from `chrome.storage.sync`, makes the fetch, caches the result for 60 s.
3. **Licence validation** — handles `LICENCE_ACTIVATE`, `LICENCE_CHECK`, `LICENCE_DEACTIVATE` messages.

### Message Types

| Type | Sent by | Payload | Response |
|------|---------|---------|----------|
| `CLICKUP_API` | content script, options panel | `{ path: string }` | `{ data }` or `{ error }` |
| `CLICKUP_INVALIDATE` | content script | `{ path: string }` | (none) |
| `LICENCE_ACTIVATE` | options panel, popup | `{ key: string }` | `{ success: boolean, error?: string }` |
| `LICENCE_CHECK` | options panel, popup | — | `{ isPro: boolean }` |
| `LICENCE_DEACTIVATE` | options panel, popup | — | `{ success: boolean }` |

### API Cache

Responses are cached in a `Map` keyed by path with a 60-second TTL. `CLICKUP_INVALIDATE` removes a single entry (sent by the content script when a task is re-opened to force a fresh field fetch).

---

## Popup

**Files:** `popup/popup.html`, `popup/popup.js`, `popup/popup.css`

The popup is **no longer the primary UI** — clicking the extension icon opens the side panel. The popup HTML/JS is retained as a fallback and reference only; `"default_popup"` is not set in `manifest.json`.

The popup contains:
- ClickUp API token input (save & verify)
- Licence section (activate / deactivate Pro)
- Accent colour picker
- "Open Configuration Panel →" button (opens side panel)
- "↺ Reload ClickUp tab" button (convenience reload for the active ClickUp tab)

---

## Licensing (Pro)

The extension validates keys against a **stateless HMAC endpoint** (Netlify
Function). The signing secret lives only on the server, so valid keys cannot be
forged from the shipped extension code. Full setup, minting, and deployment
instructions are in [`../LICENSING.md`](../LICENSING.md).

### How it works

1. You mint a key with `tools/mint-licence.mjs` (using your server secret) and
   send it to the supporter — e.g. after a Buy Me a Coffee payment.
2. The user enters the key in Settings → Licence → Pro Key.
3. `LICENCE_ACTIVATE` POSTs the key to the Netlify endpoint, which recomputes the
   HMAC signature and returns `{ valid: true/false }`.
4. On success, `{ valid: true, key }` is written to `chrome.storage.sync`.
5. `LICENCE_CHECK` reads that flag offline — no network call on normal loads.

### Payment

Supporters pay via [Buy Me a Coffee](https://buymeacoffee.com/dmonahu). After
payment, mint a key and email it (or automate via a BMC welcome message).

### Revoking a key

Add the key's `id` (the middle segment of `CFM-<id>-<sig>`) to the
`CFM_LICENCE_DENYLIST` env var on Netlify. See `LICENSING.md`.

> **Note:** the `licence.valid` flag is client-side, so a determined user can
> flip it in devtools — true of any in-extension gate. HMAC prevents *forging
> keys*; server-enforced gating would require moving the feature server-side.

---

## Pre-publish Checklist

Before submitting to the Chrome Web Store:

- [ ] `DEV_FORCE_PRO` is `false` in `options/options.js`
- [ ] `LICENCE_ENDPOINT` in `service-worker.js` points to your deployed Netlify site
- [ ] The same Netlify origin is listed in `manifest.json` → `host_permissions`
- [ ] `CFM_LICENCE_SECRET` is set on Netlify and a test key activates end-to-end
- [ ] `manifest.json` version number bumped
- [ ] `icons/` contains all three sizes (16, 48, 128)
- [ ] No `console.log` calls left for sensitive data (API token, licence key)

See [`../PUBLISHING.md`](../PUBLISHING.md) for the full Chrome Web Store submission checklist.
- [ ] Privacy policy URL added to CWS listing (required — extension accesses ClickUp API)
