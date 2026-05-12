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
