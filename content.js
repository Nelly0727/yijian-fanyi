// ─── 1. 解除复制限制 ───────────────────────────────────────────────
(function unlockCopy() {
  const style = document.createElement('style');
  style.textContent = '* { user-select: text !important; -webkit-user-select: text !important; }';
  document.head.appendChild(style);
  ['copy', 'cut', 'contextmenu', 'selectstart'].forEach(evt => {
    document.addEventListener(evt, e => e.stopImmediatePropagation(), true);
  });
})();

// ─── 2. API Key 管理 ────────────────────────────────────────────────
let API_KEY = '';
chrome.storage.local.get('apiKey', r => { API_KEY = r.apiKey || ''; });
chrome.storage.onChanged.addListener(changes => {
  if (changes.apiKey) API_KEY = changes.apiKey.newValue;
});

// ─── 3. 气泡元素 ────────────────────────────────────────────────────
const bubble = document.createElement('div');
bubble.id = 'gh-translate-bubble';
bubble.innerHTML = `
  <div class="gh-bubble-inner">
    <div class="gh-bubble-header">
      <span class="gh-bubble-icon">⟡</span>
      <span class="gh-bubble-title">GitHub 助手</span>
      <button class="gh-bubble-close">✕</button>
    </div>
    <div class="gh-bubble-original"></div>
    <div class="gh-bubble-divider"></div>
    <div class="gh-bubble-result">
      <div class="gh-loading"><span></span><span></span><span></span></div>
    </div>
    <div class="gh-bubble-actions">
      <button class="gh-btn gh-copy-original">复制原文</button>
      <button class="gh-btn gh-copy-translated">复制译文</button>
    </div>
  </div>
`;
document.body.appendChild(bubble);

let translatedText = '';
let originalText = '';

bubble.querySelector('.gh-bubble-close').addEventListener('click', hideBubble);
bubble.querySelector('.gh-copy-original').addEventListener('click', () => {
  navigator.clipboard.writeText(originalText);
  flashBtn(bubble.querySelector('.gh-copy-original'), '已复制！');
});
bubble.querySelector('.gh-copy-translated').addEventListener('click', () => {
  if (!translatedText) return;
  navigator.clipboard.writeText(translatedText);
  flashBtn(bubble.querySelector('.gh-copy-translated'), '已复制！');
});

function flashBtn(btn, msg) {
  const orig = btn.textContent;
  btn.textContent = msg;
  btn.classList.add('gh-btn-success');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('gh-btn-success'); }, 1500);
}
function hideBubble() { bubble.classList.remove('gh-bubble-visible'); }
function showBubble(x, y) {
  bubble.classList.add('gh-bubble-visible');
  const bw = 320;
  const left = Math.min(x, window.innerWidth - bw - 16);
  bubble.style.left = left + 'px';
  bubble.style.top = (window.scrollY + y + 12) + 'px';
}
function setResult(text) {
  translatedText = text;
  bubble.querySelector('.gh-bubble-result').innerHTML = `<p class="gh-translated">${escHtml(text)}</p>`;
}
function setLoading() {
  translatedText = '';
  bubble.querySelector('.gh-bubble-result').innerHTML =
    `<div class="gh-loading"><span></span><span></span><span></span></div>`;
}
function setError(msg) {
  bubble.querySelector('.gh-bubble-result').innerHTML = `<p class="gh-error">${escHtml(msg)}</p>`;
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── 4. DeepSeek 翻译（划词）────────────────────────────────────────
async function translate(text) {
  if (!API_KEY) { setError('请先在插件弹窗中填入 DeepSeek API Key'); return; }
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 512,
      messages: [
        { role: 'system', content: `你是 GitHub 专属翻译助手。将用户输入的英文翻译成简洁准确的中文。
规则：
- 技术术语保留英文，括号内给中文解释，例如：fork（复刻）
- 只输出译文，不要任何解释或前缀
- 保持原文的语气和格式` },
        { role: 'user', content: text }
      ]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content || '翻译失败';
}

// ─── 5. 全页翻译按钮 ─────────────────────────────────────────────────
const pageBtn = document.createElement('div');
pageBtn.id = 'gh-page-translate-btn';
pageBtn.innerHTML = `<span class="gh-btn-icon">译</span><span class="gh-btn-label">翻译全页</span>`;
document.body.appendChild(pageBtn);

let isTranslated = false;
const translatedNodes = [];

const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','KBD','VAR','TEXTAREA','INPUT']);

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest('script,style,code,pre')) return NodeFilter.FILTER_REJECT;
      // 插件自身 UI 不翻译
      if (p.closest('#gh-translate-bubble,#gh-page-translate-btn')) return NodeFilter.FILTER_REJECT;
      const text = node.textContent.trim();
      if (text.length < 2) return NodeFilter.FILTER_REJECT;
      if (!/[a-zA-Z]{3,}/.test(text)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

function batchNodes(nodes, maxChars = 1000) {
  const batches = [];
  let cur = [], curLen = 0;
  for (const node of nodes) {
    const t = node.textContent.trim();
    if (curLen + t.length > maxChars && cur.length > 0) {
      batches.push(cur); cur = []; curLen = 0;
    }
    cur.push(node); curLen += t.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function translateBatch(nodes) {
  const SEP = '\n§§\n';
  const combined = nodes.map(n => n.textContent.trim()).join(SEP);
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 2000,
      messages: [
        { role: 'system', content: `你是 GitHub 页面翻译助手。用户发来多段英文，每段之间用 §§ 分隔。
请将每段翻译成中文，同样用 §§ 分隔输出，段数必须和输入完全一致。
规则：
- 技术术语保留英文，括号内给中文，例如 fork（复刻）
- 只输出译文，不加任何解释
- 如果某段本身已是中文或数字符号，原样输出` },
        { role: 'user', content: combined }
      ]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.choices?.[0]?.message?.content || '').split('§§').map(s => s.trim());
}

async function doPageTranslate() {
  if (!API_KEY) { alert('请先在插件弹窗中填入 DeepSeek API Key'); return; }
  pageBtn.classList.add('gh-btn-loading');
  pageBtn.querySelector('.gh-btn-label').textContent = '翻译中…';

  const nodes = collectTextNodes(document.body);
  const batches = batchNodes(nodes);

  translatedNodes.length = 0;
  nodes.forEach(n => translatedNodes.push({ node: n, original: n.textContent }));

  let done = 0;
  for (const batch of batches) {
    try {
      const translations = await translateBatch(batch);
      batch.forEach((node, i) => { if (translations[i]) node.textContent = translations[i]; });
    } catch(e) { console.warn('批次翻译失败', e); }
    done += batch.length;
    pageBtn.querySelector('.gh-btn-label').textContent =
      `翻译中 ${Math.round(done / nodes.length * 100)}%`;
  }

  isTranslated = true;
  pageBtn.classList.remove('gh-btn-loading');
  pageBtn.classList.add('gh-btn-translated');
  pageBtn.querySelector('.gh-btn-icon').textContent = '原';
  pageBtn.querySelector('.gh-btn-label').textContent = '还原英文';
}

function doPageRestore() {
  translatedNodes.forEach(({ node, original }) => { node.textContent = original; });
  isTranslated = false;
  pageBtn.classList.remove('gh-btn-translated', 'gh-btn-loading');
  pageBtn.querySelector('.gh-btn-icon').textContent = '译';
  pageBtn.querySelector('.gh-btn-label').textContent = '翻译全页';
}

pageBtn.addEventListener('click', () => {
  if (isTranslated) doPageRestore();
  else doPageTranslate();
});

// ─── 6. 划词翻译事件 ─────────────────────────────────────────────────
let debounceTimer = null;

document.addEventListener('mouseup', async (e) => {
  if (bubble.contains(e.target) || pageBtn.contains(e.target)) return;
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!text || text.length < 2) { hideBubble(); return; }

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    originalText = text;
    bubble.querySelector('.gh-bubble-original').textContent =
      text.length > 80 ? text.slice(0, 80) + '…' : text;
    showBubble(e.clientX, e.clientY);
    setLoading();
    try {
      const result = await translate(text);
      setResult(result);
    } catch (err) {
      setError('翻译失败：' + err.message);
    }
  }, 300);
});

document.addEventListener('mousedown', (e) => {
  if (!bubble.contains(e.target)) hideBubble();
});
