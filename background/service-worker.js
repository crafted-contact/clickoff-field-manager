const CLICKUP_BASE = 'https://api.clickup.com/api/v2';

// In-memory cache: avoids re-fetching the same path within a session.
// Keyed by path; entries expire after 60 seconds so field values stay fresh.
const cache = new Map();
const CACHE_TTL_MS = 60_000;

function getCached(path) {
  const entry = cache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(path); return null; }
  return entry.data;
}

function setCached(path, data) {
  cache.set(path, { data, ts: Date.now() });
}

async function clickupGet(path, token) {
  const cached = getCached(path);
  if (cached) return cached;

  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    headers: { Authorization: token }
  });
  if (!res.ok) throw new Error(`ClickUp API ${res.status}: ${path}`);
  const data = await res.json();
  setCached(path, data);
  return data;
}

// Invalidate cache entry when a task is re-opened (content script signals this)
function invalidate(path) {
  cache.delete(path);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CLICKUP_INVALIDATE') {
    invalidate(message.path);
    return false;
  }

  if (message.type !== 'CLICKUP_API') return false;

  chrome.storage.sync.get('apiToken', async ({ apiToken }) => {
    if (!apiToken) {
      sendResponse({ error: 'No API token set. Open the extension popup to add one.' });
      return;
    }
    try {
      const data = await clickupGet(message.path, apiToken);
      sendResponse({ data });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  });

  return true; // keep message channel open for async response
});

// ---------------------------------------------------------------------------
// Lemon Squeezy licence API
// ---------------------------------------------------------------------------
const LS_BASE           = 'https://api.lemonsqueezy.com/v1/licenses';
const VALIDATION_TTL_MS = 24 * 60 * 60 * 1000;  // re-check after 24 h
const GRACE_PERIOD_MS   =  7 * 24 * 60 * 60 * 1000; // stay valid 7 days offline

async function lsPost(endpoint, params) {
  const res = await fetch(`${LS_BASE}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

// LICENCE_ACTIVATE — user enters a new key for the first time
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'LICENCE_ACTIVATE') return false;
  (async () => {
    const { key, instanceName } = message;
    try {
      const { ok, json } = await lsPost('activate', {
        license_key: key,
        instance_name: instanceName,
      });
      if (ok && json.activated) {
        const licence = { key, instanceId: json.instance.id, valid: true, checkedAt: Date.now() };
        await chrome.storage.sync.set({ licence });
        sendResponse({ success: true, customerName: json.meta?.customer_name ?? '' });
      } else {
        sendResponse({ success: false, error: json.error ?? 'Invalid licence key.' });
      }
    } catch (err) {
      sendResponse({ success: false, error: 'Network error — check your connection.' });
    }
  })();
  return true;
});

// LICENCE_CHECK — validate stored key; skips network if checked recently
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'LICENCE_CHECK') return false;
  (async () => {
    const { licence } = await chrome.storage.sync.get('licence');
    if (!licence?.key) { sendResponse({ isPro: false }); return; }

    const age = Date.now() - (licence.checkedAt ?? 0);
    if (age < VALIDATION_TTL_MS) { sendResponse({ isPro: licence.valid }); return; }

    try {
      const { ok, json } = await lsPost('validate', {
        license_key: licence.key,
        instance_id: licence.instanceId,
      });
      const valid = ok && json.valid === true;
      await chrome.storage.sync.set({ licence: { ...licence, valid, checkedAt: Date.now() } });
      sendResponse({ isPro: valid });
    } catch {
      // Network failure — honour grace period
      const withinGrace = (Date.now() - licence.checkedAt) < GRACE_PERIOD_MS;
      sendResponse({ isPro: withinGrace && licence.valid });
    }
  })();
  return true;
});

// LICENCE_DEACTIVATE — user removes key; frees up an activation slot on LS
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'LICENCE_DEACTIVATE') return false;
  (async () => {
    const { licence } = await chrome.storage.sync.get('licence');
    if (licence?.key && licence?.instanceId) {
      await lsPost('deactivate', {
        license_key: licence.key,
        instance_id: licence.instanceId,
      }).catch(() => {}); // best-effort
    }
    await chrome.storage.sync.remove('licence');
    sendResponse({ success: true });
  })();
  return true;
});
