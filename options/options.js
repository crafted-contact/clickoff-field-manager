// ClickUp Field Manager — Options page

let currentListId   = null;
let currentFields   = [];        // [{ id, name, type, value }]
let currentConfig   = { tabs: [], rules: [] };
let selectedTabId   = null;

// Elements
const listSelect          = document.getElementById('list-select');
const tabsSection         = document.getElementById('tabs-section');
const tabsList            = document.getElementById('tabs-list');
const newTabName          = document.getElementById('new-tab-name');
const addTabBtn           = document.getElementById('add-tab-btn');
const fieldAssignSection  = document.getElementById('field-assignment-section');
const activeTabLabel      = document.getElementById('active-tab-label');
const fieldList           = document.getElementById('field-list');
const rulesSection        = document.getElementById('rules-section');
const rulesList           = document.getElementById('rules-list');
const saveBar             = document.getElementById('save-bar');
const saveBtn             = document.getElementById('save-btn');
const saveStatus          = document.getElementById('save-status');

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
function chromeGet(keys) {
  return new Promise(resolve => chrome.storage.sync.get(keys, resolve));
}
function chromeSet(data) {
  return new Promise(resolve => chrome.storage.sync.set(data, resolve));
}

// ---------------------------------------------------------------------------
// Init — discover lists from cached field data
// ---------------------------------------------------------------------------
async function init() {
  const allData = await chromeGet(null);
  const listIds = Object.keys(allData)
    .filter(k => k.startsWith('fields_'))
    .map(k => k.replace('fields_', ''));

  if (listIds.length === 0) {
    listSelect.innerHTML = '<option value="">Open a ClickUp task first to detect its list fields.</option>';
    return;
  }

  // Show human-readable list names where cached, fall back to raw ID
  const options = listIds.map(id => {
    const name = allData[`listname_${id}`];
    const label = name ? escHtml(name) : `List ${id}`;
    return `<option value="${id}">${label}</option>`;
  }).join('');

  listSelect.innerHTML = '<option value="">— Select a list —</option>' + options;
  listSelect.addEventListener('change', () => loadList(listSelect.value));
}

// ---------------------------------------------------------------------------
// Load a list's fields and config
// ---------------------------------------------------------------------------
async function loadList(listId) {
  if (!listId) return;
  currentListId = listId;
  selectedTabId = null;

  const data = await chromeGet([`fields_${listId}`, `config_${listId}`]);
  currentFields = data[`fields_${listId}`] ?? [];
  currentConfig = JSON.parse(JSON.stringify(  // deep clone so edits don't mutate storage
    data[`config_${listId}`] ?? { tabs: [], rules: [] }
  ));

  tabsSection.hidden = false;
  fieldAssignSection.hidden = true;
  rulesSection.hidden = false;
  saveBar.hidden = false;

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

  if (currentConfig.tabs.length === 0) {
    tabsList.innerHTML = '<p class="empty">No tabs yet. Add one below.</p>';
  }

  currentConfig.tabs.forEach(tab => {
    const item = document.createElement('div');
    item.className = 'tab-item' + (tab.id === selectedTabId ? ' selected' : '');
    item.innerHTML = `
      <span class="tab-name">${escHtml(tab.name)}</span>
      <button class="btn-delete" data-tab-id="${tab.id}" title="Delete tab">✕</button>
    `;

    // Select tab
    item.addEventListener('click', e => {
      if (e.target.closest('.btn-delete')) return;
      selectedTabId = tab.id;
      renderTabs();
      renderFieldAssignment();
    });

    // Delete tab
    item.querySelector('.btn-delete').addEventListener('click', () => {
      currentConfig.tabs = currentConfig.tabs.filter(t => t.id !== tab.id);
      if (selectedTabId === tab.id) {
        selectedTabId = null;
        fieldAssignSection.hidden = true;
      }
      renderTabs();
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
});

// Allow Enter key to add tab
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

  currentFields.forEach(field => {
    const checked = (activeTab.fieldIds ?? []).includes(field.id);
    const item = document.createElement('div');
    item.className = 'field-item';
    item.innerHTML = `
      <input type="checkbox" id="f_${field.id}" data-field-id="${field.id}" ${checked ? 'checked' : ''}>
      <label for="f_${field.id}">${escHtml(field.name)}</label>
      <span class="field-type">${escHtml(field.type)}</span>
    `;
    item.querySelector('input').addEventListener('change', e => {
      activeTab.fieldIds = activeTab.fieldIds ?? [];
      if (e.target.checked) {
        if (!activeTab.fieldIds.includes(field.id)) activeTab.fieldIds.push(field.id);
      } else {
        activeTab.fieldIds = activeTab.fieldIds.filter(id => id !== field.id);
      }
    });
    fieldList.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Visibility rules
// ---------------------------------------------------------------------------
function populateRuleFieldSelects() {
  const opts = currentFields.map(f => `<option value="${f.id}">${escHtml(f.name)}</option>`).join('');
  document.getElementById('rule-target-field').innerHTML = opts;
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
  addConditionRow(); // start with one blank row
}

function gatherConditions() {
  return Array.from(
    document.querySelectorAll('#conditions-builder .condition-row')
  ).map(row => ({
    fieldId:  row.querySelector('[data-role="condition-field"]').value,
    operator: row.querySelector('[data-role="condition-operator"]').value,
    value:    row.querySelector('[data-role="condition-value"]').value.trim(),
  }));
}

function renderRules() {
  rulesList.innerHTML = '';

  if (!currentConfig.rules.length) {
    rulesList.innerHTML = '<p class="empty">No rules yet.</p>';
    return;
  }

  currentConfig.rules.forEach((rule, idx) => {
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

  if (existingIdx >= 0) {
    currentConfig.rules[existingIdx] = rule; // replace existing rule for this field
  } else {
    currentConfig.rules.push(rule);
  }

  renderRules();
  initConditionsBuilder(); // reset builder
});

// ---------------------------------------------------------------------------
// Save configuration
// ---------------------------------------------------------------------------
saveBtn.addEventListener('click', async () => {
  await chromeSet({ [`config_${currentListId}`]: currentConfig });
  saveStatus.textContent = 'Saved!';
  setTimeout(() => { saveStatus.textContent = ''; }, 2500);
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();
