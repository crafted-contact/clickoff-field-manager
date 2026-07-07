# ClickOff Field Manager

**Tabbed task views and conditional field visibility for ClickUp.**

Some ClickUp tasks have 20, 30, 40 custom fields — and you only need a handful at any given moment. ClickOff gives every task a clean, **tabbed** layout: you group custom fields into named tabs (e.g. *Brief*, *Delivery*, *QA*) and only the fields in the active tab are shown. Each **task type** keeps its own independent layout, so your *Email* tasks and your *Bug* tasks can look completely different.

Free Chrome extension (Manifest V3). Your settings and ClickUp token stay on your device — no analytics, no tracking, no server other than ClickUp.

> ClickOff Field Manager is an independent, third-party browser extension that works with ClickUp. It is not made by, affiliated with, or endorsed by ClickUp.

<!-- screenshots -->

---

## Features

- **Tabbed task views** — group custom fields into named tabs. Only the fields in the active tab are shown; the rest are tucked away.
- **Per task type** — each task type gets its own independent layout, remembered automatically.
- **Conditional visibility** — show or hide a field based on another field's value (e.g. reveal *Rejection reason* only when Status is *Rejected*).
- **Templates** — save a layout once and apply it to other task types or lists.
- **Fast and private** — settings and your ClickUp API token stay on-device. No tracking, nothing sold.
- **Free & unlimited** — all features, unlimited tabs.

---

## Install

This extension is distributed as an unpacked build you load yourself (it may also be on the Chrome Web Store — see Releases).

1. Download the latest `clickoff-field-manager-vX.Y.Z.zip` from the [**Releases**](../../releases) page.
2. Unzip it to a folder you'll keep (Chrome loads it from this location).
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder.

The ClickOff icon appears in your toolbar. Clicking it opens the configuration **side panel**.

> To update later: download the new release, unzip over the same folder (or a new one), then click the **↺ reload** icon on the extension's card at `chrome://extensions`.

---

## Setup — connect your ClickUp account

ClickOff reads your task's custom fields using your own **ClickUp personal API token**. It's created in ClickUp and stays on your device.

1. **Generate the token in ClickUp:** click your avatar (bottom-left) → **Settings** → **Apps** → under *API Token*, click **Generate** (or **Regenerate**). Copy the token — it starts with `pk_`.
2. **Add it to ClickOff:** open a ClickUp task, click the ClickOff toolbar icon to open the side panel, open **⚙ Settings**, paste the token, and click **Save & Verify**. A green confirmation means it's connected.

Then open a task and start building tabs for its task type. Switch tabs to reveal exactly the fields you need.

---

## Privacy

- Your **ClickUp API token is stored on your device only** (`chrome.storage.local`) and is never sent to the developer or any third party.
- The extension **contacts no server other than ClickUp** (`api.clickup.com`), and only using your own token to read the current task's fields.
- Your tab/field configuration is stored in Chrome storage (synced to your own Chrome profile). No analytics, no tracking.

**That's the whole policy.** ClickOff has no backend and collects nothing, so there's nothing else to disclose.

---

## Support

ClickOff is **completely free** — all features, unlimited tabs. If it saves you time, an optional tip is always welcome:

☕ **[Buy me a coffee](https://buymeacoffee.com/dmonahu)** (also linked in the side panel under ⚙ Settings → Support this project)

Bugs and feature requests: please open a GitHub [issue](../../issues). Or email **david@craftedcontact.com**.

---

## Trademark

"ClickUp" is a trademark of Mango Technologies, Inc. Used here only to describe compatibility. ClickOff is an independent product and is not affiliated with, sponsored by, or endorsed by ClickUp.

---

## Development

Contributions welcome. The extension is vanilla JS (no build step) — load it unpacked (see [Install](#install)) and edit the source directly. After a code change, reload the extension at `chrome://extensions` and hard-refresh the ClickUp tab.

Architecture and internals are documented below.

### Architecture Overview

```
Chrome icon click
      │
      ▼
Side panel opens (options/options.html)   ◄──── chrome.sidePanel.setPanelBehavior
      │
      │  reads/writes chrome.storage
      │  sends cfm_active_type / cfm_active_tab / cfm_notify via chrome.storage.local
      │
      ▼
Content script (content/content.js)       ◄──── injected on app.clickup.com/*
  • Detects task open via URL polling + MutationObserver
  • Reads task type from DOM
  • Loads preset from chrome.storage.sync
  • Injects the CFM tab strip into the ClickUp task panel
  • Hides/shows fields via data attributes + injected CSS
  • Applies conditional visibility rules on top of tab visibility
      │
      │  chrome.runtime.sendMessage (CLICKUP_API)
      ▼
Service worker (background/service-worker.js)
  • Proxies ClickUp REST API calls (auth token in storage, never in the page)
  • Caches responses for ~60 s
```

### File Structure

```
clickup-field-manager/
├── manifest.json                   MV3 manifest
├── background/
│   └── service-worker.js           ClickUp API proxy
├── content/
│   ├── content.js                  Core logic (injected into ClickUp)
│   └── content.css                 Styles injected into the ClickUp page
├── options/
│   ├── options.html                Side panel + settings UI
│   ├── options.js                  Side panel logic
│   └── options.css                 Side panel styles
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

> Clicking the extension icon opens the side panel directly via `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.

### Storage Schema

#### `chrome.storage.sync` (synced across the user's Chrome profiles)

| Key | Type | Description |
|-----|------|-------------|
| `accentColor` | `string` | Hex colour for the UI accent (`#7b68ee` default) |
| `preset_{workspaceId}_{typeKey}` | `PresetConfig` | Tab/rule preset for one task type in one workspace |
| `fields_{listId}` | `Field[]` | Cached field list for a ClickUp list |
| `cfm_templates` | `Template[]` | Named, reusable tab-layout templates |

#### `chrome.storage.local` (device-only)

| Key | Type | Description |
|-----|------|-------------|
| `apiToken` | `string` | ClickUp personal API token — device-only, never synced or sent to the developer |
| `cfm_active_type` | `{ workspaceId, typeKey, typeName, listId }` | Written by the content script when a task opens; the panel auto-follows the active task type |
| `cfm_active_tab` | `{ tabId, ts }` | Written when the user clicks a CFM tab; the panel auto-selects that tab |
| `cfm_notify` | `{ workspaceId, typeKey, ts }` | Written by the panel after saving; the content script's `onChanged` listener re-applies config |
| `task_meta_{taskId}` | `{ listId, workspaceId, typeKey, typeName }` | Phase-1 task cache; avoids an API round-trip on revisit |

#### `PresetConfig`

```jsonc
{
  "tabs": [
    { "id": "tab-abc123", "name": "Finance", "fieldIds": ["field-id-1", "__s_description"] }
  ],
  "rules": [
    {
      "targetFieldId": "field-id-3",
      "action": "hide",              // "hide" | "show"
      "logic": "AND",                // "AND" | "OR"
      "conditions": [
        { "fieldId": "field-id-1", "operator": "equals", "value": "Approved" }
      ]
    }
  ],
  "defaultTab": "tab-abc123"         // null = "All Fields" is default
}
```

#### `Field`

```jsonc
{
  "id": "abc123",      // ClickUp custom field ID, or "__s_*" for a structural (built-in) section
  "name": "Budget",
  "type": "currency"   // ClickUp field type, or "structural" for built-in sections
}
```

### Content Script — `content/content.js`

Injected at `document_idle` on `https://app.clickup.com/*`.

- **`handleTaskOpen(taskId, panel)`** — entry point when a task opens. *Phase 1:* reads `task_meta_{taskId}` and renders the tab strip instantly from cache. *Phase 2:* fetches fields from the API, reads the task type from the DOM, loads the full preset, tags field rows, and applies the active tab + rules.
- **`tagFieldElements(panel, fields)`** — locates each field's DOM row and tags it with `data-cfm-field-id`. Includes a **self-healing** integrity check: if a tagged row no longer carries the field's UUID or its name label, the stale tag is cleared and the row re-tagged (guards against DOM node reuse).
- **`applyTab(panel, activeTabId, tabs)`** — hides tagged rows not in the active tab via `data-cfm-tab-hidden`; `__all` shows everything. Structural sections are handled via injected CSS in `applyStructuralVisibility`.
- **`applyVisibilityRules(panel, fields, rules)`** — evaluates AND/OR conditions against current field values and hides/shows the target field. Runs on top of tab visibility.
- **`scheduleRetries` / `setupPanelObserver`** — re-tag and re-apply as ClickUp renders fields lazily (retry schedule + a debounced `MutationObserver`).
- **`ensureTabStripSpacing(panel)`** — inserts a spacer after the tab strip. **Idempotent** — it only inserts if absent, which is critical: it's called on every `applyTab`, itself triggered by the observer, so re-adding a node each call would create an infinite loop.

### Options Panel — `options/options.js`

The side panel (`options/options.html`), opened on icon click.

- **`loadTypeContext({ workspaceId, typeKey, typeName, listId })`** — switches the panel to a task type: loads its preset, fetches the list's fields, renders all sections.
- **`savePreset(workspaceId, typeKey, config)`** — writes `PresetConfig` to `chrome.storage.sync` under `preset_{workspaceId}_{typeKey}`.
- **`autoSave()`** — debounced `savePreset` + a `cfm_notify` write so any open task re-applies immediately.
- The panel auto-follows the open task via `chrome.storage.onChanged` on `cfm_active_type` / `cfm_active_tab`.

### Service Worker — `background/service-worker.js`

- Opens the side panel on icon click.
- Proxies ClickUp API calls (`CLICKUP_API` messages): reads `apiToken` from storage, fetches, and caches responses (~60 s TTL). The token never enters the page context.

### Contributing

Issues and pull requests are welcome. For anything user-facing, please describe the ClickUp task type and fields involved so it can be reproduced.
