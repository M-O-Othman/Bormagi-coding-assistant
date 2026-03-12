// ── Minimal self-contained Markdown renderer ──────────────────────────────
// No external library required — handles headings, bold, italic, code spans,
// fenced code blocks, lists, blockquotes, links, and horizontal rules.

function miniMd(raw) {
  // 1. Extract fenced code blocks before any other processing
  const blocks = [];
  raw = raw.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
    return '\x00' + (blocks.length - 1) + '\x00\n';
  });

  // 2. Inline renderer: protects code spans, then applies bold/italic/links
  function inline(s) {
    const spans = [];
    // Protect inline code spans
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      spans.push(c);
      return '\x01' + (spans.length - 1) + '\x01';
    });
    // HTML-escape the rest (& < > only — * _ [ ] ( ) must survive)
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Bold (** and __)
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic (* and _)
    s = s.replace(/\*([^\s*][^*]*?)\*/g, '<em>$1</em>');
    s = s.replace(/_([^\s_][^_]*?)_/g, '<em>$1</em>');
    // Links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) =>
      '<a href="' + u.replace(/"/g, '&quot;') + '">' + t + '</a>');
    // Restore inline code spans
    s = s.replace(/\x01(\d+)\x01/g, (_, i) =>
      '<code>' + spans[+i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code>');
    return s;
  }

  // 3. Line-by-line pass
  const lines = raw.split('\n');
  const html = [];
  let listType = null;

  function closeList() {
    if (listType) { html.push('</' + listType + '>'); listType = null; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block placeholder
    const cbM = line.match(/^\x00(\d+)\x00$/);
    if (cbM) {
      closeList();
      const b = blocks[+cbM[1]];
      const safe = b.code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html.push('<pre><code class="language-' + (b.lang || 'text') + '">' + safe + '</code></pre>');
      continue;
    }

    // Heading (# – ####)
    const hM = line.match(/^(#{1,4}) (.+)/);
    if (hM) {
      closeList();
      const n = hM[1].length;
      html.push('<h' + n + '>' + inline(hM[2]) + '</h' + n + '>');
      continue;
    }

    // Horizontal rule
    if (/^([-]{3,}|[*]{3,}|[_]{3,})$/.test(line.trim())) {
      closeList();
      html.push('<hr>');
      continue;
    }

    // Blockquote
    const bqM = line.match(/^> ?(.*)/);
    if (bqM) {
      closeList();
      html.push('<blockquote><p>' + inline(bqM[1]) + '</p></blockquote>');
      continue;
    }

    // Unordered list
    const ulM = line.match(/^[-*+] (.*)/);
    if (ulM) {
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push('<li>' + inline(ulM[1]) + '</li>');
      continue;
    }

    // Ordered list
    const olM = line.match(/^\d+\. (.*)/);
    if (olM) {
      if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
      html.push('<li>' + inline(olM[1]) + '</li>');
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      closeList();
      html.push('');
      continue;
    }

    // Paragraph
    closeList();
    html.push('<p>' + inline(line) + '</p>');
  }

  closeList();
  return html.join('\n');
}

const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const typingRow = document.getElementById('typing-row');
const typingLabel = document.getElementById('typing-label');
const agentSel = document.getElementById('agent-selector');
const pillEl = document.getElementById('provider-pill');

let currentContentEl = null;   // .msg-content being streamed
let currentThoughtStrip = null;   // .thought-strip of current row
let currentCursor = null;   // blinking cursor node
let streamBuffer = '';     // raw markdown as it streams in
let isStreaming = false;
let activeAgentId = null;
let activeAgentName = null;
let agentList = [];
let currentModel = '';
let currentMode = 'code';

// ── Input history (↑/↓ arrow key navigation) ──────────────────────────────
const inputHistory = [];
let historyIndex = -1;
let historyDraft = '';

// ── Model pricing table (USD per 1M tokens) ───────────────────────────────
const MODEL_PRICING = {
  'gpt-4o': { in: 5.00, out: 15.00 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'gpt-4-turbo': { in: 10.00, out: 30.00 },
  'gpt-4.5-preview': { in: 75.00, out: 150.00 },
  'o1-preview': { in: 15.00, out: 60.00 },
  'o1-mini': { in: 1.10, out: 4.40 },
  'o3-mini': { in: 1.10, out: 4.40 },
  'claude-opus-4-6': { in: 15.00, out: 75.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-haiku-4-5-20251001': { in: 0.80, out: 4.00 },
  'gemini-2.0-flash': { in: 0.10, out: 0.40 },
  'gemini-1.5-pro': { in: 3.50, out: 10.50 },
  'gemini-1.5-flash': { in: 0.075, out: 0.30 },
  'deepseek-chat': { in: 0.27, out: 1.10 },
  'deepseek-coder': { in: 0.27, out: 1.10 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'qwen-max': { in: 0.80, out: 2.40 },
  'qwen-plus': { in: 0.30, out: 0.90 },
  'qwen-turbo': { in: 0.05, out: 0.20 },
  'qwen-coder-turbo': { in: 0.30, out: 0.90 }
};

// ── Model context limits — injected by ChatViewProvider from src/constants/models.ts ─
const MODEL_CONTEXT_LIMITS = window.__MODEL_CONTEXT_LIMITS || {};

// ── Input auto-resize + history navigation ────────────────────────────────

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); return; }

  // Arrow-key input history
  if (e.key === 'ArrowUp' && inputEl.selectionStart === 0 && inputHistory.length > 0) {
    e.preventDefault();
    if (historyIndex === -1) historyDraft = inputEl.value;
    historyIndex = Math.min(historyIndex + 1, inputHistory.length - 1);
    inputEl.value = inputHistory[historyIndex];
    inputEl.setSelectionRange(0, 0);
    setTimeout(resize, 0);
    return;
  }
  if (e.key === 'ArrowDown' && historyIndex >= 0) {
    e.preventDefault();
    historyIndex--;
    inputEl.value = historyIndex === -1 ? historyDraft : inputHistory[historyIndex];
    const len = inputEl.value.length;
    inputEl.setSelectionRange(len, len);
    setTimeout(resize, 0);
    return;
  }

  setTimeout(resize, 0);
});
inputEl.addEventListener('input', resize);
function resize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

// ── Send ───────────────────────────────────────────────────────────────────

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;
  // Save to input history
  if (inputHistory[0] !== text) inputHistory.unshift(text);
  if (inputHistory.length > 50) inputHistory.length = 50;
  historyIndex = -1;
  historyDraft = '';
  hideEmpty();
  appendUserMsg(text);
  inputEl.value = '';
  inputEl.style.height = 'auto';
  beginStream();
  vscode.postMessage({ type: 'user_message', text });
}

// ── Agent dropdown ─────────────────────────────────────────────────────────

function onDropdownChange() {
  const id = agentSel.value;
  if (!id) return;
  vscode.postMessage({ type: 'select_agent', agentId: id });
}

function populateDropdown(list, activeId) {
  agentList = list;
  agentSel.innerHTML = '<option value="">— Select agent —</option>';

  const configured = list.filter(a => a.configured !== false);
  const unconfigured = list.filter(a => a.configured === false);

  if (configured.length && unconfigured.length) {
    const grpReady = document.createElement('optgroup');
    grpReady.label = 'Ready';
    configured.forEach(a => grpReady.appendChild(makeOption(a)));
    agentSel.appendChild(grpReady);

    const grpSetup = document.createElement('optgroup');
    grpSetup.label = '⚠ Needs API key';
    unconfigured.forEach(a => grpSetup.appendChild(makeOption(a)));
    agentSel.appendChild(grpSetup);
  } else {
    list.forEach(a => agentSel.appendChild(makeOption(a)));
  }

  if (activeId) {
    agentSel.value = activeId;
    setProviderPill(activeId);
  }
}

function makeOption(a) {
  const opt = document.createElement('option');
  opt.value = a.id;
  const ready = a.configured !== false;
  const defLabel = a.usesDefault ? ' (workspace default)' : '';
  opt.textContent = (ready ? '' : '⚠ ') + a.name + '  ·  ' + a.providerType + ' / ' + a.model + defLabel + (ready ? '' : ' — no API key');
  if (!ready) opt.disabled = false; // selectable so user can see the message
  return opt;
}

function setProviderPill(agentId, usingDefault) {
  const a = agentList.find(x => x.id === agentId);
  if (a) {
    const label = usingDefault ? a.providerType + ' [default]' : a.providerType;
    pillEl.textContent = label;
    pillEl.title = 'Click to switch model (' + (currentModel || a.model) + ')';
    pillEl.classList.add('visible');
  } else {
    pillEl.classList.remove('visible');
  }
}

pillEl.addEventListener('click', () => {
  if (pillEl.classList.contains('visible')) {
    vscode.postMessage({ type: 'switch_model' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function hideEmpty() {
  const e = document.getElementById('empty-state');
  if (e) e.remove();
}

function ts() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Append user message ────────────────────────────────────────────────────

function appendUserMsg(text) {
  const row = document.createElement('div');
  row.className = 'msg user';
  row.innerHTML =
    '<div class="msg-header">' +
    '<div class="msg-avatar">U</div>' +
    '<span class="msg-sender">You</span>' +
    '<span class="msg-time">' + ts() + '</span>' +
    '</div>' +
    '<div class="msg-bubble"><div class="msg-content">' + esc(text) + '</div></div>';
  messagesEl.appendChild(row);
  scrollEnd();
}

// ── Start assistant row ────────────────────────────────────────────────────

function beginStream() {
  isStreaming = true;
  sendBtn.disabled = true;
  typingRow.style.display = 'flex';
  typingLabel.textContent = (activeAgentId || 'Agent') + ' is thinking…';
  setStatus((activeAgentName || activeAgentId || 'Agent') + ' is responding…', 'active');

  const label = activeAgentId || 'Agent';
  const initials = label.slice(0, 2).toUpperCase();
  streamBuffer = '';

  const row = document.createElement('div');
  row.className = 'msg assistant';
  row.id = 'stream-row';

  // ── Thought strip (ABOVE the text) ──
  const strip = document.createElement('div');
  strip.className = 'thought-strip';
  strip.innerHTML =
    '<div class="thought-hd" data-action="toggle-strip">' +
    '<span class="thought-hd-icon">⚙</span>' +
    '<span class="thought-hd-label">0 tool actions</span>' +
    '<span class="thought-chevron">▼</span>' +
    '</div>' +
    '<div class="thought-body"></div>';

  // ── Text bubble ──
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  const content = document.createElement('div');
  content.className = 'msg-content streaming';
  content.id = 'stream-content';
  bubble.appendChild(content);

  row.innerHTML =
    '<div class="msg-header">' +
    '<div class="msg-avatar">' + esc(initials) + '</div>' +
    '<span class="msg-sender">' + esc(label) + '</span>' +
    '<span class="msg-time">' + ts() + '</span>' +
    '</div>';
  row.appendChild(strip);
  row.appendChild(bubble);
  messagesEl.appendChild(row);

  currentContentEl = content;
  currentThoughtStrip = strip;

  // blinking cursor
  currentCursor = document.createElement('span');
  currentCursor.className = 'cursor';
  content.appendChild(currentCursor);

  scrollEnd();
}

window.toggleStrip = function (hd) {
  hd.closest('.thought-strip').classList.toggle('open');
};

// ── Stream text delta ──────────────────────────────────────────────────────

function appendDelta(delta) {
  if (!currentContentEl || !currentCursor) return;
  streamBuffer += delta;
  currentCursor.insertAdjacentText('beforebegin', delta);
  scrollEnd();
}

// ── Append thought event ───────────────────────────────────────────────────

// ── Tool category icons ────────────────────────────────────────────────────

const TOOL_CATEGORY_ICONS = {
  read: '📄',
  edit: '✏️',
  write: '✏️',
  search: '🔎',
  run: '▶️',
  git: '🌿',
  fetch: '🌐',
  error: '⚠️',
  thinking: '◎',
};

function getThoughtIcon(event) {
  if (event.type === 'error') return TOOL_CATEGORY_ICONS.error;
  if (event.type === 'thinking') return TOOL_CATEGORY_ICONS.thinking;
  const label = (event.label || '').toLowerCase();
  if (label.includes('read') || label.includes('file')) return TOOL_CATEGORY_ICONS.read;
  if (label.includes('write') || label.includes('edit') || label.includes('patch')) return TOOL_CATEGORY_ICONS.edit;
  if (label.includes('search') || label.includes('grep') || label.includes('find')) return TOOL_CATEGORY_ICONS.search;
  if (label.includes('run') || label.includes('exec') || label.includes('command')) return TOOL_CATEGORY_ICONS.run;
  if (label.includes('git') || label.includes('commit') || label.includes('branch')) return TOOL_CATEGORY_ICONS.git;
  if (label.includes('fetch') || label.includes('http') || label.includes('request')) return TOOL_CATEGORY_ICONS.fetch;
  return event.type === 'tool_result' ? '←' : '→';
}

function appendThought(event) {
  if (!currentThoughtStrip) return;

  const body = currentThoughtStrip.querySelector('.thought-body');
  const counter = currentThoughtStrip.querySelector('.thought-hd-label');

  const icon = getThoughtIcon(event);
  const detail = event.detail ? String(event.detail) : '';
  const isLong = detail.length > 300;
  const detailId = 'td-' + Math.random().toString(36).slice(2);

  const item = document.createElement('div');
  item.className = 'thought-item';
  item.innerHTML =
    '<div class="thought-item-row">' +
    '<span class="t-icon">' + icon + '</span>' +
    '<span class="t-label">' + esc(event.label) + '</span>' +
    (event.durationMs != null ? '<span class="t-duration">' + event.durationMs + 'ms</span>' : '') +
    '</div>' +
    (detail
      ? '<div class="thought-detail' + (isLong ? ' thought-detail-collapsed' : '') + '" id="' + detailId + '">' +
      esc(isLong ? detail.slice(0, 300) + '…' : detail) +
      '</div>' +
      (isLong ? '<button class="thought-expand-btn" data-action="toggle-detail" data-detail-id="' + detailId + '" data-detail-full="' + esc(detail).replace(/"/g, '&quot;') + '">Show more</button>' : '')
      : '');

  body.appendChild(item);

  const n = body.querySelectorAll('.thought-item').length;
  counter.textContent = n + ' tool action' + (n === 1 ? '' : 's');
  scrollEnd();

  // Mirror to log drawer
  appendToDrawer(event);
}

window.toggleThoughtDetail = function (id, btn, fullText) {
  const el = document.getElementById(id);
  if (!el) return;
  const collapsed = el.classList.toggle('thought-detail-collapsed');
  el.innerHTML = collapsed ? fullText.slice(0, 300) + '…' : fullText;
  btn.textContent = collapsed ? 'Show more' : 'Show less';
};

// ── End stream ─────────────────────────────────────────────────────────────

function endStream() {
  isStreaming = false;
  sendBtn.disabled = false;
  typingRow.style.display = 'none';

  const row = document.getElementById('stream-row');
  if (row) row.removeAttribute('id');
  const sc = document.getElementById('stream-content');
  if (sc) {
    sc.removeAttribute('id');
    sc.classList.remove('streaming');
    // Render Markdown from the streamed plain text
    const rawText = (streamBuffer || sc.textContent || '').replace(/\r\n/g, '\n');
    if (rawText.trim()) {
      sc.innerHTML = renderMarkdown(rawText);
      postProcessCodeBlocks(sc);
    }
  }
  streamBuffer = '';
  if (currentCursor) { currentCursor.remove(); currentCursor = null; }

  // Hide strip if no tool calls were made
  if (currentThoughtStrip) {
    const n = currentThoughtStrip.querySelectorAll('.thought-item').length;
    if (n === 0) currentThoughtStrip.style.display = 'none';
  }

  currentContentEl = null;
  currentThoughtStrip = null;
  clearStatus();
}

// ── Markdown rendering ────────────────────────────────────────────────────

const COLLAPSE_THRESHOLD = 30; // lines

/**
 * Parse Markdown text and return HTML using the built-in miniMd renderer.
 */
function renderMarkdown(raw) {
  // Use marked.js if available (injected via ChatViewProvider)
  if (typeof marked !== 'undefined' && marked.parse) {
    try {
      // GFM is enabled by default in marked v17
      return marked.parse(raw, { gfm: true, breaks: true });
    } catch (e) {
      console.error('marked.js error:', e);
    }
  }
  // Fallback to custom mini-renderer
  try {
    return miniMd(raw);
  } catch (e) {
    return '<p>' + esc(raw) + '</p>';
  }
}

/**
 * Post-process code blocks: wrap them with header (language badge + copy btn),
 * and auto-collapse blocks exceeding COLLAPSE_THRESHOLD lines.
 */
function postProcessCodeBlocks(container) {
  const pres = container.querySelectorAll('pre');
  pres.forEach(pre => {
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;

    // Extract language from class="language-xxx"
    const langMatch = (codeEl.className || '').match(/language-(\S+)/);
    const lang = langMatch ? langMatch[1] : '';

    // Mark code element so inline-code styles don't apply
    codeEl.classList.add('code-block-code');

    // Build wrapper
    const wrap = document.createElement('div');
    wrap.className = 'md-code-block-wrap';

    // Header: language badge + copy button
    const header = document.createElement('div');
    header.className = 'md-code-header';
    header.innerHTML =
      '<span class="md-code-lang">' + esc(lang || 'code') + '</span>' +
      '<button class="md-code-copy" data-action="copy-code">Copy</button>';

    // Body
    const body = document.createElement('div');
    body.className = 'md-code-body';

    // Move pre into body
    pre.parentNode.insertBefore(wrap, pre);
    body.appendChild(pre);
    wrap.appendChild(header);
    wrap.appendChild(body);

    // Auto-collapse if > COLLAPSE_THRESHOLD lines
    const lineCount = (codeEl.textContent || '').split('\n').length;
    if (lineCount > COLLAPSE_THRESHOLD) {
      body.classList.add('collapsed');
      const expandBtn = document.createElement('button');
      expandBtn.className = 'md-code-expand';
      expandBtn.textContent = 'Expand (' + lineCount + ' lines)';
      expandBtn.onclick = function () {
        const isCollapsed = body.classList.toggle('collapsed');
        expandBtn.textContent = isCollapsed
          ? 'Expand (' + lineCount + ' lines)'
          : 'Collapse';
      };
      wrap.appendChild(expandBtn);
    }
  });
}

/**
 * Copy code block content to clipboard.
 */
function copyCodeBlock(btn) {
  const wrap = btn.closest('.md-code-block-wrap');
  const code = wrap ? wrap.querySelector('code') : null;
  if (!code) return;
  const text = code.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }).catch(() => {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}

// ── System / error messages ────────────────────────────────────────────────

function appendSystemMsg(text, isError) {
  hideEmpty();
  const cls = isError ? 'error' : 'system';
  const row = document.createElement('div');
  row.className = 'msg ' + cls;
  row.innerHTML =
    '<div class="msg-header">' +
    '<div class="msg-avatar">' + (isError ? '!' : 'B') + '</div>' +
    '<span class="msg-sender">' + (isError ? 'Error' : 'Bormagi') + '</span>' +
    '<span class="msg-time">' + ts() + '</span>' +
    '</div>' +
    '<div class="msg-bubble"><div class="msg-content">' + esc(text) + '</div></div>';
  messagesEl.appendChild(row);
  scrollEnd();
}

// ── Inline action approval cards ──────────────────────────────────────────

const RISK_COLORS = { low: 'var(--vscode-terminal-ansiGreen,#23d18b)', medium: 'var(--vscode-editorWarning-foreground,#cca700)', high: 'var(--vscode-inputValidation-errorBorder,#f14c4c)' };

function showActionCard(id, prompt, actions, meta) {
  // meta: { kind, reason, scope, risk, alternatives }
  hideEmpty();
  const row = document.createElement('div');
  row.className = 'msg action-card';
  row.id = 'action-' + id;

  const btnsHtml = actions.map((a, idx) => {
    const isDeny = idx === actions.length - 1 && actions.length > 1;
    return '<button class="action-btn' + (isDeny ? ' deny-btn' : '') + '" ' +
      'data-action="respond-action" data-card-id="' + esc(id) + '" data-choice="' + esc(a) + '">' +
      esc(a) + '</button>';
  }).join('');

  const riskColor = meta?.risk ? RISK_COLORS[meta.risk] || '' : '';
  const riskBadge = meta?.risk
    ? '<span class="action-risk-badge" style="color:' + riskColor + '">● ' + meta.risk.toUpperCase() + '</span>'
    : '';
  const kindBadge = meta?.kind
    ? '<span class="action-kind-badge">' + esc(meta.kind) + '</span>'
    : '';
  const reasonHtml = meta?.reason
    ? '<div class="action-meta-row"><b>Reason:</b> ' + esc(meta.reason) + '</div>'
    : '';
  const scopeHtml = meta?.scope?.length
    ? '<div class="action-meta-row"><b>Scope:</b> ' + meta.scope.map(s => '<code>' + esc(s) + '</code>').join(', ') + '</div>'
    : '';

  row.innerHTML =
    '<div class="msg-header">' +
    '<div class="msg-avatar">⚡</div>' +
    '<span class="msg-sender">Action Required</span>' +
    (kindBadge || riskBadge ? '<span style="display:flex;gap:4px;margin-left:auto">' + kindBadge + riskBadge + '</span>' : '') +
    '<span class="msg-time">' + ts() + '</span>' +
    '</div>' +
    '<div class="msg-bubble"><div class="msg-content">' +
    '<p>' + esc(prompt) + '</p>' +
    reasonHtml + scopeHtml +
    '<div class="action-btns">' + btnsHtml + '</div>' +
    '</div></div>';

  messagesEl.appendChild(row);
  scrollEnd();
}

window.respondAction = function (id, value) {
  const card = document.getElementById('action-' + id);
  if (card) {
    const btns = card.querySelectorAll('.action-btn');
    btns.forEach(b => {
      b.disabled = true;
      if (b.getAttribute('data-action') === value) b.classList.add('chosen');
    });
    const resolvedNote = document.createElement('div');
    resolvedNote.className = 'action-resolved';
    resolvedNote.textContent = 'You chose: ' + value;
    card.querySelector('.action-btns').replaceWith(resolvedNote);
  }
  vscode.postMessage({ type: 'action_response', id, value });
};

window.sendResume = function () {
  vscode.postMessage({ type: 'user_message', text: '/resume' });
};

window.dismissResume = function (btn) {
  btn.closest('.msg').remove();
};

// ── Misc ───────────────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  'Explain how authentication works in this repo',
  'Fix the failing tests in the checkout flow',
  '/plan migrate from Express to Fastify',
  'Review this diff for security risks',
];

function buildEmptyState() {
  const chips = EXAMPLE_PROMPTS.map(p =>
    '<button class="example-chip" data-action="use-example" data-prompt="' + esc(p) + '">' + esc(p) + '</button>'
  ).join('');
  return '<div id="empty-state">' +
    '<div class="empty-icon">◈</div>' +
    '<div class="empty-title">Bormagi — AI Coding Assistant</div>' +
    '<div class="empty-sub">Ask a question, describe a bug, or request a code change.</div>' +
    '<div class="example-chips">' + chips + '</div>' +
    '</div>';
}

window.useExamplePrompt = function (text) {
  const input = document.getElementById('user-input');
  if (!input) return;
  input.value = text;
  input.focus();
  input.dispatchEvent(new Event('input'));
};

function clearChat() {
  messagesEl.innerHTML = buildEmptyState();
  currentContentEl = currentThoughtStrip = currentCursor = null;
  hideContextRail();
}

function exportConversation() {
  const agentName = activeAgentName || activeAgentId || 'Agent';
  const date = new Date().toISOString().slice(0, 10);
  const lines = ['# Conversation — ' + agentName + ' · ' + date, ''];
  const msgs = messagesEl.querySelectorAll('.msg');
  msgs.forEach(msg => {
    const isUser = msg.classList.contains('user');
    const isAssistant = msg.classList.contains('assistant');
    if (!isUser && !isAssistant) return;
    const sender = msg.querySelector('.msg-sender');
    const content = msg.querySelector('.msg-content');
    if (!sender || !content) return;
    lines.push('## ' + sender.textContent.trim());
    lines.push('');
    lines.push(content.textContent.trim());
    lines.push('');
  });
  const md = lines.join('\n');
  navigator.clipboard.writeText(md).then(() => {
    const orig = pillEl.textContent;
    pillEl.textContent = 'copied!';
    setTimeout(() => { pillEl.textContent = orig; }, 1500);
  }).catch(() => {
    // Fallback: open in new window
    const w = window.open('', '_blank');
    if (w) { w.document.write('<pre>' + md.replace(/</g, '&lt;') + '</pre>'); }
  });
}

function refreshAgents() { vscode.postMessage({ type: 'refresh_agents' }); }
function openDashboard() { vscode.postMessage({ type: 'open_dashboard' }); }
function openMeeting() { vscode.postMessage({ type: 'open_meeting' }); }
function openAgentSettings() { vscode.postMessage({ type: 'open_agent_settings' }); }
function scrollEnd() { messagesEl.scrollTop = messagesEl.scrollHeight; }

// ── Mode picker ────────────────────────────────────────────────────────────

const MODES = [
  { id: 'ask',  label: '💬 Ask' },
  { id: 'plan', label: '📋 Plan' },
  { id: 'code', label: '⌨️ Code' },
];

function initModePicker() {
  const pill = document.getElementById('mode-pill');
  const menu = document.getElementById('mode-menu');
  if (!pill || !menu) return;

  // Build menu items
  MODES.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'mode-option' + (m.id === currentMode ? ' active' : '');
    btn.dataset.mode = m.id;
    btn.textContent = m.label;
    btn.onclick = () => selectMode(m.id, m.label);
    menu.appendChild(btn);
  });

  pill.addEventListener('click', e => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });

  document.addEventListener('click', () => menu.classList.remove('open'));
}

function selectMode(modeId, modeLabel) {
  currentMode = modeId;
  updateModePill(modeLabel || modeId);
  document.getElementById('mode-menu').classList.remove('open');
  vscode.postMessage({ type: 'set_mode', mode: modeId });
  // Persist selection across webview reloads
  const state = vscode.getState() || {};
  vscode.setState({ ...state, mode: modeId });
}

function updateModePill(label) {
  const pill = document.getElementById('mode-pill');
  if (!pill) return;
  // Keep the chevron span, update only the text node
  pill.childNodes[0].textContent = label + ' ';
  // Update active state in menu
  document.querySelectorAll('.mode-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });
}

// ── Context rail ───────────────────────────────────────────────────────────

let activePlan = null;

window.toggleContextRail = function () {
  document.getElementById('context-rail').classList.toggle('collapsed');
};

function showContextRail(items) {
  const rail = document.getElementById('context-rail');
  const body = document.getElementById('context-rail-body');
  if (!rail || !body) return;
  body.innerHTML = '';
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'ctx-rail-item';
    el.innerHTML =
      '<span class="ctx-rail-item-icon">' + (item.icon || '◆') + '</span>' +
      '<span class="ctx-rail-item-label">' + esc(item.label) + '</span>' +
      (item.status ? '<span class="ctx-rail-status">' + esc(item.status) + '</span>' : '');
    body.appendChild(el);
  });
  rail.classList.add('visible');
}

function hideContextRail() {
  const rail = document.getElementById('context-rail');
  if (rail) {
    rail.classList.remove('visible');
    activePlan = null;
  }
}

// ── Context update (full rail from backend) ────────────────────────────────

function showContextUpdate(items, tokenHealth) {
  const rail = document.getElementById('context-rail');
  const body = document.getElementById('context-rail-body');
  const titleEl = document.getElementById('context-rail-title');
  if (!rail || !body) return;

  // Update header with token health badge
  const healthClass = 'th-' + (tokenHealth || 'healthy');
  const healthLabel = tokenHealth === 'near-limit' ? 'Near limit' : tokenHealth === 'busy' ? 'Busy' : 'Healthy';
  if (titleEl) {
    titleEl.innerHTML =
      'Active Context &nbsp;<span class="token-health-badge ' + healthClass + '">' + healthLabel + '</span>';
  }

  body.innerHTML = '';
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'ctx-rail-item ctx-rail-item-full';
    el.dataset.itemId = item.id;

    const typeIcon = item.itemType === 'file' ? '📄'
      : item.itemType === 'instruction' ? '📜'
        : item.itemType === 'reference' ? '🔗'
          : item.itemType === 'checkpoint' ? '🔖'
            : item.itemType === 'mode' ? '◈'
              : '◆';

    const tokBadge = item.estimatedTokens
      ? '<span class="ctx-tok-badge">' + (item.estimatedTokens > 999 ? Math.round(item.estimatedTokens / 1000) + 'k' : item.estimatedTokens) + '</span>'
      : '';
    const removeBtn = item.removable
      ? '<button class="ctx-remove-btn" title="Remove from context" data-action="remove-ctx-item" data-item-id="' + esc(item.id) + '">×</button>'
      : '';

    el.innerHTML =
      '<span class="ctx-rail-item-icon">' + typeIcon + '</span>' +
      '<span class="ctx-rail-item-label" title="' + esc(item.source) + '">' + esc(item.label) + '</span>' +
      tokBadge +
      removeBtn;

    body.appendChild(el);
  });

  rail.classList.add('visible');
}

window.removeContextItem = function (itemId) {
  vscode.postMessage({ type: 'remove_context_item', itemId });
  // Optimistically remove from rail
  const rail = document.getElementById('context-rail-body');
  if (rail) {
    const el = rail.querySelector('[data-item-id="' + itemId + '"]');
    if (el) el.remove();
  }
};

function refreshContextRail() {
  if (!activePlan) { hideContextRail(); return; }
  const total = activePlan.milestones.length;
  const done = activePlan.milestones.filter(m => m.status === 'done').length;
  const items = [
    { icon: '📋', label: activePlan.objective, status: done + '/' + total },
    ...activePlan.milestones.map(m => ({
      icon: m.status === 'done' ? '✓' : m.status === 'blocked' ? '⊘' : '○',
      label: m.title,
      status: m.status !== 'todo' ? m.status : undefined,
    })),
  ];
  showContextRail(items);
}

// ── Plan card ──────────────────────────────────────────────────────────────

function showPlanArtifact(plan) {
  hideEmpty();
  activePlan = plan;
  refreshContextRail();

  const row = document.createElement('div');
  row.className = 'msg system';
  row.dataset.planId = plan.id;

  const total = plan.milestones.length;
  const done = plan.milestones.filter(m => m.status === 'done').length;

  const milestonesHtml = plan.milestones.map((ms, idx) => {
    const isDone = ms.status === 'done';
    return '<div class="plan-milestone">' +
      '<input type="checkbox" ' + (isDone ? 'checked' : '') + ' ' +
      'data-action="toggle-milestone" data-plan-id="' + esc(plan.id) + '" data-idx="' + idx + '">' +
      '<span class="plan-milestone-text' + (isDone ? ' done' : '') + '">' + esc(ms.title) + '</span>' +
      '</div>';
  }).join('');

  const decisionsHtml = plan.decisions && plan.decisions.length
    ? '<div class="plan-card-decisions">Decisions: ' + esc(plan.decisions[plan.decisions.length - 1]) + '</div>'
    : '';

  row.innerHTML =
    '<div class="msg-header">' +
    '<div class="msg-avatar">📋</div>' +
    '<span class="msg-sender">Plan</span>' +
    '<span class="msg-time">' + ts() + '</span>' +
    '</div>' +
    '<div class="msg-bubble"><div class="msg-content">' +
    '<div class="plan-card">' +
    '<div class="plan-card-header">' +
    '<span class="plan-card-icon">📋</span>' +
    '<span class="plan-card-title">' + esc(plan.objective) + '</span>' +
    '<span class="plan-card-badge">' + done + '/' + total + '</span>' +
    '</div>' +
    milestonesHtml +
    decisionsHtml +
    '</div>' +
    '</div></div>';

  messagesEl.appendChild(row);
  scrollEnd();
}

window.toggleMilestone = function (planId, idx, checked) {
  if (!activePlan || activePlan.id !== planId) return;
  activePlan.milestones[idx].status = checked ? 'done' : 'todo';
  refreshContextRail();
  // Update the text styling inline
  const card = messagesEl.querySelector('[data-plan-id="' + planId + '"]');
  if (card) {
    const texts = card.querySelectorAll('.plan-milestone-text');
    if (texts[idx]) texts[idx].classList.toggle('done', checked);
  }
};

// ── Diff summary card ──────────────────────────────────────────────────────

function showDiffSummary(msg) {
  // OQ-8 B: only show for 2+ files changed
  if (!msg.changedFiles || msg.changedFiles.length < 2) return;

  hideEmpty();
  const row = document.createElement('div');
  row.className = 'msg system';

  const filesHtml = msg.changedFiles.map(f => '<li>' + esc(f) + '</li>').join('');
  const risksHtml = msg.risks && msg.risks.length
    ? '<div class="diff-card-risks">⚠ ' + msg.risks.map(r => esc(r)).join(' · ') + '</div>'
    : '';
  const cpHtml = msg.checkpointRef
    ? '<div class="diff-card-checkpoint">Checkpoint: ' + esc(msg.checkpointRef) + '</div>'
    : '';

  row.innerHTML =
    '<div class="msg-header">' +
    '<div class="msg-avatar">±</div>' +
    '<span class="msg-sender">Changes</span>' +
    '<span class="msg-time">' + ts() + '</span>' +
    '</div>' +
    '<div class="msg-bubble"><div class="msg-content">' +
    '<div class="diff-card">' +
    '<div class="diff-card-header">' +
    '<span class="diff-card-icon">±</span>' +
    '<span class="diff-card-title">' + esc(msg.intent || 'Files changed') + '</span>' +
    '</div>' +
    '<ul class="diff-file-list">' + filesHtml + '</ul>' +
    risksHtml +
    cpHtml +
    '</div>' +
    '</div></div>';

  messagesEl.appendChild(row);
  scrollEnd();
}

// ── Extension → WebView messages ──────────────────────────────────────────

window.addEventListener('message', e => {
  const m = e.data;
  switch (m.type) {

    case 'text_delta':
      appendDelta(m.delta);
      break;

    case 'text_done':
      endStream();
      break;

    case 'thought':
      appendThought(m.event);
      break;

    case 'error':
      endStream();
      appendSystemMsg(m.message, true);
      setStatus('Error: ' + m.message + ' — check Settings for API key', 'error');
      break;

    case 'agent_changed':
      activeAgentId = m.agentId;
      activeAgentName = m.agentName;
      currentModel = m.model;
      agentSel.value = m.agentId;
      setProviderPill(m.agentId, m.usingDefault);
      typingLabel.textContent = (m.agentName || m.agentId) + ' is thinking…';
      break;

    case 'agent_list':
      populateDropdown(m.agents, m.activeAgentId);
      if (m.activeAgentId) activeAgentId = m.activeAgentId;
      break;

    case 'undo_result':
      endStream();
      appendSystemMsg(m.message, false);
      break;

    case 'git_status':
      const gs = document.getElementById('git-status');
      const cp = document.getElementById('checkpoint-pill');
      if (gs && m.status) {
        gs.textContent = `🎋 ${m.status.branch || 'detached'}`;
        gs.title = m.status.isDirty ? 'Workspace has uncommitted changes' : 'Workspace is clean';
        if (m.status.isDirty) gs.classList.add('dirty');
        else gs.classList.remove('dirty');
      }
      if (cp) {
        if (m.checkpointId) {
          cp.textContent = `📍 ${m.checkpointId.substring(0, 8)}`;
          cp.classList.add('visible');
        } else {
          cp.classList.remove('visible');
        }
      }
      break;

    case 'token_usage':
      currentModel = m.model || currentModel;
      updateTokenStats(m.lastInputTokens, m.sessionInputTokens, m.sessionOutputTokens);
      break;

    case 'model_switched':
      currentModel = m.model;
      // Update pill with new model name without changing usingDefault state
      if (pillEl.classList.contains('visible')) {
        pillEl.title = 'Click to switch model (' + m.model + ')';
      }
      appendSystemMsg('Model switched to ' + m.model, false);
      break;

    case 'wf_command_result':
      endStream();
      appendSystemMsg(m.message, false);
      break;

    case 'action_request':
      showActionCard(m.id, m.prompt, m.actions, { kind: m.kind, reason: m.reason, scope: m.scope, risk: m.risk });
      break;

    case 'mode_changed': {
      currentMode = m.mode;
      // Prefer the full emoji label from MODES; fall back to backend modeLabel
      const _modeEntry = MODES.find(x => x.id === m.mode);
      updateModePill(_modeEntry ? _modeEntry.label : (m.modeLabel || m.mode));
      break;
    }

    case 'compaction_notice': {
      const row = document.createElement('div');
      row.className = 'msg compaction';
      const dropped = m.droppedCount || 0;
      row.innerHTML =
        '<div class="msg-header">' +
        '<div class="msg-avatar">↻</div>' +
        '<span class="msg-sender">Bormagi</span>' +
        '<span class="msg-time">' + ts() + '</span>' +
        '</div>' +
        '<div class="msg-bubble"><div class="msg-content compaction-notice">' +
        'Conversation compacted — ' + dropped + ' older turn' + (dropped === 1 ? '' : 's') + ' trimmed to stay within context limits.' +
        '</div></div>';
      messagesEl.appendChild(row);
      scrollEnd();
      break;
    }

    case 'checkpoint_created': {
      const row = document.createElement('div');
      row.className = 'msg checkpoint-notice';
      row.innerHTML =
        '<div class="msg-header">' +
        '<div class="msg-avatar">📍</div>' +
        '<span class="msg-sender">Checkpoint</span>' +
        '<span class="msg-time">' + ts() + '</span>' +
        '</div>' +
        '<div class="msg-bubble"><div class="msg-content">' +
        '<strong>' + esc(m.label || 'Checkpoint created') + '</strong>' +
        (m.changedFiles && m.changedFiles.length
          ? '<br><span style="font-size:11px;opacity:0.7">' + m.changedFiles.length + ' file' + (m.changedFiles.length === 1 ? '' : 's') + ' saved</span>'
          : '') +
        '</div></div>';
      messagesEl.appendChild(row);
      scrollEnd();
      break;
    }

    case 'plan_artifact':
      showPlanArtifact(m.plan);
      break;

    case 'diff_summary':
      showDiffSummary(m);
      break;

    case 'context_update':
      showContextUpdate(m.items, m.tokenHealth);
      break;

    case 'resume_state': {
      hideEmpty();
      const row = document.createElement('div');
      row.className = 'msg system';
      row.innerHTML =
        '<div class="msg-header">' +
        '<div class="msg-avatar">▶</div>' +
        '<span class="msg-sender">Resume</span>' +
        '<span class="msg-time">' + ts() + '</span>' +
        '</div>' +
        '<div class="msg-bubble"><div class="msg-content">' +
        '<div class="resume-card">' +
        '<div class="resume-card-title">' + esc(m.taskTitle || 'Previous Task') + '</div>' +
        '<div class="resume-card-row">Mode: <span>' + esc(m.mode || 'ask') + '</span></div>' +
        (m.lastSummary ? '<div class="resume-card-row">Last: <span>' + esc(m.lastSummary) + '</span></div>' : '') +
        (m.nextAction ? '<div class="resume-card-row">Next: <span>' + esc(m.nextAction) + '</span></div>' : '') +
        '<div class="resume-card-actions">' +
        '<button class="action-btn" data-action="send-resume">Resume</button>' +
        '<button class="action-btn deny-btn" data-action="dismiss-resume">Dismiss</button>' +
        '</div>' +
        '</div>' +
        '</div></div>';
      messagesEl.appendChild(row);
      scrollEnd();
      break;
    }
  }
});

function updateTokenStats(lastIn, sessIn, sessOut) {
  const fmt = n => n.toLocaleString();
  document.getElementById('tok-ctx-val').textContent = fmt(lastIn);
  document.getElementById('tok-in-val').textContent = fmt(sessIn);
  document.getElementById('tok-out-val').textContent = fmt(sessOut);
  // Cost estimate
  const p = MODEL_PRICING[currentModel];
  if (p) {
    const costUsd = (sessIn / 1e6) * p.in + (sessOut / 1e6) * p.out;
    const costStr = costUsd < 0.0001 ? '<$0.0001' : '$' + costUsd.toFixed(4);
    document.getElementById('tok-cost-val').textContent = costStr;
  }
  document.getElementById('token-stats').classList.add('visible');

  // Near-capacity badge on chat input
  const limit = MODEL_CONTEXT_LIMITS[currentModel] ?? 0;
  const badge = document.getElementById('ctx-badge');
  if (badge && limit > 0 && lastIn >= limit * 0.8) {
    const pct = Math.round((lastIn / limit) * 100);
    badge.textContent = `⚠ Context ${pct}% full — oldest turns may be trimmed on next message`;
    badge.classList.add('visible');
  } else if (badge) {
    badge.classList.remove('visible');
  }
}

// ── Status bar ─────────────────────────────────────────────────────────────

let sbTimer = null;

function setStatus(text, state /* 'idle'|'active'|'error' */, autoClearMs) {
  const bar = document.getElementById('status-bar');
  const dot = document.getElementById('sb-dot');
  const txt = document.getElementById('sb-text');
  if (!bar) { return; }
  clearTimeout(sbTimer);
  bar.classList.add('visible');
  dot.className = state === 'active' ? 'active' : state === 'error' ? 'error' : '';
  txt.textContent = text;
  if (autoClearMs) { sbTimer = setTimeout(clearStatus, autoClearMs); }
}

function clearStatus() {
  const bar = document.getElementById('status-bar');
  if (bar) { bar.classList.remove('visible'); }
}

function dismissStatus() { clearStatus(); }

// ── Overflow menu ──────────────────────────────────────────────────────────

function toggleOverflow() {
  document.getElementById('overflow-dropdown').classList.toggle('open');
}

function closeOverflow() {
  document.getElementById('overflow-dropdown').classList.remove('open');
}

// Close overflow when clicking outside of it
document.addEventListener('click', e => {
  const wrap = document.getElementById('overflow-wrap');
  if (wrap && !wrap.contains(e.target)) {
    closeOverflow();
  }
});

// ── Log drawer ─────────────────────────────────────────────────────────────

let drawerOpen = false;

function toggleDrawer() {
  drawerOpen = !drawerOpen;
  document.getElementById('log-drawer').classList.toggle('open', drawerOpen);
  document.getElementById('log-toggle-btn').classList.toggle('active', drawerOpen);
}

function appendToDrawer(event) {
  const feed = document.getElementById('log-feed');
  const empty = document.getElementById('log-empty');
  if (empty) { empty.remove(); }

  const icon = event.type === 'tool_call' ? '→' :
    event.type === 'tool_result' ? '←' :
      event.type === 'thinking' ? '◎' : '⚠';

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML =
    '<div class="log-entry-hd">' +
    '<span>' + icon + '</span>' +
    '<span>' + esc(event.label) + '</span>' +
    '</div>' +
    (event.detail
      ? '<div class="log-entry-detail">' + esc(String(event.detail).slice(0, 400)) + '</div>'
      : '');
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

// Boot — restore persisted state
const _savedState = vscode.getState();
if (_savedState?.mode) {
  const _saved = MODES.find(m => m.id === _savedState.mode);
  if (_saved) {
    currentMode = _saved.id;
  }
}
initModePicker();

// ── Wire toolbar button event listeners (CSP: no inline handlers allowed) ──
agentSel.addEventListener('change', onDropdownChange);
sendBtn.addEventListener('click', sendMessage);

document.getElementById('btn-refresh-agents')?.addEventListener('click', refreshAgents);
document.getElementById('btn-clear-chat')?.addEventListener('click', clearChat);
document.getElementById('btn-agent-settings')?.addEventListener('click', openAgentSettings);
document.getElementById('btn-open-meeting')?.addEventListener('click', openMeeting);
document.getElementById('log-toggle-btn')?.addEventListener('click', toggleDrawer);
document.getElementById('log-close')?.addEventListener('click', toggleDrawer);
document.getElementById('sb-dismiss')?.addEventListener('click', dismissStatus);
document.getElementById('btn-overflow')?.addEventListener('click', toggleOverflow);
document.getElementById('btn-export')?.addEventListener('click', () => { exportConversation(); closeOverflow(); });
document.getElementById('btn-dashboard')?.addEventListener('click', () => { openDashboard(); closeOverflow(); });
document.getElementById('checkpoint-pill')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'open_checkpoints' });
});
document.getElementById('context-rail-header')?.addEventListener('click', toggleContextRail);

// ── Delegated event handlers (CSP: no inline handlers in dynamic HTML) ──────
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case 'toggle-strip': {
      toggleStrip(el);
      break;
    }
    case 'toggle-detail': {
      const id = el.dataset.detailId;
      const full = el.dataset.detailFull || '';
      const target = document.getElementById(id);
      if (!target) break;
      const collapsed = target.classList.toggle('thought-detail-collapsed');
      target.innerHTML = collapsed ? full.slice(0, 300) + '…' : full;
      el.textContent = collapsed ? 'Show more' : 'Show less';
      break;
    }
    case 'copy-code': {
      copyCodeBlock(el);
      break;
    }
    case 'respond-action': {
      respondAction(el.dataset.cardId, el.dataset.choice);
      break;
    }
    case 'use-example': {
      window.useExamplePrompt(el.dataset.prompt || '');
      break;
    }
    case 'remove-ctx-item': {
      window.removeContextItem(el.dataset.itemId);
      break;
    }
    case 'send-resume': {
      window.sendResume();
      break;
    }
    case 'dismiss-resume': {
      el.closest('.msg')?.remove();
      break;
    }
  }
});

document.addEventListener('change', e => {
  const el = e.target.closest('[data-action="toggle-milestone"]');
  if (!el) return;
  window.toggleMilestone(el.dataset.planId, parseInt(el.dataset.idx, 10), el.checked);
});

vscode.postMessage({ type: 'refresh_agents' });
