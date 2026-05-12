const tokenInput = document.getElementById('token-input');
const saveBtn = document.getElementById('save-btn');
const statusMsg = document.getElementById('status-msg');
const openOptionsBtn = document.getElementById('open-options-btn');

function setStatus(text, color) {
  statusMsg.textContent = text;
  statusMsg.style.color = color;
}

// Show saved state on open
chrome.storage.sync.get('apiToken', ({ apiToken }) => {
  if (apiToken) tokenInput.placeholder = 'Token saved ✓  (paste to replace)';
});

saveBtn.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  if (!token) { setStatus('Please enter a token.', '#dc2626'); return; }

  saveBtn.disabled = true;
  setStatus('Verifying…', '#6b7280');

  // Save first, then verify via the service worker (which needs it in storage)
  chrome.storage.sync.set({ apiToken: token }, () => {
    chrome.runtime.sendMessage({ type: 'CLICKUP_API', path: '/user' }, (response) => {
      saveBtn.disabled = false;

      if (chrome.runtime.lastError || response?.error) {
        setStatus('Token invalid — check and try again.', '#dc2626');
        chrome.storage.sync.remove('apiToken');
        return;
      }

      const username = response?.data?.user?.username ?? '';
      tokenInput.value = '';
      tokenInput.placeholder = username ? `Saved ✓  (${username})` : 'Token saved ✓';
      setStatus('Token verified!', '#16a34a');
      setTimeout(() => setStatus('', ''), 3000);
    });
  });
});

// Enter key submits
tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});

openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
