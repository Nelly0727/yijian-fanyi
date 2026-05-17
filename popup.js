const input = document.getElementById('apiKey');
const status = document.getElementById('status');

// 读取已保存的 key
chrome.storage.local.get('apiKey', r => {
  if (r.apiKey) input.value = r.apiKey;
});

document.getElementById('save').addEventListener('click', () => {
  const key = input.value.trim();
  if (!key) { status.textContent = '请输入 API Key'; status.style.color = '#f85149'; return; }
  chrome.storage.local.set({ apiKey: key }, () => {
    status.textContent = '✓ 已保存';
    status.style.color = '#3fb950';
    setTimeout(() => status.textContent = '', 2000);
  });
});
