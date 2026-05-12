// ClickUp Field Manager — content script
// Runs on app.clickup.com. All logic is in this one file (MV3 content scripts
// cannot use ES module imports).

// ---------------------------------------------------------------------------
// In-memory task cache — avoids re-fetching API when the user navigates back
// to a task they've already opened this session.
// ---------------------------------------------------------------------------
const taskCache = new Map(); // taskId → { listId, fields }

// ---------------------------------------------------------------------------
// API helper — proxies through the background service worker to avoid CORS
// ---------------------------------------------------------------------------
function apiGet(path) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'CLICKUP_API', path }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error('No response from service worker'));
      if (response.error) return reject(new Error(response.error));
      resolve(response.data);
    });
  });
}

// ---------------------------------------------------------------------------
// Task ID extraction from URL
// ---------------------------------------------------------------------------
function getTaskIdFromUrl(url = location.href) {
  const match = url.match(/\/t\/([a-z0-9]+)/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// findTaskPanel — tries a sequence of increasingly broad selectors.
// ClickUp uses hashed React class names that change with deployments, so we
// use structural and semantic signals in priority order.
// ---------------------------------------------------------------------------
function findTaskPanel() {
  return (
    document.querySelector('[data-test="task-detail"]') ||
    document.querySelector('[data-test="task-view"]') ||
    document.querySelector('.cu-task-detail__main') ||
    document.querySelector('.cu-task-detail') ||
    document.querySelector('[class*="taskDetail"]:not([class*="taskDetailList"])') ||
    document.querySelector('[class*="task-detail"]:not([class*="task-detail-list"])') ||
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

    // Safety timeout
    setTimeout(() => { obs.disconnect(); resolve(findTaskPanel()); }, timeoutMs);
  });
}

// Waits until at least some field label elements have rendered inside the panel.
// Uses a MutationObserver on the panel itself (cheaper than watching document.body).
// Resolves early once stable; falls back after timeoutMs.
function waitForFieldsToRender(panel, knownFieldNames, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const nameSet = new Set(knownFieldNames.map(n => n.toLowerCase()));

    function hasAnyFieldLabel() {
      const els = panel.querySelectorAll('*');
      for (const el of els) {
        if (el.children.length <= 3 && nameSet.has(el.textContent.trim().toLowerCase())) {
          return true;
        }
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
// fetchTaskFields — returns { listId, fields[] } from the ClickUp API.
// Checks the in-memory cache first; API responses are cached for 60s in the
// service worker too, so round-trips are minimised.
// ---------------------------------------------------------------------------
async function fetchTaskFields(taskId) {
  if (taskCache.has(taskId)) return taskCache.get(taskId);

  const task = await apiGet(`/task/${taskId}?include_subtasks=false`);

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

  const result = { listId: task.list?.id, fields: [...builtIn, ...custom] };
  taskCache.set(taskId, result);
  return result;
}

// ---------------------------------------------------------------------------
// tagFieldElements — single pass through the panel DOM.
// Builds a lowercase name → field Map first, then does one querySelectorAll
// to find label candidates. O(n) instead of O(n × m).
// ---------------------------------------------------------------------------
function findFieldRow(labelEl) {
  let el = labelEl.parentElement;
  for (let i = 0; i < 6; i++) {
    if (!el) break;
    if (el.offsetHeight > 20 && el.children.length >= 1) return el;
    el = el.parentElement;
  }
  return labelEl.parentElement;
}

function tagFieldElements(panel, fields) {
  // Build lookup map: lowercase name → field
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
  const tagged = new Map(); // fieldId → element

  const allEls = panel.querySelectorAll('*');
  for (const el of allEls) {
    if (el.children.length > 3) continue; // skip containers
    const text = el.textContent.trim().toLowerCase();
    if (!text || !byName.has(text)) continue;

    const field = byName.get(text);
    const row = findFieldRow(el);
    if (row && !row.dataset.cfmFieldId) {
      row.dataset.cfmFieldId = field.id;
      row.dataset.cfmFieldName = field.name;
      tagged.set(field.id, row);
      byName.delete(text); // each field tagged once; stop checking this name
    }
  }

  return tagged;
}

// ---------------------------------------------------------------------------
// Config storage — load and save per-list configuration
// ---------------------------------------------------------------------------
function loadListConfig(listId) {
  return new Promise(resolve => {
    chrome.storage.sync.get(`config_${listId}`, data => {
      resolve(data[`config_${listId}`] ?? { tabs: [], rules: [] });
    });
  });
}

// ---------------------------------------------------------------------------
// Tab strip UI
// ---------------------------------------------------------------------------
function buildTabStrip(panel, tabs, currentTabId = '__all') {
  panel.querySelector('.cfm-tab-strip')?.remove();

  const strip = document.createElement('div');
  strip.className = 'cfm-tab-strip';

  // "All Fields" tab always first
  const allBtn = document.createElement('button');
  allBtn.className = 'cfm-tab' + (currentTabId === '__all' ? ' cfm-tab--active' : '');
  allBtn.textContent = 'All Fields';
  allBtn.dataset.cfmTab = '__all';
  strip.appendChild(allBtn);

  tabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'cfm-tab' + (tab.id === currentTabId ? ' cfm-tab--active' : '');
    btn.textContent = tab.name;
    btn.dataset.cfmTab = tab.id;
    strip.appendChild(btn);
  });

  // Single delegated click handler — no per-tab listeners
  strip.addEventListener('click', (e) => {
    const btn = e.target.closest('.cfm-tab');
    if (!btn) return;
    strip.querySelectorAll('.cfm-tab').forEach(t => t.classList.remove('cfm-tab--active'));
    btn.classList.add('cfm-tab--active');
    // Batch DOM visibility changes in one animation frame
    requestAnimationFrame(() => applyTab(panel, btn.dataset.cfmTab, tabs));
  });

  panel.insertBefore(strip, panel.firstChild);
  return strip;
}

function applyTab(panel, activeTabId, tabs) {
  const fieldEls = panel.querySelectorAll('[data-cfm-field-id]');

  if (activeTabId === '__all') {
    fieldEls.forEach(el => el.removeAttribute('data-cfm-tab-hidden'));
    return;
  }

  const activeTab = tabs.find(t => t.id === activeTabId);
  const tabFieldIds = new Set(activeTab?.fieldIds ?? []);

  fieldEls.forEach(el => {
    el.dataset.cfmTabHidden = tabFieldIds.has(el.dataset.cfmFieldId) ? 'false' : 'true';
  });
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
// Main task open/close handlers
// ---------------------------------------------------------------------------
async function handleTaskOpen(taskId, panel) {
  try {
    // Fetch task fields and config in parallel where possible.
    // We need listId from the task before we can load config, so:
    //   1. Fetch task (may be instant if cached)
    //   2. Then load config + wait for DOM in parallel
    const { listId, fields } = await fetchTaskFields(taskId);

    const [config] = await Promise.all([
      loadListConfig(listId),
      waitForFieldsToRender(panel, fields.map(f => f.name)),
    ]);

    // Tag field elements (single DOM pass)
    tagFieldElements(panel, fields);

    // Cache field list for options page
    chrome.storage.sync.set({ [`fields_${listId}`]: fields });

    // Build tab strip and apply visibility rules in one animation frame
    requestAnimationFrame(() => {
      buildTabStrip(panel, config.tabs ?? []);
      applyVisibilityRules(panel, fields, config.rules ?? []);
    });

  } catch (err) {
    // Silently fail — extension issues should never break ClickUp
    console.warn('[CFM]', err.message);
  }
}

function handleTaskClose() {
  // Nothing to clean up — the tab strip is inside the panel which ClickUp
  // removes from the DOM itself on navigation.
}

// ---------------------------------------------------------------------------
// URL-change observer — detects SPA navigation
// ---------------------------------------------------------------------------
let lastTaskId = null;
let activePanel = null;

function checkUrl() {
  const taskId = getTaskIdFromUrl();

  if (taskId && taskId !== lastTaskId) {
    lastTaskId = taskId;
    // Invalidate service worker cache for this task so we get fresh field values
    chrome.runtime.sendMessage({ type: 'CLICKUP_INVALIDATE', path: `/task/${taskId}?include_subtasks=false` });
    // Also invalidate in-memory cache so conditional rules see current values
    taskCache.delete(taskId);

    waitForTaskPanel().then(panel => {
      if (!panel) return;
      activePanel = panel;
      handleTaskOpen(taskId, panel);
    });
    return;
  }

  if (!taskId && lastTaskId) {
    lastTaskId = null;
    activePanel = null;
    handleTaskClose();
  }
}

// Intercept SPA navigation methods
const _push = history.pushState.bind(history);
const _replace = history.replaceState.bind(history);
history.pushState = (...args) => { _push(...args); setTimeout(checkUrl, 50); };
history.replaceState = (...args) => { _replace(...args); setTimeout(checkUrl, 50); };
window.addEventListener('popstate', () => setTimeout(checkUrl, 50));

// Also watch for DOM changes that indicate navigation without URL change
// (childList:false subtree:false = bare minimum footprint)
const navObserver = new MutationObserver(() => {
  const taskId = getTaskIdFromUrl();
  if (taskId !== lastTaskId) checkUrl();
});
navObserver.observe(document.body, { childList: true, subtree: false });

// Check on initial load (direct URL navigation to a task)
checkUrl();
