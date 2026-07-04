// ClickUp Field Manager — content script
// Runs on app.clickup.com. All logic is in this one file (MV3 content scripts
// cannot use ES module imports).

// ---------------------------------------------------------------------------
// Safe chrome API wrappers
//
// When the extension is reloaded while a tab is still open the content script
// keeps running but the extension context is invalidated — any chrome.* call
// will throw or return a rejected Promise. These helpers swallow those errors
// silently so they don't show up as "Uncaught" in chrome://extensions/errors.
// ---------------------------------------------------------------------------
function safeSet(data) {
  try { chrome.storage.local.set(data).catch(() => {}); } catch (_) {}
}

function safeGet(key) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(key, r => resolve(r ?? {}));
    } catch (_) {
      resolve({});
    }
  });
}

// ---------------------------------------------------------------------------
// In-memory task cache — avoids re-fetching API when the user navigates back
// to a task they've already opened this session.
// ---------------------------------------------------------------------------
const taskCache = new Map(); // taskId → { listId, workspaceId, fields }

// ---------------------------------------------------------------------------
// Structural elements — tagged by selector, not by text label.
// These represent the major sections of a task view (title, description, etc.)
// and can be assigned to tabs just like custom fields.
// ---------------------------------------------------------------------------
// Each entry may include an optional `hideSels` array of additional CSS
// selectors to hide alongside the primary `sel`. This covers companion
// widgets that live outside the primary element but should be hidden together
// (e.g. the Track Time "▶ Start" button which is a sibling of the label row).
const STRUCTURAL_SELECTORS = [
  { id: '__s_brain',        name: 'Brain AI Bar',         sel: 'cu-brain-command-bar-at-location' },
  { id: '__s_tasktype',     name: 'Task Type',            sel: '[data-test="cu-task-view-task-label__task-type"]' },
  { id: '__s_title',        name: 'Task Title',           sel: 'cu-task-title' },
  { id: '__s_status',       name: 'Status',               sel: '[data-test="task-field-label-icon__container-Status"]' },
  { id: '__s_assignees',    name: 'Assignees',            sel: '[data-test="task-field-label-icon__container-Assignees"]' },
  { id: '__s_dates',        name: 'Dates',                sel: '[data-test="task-field-label-icon__container-Dates"]' },
  { id: '__s_priority',     name: 'Priority',             sel: '[data-test="task-field-label-icon__container-Priority"]' },
  // Track Time: hides both the label/timer row and the standalone Start button.
  // The Start button is a sibling of the label container so we target it
  // separately via hideSels rather than relying on DOM walking.
  { id: '__s_tracktime',    name: 'Track Time',           sel: '[data-test="task-field-label-icon__container-Track time"]',
    hideSels: [
      '[data-test="task-field-label-icon__container-Track time"]',
      'cu-task-time-tracker',
      'cu-task-view-time-tracker',
      '[data-test="task-time-tracking-button"]',
      '[data-test="time-tracker"]',
    ]
  },
  // Tags and Time Estimate: hero-section property icons. These have no CDK
  // virtual-scroll rows of their own, so they need structural selectors here
  // to be show/hide-able from the options panel.
  { id: '__s_tags',         name: 'Tags (header)',        sel: '[data-test="task-field-label-icon__container-Tags"]' },
  { id: '__s_timeestimate', name: 'Time Estimate (header)', sel: '[data-test="task-field-label-icon__container-Time estimate"]',
    hideSels: [
      '[data-test="task-field-label-icon__container-Time estimate"]',
      '[data-test="task-field-label-icon__container-Time Estimate"]',
    ]
  },
  { id: '__s_more',         name: 'More',                 sel: '[data-test="task-field-label-icon__container-More"]' },
  { id: '__s_collapsed',    name: 'Collapsed Properties', sel: 'cu-task-hero-section-collapsed' },
  // Description: ClickUp collapses this component in multiple layers when it
  // detects the host is hidden (via IntersectionObserver / ResizeObserver).
  // Confirmed collapse chain — ClickUp uses display:none (class-based, no inline
  // styles) on ALL of these layers simultaneously:
  //   1. .content-container                          (depth 0)
  //   2. cu-task-view-content-description            (depth 1, Angular component)
  //   3. .content-description-body                   (depth 2)
  //   4. anonymous DIV (no class) inside body        (depth 3) ← content wrapper
  //   5. cu-task-editor                              (depth 4, Quill host)
  //   6. .cu-editor-wrapper                          (depth 5) ← Angular "collapsed" flag ★
  //   7. .cu-editor-content                          (depth 6) ← Angular content container ★
  //   8. .ql-container                               (depth 7, Quill container)
  //   9. .ql-editor                                  (depth 8, Quill content div)
  // Layers 6 & 7 (.cu-editor-wrapper and .cu-editor-content) are the key ones:
  // they remain display:none even after the host is re-shown, keeping the Quill
  // editor collapsed and scrollHeight at 0 despite innerHTML being present.
  // We force ALL layers back to display:block AND height:auto when the tab
  // includes Description, overriding both hiding axes all the way to Quill.
  { id: '__s_description',  name: 'Description',          sel: 'cu-task-view-task-content-description-expanded-collapsed',
    restoreSels: [
      'cu-task-view-task-content-description-expanded-collapsed .content-container',
      'cu-task-view-task-content-description-expanded-collapsed cu-task-view-content-description',
      'cu-task-view-task-content-description-expanded-collapsed .content-description-body',
      'cu-task-view-task-content-description-expanded-collapsed .content-description-body > div',
      'cu-task-view-task-content-description-expanded-collapsed cu-task-editor',
      'cu-task-view-task-content-description-expanded-collapsed .cu-editor-wrapper',
      'cu-task-view-task-content-description-expanded-collapsed .cu-editor-content',
      'cu-task-view-task-content-description-expanded-collapsed .ql-container',
      'cu-task-view-task-content-description-expanded-collapsed .ql-editor',
    ] },
  { id: '__s_relations',    name: 'Relations',            sel: 'cu-task-view-relationships-section' },
  { id: '__s_checklists',   name: 'Checklists',           sel: 'cu-task-view-checklists-section' },
  { id: '__s_subtasks',     name: 'Subtasks',             sel: 'cu-task-view-subtasks-section' },
  { id: '__s_attachments',  name: 'Attachments',          sel: 'cu-task-view-attachments-section' },
  { id: '__s_comments',     name: 'Comments',             sel: 'cu-quill-rich-editor-comments' },
];

const STRUCTURAL_FIELDS = STRUCTURAL_SELECTORS.map(({ id, name }) => ({
  id, name, type: 'structural', value: '',
}));

// Returns an element's full natural height including its own margins.
// Recorded once at tag time (when the element is visible) so applyTab can
// clip the CDK viewport without re-measuring display:none elements.
function recordedH(el) {
  const r = el.getBoundingClientRect();
  const s = window.getComputedStyle(el);
  return r.height + (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0);
}

// ---------------------------------------------------------------------------
// findStructuralWrapper
//
// The fundamental insight: Angular component host elements should NOT have
// DOM attributes set on them directly — it triggers Angular change detection
// and causes components to re-render unexpectedly. But a plain <div> wrapper
// is safe to show/hide via data-cfm-tab-hidden.
//
// This function walks UP from a structural component element and looks for
// the nearest plain-HTML-element ancestor that contains ONLY this structural
// field (and its companion widgets) and nothing else we care about. If found,
// we tag THAT instead of the component — which means:
//   • data-cfm-tab-hidden is set on a plain div (safe, no Angular reaction)
//   • companion elements (e.g. Track Time "Start" button) are inside the same
//     wrapper and are hidden automatically
//   • no guessing, no walking on every tab switch, no side-effects
//
// Returns the wrapper element to tag, or the original component if no suitable
// plain wrapper exists (caller will use CSS injection as a fallback).
// ---------------------------------------------------------------------------
function findStructuralWrapper(componentEl, panel) {
  // All Angular component selectors we know about. If we find any of these
  // inside a candidate wrapper, the wrapper is too broad — it contains other
  // structural fields and we must not collapse it.
  const allSels = STRUCTURAL_SELECTORS.map(s => s.sel);

  let node = componentEl.parentElement;
  for (let depth = 0; depth < 8; depth++) {
    if (!node || node === panel || node === document.body) break;

    // Only consider plain HTML elements (not Angular component host elements).
    // Angular components have hyphenated tag names. We walk THROUGH them
    // without touching them, continuing up to find a plain ancestor.
    if (node.tagName.includes('-')) {
      node = node.parentElement;
      continue;
    }

    // Plain element found. Check whether it contains any OTHER structural
    // component besides the one we started from.
    const containsOtherStructural = allSels.some(sel => {
      const found = node.querySelector(sel);
      // `found` must exist, must not be our starting component, and must not
      // be a descendant of our component (some components nest sub-components).
      return found && found !== componentEl && !componentEl.contains(found);
    });

    if (containsOtherStructural) {
      // This wrapper holds multiple structural fields — tagging it would be
      // too coarse. Fall back to the component element itself.
      break;
    }

    // This plain element wraps only our structural field. Use it.
    return node;
  }

  // No suitable plain wrapper found — fall back to the component itself.
  // applyTab will use CSS injection for this element (data-cfm-struct-css).
  return componentEl;
}

// Tracks structural IDs whose elements are Angular component hosts that cannot
// safely have DOM attributes set on them. applyStructuralVisibility reads this
// Set directly — no DOM attribute is ever set on the Angular elements.
const _structuralCssIds = new Set();

// Structural IDs that must ALWAYS use CSS injection (never the plain-wrapper
// data-attribute path). Hiding ANY ancestor of these components via
// display:none — even a plain div wrapper — triggers ClickUp's
// IntersectionObserver, which collapses the Angular component internally.
// Once collapsed, removing display:none leaves the component at height:0 and
// the restoreRules cannot run because the ID was never added to
// _structuralCssIds. Forcing CSS injection guarantees restoreRules always fire.
const ALWAYS_CSS_INJECT = new Set(['__s_description']);

function tagStructuralElements() {
  if (!activePanel) return;

  for (const { id, name, sel } of STRUCTURAL_SELECTORS) {
    const componentEl = document.querySelector(sel);
    if (!componentEl) continue;

    // For IDs in ALWAYS_CSS_INJECT, skip the wrapper search entirely and
    // treat the component element itself as requiring CSS injection.
    const forceCSS = ALWAYS_CSS_INJECT.has(id);
    const target = forceCSS ? componentEl : findStructuralWrapper(componentEl, activePanel);
    const needsCss = forceCSS || (target === componentEl && target.tagName.includes('-'));

    // If description just appeared in the DOM for the first time (wasn't in
    // _structuralCssIds before), reset the nudge flag so the next applyTab
    // call will fire the IntersectionObserver expand cycle.
    if (id === '__s_description' && needsCss && !_structuralCssIds.has(id)) {
      _descPrevInTab = false;
    }

    if (needsCss) {
      // Angular component host (or force-CSS entry) — set ZERO attributes on it.
      // Record the need for CSS injection in a plain JS Set that Angular
      // can never observe or react to.
      _structuralCssIds.add(id);
      // Remove any stale DOM tags for this ID from previous runs where a
      // plain wrapper was found but is now gone.
      activePanel.querySelectorAll(`[data-cfm-field-id="${id}"]`).forEach(el => {
        el.removeAttribute('data-cfm-field-id');
        el.removeAttribute('data-cfm-field-name');
        el.removeAttribute('data-cfm-natural-h');
        el.removeAttribute('data-cfm-tab-hidden');
      });
    } else {
      // Plain element wrapper — safe to tag and use data-cfm-tab-hidden.
      _structuralCssIds.delete(id);
      // Remove stale tags pointing to old wrappers.
      activePanel.querySelectorAll(`[data-cfm-field-id="${id}"]`).forEach(el => {
        if (el === target) return;
        el.removeAttribute('data-cfm-field-id');
        el.removeAttribute('data-cfm-field-name');
        el.removeAttribute('data-cfm-natural-h');
        el.removeAttribute('data-cfm-tab-hidden');
      });
      target.dataset.cfmFieldId   = id;
      target.dataset.cfmFieldName = name;
      const h = recordedH(target);
      if (h > 0) target.dataset.cfmNaturalH = h;
    }
  }
}

// ---------------------------------------------------------------------------
// API helper — proxies through the background service worker to avoid CORS
// ---------------------------------------------------------------------------
function apiGet(path) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'CLICKUP_API', path }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response) return reject(new Error('No response from service worker'));
        if (response.error) return reject(new Error(response.error));
        resolve(response.data);
      });
    } catch (err) {
      reject(err); // extension context invalidated — caller's .catch() handles it
    }
  });
}

// ---------------------------------------------------------------------------
// Task ID extraction from URL
// ---------------------------------------------------------------------------
function getTaskIdFromUrl(url = location.href) {
  // ClickUp URL formats:
  //   /t/{taskId}                (old)
  //   /t/{workspaceId}/{taskId}  (new — workspace id is numeric)
  // The task segment is normally ClickUp's native alphanumeric id (e.g.
  // "86b8c3pej") but a custom task id (e.g. "PROJ-123") can also appear, so the
  // captured segment allows hyphens.
  const match = url.match(/\/t\/(?:[0-9]+\/)?([a-z0-9-]+)/i);
  return match ? match[1] : null;
}

// The numeric workspace (team) id from the new-style URL, or null on old URLs.
function getWorkspaceIdFromUrl(url = location.href) {
  const match = url.match(/\/t\/([0-9]+)\/[a-z0-9-]+/i);
  return match ? match[1] : null;
}

// Build the /task API path for a given task id. Custom task ids (which contain a
// hyphen) only resolve when custom_task_ids=true and the team_id is supplied.
// Both the fetch and the cache-invalidate signal must use this same string.
function taskApiPath(taskId) {
  let path = `/task/${taskId}?include_subtasks=false`;
  if (taskId.includes('-')) {
    const workspaceId = getWorkspaceIdFromUrl();
    if (workspaceId) path += `&custom_task_ids=true&team_id=${workspaceId}`;
  }
  return path;
}

// ---------------------------------------------------------------------------
// findTaskPanel — tries a sequence of increasingly broad selectors.
// ClickUp uses hashed React class names that change with deployments, so we
// use structural and semantic signals in priority order.
// ---------------------------------------------------------------------------
function findTaskPanel() {
  return (
    document.querySelector('cu-task-view-task-content') ||
    document.querySelector('.cu-task-view__main') ||
    document.querySelector('.cu-task-view__container') ||
    document.querySelector('[data-test="task-detail"]') ||
    document.querySelector('[data-test="task-view"]') ||
    document.querySelector('.cu-task-detail__main') ||
    document.querySelector('.cu-task-detail') ||
    null
  );
}

// Waits for the task panel DOM node to appear, polling with a MutationObserver
// then falling back to intervals. Resolves as soon as the panel is found.
function waitForTaskPanel(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const panel = findTaskPanel();
    if (panel) return resolve(panel);

    const deadline = Date.now() + timeoutMs;

    const obs = new MutationObserver(() => {
      const p = findTaskPanel();
      if (p) { obs.disconnect(); resolve(p); }
      else if (Date.now() > deadline) { obs.disconnect(); resolve(null); }
    });

    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(findTaskPanel()); }, timeoutMs);
  });
}

// Waits until at least some field label elements have rendered inside the panel.
function waitForFieldsToRender(panel, knownFieldNames, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const nameSet = new Set(knownFieldNames.map(n => normalizeText(n)));

    function hasAnyFieldLabel() {
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (nameSet.has(normalizeText(node.textContent))) return true;
      }
      return false;
    }

    if (hasAnyFieldLabel()) return resolve();

    const deadline = Date.now() + timeoutMs;
    const obs = new MutationObserver(() => {
      if (hasAnyFieldLabel()) { obs.disconnect(); resolve(); }
      else if (Date.now() > deadline) { obs.disconnect(); resolve(); }
    });

    obs.observe(panel, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(); }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// fetchTaskFields — returns { listId, workspaceId, fields[] } from the ClickUp API.
// ---------------------------------------------------------------------------
async function fetchTaskFields(taskId) {
  if (taskCache.has(taskId)) return taskCache.get(taskId);

  const task = await apiGet(taskApiPath(taskId));

  const builtIn = [
    { id: '__status',        name: 'Status',        type: 'status',    value: task.status?.status ?? '' },
    { id: '__assignees',     name: 'Assignees',     type: 'assignees', value: (task.assignees ?? []).map(a => a.username).join(', ') },
    { id: '__due_date',      name: 'Due Date',      type: 'date',      value: task.due_date ?? '' },
    { id: '__priority',      name: 'Priority',      type: 'priority',  value: task.priority?.priority ?? '' },
    { id: '__tags',          name: 'Tags',          type: 'tags',      value: (task.tags ?? []).map(t => t.name).join(', ') },
    { id: '__time_estimate', name: 'Time Estimate', type: 'time',      value: task.time_estimate ?? '' },
  ];

  const custom = (task.custom_fields ?? []).map(f => ({
    id: f.id,
    name: f.name,
    type: f.type,
    value: f.value ?? '',
  }));

  const result = {
    listId:      task.list?.id,
    workspaceId: String(task.team_id ?? ''),
    fields:      [...builtIn, ...custom],
  };
  taskCache.set(taskId, result);
  return result;
}

// ---------------------------------------------------------------------------
// Text normalisation — collapses all whitespace variants to a single space.
// Handles non-breaking spaces ( ) that ClickUp occasionally injects.
// ---------------------------------------------------------------------------
function normalizeText(str) {
  return str.replace(/[\s ]+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// findFieldRow — climbs the DOM from a starting element until it finds the
// full field row (label + value together).
//
// Two-pass strategy:
//
//  Pass 1 (preferred): look for an element that is ≥ 45 % of the panel width
//  AND lives in a sibling list (parent.children ≥ 2). This targets field-row
//  components sitting inside the fields list.
//
//  Pass 2 (fallback): any non-inline element with ≥ 30 % panel width and a
//  reasonable height. Handles single-field lists where there are no siblings.
//
//  Both passes skip inline/icon elements. getBoundingClientRect is used because
//  offsetWidth returns 0 inside flex/grid containers.
// ---------------------------------------------------------------------------
function findFieldRow(el) {
  if (!el) return null;

  const skip = new Set(['SPAN','EM','B','I','STRONG','A','LABEL',
                        'SVG','PATH','G','USE','BUTTON','INPUT','TEXTAREA','SELECT']);

  const pw = activePanel
    ? (activePanel.getBoundingClientRect().width || activePanel.offsetWidth)
    : 0;
  const minW1 = pw > 100 ? pw * 0.45 : 150;
  const minW2 = pw > 100 ? pw * 0.20 : 60;  // relaxed: 20% of panel

  // Pass 1 — wide block in a sibling list (standard field-row in a flex/grid list)
  let node = el;
  for (let i = 0; i < 25; i++) {
    if (!node || node === activePanel || node === document.body) break;
    if (!skip.has(node.tagName)) {
      const r = node.getBoundingClientRect();
      if (r.width >= minW1 && r.height >= 10 && r.height < 300) {
        const p = node.parentElement;
        if (p && p !== activePanel && p.children.length >= 2) return node;
      }
    }
    node = node.parentElement;
  }

  // Pass 2 — Angular/custom-element host (tag name contains a hyphen).
  // These often have display:contents so getBoundingClientRect returns 0×0,
  // but they represent the semantic field-row boundary in the component tree.
  // Accept when: it has sibling children AND the parent container has height.
  node = el;
  for (let i = 0; i < 25; i++) {
    if (!node || node === activePanel || node === document.body) break;
    if (node.tagName && node.tagName.includes('-')) {
      const p = node.parentElement;
      if (p && p.children.length >= 2) {
        const pr = p.getBoundingClientRect();
        if (pr.height >= 10) return node;
      }
    }
    node = node.parentElement;
  }

  // Pass 3 — any block with relaxed width threshold
  node = el;
  for (let i = 0; i < 20; i++) {
    if (!node || node === activePanel || node === document.body) break;
    if (!skip.has(node.tagName)) {
      const r = node.getBoundingClientRect();
      if (r.width >= minW2 && r.height >= 10 && r.height < 250) return node;
    }
    node = node.parentElement;
  }

  return null;
}

// ---------------------------------------------------------------------------
// tagFieldElements — two-strategy tagging, safe to call multiple times.
//
// Ground truth from DOM inspection:
//   ClickUp renders every custom field row as div.cu-task-custom-fields__virtual-scroll-row
//   inside a CDK virtual scroll viewport. This is the definitive field-row element.
//
// Strategy 1 (row enumeration):
//   Query all .cu-task-custom-fields__virtual-scroll-row elements and match each
//   to a known field by:
//     (a) UUID scan — look for any known field UUID in any attribute within the row
//     (b) Label text match — walk text nodes within the row for an exact name match
//   Because we start from the known row element, section headers and other non-field
//   elements are structurally excluded — they are never .cu-task-custom-fields__virtual-scroll-row.
//
// Strategy 2 (UUID_ATTRS fallback):
//   For any fields not resolved by Strategy 1 (e.g. outside the virtual scroll,
//   or in a different layout), fall back to the proven UUID attribute + LCA walk.
// ---------------------------------------------------------------------------
function tagFieldElements(panel, fields) {
  // Skip fields already tagged anywhere in the panel.
  const alreadyTagged = new Set(
    [...panel.querySelectorAll('[data-cfm-field-id]')].map(el => el.dataset.cfmFieldId)
  );
  const remaining = new Map(
    fields.filter(f => !alreadyTagged.has(f.id)).map(f => [f.id, f])
  );
  if (!remaining.size) return;

  // Set of all non-structural field UUIDs we are trying to tag.
  const knownIds = new Set([...remaining.keys()].filter(id => !id.startsWith('__')));

  // Name → field map for O(1) label-text lookups.
  const byName = new Map(
    [...remaining.values()]
      .filter(f => !f.id.startsWith('__'))
      .map(f => [normalizeText(f.name), f])
  );

  // ── Strategy 1: enumerate known field-row elements ───────────────────────
  //
  // DOM inspection confirmed that ClickUp renders all custom fields inside
  // div.cu-task-custom-fields__virtual-scroll-row elements. Enumerating these
  // directly is structurally safe — section headers, value-only elements, and
  // other non-field nodes are never this element type.
  const fieldRows = [...panel.querySelectorAll('.cu-task-custom-fields__virtual-scroll-row')];

  for (const row of fieldRows) {
    if (row.dataset.cfmFieldId || !remaining.size) continue;

    let matched = null;

    // (a) UUID scan: check every attribute on every element within this row.
    // knownIds only contains our custom field UUIDs — task-link UUIDs, user IDs,
    // and other incidental UUIDs are not in the set and are ignored.
    scanUUID: for (const el of row.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        if (knownIds.has(attr.value)) {
          matched = remaining.get(attr.value);
          break scanUUID;
        }
      }
    }

    // (b) Label text match: if no UUID found, walk text nodes within the row.
    // Working inside a single known field-row element makes this safe — the only
    // candidate texts are the field label and its current value.
    if (!matched && byName.size) {
      const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let tn;
      while ((tn = tw.nextNode())) {
        const norm = normalizeText(tn.textContent);
        if (norm && byName.has(norm)) { matched = byName.get(norm); break; }
      }
    }

    if (matched) {
      row.dataset.cfmFieldId = matched.id;
      row.dataset.cfmFieldName = matched.name;
      row.dataset.cfmNaturalH = recordedH(row);
      remaining.delete(matched.id);
      byName.delete(normalizeText(matched.name));
      knownIds.delete(matched.id);
    }
  }

  // ── Strategy 2: UUID_ATTRS fallback ──────────────────────────────────────
  //
  // Handles any fields that live outside the virtual scroll (e.g. a different
  // ClickUp layout or a future DOM change). Uses the proven UUID attribute +
  // LCA walk approach.
  //
  // KEY GUARD: If the panel uses CDK virtual scroll rows, a field's UUID appearing
  // in the sidebar or another non-row element is metadata — not the field's UI row.
  // In that case we skip and let the mutation observer retry when CDK renders the row.
  const UUID_ATTRS = [
    'data-id', 'data-field-id', 'data-custom-field-id',
    'data-task-custom-field-id', 'data-custom-field-type-id',
  ];

  // True if this panel uses CDK virtual scroll for custom fields.
  const hasCdkRows = panel.querySelector('.cu-task-custom-fields__virtual-scroll-row') !== null;

  for (const [fieldId, field] of remaining) {
    if (fieldId.startsWith('__')) continue;
    const valueEl = panel.querySelector(UUID_ATTRS.map(a => `[${a}="${fieldId}"]`).join(', '));
    if (!valueEl) continue;

    // Fast path: if the UUID-bearing element is directly inside a CDK row, use it.
    const directRow = valueEl.closest('.cu-task-custom-fields__virtual-scroll-row');
    if (directRow) {
      if (!directRow.dataset.cfmFieldId) {
        directRow.dataset.cfmFieldId = fieldId;
        directRow.dataset.cfmFieldName = field.name;
        directRow.dataset.cfmNaturalH = recordedH(directRow);
        remaining.delete(fieldId);
      }
      continue; // whether tagged or already owned, don't fall through to LCA
    }

    // If the panel has CDK rows but the UUID is not in any of them, this is a
    // sidebar/metadata reference. Skip — the mutation observer will retry when
    // CDK renders the actual field row.
    if (hasCdkRows) continue;

    // No CDK virtual scroll in this panel — fall back to full LCA walk.
    const normName = normalizeText(field.name);
    let lca = null;
    let node = valueEl.parentElement;
    for (let depth = 0; depth < 12 && node && node !== panel && node !== document.body; depth++) {
      const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let tn;
      while ((tn = tw.nextNode())) {
        if (normalizeText(tn.textContent) === normName) { lca = node; break; }
      }
      if (lca) break;
      node = node.parentElement;
    }

    let row = (lca && findFieldRow(lca)) ?? lca ?? findFieldRow(valueEl) ?? valueEl;
    if (row && !row.contains(valueEl)) row = findFieldRow(valueEl) ?? valueEl;

    if (row && !row.dataset.cfmFieldId) {
      row.dataset.cfmFieldId = fieldId;
      row.dataset.cfmFieldName = field.name;
      row.dataset.cfmNaturalH = recordedH(row);
    }
    remaining.delete(fieldId);
  }

  // Log fields that couldn't be tagged in either pass.
  const untaggeable = [...remaining.values()]
    .filter(f => !f.id.startsWith('__') && !_warnedUntaggeable.has(f.id));
  if (untaggeable.length) {
    untaggeable.forEach(f => _warnedUntaggeable.add(f.id));
  }
}

// ---------------------------------------------------------------------------
// Panel-wide mutation observer — re-tags newly rendered field rows.
// Watches the entire panel instead of only the CDK virtual scroll viewport,
// which means it catches both virtual-scrolled and flat-layout renders.
// ---------------------------------------------------------------------------
let panelObserver = null;

function setupPanelObserver(panel, fields) {
  if (panelObserver) panelObserver.disconnect();

  let debounce;
  panelObserver = new MutationObserver((mutations) => {
    const hasNewNodes = mutations.some(m => m.addedNodes.length > 0);
    if (!hasNewNodes) return;

    clearTimeout(debounce);
    debounce = setTimeout(() => {
      // Angular re-renders the task view during SPA navigation, replacing the
      // panel's inner DOM and removing our injected tab strip. Rebuild it
      // whenever the observer fires and the strip is no longer present.
      if (!panel.querySelector('.cfm-tab-strip') && activeTabState.tabs.length > 0) {
        buildTabStrip(panel, activeTabState.tabs, activeTabState.id);
      }
      tagFieldElements(panel, fields);
      tagStructuralElements();
      applyTab(panel, activeTabState.id, activeTabState.tabs);
    }, 200);
  });

  panelObserver.observe(panel, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Preset storage — load personal presets keyed by workspace + task type.
// Storage key: preset_${workspaceId}_${typeKey}  (chrome.storage.sync)
// ---------------------------------------------------------------------------
function presetKey(workspaceId, typeKey) {
  return `preset_${workspaceId}_${typeKey}`;
}

function loadPreset(workspaceId, typeKey) {
  return new Promise(resolve => {
    const key = presetKey(workspaceId, typeKey);
    chrome.storage.sync.get(key, data => {
      resolve(data[key] ?? { tabs: [], rules: [] });
    });
  });
}

// ---------------------------------------------------------------------------
// Task-type helpers
// ---------------------------------------------------------------------------

// Read the current task type label from the ClickUp DOM.
// Returns the raw display name (e.g. "Email", "Copywriting Brief") or null.
function getTaskTypeFromDom() {
  const el = document.querySelector('[data-test="cu-task-view-task-label__task-type"]');
  return el?.textContent.trim() || null;
}

// Normalise a task type display name to a safe storage key.
// "Email Marketing" → "email_marketing"
function normalizeTypeKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ---------------------------------------------------------------------------
// Preset import / export — copyable Base64 strings so users can share presets
// ---------------------------------------------------------------------------
function exportPresetString(config, typeName) {
  return btoa(JSON.stringify({
    v:       1,
    typeName: typeName ?? '',
    tabs:    config.tabs  ?? [],
    rules:   config.rules ?? [],
  }));
}

function importPresetString(str) {
  try {
    const obj = JSON.parse(atob(str));
    if (obj.v !== 1 || !Array.isArray(obj.tabs)) return null;
    return { tabs: obj.tabs, rules: obj.rules ?? [], typeName: obj.typeName ?? '' };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tab strip UI
// ---------------------------------------------------------------------------
function buildTabStrip(panel, tabs, currentTabId = '__all') {
  panel.querySelector('.cfm-tab-strip')?.remove();

  const strip = document.createElement('div');
  strip.className = 'cfm-tab-strip';

  // Custom tabs first
  tabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'cfm-tab' + (tab.id === currentTabId ? ' cfm-tab--active' : '');
    btn.textContent = tab.name;
    btn.dataset.cfmTab = tab.id;
    strip.appendChild(btn);
  });

  // "All Fields" tab always last
  const allBtn = document.createElement('button');
  allBtn.className = 'cfm-tab' + (currentTabId === '__all' ? ' cfm-tab--active' : '');
  allBtn.textContent = 'All Fields';
  allBtn.dataset.cfmTab = '__all';
  strip.appendChild(allBtn);

  // Use data-cfm-tab attribute (not class) as the selector so any future
  // action buttons without data-cfm-tab never accidentally trigger tab switching.
  strip.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cfm-tab]');
    if (!btn) return;
    strip.querySelectorAll('.cfm-tab').forEach(t => t.classList.remove('cfm-tab--active'));
    btn.classList.add('cfm-tab--active');
    requestAnimationFrame(() => {
      // Re-tag structural elements on every tab switch. Angular may have
      // replaced the element since the last tag (e.g. after a re-render).
      tagStructuralElements();
      applyTab(panel, btn.dataset.cfmTab, tabs);
    });
    // Tell the options panel which tab is now active so it can follow along.
    safeSet({ cfm_active_tab: { tabId: btn.dataset.cfmTab, ts: Date.now() } });
  });

  const scrollBody = panel.querySelector('.cu-task-view-task-content__body')
    || panel.querySelector('cu-task-view-task-content')
    || panel;
  scrollBody.prepend(strip);
  return strip;
}


// After hiding individual field rows, Angular wrapper elements and section
// containers may retain padding/gap that leaves visible empty space.
// Walk UP from each hidden field (up to 6 levels) and mark each ancestor
// as wrapper-hidden when it has no visible tagged descendants.
//
// Two hard stops prevent over-hiding:
//   - any ancestor that contains the tab strip (must stay visible)
//   - any ancestor that already has a visible tagged field inside it
function collapseEmptyWrappers(panel) {
  panel.querySelectorAll('[data-cfm-wrapper-hidden]')
    .forEach(el => el.removeAttribute('data-cfm-wrapper-hidden'));
  panel.querySelectorAll('[data-cfm-mixed]')
    .forEach(el => el.removeAttribute('data-cfm-mixed'));
  panel.querySelectorAll('[data-cfm-empty-toggle]')
    .forEach(el => el.removeAttribute('data-cfm-empty-toggle'));

  if (activeTabState.id === '__all') return;

  const tabStrip = panel.querySelector('.cfm-tab-strip');
  const hiddenEls = [...panel.querySelectorAll('[data-cfm-field-id][data-cfm-tab-hidden="true"]')];
  const visibleEls = [...panel.querySelectorAll('[data-cfm-field-id]:not([data-cfm-tab-hidden="true"])')];

  // Pass 1 — walk UP from each hidden field and mark fully-empty ancestors.
  // Never tag Angular component host elements (hyphenated tag names) — setting
  // data attributes on them can interfere with Angular's internal state and
  // our CSS rules would hide components that manage their own visibility.
  for (const el of hiddenEls) {
    let node = el.parentElement;
    for (let depth = 0; depth < 6; depth++) {
      if (!node || node === panel) break;
      if (tabStrip && node.contains(tabStrip)) break;
      if (node.dataset.cfmWrapperHidden) break;
      if (node.dataset.cfmFieldId) break;
      if (node.tagName.includes('-')) { node = node.parentElement; continue; } // skip Angular hosts
      if (node.querySelector('[data-cfm-field-id]:not([data-cfm-tab-hidden="true"])')) break;
      node.dataset.cfmWrapperHidden = 'true';
      node = node.parentElement;
    }
  }

  // Pass 2 — mark containers that hold both visible and hidden tagged fields.
  // ClickUp/Angular may keep explicit pixel heights on these; height:auto in CSS
  // lets them shrink to fit their remaining visible children.
  for (const el of hiddenEls) {
    let node = el.parentElement;
    for (let depth = 0; depth < 8; depth++) {
      if (!node || node === panel) break;
      if (node.dataset.cfmFieldId) break;
      if (tabStrip && node.contains(tabStrip)) break;
      if (visibleEls.some(v => node.contains(v))) {
        node.dataset.cfmMixed = 'true';
        break;
      }
      node = node.parentElement;
    }
  }

  // Pass 3 — find ClickUp's "show N empty fields" toggle and mark it so the
  // gap above it collapses when the fields preceding it are hidden.
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  let tn;
  while ((tn = walker.nextNode())) {
    if (!/show\s+\d+/i.test(tn.textContent)) continue;
    let btn = tn.parentElement;
    while (btn && btn !== panel) {
      if (btn.tagName === 'BUTTON' || btn.getAttribute('role') === 'button') break;
      btn = btn.parentElement;
    }
    if (btn && btn !== panel) btn.dataset.cfmEmptyToggle = 'true';
    break;
  }
}

// Clamp the CDK virtual-scroll viewport that contains our field rows to exactly
// the summed natural height of the currently-visible fields. This hides the
// internal spacer (which CDK uses for its own layout and must not be modified)
// without touching its value, avoiding the overlap that direct spacer edits cause.
function clampCdkViewport(panel) {
  const viewport = [...panel.querySelectorAll('cdk-virtual-scroll-viewport')]
    .find(vp => vp.querySelector('[data-cfm-field-id]'));
  if (!viewport) return;

  if (activeTabState.id === '__all') {
    viewport.style.removeProperty('max-height');
    viewport.style.removeProperty('overflow-x');
    viewport.style.removeProperty('overflow-y');
    return;
  }

  const visibleFields = [...viewport.querySelectorAll('[data-cfm-field-id]')]
    .filter(el => el.dataset.cfmTabHidden !== 'true');

  const visibleH = visibleFields.reduce(
    (sum, el) => sum + (parseFloat(el.dataset.cfmNaturalH) || 0), 0
  );

  // 32 px buffer covers flex-gap between rows (not captured in individual heights).
  // overflow-x: hidden prevents the CSS quirk where overflow-y:hidden forces
  // overflow-x to auto, producing an unwanted horizontal scrollbar.
  viewport.style.setProperty('max-height', (visibleH + 32) + 'px', 'important');
  viewport.style.setProperty('overflow-x', 'hidden', 'important');
  viewport.style.setProperty('overflow-y', 'hidden', 'important');
}

// ---------------------------------------------------------------------------
// Dynamic structural-element visibility stylesheet
//
// Hides structural sections (Description, Checklists, etc.) by injecting CSS
// rules that target them by their Angular component selector, NOT by mutating
// any attribute on the element itself.
//
// Why: setting data-cfm-tab-hidden="true" directly on Angular component host
// elements (e.g. cu-task-view-task-content-description-expanded-collapsed)
// triggers Angular's MutationObserver-based change detection, which causes the
// component to re-render and strip our custom attributes — making the element
// reappear as visible. A stylesheet injection never touches the element, so
// Angular never sees a DOM attribute change on its host.
// ---------------------------------------------------------------------------
const CFM_STRUCT_STYLE_ID = 'cfm-structural-visibility';

function applyStructuralVisibility(panel, activeTabId, tabs) {
  let styleEl = document.getElementById(CFM_STRUCT_STYLE_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = CFM_STRUCT_STYLE_ID;
    // Don't append here — every code path below ends with appendChild(styleEl)
    // which moves/inserts it at the end of <head>, always beating Angular's
    // dynamically-injected component stylesheets on source-order cascade.
  }

  // Build restore rules — emitted for entries that ARE in the active tab but
  // whose Angular component may have internally collapsed (e.g. description
  // collapses its .content-container via IntersectionObserver when we hid it on
  // a previous tab).
  //
  // We override BOTH hiding axes ClickUp uses:
  //   1. display:none   — class-based (fixed by display:block !important)
  //   2. height:0 + overflow:hidden — class-based or inline (fixed by
  //      height:auto + max-height:none + overflow:visible !important)
  // Using !important in an author stylesheet beats both class rules AND inline
  // styles (Angular renderer style bindings) in the CSS cascade.
  const restoreRules = [];
  for (const id of _structuralCssIds) {
    const entry = STRUCTURAL_SELECTORS.find(s => s.id === id);
    const sels = entry?.restoreSels ?? (entry?.restoreSel ? [entry.restoreSel] : []);
    if (!sels.length) continue;
    const inActiveTab = activeTabId === '__all' ||
      (tabs.find(t => t.id === activeTabId)?.fieldIds ?? []).includes(id);
    if (inActiveTab) {
      sels.forEach(sel => restoreRules.push(
        `${sel} { display: block !important; height: auto !important; ` +
        `min-height: 0 !important; max-height: none !important; overflow: visible !important; }`
      ));
    }
  }

  if (activeTabId === '__all') {
    // On All Fields, only emit the restore rules (no hide rules needed).
    styleEl.textContent = restoreRules.join('\n');
    // Always move to end of <head> so our !important rules win source-order
    // cascade against all Angular-injected component stylesheets (505+ sheets
    // appear after our original insertion point #252 of 757).
    document.head.appendChild(styleEl);
    return;
  }

  const tabFieldIds = new Set(
    (tabs.find(t => t.id === activeTabId)?.fieldIds) ?? []
  );

  // _structuralCssIds holds the IDs of structural elements that live on Angular
  // component hosts — we never set DOM attributes on those elements, so we read
  // from this plain JS Set instead of querying the DOM.
  //
  // Use display:none for hiding. For components that internally collapse when
  // hidden (e.g. description), we emit a restoreSel rule above that forces the
  // inner content back to display:block when the component should be visible.
  const cssRules = [...restoreRules];
  for (const id of _structuralCssIds) {
    if (tabFieldIds.has(id)) continue; // in this tab → should be visible
    const entry = STRUCTURAL_SELECTORS.find(s => s.id === id);
    if (!entry) continue;
    (entry.hideSels ?? [entry.sel]).forEach(sel => {
      cssRules.push(`${sel} { display: none !important; }`);
    });
  }

  styleEl.textContent = cssRules.join('\n');
  // Always move to end of <head> so our !important rules win source-order
  // cascade against all Angular-injected component stylesheets (505+ sheets
  // appear after our original insertion point #252 of 757).
  document.head.appendChild(styleEl);
}

// ---------------------------------------------------------------------------
// nudgeDescriptionExpansion
//
// Root cause: when ClickUp's description component is hidden via display:none
// (our tab-hiding CSS), the Quill editor inside never lays out (or collapses).
// When we restore display:block, our CSS restore rules set height:auto on all
// inner layers — but Quill's internal sizing is driven by its own layout pass,
// which it triggers in response to a window 'resize' event.
//
// Dispatching a synthetic resize event immediately after showing the description
// causes Quill to recalculate its height and render at full content height.
// This was confirmed via console testing (dispatchEvent returned true and the
// description became visible).
//
// We only nudge when transitioning from "description was hidden/unknown" to
// "description is now in the active tab", tracked via _descPrevInTab, so we
// don't fire unnecessary resize events on every tab switch.
// ---------------------------------------------------------------------------
let _descNudgeTimer  = null;
let _descPrevInTab   = false; // was description visible on the previous tab?

function nudgeDescriptionExpansion(descNowInTab) {
  const wasNotInTab = !_descPrevInTab;
  _descPrevInTab = descNowInTab;

  if (!descNowInTab) return;   // description hidden on this tab — nothing to expand
  if (!wasNotInTab)  return;   // description was already visible — no nudge needed

  clearTimeout(_descNudgeTimer);

  // Small delay lets the browser complete the layout pass triggered by our
  // CSS change (moving style element to end of <head>) before we fire resize.
  _descNudgeTimer = setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 50);
}

function applyTab(panel, activeTabId, tabs) {
  activeTabState = { id: activeTabId, tabs };
  // Query within the panel only — prevents picking up stale tags from previous
  // task navigations when Angular reuses DOM containers.
  const fieldEls = [...panel.querySelectorAll('[data-cfm-field-id]')];

  if (activeTabId === '__all') {
    panel.removeAttribute('data-cfm-tab-active');
    fieldEls.forEach(el => el.removeAttribute('data-cfm-tab-hidden'));
    applyStructuralVisibility(panel, '__all', tabs);   // clears the injected stylesheet
    _descPrevInTab = true; // description is visible on All Fields
    collapseEmptyWrappers(panel);
    clampCdkViewport(panel);
    ensureTabStripSpacing(panel);
    return;
  }

  panel.dataset.cfmTabActive = 'true';

  const activeTab = tabs.find(t => t.id === activeTabId);
  const tabFieldIds = new Set(activeTab?.fieldIds ?? []);

  fieldEls.forEach(el => {
    const fieldId = el.dataset.cfmFieldId;

    const inTab = tabFieldIds.has(fieldId);
    // All tagged elements are either custom fields (CDK rows) or structural
    // elements tagged on plain div wrappers. Angular component hosts are never
    // tagged — they're handled exclusively via CSS injection in
    // applyStructuralVisibility. So data-cfm-tab-hidden is always safe here.
    if (inTab) {
      el.removeAttribute('data-cfm-tab-hidden');
    } else {
      el.dataset.cfmTabHidden = 'true';
    }
  });

  // Hide structural elements via injected CSS (zero attribute changes on Angular elements).
  applyStructuralVisibility(panel, activeTabId, tabs);

  // Trigger IntersectionObserver expand if description just became visible.
  nudgeDescriptionExpansion(tabFieldIds.has('__s_description'));

  collapseEmptyWrappers(panel);
  clampCdkViewport(panel);
  ensureTabStripSpacing(panel);
}

// Insert a fixed-height spacer immediately after the tab strip so whatever
// element comes first (title, status row, a custom field) always has breathing
// room below the strip. Removed when the "All Fields" tab is active.
function ensureTabStripSpacing(panel) {
  if (activeTabState.id === '__all') {
    // Remove spacer when on All Fields (no tab strip spacing needed)
    panel.querySelector('.cfm-tab-spacer')?.remove();
    return;
  }

  // Only insert the spacer if it isn't already there — avoids triggering
  // the MutationObserver on every applyTab call.
  if (panel.querySelector('.cfm-tab-spacer')) return;

  const tabStrip = panel.querySelector('.cfm-tab-strip');
  if (!tabStrip) return;

  const spacer = document.createElement('div');
  spacer.className = 'cfm-tab-spacer';
  tabStrip.insertAdjacentElement('afterend', spacer);
}

// ---------------------------------------------------------------------------
// Visibility engine — evaluates AND/OR condition rules
// ---------------------------------------------------------------------------
function evaluateCondition(condition, fieldValueMap) {
  const actual = fieldValueMap.get(condition.fieldId) ?? '';
  switch (condition.operator) {
    case 'equals':       return actual === (condition.value ?? '').toLowerCase();
    case 'not_equals':   return actual !== (condition.value ?? '').toLowerCase();
    case 'is_empty':     return actual === '';
    case 'is_not_empty': return actual !== '';
    default:             return false;
  }
}

function applyVisibilityRules(panel, fields, rules) {
  if (!rules.length) return;
  const fieldValueMap = new Map(fields.map(f => [f.id, String(f.value ?? '').toLowerCase()]));

  for (const rule of rules) {
    const conditions = rule.conditions ?? [];
    if (!conditions.length) continue;

    const results = conditions.map(c => evaluateCondition(c, fieldValueMap));
    const conditionMet = rule.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);

    const targetEl = panel.querySelector(`[data-cfm-field-id="${rule.targetFieldId}"]`);
    if (!targetEl) continue;

    if (conditionMet && rule.action === 'hide') {
      targetEl.dataset.cfmRuleHidden = 'true';
    } else {
      targetEl.removeAttribute('data-cfm-rule-hidden');
    }
  }

}

// ---------------------------------------------------------------------------
// scheduleRetries — re-tags and re-applies at multiple intervals after open.
// ClickUp renders some sections (Relations, Checklists, custom fields) lazily.
// ---------------------------------------------------------------------------
function scheduleRetries(panel, fields, config) {
  [500, 1500, 3000].forEach(delay => {
    setTimeout(() => {
      tagStructuralElements();
      tagFieldElements(panel, fields);
      applyTab(panel, activeTabState.id, activeTabState.tabs);
      applyVisibilityRules(panel, fields, config.rules ?? []);
    }, delay);
  });
}

// ---------------------------------------------------------------------------
// Main task open/close handlers
//
// Two-phase init so the tab strip appears as fast as possible:
//
// Phase 1 (fast): check local storage for a cached listId from a previous
//   visit to this task. If found, read the config and render the strip
//   immediately — no API call needed. This makes the strip appear in < 50 ms
//   on revisits.
//
// Phase 2 (full): fetch fresh task data from the API, persist the listId,
//   wait for field DOM nodes, tag them, and re-render the strip with any
//   config changes. Visibility rules are also applied here because they need
//   current field values.
// ---------------------------------------------------------------------------
async function handleTaskOpen(taskId, panel) {
  try {
    // ── Phase 1: immediate strip from cache ──────────────────────────────────
    // task_meta_${taskId} stores { workspaceId, typeKey, typeName, listId }
    // written at the end of Phase 2 on a previous visit.
    const localHit  = await safeGet(`task_meta_${taskId}`);
    const cachedMeta = localHit[`task_meta_${taskId}`];

    if (cachedMeta?.workspaceId && cachedMeta?.typeKey) {
      activeWorkspaceId  = cachedMeta.workspaceId;
      activeTaskTypeKey  = cachedMeta.typeKey;
      activeTaskTypeName = cachedMeta.typeName ?? null;
      activeListId       = cachedMeta.listId ? String(cachedMeta.listId) : null;

      const cachedPreset = await loadPreset(cachedMeta.workspaceId, cachedMeta.typeKey);
      activePresetConfig = cachedPreset;
      if (cachedPreset.tabs?.length || cachedPreset.defaultTab) {
        const defaultTab = cachedPreset.defaultTab ?? '__all';
        tagStructuralElements();
        requestAnimationFrame(() => {
          buildTabStrip(panel, cachedPreset.tabs ?? [], defaultTab);
          applyTab(panel, defaultTab, cachedPreset.tabs ?? []);
        });
      }
    }

    // ── Phase 2: full API fetch ───────────────────────────────────────────────
    const { listId, workspaceId, fields } = await fetchTaskFields(taskId);
    activeListId      = String(listId ?? '');
    activeWorkspaceId = workspaceId;

    // Get task type name from the ClickUp DOM. The task type label element
    // may not be rendered yet immediately after navigation, so we try once and
    // fall back to a short wait if needed.
    let typeName = getTaskTypeFromDom();
    if (!typeName) {
      await new Promise(r => setTimeout(r, 400));
      typeName = getTaskTypeFromDom();
    }

    const typeKey      = typeName ? normalizeTypeKey(typeName) : null;
    activeTaskTypeName = typeName;
    activeTaskTypeKey  = typeKey;

    // Persist meta for Phase 1 on the next visit to this task.
    safeSet({ [`task_meta_${taskId}`]: { workspaceId, typeKey, typeName, listId } });
    // Keep the legacy key for any code still reading it.
    safeSet({ [`task_list_${taskId}`]: listId });

    // Load the personal preset for this task type (or empty config if none).
    let preset = { tabs: [], rules: [] };
    if (workspaceId && typeKey) {
      preset = await loadPreset(workspaceId, typeKey);
    }
    activePresetConfig = preset;
    const defaultTab   = preset.defaultTab ?? '__all';

    // Render the strip immediately — strip only needs tab names, not DOM fields.
    tagStructuralElements();
    requestAnimationFrame(() => {
      buildTabStrip(panel, preset.tabs ?? [], defaultTab);
      applyTab(panel, defaultTab, preset.tabs ?? []);
    });

    // Start retries and observer before waiting for field DOM nodes so their
    // timers run from task-open rather than from when fields finish rendering.
    scheduleRetries(panel, fields, preset);
    setupPanelObserver(panel, fields);

    // Wait for field elements, then tag and apply.
    await waitForFieldsToRender(panel, fields.map(f => f.name));
    tagFieldElements(panel, fields);

    requestAnimationFrame(() => {
      applyTab(panel, activeTabState.id, activeTabState.tabs);
      applyVisibilityRules(panel, fields, preset.rules ?? []);
    });

    // Publish context so the options side-panel can auto-follow.
    safeSet({ cfm_active_list: activeListId });
    safeSet({ cfm_active_type: { workspaceId, typeKey, typeName, listId } });

    // Cache fields for the options page field-assignment UI.
    safeSet({ [`fields_${listId}`]: [...STRUCTURAL_FIELDS, ...fields] });
    apiGet(`/list/${listId}`)
      .then(list => { if (list?.name) safeSet({ [`listname_${listId}`]: list.name }); })
      .catch(() => {});

  } catch (err) {
    // Retries (scheduleRetries) will recover from transient DOM-timing failures,
    // but log the error so genuine failures (e.g. a 401 from an expired API
    // token) are visible in the console instead of failing silently.
    console.warn('[ClickOff] task setup failed:', err.message);
  }
}

function handleTaskClose() {
  if (panelObserver) { panelObserver.disconnect(); panelObserver = null; }
}

// ---------------------------------------------------------------------------
// URL-change observer — detects SPA navigation
// ---------------------------------------------------------------------------
let lastTaskId         = null;
let activePanel        = null;
let activeListId       = null;
let activeWorkspaceId  = null;   // ClickUp workspace (team) ID from API
let activeTaskTypeName = null;   // Raw display name, e.g. "Email"
let activeTaskTypeKey  = null;   // Normalised storage key, e.g. "email"
let activePresetConfig = { tabs: [], rules: [] }; // Current preset (for export)
let activeTabState     = { id: '__all', tabs: [] };
// Tracks field IDs already reported as untaggeable — prevents repeat console noise
// across observer/retry calls for the same task.
const _warnedUntaggeable = new Set();

function checkUrl() {
  const taskId = getTaskIdFromUrl();

  if (taskId && taskId !== lastTaskId) {
    // ── New task navigation ────────────────────────────────────────────────
    lastTaskId = taskId;
    _warnedUntaggeable.clear();
    try { chrome.runtime.sendMessage({ type: 'CLICKUP_INVALIDATE', path: taskApiPath(taskId) }); } catch (_) {}
    taskCache.delete(taskId);

    waitForTaskPanel().then(panel => {
      if (!panel) return;
      activePanel = panel;
      handleTaskOpen(taskId, panel);
    });
    return;
  }

  if (taskId && taskId === lastTaskId && activeTabState.tabs.length > 0) {
    // ── Same task — check Angular hasn't wiped our injected UI ────────────
    // Case A: the panel element itself was destroyed and recreated.
    if (activePanel && !document.body.contains(activePanel)) {
      waitForTaskPanel().then(panel => {
        if (!panel) return;
        activePanel = panel;
        handleTaskOpen(taskId, panel);
      });
      return;
    }
    // Case B: the panel is still in the DOM but the tab strip was removed
    // (Angular re-rendered the panel's inner content).
    if (activePanel && !activePanel.querySelector('.cfm-tab-strip')) {
      buildTabStrip(activePanel, activeTabState.tabs, activeTabState.id);
      applyTab(activePanel, activeTabState.id, activeTabState.tabs);
    }
  }

  if (!taskId && lastTaskId) {
    lastTaskId = null;
    activePanel = null;
    handleTaskClose();
  }
}

// Intercept SPA navigation methods (fast path).
// Note: ClickUp's Angular router bootstraps before document_idle and caches
// its own pushState reference, so these patches may not fire for every
// navigation. The setInterval below is the reliable fallback.
const _push = history.pushState.bind(history);
const _replace = history.replaceState.bind(history);
history.pushState = (...args) => { _push(...args); setTimeout(checkUrl, 50); };
history.replaceState = (...args) => { _replace(...args); setTimeout(checkUrl, 50); };
window.addEventListener('popstate', () => setTimeout(checkUrl, 50));
window.addEventListener('hashchange', () => setTimeout(checkUrl, 50));

// Polling fallback — catches any navigation the pushState patch misses.
// checkUrl() is a no-op when the URL hasn't changed, so 500 ms polling
// costs nothing on a stable page.
setInterval(checkUrl, 500);

// ---------------------------------------------------------------------------
// Real-time config updates — the options page writes a cfm_notify key to
// local storage whenever it auto-saves. We watch for that change here.
// This avoids the `tabs` permission (which triggers Chrome Web Store manual
// review) while being equally reliable.
// ---------------------------------------------------------------------------
function reapplyConfig(config) {
  activePresetConfig = config; // keep in sync for the export button
  if (!activePanel) return;
  requestAnimationFrame(() => {
    tagStructuralElements();
    const cached = taskCache.get(lastTaskId);
    if (cached) tagFieldElements(activePanel, cached.fields);

    const tabStillExists = activeTabState.id === '__all' ||
      (config.tabs ?? []).some(t => t.id === activeTabState.id);
    const tabToShow = tabStillExists ? activeTabState.id : (config.defaultTab ?? '__all');
    buildTabStrip(activePanel, config.tabs ?? [], tabToShow);
    applyTab(activePanel, tabToShow, config.tabs ?? []);
    if (cached) applyVisibilityRules(activePanel, cached.fields, config.rules ?? []);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.cfm_notify) return;
  const { workspaceId, typeKey } = changes.cfm_notify.newValue ?? {};
  // Only react if the notification matches the currently-open task's preset key.
  if (!activePanel || !activeWorkspaceId || !activeTaskTypeKey) return;
  if (workspaceId !== activeWorkspaceId || typeKey !== activeTaskTypeKey) return;
  loadPreset(activeWorkspaceId, activeTaskTypeKey).then(reapplyConfig);
});

// Check on initial load (direct URL navigation to a task)
checkUrl();
