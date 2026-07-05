const CLICKUP_BASE = 'https://api.clickup.com/api/v2';

// Open the side panel when the user clicks the extension icon.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

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
  if (cached) {
    // A served cache entry still proves the token works — clear any stale flag.
    chrome.storage.local.remove('cfm_auth_error');
    return cached;
  }

  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    headers: { Authorization: token }
  });
  if (!res.ok) {
    // Only 401 means the token itself is invalid/expired/revoked — flag it so
    // the side panel prompts the user to re-verify. A 403 means the token is
    // valid but lacks access to THIS resource (e.g. a task in a restricted
    // space); re-entering a token can't fix that, so it must NOT set the flag.
    if (res.status === 401) {
      chrome.storage.local.set({ cfm_auth_error: { status: 401, path, ts: Date.now() } });
    }
    throw new Error(`ClickUp API ${res.status}: ${path}`);
  }
  const data = await res.json();
  // A successful call proves the token works — clear any stale auth-error flag.
  chrome.storage.local.remove('cfm_auth_error');
  setCached(path, data);
  return data;
}

// Invalidate cache entry when a task is re-opened (content script signals this)
function invalidate(path) {
  cache.delete(path);
}

// Read the API token from chrome.storage.local. A ClickUp personal token grants
// full account access, so we keep it on-device rather than syncing it through
// the user's Google account. Older builds stored it in storage.sync — migrate
// that token to local transparently the first time we need it.
async function getApiToken() {
  const { apiToken } = await chrome.storage.local.get('apiToken');
  if (apiToken) return apiToken;

  const synced = await chrome.storage.sync.get('apiToken');
  if (synced.apiToken) {
    await chrome.storage.local.set({ apiToken: synced.apiToken });
    await chrome.storage.sync.remove('apiToken');
    return synced.apiToken;
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CLICKUP_INVALIDATE') {
    invalidate(message.path);
    return false;
  }

  if (message.type !== 'CLICKUP_API') return false;

  (async () => {
    const apiToken = await getApiToken();
    if (!apiToken) {
      sendResponse({ error: 'No API token set. Open the extension settings to add one.' });
      return;
    }
    try {
      const data = await clickupGet(message.path, apiToken);
      sendResponse({ data });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});

// VERIFY_TOKEN — test a candidate token against /user WITHOUT writing it to
// storage. Lets the options page validate a new token before persisting it, so
// a failed re-entry never clobbers a previously-working token.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'VERIFY_TOKEN') return false;
  (async () => {
    try {
      const res = await fetch(`${CLICKUP_BASE}/user`, {
        headers: { Authorization: message.token ?? '' }
      });
      if (!res.ok) { sendResponse({ ok: false, status: res.status }); return; }
      const data = await res.json();
      sendResponse({ ok: true, user: data.user });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});
