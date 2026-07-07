// ClickUp Field Manager — Options page
// Free and unrestricted. Support is via an optional Buy Me a Coffee link.

let currentListId      = null;   // list used for field fetching (not the config key)
let currentWorkspaceId = null;   // ClickUp workspace ID
let currentTypeKey     = null;   // normalised task type key, e.g. "email"
let currentTypeName    = null;   // display name, e.g. "Email"
let currentFields      = [];
let currentConfig      = { tabs: [], rules: [] };
let selectedTabId      = null;

// Elements
const authErrorBanner    = document.getElementById('auth-error-banner');
const authErrorFixBtn    = document.getElementById('auth-error-fix-btn');
const typeContextBanner  = document.getElementById('type-context-banner');
const typeContextName    = document.getElementById('type-context-name');
const typeContextHint    = document.getElementById('type-context-hint');
const listSelect         = document.getElementById('list-select');
const refreshListsBtn    = document.getElementById('refresh-lists-btn');
const tabsSection        = document.getElementById('tabs-section');
const tabsList           = document.getElementById('tabs-list');
const newTabName         = document.getElementById('new-tab-name');
const addTabBtn          = document.getElementById('add-tab-btn');
const fieldAssignSection = document.getElementById('field-assignment-section');
const activeTabLabel     = document.getElementById('active-tab-label');
const fieldList          = document.getElementById('field-list');
const rulesSection       = document.getElementById('rules-section');
const rulesList          = document.getElementById('rules-list');
const templatesSection   = document.getElementById('templates-section');
const templateSelect     = document.getElementById('template-select');
const loadTemplateBtn    = document.getElementById('load-template-btn');
const deleteTemplateBtn  = document.getElementById('delete-template-btn');
const templateNameInput  = document.getElementById('template-name');
const saveTemplateBtn    = document.getElementById('save-template-btn');
const templateMsg        = document.getElementById('template-msg');
const saveBar              = document.getElementById('save-bar');
const saveBtn              = document.getElementById('save-btn');
const saveStatus           = document.getElementById('save-status');
const allFieldsDefaultCb   = document.getElementById('all-fields-default-cb');

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
const chromeGet      = keys => new Promise(r => chrome.storage.sync.get(keys, r));
const chromeSet      = data => new Promise(r => chrome.storage.sync.set(data, r));
const chromeGetLocal = keys => new Promise(r => chrome.storage.local.get(keys, r));
const chromeSetLocal = data => new Promise(r => chrome.storage.local.set(data, r));

// ---------------------------------------------------------------------------
// Preset storage helpers — keyed by workspaceId + task type
// ---------------------------------------------------------------------------
function presetKey(workspaceId, typeKey) {
  return `preset_${workspaceId}_${typeKey}`;
}

function loadPreset(workspaceId, typeKey) {
  return chromeGet(presetKey(workspaceId, typeKey)).then(data =>
    data[presetKey(workspaceId, typeKey)] ?? { tabs: [], rules: [] }
  );
}

function savePreset(workspaceId, typeKey, config) {
  return chromeSet({ [presetKey(workspaceId, typeKey)]: config });
}

// ---------------------------------------------------------------------------
// Field-name → id resolution for name-based templates.
//
// Templates store field *names* (portable across workspaces/lists where UUIDs
// differ). Resolving names back to ids must EXCLUDE the non-assignable built-in
// fields (__status, __assignees, __priority, __tags, __due_date, __time_estimate):
// these never appear in the field checklist, yet each shares a name with its
// structural section counterpart (__s_status is also "Status", etc.). A naive
// `new Map(fields.map(f => [f.name.toLowerCase(), f.id]))` lets the built-in
// overwrite the structural id, so a round-tripped "Status" section would resolve
// to the dead __status id and silently stop hiding. Excluding built-ins keeps
// names unambiguous for everything the user can actually assign; any residual
// duplicate (e.g. a custom field named exactly like a structural section) is
// resolved first-wins, with a warning for support.
// ---------------------------------------------------------------------------
function isAssignableField(f) {
  // Structural sections (__s_*) and real custom fields are assignable; the plain
  // built-in __-fields are not (they're excluded from the assignment checklist).
  return !(f.id.startsWith('__') && !f.id.startsWith('__s_'));
}

function buildNameToId(fields) {
  const map = new Map();
  for (const f of fields) {
    if (!isAssignableField(f)) continue;
    const key = (f.name ?? '').toLowerCase();
    if (!key) continue;
    if (map.has(key)) {
      console.warn(`[ClickOff] duplicate field name "${f.name}" — template resolves it to the first match (${map.get(key)}).`);
      continue; // first-wins: deterministic, prefers the earlier (structural) field
    }
    map.set(key, f.id);
  }
  return map;
}

// ---------------------------------------------------------------------------
// API helper — proxies through service worker
// ---------------------------------------------------------------------------
function apiGet(path) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'CLICKUP_API', path }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.error) return reject(new Error(res.error));
      resolve(res?.data);
    });
  });
}

// ---------------------------------------------------------------------------
// Field definitions (mirrors content.js — kept in sync manually)
// ---------------------------------------------------------------------------
const STRUCTURAL_FIELDS = [
  { id: '__s_brain',       name: 'Brain AI Bar',         type: 'structural' },
  { id: '__s_tasktype',    name: 'Task Type',            type: 'structural' },
  { id: '__s_title',       name: 'Task Title',           type: 'structural' },
  { id: '__s_status',      name: 'Status',               type: 'structural' },
  { id: '__s_assignees',   name: 'Assignees',            type: 'structural' },
  { id: '__s_dates',       name: 'Dates',                type: 'structural' },
  { id: '__s_priority',    name: 'Priority',             type: 'structural' },
  { id: '__s_tracktime',   name: 'Track Time',           type: 'structural' },
  { id: '__s_more',        name: 'More',                 type: 'structural' },
  { id: '__s_collapsed',   name: 'Collapsed Properties', type: 'structural' },
  { id: '__s_description', name: 'Description',          type: 'structural' },
  { id: '__s_relations',   name: 'Relations',            type: 'structural' },
  { id: '__s_checklists',  name: 'Checklists',           type: 'structural' },
  { id: '__s_subtasks',    name: 'Subtasks',             type: 'structural' },
  { id: '__s_attachments', name: 'Attachments',          type: 'structural' },
  { id: '__s_comments',    name: 'Comments',             type: 'structural' },
];

const BUILT_IN_FIELDS = [
  { id: '__status',        name: 'Status',        type: 'status' },
  { id: '__assignees',     name: 'Assignees',     type: 'assignees' },
  { id: '__due_date',      name: 'Due Date',      type: 'date' },
  { id: '__priority',      name: 'Priority',      type: 'priority' },
  { id: '__tags',          name: 'Tags',          type: 'tags' },
  { id: '__time_estimate', name: 'Time Estimate', type: 'time' },
];

// ---------------------------------------------------------------------------
// Workspace list discovery
// ---------------------------------------------------------------------------
async function discoverWorkspaceLists() {
  listSelect.disabled = true;
  refreshListsBtn.textContent = '…';
  try {
    const teamsData = await apiGet('/team');
    const teams = teamsData?.teams ?? [];
    const allLists = [];

    await Promise.all(teams.map(async team => {
      const spacesData = await apiGet(`/team/${team.id}/space?archived=false`);
      const spaces = spacesData?.spaces ?? [];

      await Promise.all(spaces.map(async space => {
        const [foldersData, folderlessData] = await Promise.all([
          apiGet(`/space/${space.id}/folder?archived=false`),
          apiGet(`/space/${space.id}/list?archived=false`),
        ]);

        for (const list of (folderlessData?.lists ?? [])) {
          allLists.push({ id: list.id, name: list.name, path: `${space.name} → ${list.name}` });
        }
        for (const folder of (foldersData?.folders ?? [])) {
          for (const list of (folder.lists ?? [])) {
            allLists.push({ id: list.id, name: list.name, path: `${space.name} → ${folder.name} → ${list.name}` });
          }
        }
      }));
    }));

    allLists.sort((a, b) => a.path.localeCompare(b.path));
    await chromeSetLocal({ workspace_lists: allLists });
    return allLists;
  } catch (_) {
    return [];
  } finally {
    listSelect.disabled = false;
    refreshListsBtn.textContent = '↻';
  }
}

async function populateListDropdown(forceRefresh = false) {
  listSelect.disabled = true;
  refreshListsBtn.textContent = '…';

  try {
    let workspaceLists;
    if (forceRefresh) {
      workspaceLists = await discoverWorkspaceLists();
    } else {
      const cached = await chromeGetLocal('workspace_lists');
      workspaceLists = cached.workspace_lists?.length
        ? cached.workspace_lists
        : await discoverWorkspaceLists();
    }

    // Merge any locally-visited lists not yet in workspace cache
    const local = await chromeGetLocal(null);
    const known = new Map(workspaceLists.map(l => [l.id, l]));
    Object.keys(local).filter(k => k.startsWith('fields_')).forEach(k => {
      const id = k.replace('fields_', '');
      if (!known.has(id)) {
        const name = local[`listname_${id}`] || `List ${id}`;
        known.set(id, { id, name, path: name });
      }
    });

    const all = [...known.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (!all.length) {
      listSelect.innerHTML = '<option value="">— no lists found; check your API token —</option>';
      return;
    }

    listSelect.innerHTML = '<option value="">— Select a list —</option>' +
      all.map(l => `<option value="${escHtml(l.id)}">${escHtml(l.path)}</option>`).join('');
  } finally {
    listSelect.disabled = false;
    refreshListsBtn.textContent = '↻';
  }
}

// ---------------------------------------------------------------------------
// Fetch list fields (cache → API → fallback)
// ---------------------------------------------------------------------------
async function fetchListFields(listId) {
  const cached = await chromeGetLocal(`fields_${listId}`);
  if (cached[`fields_${listId}`]?.length) return cached[`fields_${listId}`];

  try {
    const data = await apiGet(`/list/${listId}/field`);
    const custom = (data?.fields ?? []).map(f => ({ id: f.id, name: f.name, type: f.type, value: '' }));
    const all = [...STRUCTURAL_FIELDS, ...BUILT_IN_FIELDS, ...custom];
    await chromeSetLocal({ [`fields_${listId}`]: all });
    return all;
  } catch {
    return [...STRUCTURAL_FIELDS, ...BUILT_IN_FIELDS];
  }
}

// ---------------------------------------------------------------------------
// Quick-apply template (next to list selector)
// ---------------------------------------------------------------------------
const quickTemplateRow  = document.getElementById('quick-template-row');
const quickTemplateSelect = document.getElementById('quick-template-select');
const quickApplyBtn     = document.getElementById('quick-apply-btn');
const quickTemplateMsg  = document.getElementById('quick-template-msg');

async function populateQuickTemplateSelect() {
  const templates = await getTemplates();
  if (!templates.length) {
    quickTemplateRow.hidden = true;
    return;
  }
  quickTemplateSelect.innerHTML = '<option value="">— apply a saved template —</option>' +
    templates.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)}</option>`).join('');
  quickTemplateRow.hidden = false;
}

quickApplyBtn.addEventListener('click', async () => {
  const id = quickTemplateSelect.value;
  if (!id || (!currentWorkspaceId && !currentListId)) return;

  const templates = await getTemplates();
  const tpl = templates.find(t => t.id === id);
  if (!tpl) return;

  const nameToId = buildNameToId(currentFields);
  currentConfig = {
    tabs: tpl.config.tabs.map(tab => ({
      id: `tab_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: tab.name,
      fieldIds: (tab.fieldNames ?? []).map(n => nameToId.get(n.toLowerCase())).filter(Boolean),
    })),
    rules: (tpl.config.rules ?? []).map(rule => ({
      targetFieldId: nameToId.get(rule.targetFieldName?.toLowerCase()),
      action: rule.action,
      logic: rule.logic,
      conditions: (rule.conditions ?? []).map(c => ({
        fieldId: nameToId.get(c.fieldName?.toLowerCase()),
        operator: c.operator,
        value: c.value,
      })).filter(c => c.fieldId),
    })).filter(r => r.targetFieldId),
    defaultTab: tpl.config.defaultTab ?? null,
  };

  selectedTabId = null;
  fieldAssignSection.hidden = true;
  allFieldsDefaultCb.checked = (currentConfig.defaultTab ?? '__all') === '__all';
  renderTabs();
  renderRules();
  if (currentWorkspaceId && currentTypeKey) {
    await savePreset(currentWorkspaceId, currentTypeKey, currentConfig);
    notifyContentScripts(currentWorkspaceId, currentTypeKey);
  }
  quickTemplateMsg.textContent = `"${tpl.name}" applied.`;
  setTimeout(() => { quickTemplateMsg.textContent = ''; }, 2500);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  listSelect.addEventListener('change', () => {
    const lid = listSelect.value;
    if (lid) loadFieldSource(lid);
  });
  refreshListsBtn.addEventListener('click', () => populateListDropdown(true));
  await populateListDropdown();
  await populateQuickTemplateSelect();

  // Auto-follow: if the user already has a task open in ClickUp, load its type.
  const { cfm_active_type } = await chromeGetLocal('cfm_active_type');
  if (cfm_active_type?.workspaceId && cfm_active_type?.typeKey) {
    await loadTypeContext(cfm_active_type);
  }

  // Reflect any auth error the content script/service worker has already hit.
  refreshAuthErrorBanner();
}

// ---------------------------------------------------------------------------
// Auth-error banner — driven by the cfm_auth_error flag the service worker
// sets on a 401/403 and clears on the next successful API call.
// ---------------------------------------------------------------------------
async function refreshAuthErrorBanner() {
  const { cfm_auth_error } = await chromeGetLocal('cfm_auth_error');
  authErrorBanner.hidden = !cfm_auth_error;
  if (cfm_auth_error) {
    // The flag may be stale (a transient failure, or a token since fixed).
    // Probe /user — if the token actually works the service worker clears the
    // flag on success, and the storage listener hides the banner.
    chrome.runtime.sendMessage({ type: 'CLICKUP_API', path: '/user' }, () => {});
  }
}

authErrorFixBtn.addEventListener('click', () => {
  settingsSection.hidden = false;
  settingsToggleBtn.classList.add('active');
  settingsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sTokenInput.focus();
});

// While the side panel stays open, follow the user as they navigate between
// tasks and switch tabs — update automatically.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Show/hide the token banner as the auth-error flag is set or cleared.
  if (changes.cfm_auth_error) {
    authErrorBanner.hidden = !changes.cfm_auth_error.newValue;
  }

  // Follow task type changes (new task opened).
  if (changes.cfm_active_type) {
    const ctx = changes.cfm_active_type.newValue;
    if (!ctx?.workspaceId || !ctx?.typeKey) return;
    if (editingTemplateId) return;
    // Skip if same type is already loaded.
    if (ctx.workspaceId === currentWorkspaceId && ctx.typeKey === currentTypeKey) {
      // Different list for the same type → refresh field source silently.
      if (ctx.listId && ctx.listId !== currentListId) loadFieldSource(ctx.listId);
      return;
    }
    loadTypeContext(ctx);
  }

  // Follow active tab switches inside the task view.
  if (changes.cfm_active_tab) {
    const { tabId } = changes.cfm_active_tab.newValue ?? {};
    if (!tabId || editingTemplateId) return;

    if (tabId === '__all') {
      // "All Fields" selected — deselect any tab in the panel.
      selectedTabId = null;
      fieldAssignSection.hidden = true;
      renderTabs();
    } else {
      const tab = currentConfig.tabs.find(t => t.id === tabId);
      if (!tab) return;
      selectedTabId = tabId;
      renderTabs();
      renderFieldAssignment();
    }
  }
});

// ---------------------------------------------------------------------------
// Load the task type context and its preset (primary config function).
// Called automatically when cfm_active_type changes, or on init.
// ---------------------------------------------------------------------------
async function loadTypeContext({ workspaceId, typeKey, typeName, listId }) {
  currentWorkspaceId = workspaceId;
  currentTypeKey     = typeKey;
  currentTypeName    = typeName ?? typeKey;
  currentListId      = listId ?? null;
  selectedTabId      = null;

  // Update the type banner UI.
  if (typeContextName) typeContextName.textContent = currentTypeName;
  if (typeContextBanner) typeContextBanner.hidden = false;
  if (typeContextHint)   typeContextHint.hidden   = true;

  // Sync the list dropdown to the field source for this task.
  if (listId) {
    listSelect.value = String(listId);
    // If the dropdown doesn't have this list yet (edge case), add a placeholder.
    if (!listSelect.value || listSelect.value !== String(listId)) {
      const opt = document.createElement('option');
      opt.value = String(listId);
      opt.textContent = currentTypeName + ' list';
      listSelect.prepend(opt);
      listSelect.value = String(listId);
    }
  }

  const [fields, preset] = await Promise.all([
    listId ? fetchListFields(listId) : Promise.resolve([...STRUCTURAL_FIELDS, ...BUILT_IN_FIELDS]),
    loadPreset(workspaceId, typeKey),
  ]);

  currentFields = fields;
  currentConfig = {
    tabs:       preset.tabs       ?? [],
    rules:      preset.rules      ?? [],
    defaultTab: preset.defaultTab ?? null,
  };

  tabsSection.hidden        = false;
  fieldAssignSection.hidden = true;
  rulesSection.hidden       = false;
  templatesSection.hidden   = false;
  saveBar.hidden            = false;

  allFieldsDefaultCb.checked = (currentConfig.defaultTab ?? '__all') === '__all';

  renderTabs();
  renderRules();
  await renderTemplates();
  populateRuleFieldSelects();
  initConditionsBuilder();
}

// ---------------------------------------------------------------------------
// Change the field source (list) without changing the active type context.
// Used when the user manually picks a different list from the dropdown.
// ---------------------------------------------------------------------------
async function loadFieldSource(listId) {
  if (!listId || listId === currentListId) return;
  currentListId = listId;

  const fields = await fetchListFields(listId);
  currentFields = fields;

  // Re-render field assignment UI with updated field list.
  selectedTabId = null;
  fieldAssignSection.hidden = true;
  renderTabs();
  renderRules();
  populateRuleFieldSelects();
  initConditionsBuilder();
}

// ---------------------------------------------------------------------------
// Legacy: load config by list (kept for template editing which still needs
// a list to resolve field names → IDs and does not use task type presets).
// ---------------------------------------------------------------------------
async function loadList(listId) {
  if (!listId) return;
  currentListId = listId;
  selectedTabId = null;

  const fields = await fetchListFields(listId);
  currentFields = fields;

  fieldAssignSection.hidden = true;
  if (tabsSection.hidden) tabsSection.hidden = false;

  renderTabs();
  renderRules();
  populateRuleFieldSelects();
  initConditionsBuilder();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function renderTabs() {
  tabsList.innerHTML = '';

  if (!currentConfig.tabs.length) {
    tabsList.innerHTML = '<p class="empty">No tabs yet. Add one below.</p>';
  }

  currentConfig.tabs.forEach(tab => {
    const fieldCount = (tab.fieldIds ?? []).length;
    const isDefault  = currentConfig.defaultTab === tab.id;
    const item = document.createElement('div');
    item.className = 'tab-item' + (tab.id === selectedTabId ? ' selected' : '');
    item.innerHTML = `
      <span class="tab-name">${escHtml(tab.name)}</span>
      <span class="tab-field-count">${fieldCount} visible</span>
      <label class="tab-default-label" title="Open this tab by default">
        <input type="checkbox" class="tab-default-cb" ${isDefault ? 'checked' : ''}>
        <span>Default</span>
      </label>
      <button class="btn-delete" title="Delete tab">✕</button>
    `;

    // "Default" checkbox — mutually exclusive with "All Fields" default.
    item.querySelector('.tab-default-cb').addEventListener('change', e => {
      e.stopPropagation();
      if (e.target.checked) {
        currentConfig.defaultTab = tab.id;
        allFieldsDefaultCb.checked = false; // deselect "All Fields"
      } else {
        currentConfig.defaultTab = null;
      }
      renderTabs(); // refresh other tabs' checkboxes
      autoSave();
    });

    item.addEventListener('click', e => {
      if (e.target.closest('.btn-delete') || e.target.closest('.tab-default-label')) return;
      selectedTabId = tab.id;
      renderTabs();
      renderFieldAssignment();
    });
    item.querySelector('.btn-delete').addEventListener('click', () => {
      if (currentConfig.defaultTab === tab.id) currentConfig.defaultTab = null;
      currentConfig.tabs = currentConfig.tabs.filter(t => t.id !== tab.id);
      if (selectedTabId === tab.id) { selectedTabId = null; fieldAssignSection.hidden = true; }
      renderTabs();
      autoSave();
    });
    tabsList.appendChild(item);
  });
}

addTabBtn.addEventListener('click', () => {
  const name = newTabName.value.trim();
  if (!name) { newTabName.focus(); return; }
  const tab = { id: `tab_${Date.now()}`, name, fieldIds: [] };
  currentConfig.tabs.push(tab);
  newTabName.value = '';
  selectedTabId = tab.id;
  renderTabs();
  renderFieldAssignment();
  autoSave();
});

newTabName.addEventListener('keydown', e => { if (e.key === 'Enter') addTabBtn.click(); });

// ---------------------------------------------------------------------------
// Field assignment
// ---------------------------------------------------------------------------
function renderFieldAssignment() {
  if (!selectedTabId) { fieldAssignSection.hidden = true; return; }
  const activeTab = currentConfig.tabs.find(t => t.id === selectedTabId);
  if (!activeTab) { fieldAssignSection.hidden = true; return; }

  fieldAssignSection.hidden = false;
  activeTabLabel.textContent = activeTab.name;
  fieldList.innerHTML = '';

  const structural = currentFields.filter(f => f.type === 'structural');
  // Built-in fields (status, assignees, etc.) all live inside cu-task-hero-section,
  // which is already represented by the __s_properties structural section. They can't
  // be toggled individually so we omit them from the field assignment checklist.
  const other = currentFields.filter(
    f => f.type !== 'structural' && !(f.id.startsWith('__') && !f.id.startsWith('__s_'))
  );

  function makeFieldItem(field) {
    const checked = (activeTab.fieldIds ?? []).includes(field.id);
    const item = document.createElement('div');
    item.className = 'field-item';
    item.innerHTML = `
      <input type="checkbox" id="f_${field.id}" ${checked ? 'checked' : ''}>
      <label for="f_${field.id}">${escHtml(field.name)}</label>
      <span class="field-type">${escHtml(field.type === 'structural' ? 'section' : field.type)}</span>
    `;
    item.querySelector('input').addEventListener('change', e => {
      activeTab.fieldIds = activeTab.fieldIds ?? [];
      if (e.target.checked) {
        if (!activeTab.fieldIds.includes(field.id)) activeTab.fieldIds.push(field.id);
      } else {
        activeTab.fieldIds = activeTab.fieldIds.filter(id => id !== field.id);
      }
      renderTabs(); // update count badge
      selectedTabId = activeTab.id; // keep selection after re-render
      autoSave();
    });
    return item;
  }

  if (structural.length) {
    const hdr = document.createElement('p');
    hdr.className = 'field-group-label';
    hdr.textContent = 'Sections';
    fieldList.appendChild(hdr);
    structural.forEach(f => fieldList.appendChild(makeFieldItem(f)));
  }
  if (other.length) {
    const hdr = document.createElement('p');
    hdr.className = 'field-group-label';
    hdr.textContent = 'Fields';
    fieldList.appendChild(hdr);
    other.forEach(f => fieldList.appendChild(makeFieldItem(f)));
  }
}

// ---------------------------------------------------------------------------
// Template edit mode
// ---------------------------------------------------------------------------
let editingTemplateId = null;
let editingTemplateOriginalListId = null;
let editingTemplateOriginalTypeCtx = null; // { workspaceId, typeKey, typeName, listId }

const editTemplateBtn          = document.getElementById('edit-template-btn');
const templateEditPicker       = document.getElementById('template-edit-picker');
const templateEditListSelect   = document.getElementById('template-edit-list-select');
const templateEditBeginBtn     = document.getElementById('template-edit-begin-btn');
const templateEditCancelPicker = document.getElementById('template-edit-cancel-picker-btn');
const templateEditBanner       = document.getElementById('template-edit-banner');
const templateEditBannerName   = document.getElementById('template-edit-banner-name');
const templateEditUpdateBtn    = document.getElementById('template-edit-update-btn');
const templateEditExitBtn      = document.getElementById('template-edit-exit-btn');

editTemplateBtn.addEventListener('click', async () => {
  const id = templateSelect.value;
  if (!id) { setTemplateMsg('Select a template first.'); return; }
  const templates = await getTemplates();
  const tpl = templates.find(t => t.id === id);
  if (!tpl) return;

  // Populate the picker's list dropdown from the main list select
  templateEditListSelect.innerHTML = listSelect.innerHTML;
  templateEditPicker.dataset.tplId   = id;
  templateEditPicker.dataset.tplName = tpl.name;
  // Snapshot current type context so we can restore it after editing.
  editingTemplateOriginalTypeCtx = currentWorkspaceId
    ? { workspaceId: currentWorkspaceId, typeKey: currentTypeKey, typeName: currentTypeName, listId: currentListId }
    : null;

  templateEditPicker.hidden = false;
});

templateEditCancelPicker.addEventListener('click', () => {
  templateEditPicker.hidden = true;
});

templateEditBeginBtn.addEventListener('click', async () => {
  const listId = templateEditListSelect.value;
  if (!listId) { return; }

  const id   = templateEditPicker.dataset.tplId;
  const name = templateEditPicker.dataset.tplName;
  const templates = await getTemplates();
  const tpl = templates.find(t => t.id === id);
  if (!tpl) return;

  templateEditPicker.hidden = true;
  editingTemplateOriginalListId = currentListId;
  editingTemplateId = id;

  // Load the chosen list's available fields, then override config with the template
  await loadList(listId);

  const nameToId = buildNameToId(currentFields);
  currentConfig = {
    tabs: tpl.config.tabs.map(tab => ({
      id: `tab_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: tab.name,
      fieldIds: (tab.fieldNames ?? []).map(n => nameToId.get(n.toLowerCase())).filter(Boolean),
    })),
    rules: (tpl.config.rules ?? []).map(rule => ({
      targetFieldId: nameToId.get(rule.targetFieldName?.toLowerCase()),
      action: rule.action,
      logic: rule.logic,
      conditions: (rule.conditions ?? []).map(c => ({
        fieldId: nameToId.get(c.fieldName?.toLowerCase()),
        operator: c.operator,
        value: c.value,
      })).filter(c => c.fieldId),
    })).filter(r => r.targetFieldId),
    defaultTab: tpl.config.defaultTab ?? null,
  };

  selectedTabId = null;
  fieldAssignSection.hidden = true;
  allFieldsDefaultCb.checked = (currentConfig.defaultTab ?? '__all') === '__all';
  renderTabs();
  renderRules();

  templateEditBannerName.textContent = name;
  templateEditBanner.hidden = false;
});

templateEditUpdateBtn.addEventListener('click', async () => {
  if (!editingTemplateId) return;

  // Show feedback immediately so the user knows the click registered.
  templateEditUpdateBtn.disabled = true;
  const originalText = templateEditUpdateBtn.textContent;
  templateEditUpdateBtn.textContent = 'Saving…';

  try {
    const templates = await getTemplates();
    const idx = templates.findIndex(t => t.id === editingTemplateId);
    if (idx < 0) throw new Error('Template not found in storage.');

    const idToName = new Map(currentFields.map(f => [f.id, f.name]));
    templates[idx].config = {
      tabs: currentConfig.tabs.map(tab => ({
        name: tab.name,
        fieldNames: (tab.fieldIds ?? []).map(id => idToName.get(id)).filter(Boolean),
      })),
      rules: currentConfig.rules.map(rule => ({
        targetFieldName: idToName.get(rule.targetFieldId),
        action: rule.action,
        logic: rule.logic,
        conditions: (rule.conditions ?? []).map(c => ({
          fieldName: idToName.get(c.fieldId),
          operator: c.operator,
          value: c.value,
        })),
      })).filter(r => r.targetFieldName),
      defaultTab: currentConfig.defaultTab,
    };

    await saveTemplates(templates);
    templateEditUpdateBtn.textContent = 'Saved ✓';
    await new Promise(r => setTimeout(r, 800));
    await exitTemplateEditMode();
  } catch (_) {
    templateEditUpdateBtn.textContent = 'Error — try again';
    await new Promise(r => setTimeout(r, 2000));
    templateEditUpdateBtn.disabled = false;
    templateEditUpdateBtn.textContent = originalText;
  }
});

templateEditExitBtn.addEventListener('click', exitTemplateEditMode);

async function exitTemplateEditMode() {
  editingTemplateId = null;
  templateEditBanner.hidden = true;
  await renderTemplates();

  if (editingTemplateOriginalTypeCtx) {
    // Restore the task type context that was active before editing.
    const ctx = editingTemplateOriginalTypeCtx;
    editingTemplateOriginalTypeCtx = null;
    editingTemplateOriginalListId  = null;
    await loadTypeContext(ctx);
  } else if (editingTemplateOriginalListId) {
    // Fallback: restore by list (legacy path).
    listSelect.value = editingTemplateOriginalListId;
    await loadFieldSource(editingTemplateOriginalListId);
    editingTemplateOriginalListId = null;
  } else {
    // Nothing to restore — reset to blank state.
    currentWorkspaceId = null;
    currentTypeKey     = null;
    currentTypeName    = null;
    currentListId      = null;
    currentConfig      = { tabs: [], rules: [] };
    currentFields      = [];
    if (typeContextBanner) typeContextBanner.hidden = true;
    if (typeContextHint)   typeContextHint.hidden   = false;
    tabsSection.hidden        = true;
    fieldAssignSection.hidden = true;
    rulesSection.hidden       = true;
    saveBar.hidden            = true;
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
async function getTemplates() {
  const { cfm_templates } = await chromeGetLocal('cfm_templates');
  return cfm_templates ?? [];
}

async function saveTemplates(templates) {
  await chromeSetLocal({ cfm_templates: templates });
}

async function renderTemplates() {
  const templates = await getTemplates();
  const opts = '<option value="">— select a template —</option>' +
    templates.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)}</option>`).join('');
  templateSelect.innerHTML = opts;
  await populateQuickTemplateSelect();
}

function setTemplateMsg(text, ms = 3000) {
  templateMsg.textContent = text;
  if (ms) setTimeout(() => { templateMsg.textContent = ''; }, ms);
}

saveTemplateBtn.addEventListener('click', async () => {
  const name = templateNameInput.value.trim();
  if (!name) { templateNameInput.focus(); return; }
  if (!currentWorkspaceId && !currentListId) { setTemplateMsg('Open a task in ClickUp first.'); return; }
  if (!(currentConfig.tabs ?? []).length) { setTemplateMsg('Add at least one tab first.'); return; }

  saveTemplateBtn.disabled = true;
  const origText = saveTemplateBtn.textContent;
  saveTemplateBtn.textContent = 'Saving…';

  try {
    const idToName = new Map(currentFields.map(f => [f.id, f.name]));
    const tplConfig = {
      tabs: (currentConfig.tabs ?? []).map(tab => ({
        name: tab.name,
        fieldNames: (tab.fieldIds ?? []).map(id => idToName.get(id)).filter(Boolean),
      })),
      rules: (currentConfig.rules ?? []).map(rule => ({
        targetFieldName: idToName.get(rule.targetFieldId),
        action: rule.action,
        logic: rule.logic,
        conditions: (rule.conditions ?? []).map(c => ({
          fieldName: idToName.get(c.fieldId),
          operator: c.operator,
          value: c.value,
        })),
      })).filter(r => r.targetFieldName),
    };

    const templates = await getTemplates();
    templates.push({ id: `tpl_${Date.now()}`, name, config: tplConfig });
    await saveTemplates(templates);

    templateNameInput.value = '';
    setTemplateMsg(`"${name}" saved.`);
    await renderTemplates();
  } catch (_) {
    setTemplateMsg('Save failed — please try again.');
  } finally {
    saveTemplateBtn.disabled = false;
    saveTemplateBtn.textContent = origText;
  }
});

loadTemplateBtn.addEventListener('click', async () => {
  const id = templateSelect.value;
  if (!id) return;

  const templates = await getTemplates();
  const tpl = templates.find(t => t.id === id);
  if (!tpl) return;

  const nameToId = buildNameToId(currentFields);

  currentConfig = {
    tabs: tpl.config.tabs.map(tab => ({
      id: `tab_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: tab.name,
      fieldIds: (tab.fieldNames ?? []).map(n => nameToId.get(n.toLowerCase())).filter(Boolean),
    })),
    rules: (tpl.config.rules ?? []).map(rule => ({
      targetFieldId: nameToId.get(rule.targetFieldName?.toLowerCase()),
      action: rule.action,
      logic: rule.logic,
      conditions: (rule.conditions ?? []).map(c => ({
        fieldId: nameToId.get(c.fieldName?.toLowerCase()),
        operator: c.operator,
        value: c.value,
      })).filter(c => c.fieldId),
    })).filter(r => r.targetFieldId),
  };

  selectedTabId = null;
  fieldAssignSection.hidden = true;
  renderTabs();
  renderRules();
  setTemplateMsg(`"${tpl.name}" loaded. Click Save Configuration to apply.`);
});

deleteTemplateBtn.addEventListener('click', async () => {
  const id = templateSelect.value;
  if (!id) return;
  const templates = await getTemplates();
  const tpl = templates.find(t => t.id === id);
  if (!tpl || !confirm(`Delete template "${tpl.name}"?`)) return;
  await saveTemplates(templates.filter(t => t.id !== id));
  setTemplateMsg(`"${tpl.name}" deleted.`);
  await renderTemplates();
});

// ---------------------------------------------------------------------------
// Visibility rules
// ---------------------------------------------------------------------------
function populateRuleFieldSelects() {
  document.getElementById('rule-target-field').innerHTML =
    currentFields.map(f => `<option value="${f.id}">${escHtml(f.name)}</option>`).join('');
}

function fieldSelectOpts() {
  return currentFields.map(f => `<option value="${f.id}">${escHtml(f.name)}</option>`).join('');
}

function addConditionRow() {
  const builder = document.getElementById('conditions-builder');
  const row = document.createElement('div');
  row.className = 'condition-row';
  row.innerHTML = `
    <select data-role="condition-field">${fieldSelectOpts()}</select>
    <select data-role="condition-operator">
      <option value="equals">equals</option>
      <option value="not_equals">does not equal</option>
      <option value="is_empty">is empty</option>
      <option value="is_not_empty">is not empty</option>
    </select>
    <input type="text" data-role="condition-value" placeholder="value" />
    <button type="button" class="btn-delete" title="Remove condition">✕</button>
  `;
  row.querySelector('.btn-delete').addEventListener('click', () => row.remove());
  builder.appendChild(row);
}

function initConditionsBuilder() {
  document.getElementById('conditions-builder').innerHTML = '';
  addConditionRow();
}

function gatherConditions() {
  return Array.from(document.querySelectorAll('#conditions-builder .condition-row')).map(row => ({
    fieldId:  row.querySelector('[data-role="condition-field"]').value,
    operator: row.querySelector('[data-role="condition-operator"]').value,
    value:    row.querySelector('[data-role="condition-value"]').value.trim(),
  }));
}

function renderRules() {
  rulesList.innerHTML = '';
  if (!(currentConfig.rules ?? []).length) {
    rulesList.innerHTML = '<p class="empty">No rules yet.</p>';
    return;
  }
  (currentConfig.rules ?? []).forEach((rule, idx) => {
    const targetField = currentFields.find(f => f.id === rule.targetFieldId);
    const logic = rule.logic ?? 'AND';
    const condHtml = (rule.conditions ?? []).map(c => {
      const cf = currentFields.find(f => f.id === c.fieldId);
      const val = c.value ? ` &ldquo;${escHtml(c.value)}&rdquo;` : '';
      return `<em>${escHtml(cf?.name ?? c.fieldId)}</em> ${c.operator.replace(/_/g, ' ')}${val}`;
    }).join(` &nbsp;<strong>${logic}</strong>&nbsp; `);

    const item = document.createElement('div');
    item.className = 'rule-summary';
    item.innerHTML = `
      <div class="rule-text">
        <strong>${rule.action === 'hide' ? 'Hide' : 'Show'}</strong>
        <strong>${escHtml(targetField?.name ?? rule.targetFieldId)}</strong>
        &nbsp;when&nbsp; ${condHtml}
      </div>
      <button class="btn-delete" title="Delete rule">✕</button>
    `;
    item.querySelector('.btn-delete').addEventListener('click', () => {
      currentConfig.rules.splice(idx, 1);
      renderRules();
    });
    rulesList.appendChild(item);
  });
}

document.getElementById('add-condition-btn').addEventListener('click', addConditionRow);

document.getElementById('save-rule-btn').addEventListener('click', () => {
  const targetFieldId = document.getElementById('rule-target-field').value;
  const action        = document.getElementById('rule-action').value;
  const logic         = document.getElementById('rule-logic').value;
  const conditions    = gatherConditions();
  if (!conditions.length) { alert('Add at least one condition.'); return; }

  currentConfig.rules = currentConfig.rules ?? [];
  const existingIdx = currentConfig.rules.findIndex(r => r.targetFieldId === targetFieldId);
  const rule = { targetFieldId, action, logic, conditions };
  if (existingIdx >= 0) currentConfig.rules[existingIdx] = rule;
  else currentConfig.rules.push(rule);

  renderRules();
  initConditionsBuilder();
});

// ---------------------------------------------------------------------------
// Notify content scripts to re-apply config immediately.
// We write a local-storage sentinel instead of using chrome.tabs.sendMessage,
// which requires the `tabs` permission (a known manual-review trigger on the
// Chrome Web Store). Content scripts listen to storage.onChanged for this key.
// ---------------------------------------------------------------------------
function notifyContentScripts(workspaceId, typeKey) {
  chrome.storage.local.set({ cfm_notify: { workspaceId, typeKey, ts: Date.now() } });
}

// ---------------------------------------------------------------------------
// Auto-save (called on every field/tab change for real-time updates)
// ---------------------------------------------------------------------------
let autoSaveTimer;
async function autoSave() {
  if (!currentWorkspaceId || !currentTypeKey) return;
  if (editingTemplateId) return; // edits go to the template, not to the preset
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    await savePreset(currentWorkspaceId, currentTypeKey, currentConfig);
    notifyContentScripts(currentWorkspaceId, currentTypeKey);
    saveStatus.textContent = 'Saved';
    setTimeout(() => { saveStatus.textContent = ''; }, 1500);
  }, 150); // debounce rapid checkbox clicks
}

// ---------------------------------------------------------------------------
// "All Fields" default checkbox — mutually exclusive with per-tab defaults
// ---------------------------------------------------------------------------
allFieldsDefaultCb.addEventListener('change', () => {
  if (allFieldsDefaultCb.checked) {
    currentConfig.defaultTab = '__all';
    renderTabs(); // uncheck any per-tab default checkboxes
  } else {
    currentConfig.defaultTab = null;
  }
  autoSave();
});

// ---------------------------------------------------------------------------
// Save configuration (explicit button still available)
// ---------------------------------------------------------------------------
saveBtn.addEventListener('click', async () => {
  if (!currentWorkspaceId || !currentTypeKey) return;
  clearTimeout(autoSaveTimer);
  await savePreset(currentWorkspaceId, currentTypeKey, currentConfig);
  notifyContentScripts(currentWorkspaceId, currentTypeKey);
  saveStatus.textContent = 'Saved!';
  setTimeout(() => { saveStatus.textContent = ''; }, 2500);
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------
const settingsToggleBtn  = document.getElementById('settings-toggle-btn');
const settingsSection    = document.getElementById('settings-section');
const sTokenInput        = document.getElementById('s-token-input');
const sSaveTokenBtn      = document.getElementById('s-save-token-btn');
const sTokenMsg          = document.getElementById('s-token-msg');
const sAccentColour      = document.getElementById('s-accent-colour');
const sAccentHex         = document.getElementById('s-accent-hex');
const sResetColourBtn    = document.getElementById('s-reset-colour-btn');

const DEFAULT_ACCENT = '#7b68ee';

settingsToggleBtn.addEventListener('click', () => {
  const opening = settingsSection.hidden;
  settingsSection.hidden = !opening;
  settingsToggleBtn.classList.toggle('active', opening);
});

// ── Token ──────────────────────────────────────────────────────────────────
function setTokenMsg(text, color) {
  sTokenMsg.textContent = text;
  sTokenMsg.style.color = color;
}

// Token lives in storage.local (full-access credential, kept off Google sync).
// Fall back to a legacy sync token so the placeholder is correct mid-migration.
chrome.storage.local.get('apiToken', ({ apiToken }) => {
  if (apiToken) { sTokenInput.placeholder = 'Token saved ✓  (paste to replace)'; return; }
  chrome.storage.sync.get('apiToken', ({ apiToken: synced }) => {
    if (synced) sTokenInput.placeholder = 'Token saved ✓  (paste to replace)';
  });
});

sSaveTokenBtn.addEventListener('click', () => {
  const token = sTokenInput.value.trim();
  if (!token) { setTokenMsg('Please enter a token.', '#dc2626'); return; }
  sSaveTokenBtn.disabled = true;
  setTokenMsg('Verifying…', '#6b7280');
  // Verify the candidate token BEFORE persisting it — a failed re-entry must
  // never wipe a previously-working token.
  chrome.runtime.sendMessage({ type: 'VERIFY_TOKEN', token }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      sSaveTokenBtn.disabled = false;
      setTokenMsg('Token invalid — check and try again.', '#dc2626');
      return;
    }
    // Valid → now persist it and clear any standing auth-error flag.
    chrome.storage.local.set({ apiToken: token }, () => {
      chrome.storage.sync.remove('apiToken'); // drop any legacy synced copy
      chrome.storage.local.remove('cfm_auth_error');
      sSaveTokenBtn.disabled = false;
      const username = response.user?.username ?? '';
      sTokenInput.value = '';
      sTokenInput.placeholder = username ? `Saved ✓  (${username})` : 'Token saved ✓';
      setTokenMsg('Token verified!', '#16a34a');
      setTimeout(() => setTokenMsg('', ''), 3000);
    });
  });
});

sTokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') sSaveTokenBtn.click(); });

// ── Accent colour ────────────────────────────────────────────────────────────
function applyAccent(hex) {
  document.documentElement.style.setProperty('--cfm-accent', hex);
  sAccentColour.value = hex;
  sAccentHex.value    = hex;
}

sAccentColour.addEventListener('input', () => {
  applyAccent(sAccentColour.value);
  chrome.storage.sync.set({ accentColor: sAccentColour.value });
});

sAccentHex.addEventListener('input', () => {
  const val = sAccentHex.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    applyAccent(val);
    chrome.storage.sync.set({ accentColor: val });
  } else {
    document.documentElement.style.setProperty('--cfm-accent', val);
  }
});

sAccentHex.addEventListener('blur', () => {
  if (!/^#[0-9a-fA-F]{6}$/.test(sAccentHex.value.trim())) {
    chrome.storage.sync.get('accentColor', ({ accentColor }) => applyAccent(accentColor || DEFAULT_ACCENT));
  }
});

sResetColourBtn.addEventListener('click', () => {
  applyAccent(DEFAULT_ACCENT);
  chrome.storage.sync.set({ accentColor: DEFAULT_ACCENT });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
chrome.storage.sync.get('accentColor', ({ accentColor }) => {
  const hex = accentColor || DEFAULT_ACCENT;
  document.documentElement.style.setProperty('--cfm-accent', hex);
  applyAccent(hex);
});

// Reflect / self-heal the auth-error banner independently of init(), so a
// failure elsewhere in startup can't leave a stale banner stuck on screen.
refreshAuthErrorBanner();

init();
