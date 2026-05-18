// 채팅 UI 메인 스크립트 (ESM).
// markdown 렌더러는 백엔드 정적 라우트 화이트리스트가 /markdown.js를 포함하지 않아
// 별도 파일로 import할 수 없어 이 파일에 inline으로 포함.

// ---------------- Markdown 렌더러 ----------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(text) {
  // 입력은 이미 escapeHtml 처리된 문자열을 받는다.
  // 코드 → 링크 → bold → italic 순으로 placeholder 치환.
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`);
    return `${codes.length - 1}`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safeUrl = /^(https?:|mailto:|#|\/)/i.test(url) ? url : '#';
    const external = /^https?:/i.test(safeUrl);
    const attr = external ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${safeUrl}"${attr}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/(\d+)/g, (_, i) => codes[Number(i)] ?? '');
  return s;
}

function renderTableRow(rowText, tag) {
  const cells = rowText
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => `<${tag}>${renderInline(escapeHtml(c.trim()))}</${tag}>`)
    .join('');
  return `<tr>${cells}</tr>`;
}

export function renderMarkdown(src) {
  if (typeof src !== 'string' || !src) return '';
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 코드 블록
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing ```
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 헤더
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(h[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // 표: header | separator | rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}.*\|/.test(lines[i + 1])) {
      const header = line;
      i += 2; // header + separator
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      const thead = `<thead>${renderTableRow(header, 'th')}</thead>`;
      const tbody = `<tbody>${rows.map(r => renderTableRow(r, 'td')).join('')}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // 순서 없는 리스트
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map(t => `<li>${renderInline(escapeHtml(t))}</li>`).join('')}</ul>`);
      continue;
    }

    // 순서 있는 리스트
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map(t => `<li>${renderInline(escapeHtml(t))}</li>`).join('')}</ol>`);
      continue;
    }

    // 빈 줄 → 단락 구분
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 일반 단락 (다음 빈 줄/블록까지)
    const para = [];
    while (i < lines.length && lines[i].trim() !== ''
        && !/^```/.test(lines[i])
        && !/^(#{1,6})\s+/.test(lines[i])
        && !/^\s*[-*]\s+/.test(lines[i])
        && !/^\s*\d+\.\s+/.test(lines[i])
        && !(/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}.*\|/.test(lines[i + 1]))) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(escapeHtml(para.join('\n')))}</p>`);
  }
  return out.join('\n');
}

// ---------------- State ----------------

const state = {
  sessionId: null,
  pendingPdf: null,
  persona: 'neutral',
  busy: false,
  messages: [],
};

const MAX_BYTES = 50 * 1024 * 1024;
const STATUS_LABEL = {
  supported: 'supported',
  partially_supported: 'partial',
  unsupported: 'unsupported',
  contradicted: 'contradicted',
};

// ---------------- DOM 참조 ----------------

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const composerInput = $('composerInput');
const sendBtn = $('sendBtn');
const attachBtn = $('attachBtn');
const fileInput = $('fileInput');
const attachmentChip = $('attachmentChip');
const attachName = $('attachName');
const attachSize = $('attachSize');
const attachClear = $('attachClear');
const composerHint = $('composerHint');
const dropOverlay = $('dropOverlay');
const openSettingsBtn = $('openSettingsBtn');
const newAnalysisBtn = $('newAnalysisBtn');
const settingsModal = $('settingsModal');
const savePromptsBtn = $('savePromptsBtn');
const promptsStatus = $('promptsStatus');
const promptAnalyst = $('promptAnalyst');
const promptVerifier = $('promptVerifier');
const promptWriter = $('promptWriter');
const promptOrchestrator = $('promptOrchestrator');
const PROMPT_FIELDS = { analyst: promptAnalyst, verifier: promptVerifier, writer: promptWriter, orchestrator: promptOrchestrator };

// ---------------- 유틸 ----------------

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}
function fmtSec(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}
function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function uid() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function setComposerHint(text, isError = false) {
  composerHint.textContent = text || '';
  composerHint.classList.toggle('error', !!isError);
}

function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

// ---------------- 메시지 렌더 ----------------

function createMsgNode(msg) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${msg.role}`;
  wrap.dataset.id = msg.id;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = msg.role === 'user' ? '나' : 'AI';
  wrap.appendChild(avatar);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.appendChild(bubble);

  return wrap;
}

function renderUserAttachmentBubble(bubble, msg) {
  bubble.innerHTML = '';
  if (msg.file) {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `<span class="chip-icon">📄</span><span class="chip-name"></span><span class="chip-size"></span>`;
    chip.querySelector('.chip-name').textContent = msg.file.name;
    chip.querySelector('.chip-size').textContent = fmtBytes(msg.file.size);
    bubble.appendChild(chip);
  }
  if (msg.text) {
    const body = document.createElement('div');
    body.className = 'user-text';
    body.textContent = msg.text;
    bubble.appendChild(body);
  }
}

function renderUserChatBubble(bubble, msg) {
  bubble.innerHTML = '';
  const body = document.createElement('div');
  body.className = 'user-text';
  body.textContent = msg.text || '';
  bubble.appendChild(body);
}

function renderDirectiveCard(directive) {
  const card = document.createElement('div');
  card.className = 'directive-card';
  const lines = [];
  lines.push(`🧠 오케스트레이터 해석: ${directive.interpretedEmphasis || '(없음)'}`);
  lines.push('계획:');
  lines.push(`  - 추출 focus: ${directive.extractionFocus || '기본'}`);
  lines.push(`  - 검증 focus: ${directive.verificationFocus || '기본'}`);
  if (directive.additionalAuditTasks && directive.additionalAuditTasks.length) {
    lines.push(`  - 추가 감사: ${directive.additionalAuditTasks.map(t => t.name).join(', ')}`);
  }
  if (directive.additionalReportSections && directive.additionalReportSections.length) {
    lines.push(`  - 추가 섹션: ${directive.additionalReportSections.map(s => s.title).join(', ')}`);
  }
  if (directive.reportSectionsToEmphasize && directive.reportSectionsToEmphasize.length) {
    lines.push(`  - 강조 섹션: ${directive.reportSectionsToEmphasize.join(', ')}`);
  }
  card.textContent = lines.join('\n');
  return card;
}

function renderAnalysisBubble(bubble, msg) {
  bubble.innerHTML = '';

  // directive 박스 (오케스트레이터 결과)
  if (msg.directive && msg.directive.interpretedEmphasis) {
    bubble.appendChild(renderDirectiveCard(msg.directive));
  }

  // progress 블록
  const progressBlock = document.createElement('div');
  progressBlock.className = 'progress-block';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'progress-toggle';
  const list = document.createElement('div');
  list.className = 'progress-list';
  progressBlock.appendChild(toggle);
  progressBlock.appendChild(list);

  for (const p of msg.progress || []) {
    const line = document.createElement('div');
    line.className = 'line' + (p.stage === 'error' ? ' error' : '');
    line.textContent = p.message;
    list.appendChild(line);
  }
  const count = (msg.progress || []).length;
  if (msg.status === 'done') {
    progressBlock.classList.add('collapsed');
    toggle.textContent = `▶ 진행 ${count}단계 보기`;
  } else if (msg.status === 'error') {
    toggle.textContent = `▼ 진행 (오류)`;
  } else {
    toggle.textContent = `진행 중... (${count}단계)`;
  }
  toggle.addEventListener('click', () => {
    progressBlock.classList.toggle('collapsed');
    const collapsed = progressBlock.classList.contains('collapsed');
    toggle.textContent = collapsed ? `▶ 진행 ${count}단계 보기` : `▼ 진행 ${count}단계 접기`;
  });
  bubble.appendChild(progressBlock);

  // 리포트
  if (msg.report) {
    const report = document.createElement('div');
    report.className = 'report-body';
    report.innerHTML = renderMarkdown(msg.report);
    bubble.appendChild(report);
  }

  // 에러
  if (msg.status === 'error' && msg.error) {
    const err = document.createElement('div');
    err.className = 'user-text';
    err.style.color = 'var(--error)';
    err.textContent = msg.error;
    bubble.appendChild(err);
  }

  // 메트릭 / 통계
  if (msg.status === 'done' && (msg.metrics || msg.verifiedClaims)) {
    const row = document.createElement('div');
    row.className = 'metrics-row';
    const summary = buildMetricsSummary(msg.metrics);
    const summarySpan = document.createElement('span');
    summarySpan.textContent = summary;
    row.appendChild(summarySpan);

    const statsBtn = document.createElement('button');
    statsBtn.type = 'button';
    statsBtn.className = 'stats-toggle';
    statsBtn.textContent = '통계 보기';
    row.appendChild(statsBtn);

    const detail = document.createElement('div');
    detail.className = 'stats-detail';
    detail.hidden = true;
    detail.appendChild(buildStatsDetail(msg.metrics, msg.verifiedClaims, msg.auditResults));

    statsBtn.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      statsBtn.textContent = detail.hidden ? '통계 보기' : '통계 접기';
    });

    bubble.appendChild(row);
    bubble.appendChild(detail);
  }
}

function buildMetricsSummary(metrics) {
  if (!metrics) return '';
  const a = metrics.analyst || {};
  const v = metrics.verifier || {};
  const w = metrics.writer || {};
  const totalMs = (a.durationMs || 0) + (v.durationMs || 0) + (w.durationMs || 0);
  const inTok = (a.usage?.input_tokens || 0) + (v.totalInputTokens || 0) + (w.usage?.input_tokens || 0);
  const outTok = (a.usage?.output_tokens || 0) + (v.totalOutputTokens || 0) + (w.usage?.output_tokens || 0);
  return `⏱ ${fmtSec(totalMs)} · in ${fmtTok(inTok)} / out ${fmtTok(outTok)} 토큰`;
}

function buildStatsDetail(metrics, verifiedClaims, auditResults) {
  const frag = document.createDocumentFragment();
  if (metrics) {
    const head = document.createElement('h4');
    head.textContent = '단계별';
    frag.appendChild(head);
    const a = metrics.analyst || {};
    const v = metrics.verifier || {};
    const w = metrics.writer || {};
    const totalMs = (a.durationMs || 0) + (v.durationMs || 0) + (w.durationMs || 0);
    const rows = document.createElement('div');
    rows.className = 'stage-row';
    rows.innerHTML = [
      `분석가 ${fmtSec(a.durationMs)} · in ${fmtTok(a.usage?.input_tokens)} / out ${fmtTok(a.usage?.output_tokens)}`,
      `검증가 ${fmtSec(v.durationMs)} · 호출 ${v.calls || 0}회 · in ${fmtTok(v.totalInputTokens)} / out ${fmtTok(v.totalOutputTokens)}`,
      `작가 ${fmtSec(w.durationMs)} · in ${fmtTok(w.usage?.input_tokens)} / out ${fmtTok(w.usage?.output_tokens)}`,
      `<span class="total">합계 ${fmtSec(totalMs)}</span>`,
    ].map(l => `<div>${l}</div>`).join('');
    frag.appendChild(rows);
  }
  if (Array.isArray(verifiedClaims) && verifiedClaims.length) {
    const head = document.createElement('h4');
    head.textContent = 'Claim 검증';
    head.style.marginTop = '12px';
    frag.appendChild(head);

    const stats = { supported: 0, partially_supported: 0, unsupported: 0, contradicted: 0 };
    for (const v of verifiedClaims) if (stats[v.status] !== undefined) stats[v.status] += 1;
    const badges = document.createElement('div');
    badges.className = 'verified-stats';
    for (const k of Object.keys(stats)) {
      const b = document.createElement('span');
      b.className = `stat-badge stat-${k}`;
      b.textContent = `${STATUS_LABEL[k]} ${stats[k]}`;
      badges.appendChild(b);
    }
    frag.appendChild(badges);

    const table = document.createElement('table');
    table.className = 'claims-table';
    table.innerHTML = '<thead><tr><th>상태</th><th>주장</th><th>근거</th><th>섹션</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    for (const v of verifiedClaims) {
      const tr = document.createElement('tr');
      tr.className = `claim-row claim-${v.status}`;
      const tdS = document.createElement('td'); tdS.textContent = STATUS_LABEL[v.status] ?? v.status;
      const tdC = document.createElement('td'); tdC.textContent = v.claim?.text ?? '';
      const tdE = document.createElement('td'); tdE.textContent = v.evidenceQuote ?? '';
      const tdSec = document.createElement('td'); tdSec.textContent = v.evidenceSection ?? v.claim?.sourceSection ?? '';
      tr.append(tdS, tdC, tdE, tdSec);
      tbody.appendChild(tr);
    }
    frag.appendChild(table);
  }
  if (Array.isArray(auditResults) && auditResults.length) {
    const head = document.createElement('h4');
    head.textContent = '감사 작업';
    head.style.marginTop = '12px';
    frag.appendChild(head);

    const table = document.createElement('table');
    table.className = 'claims-table';
    table.innerHTML = '<thead><tr><th>id</th><th>이름</th><th>판정</th><th>발견</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    for (const a of auditResults) {
      const tr = document.createElement('tr');
      const tdId = document.createElement('td'); tdId.textContent = a.taskId ?? '';
      const tdN = document.createElement('td'); tdN.textContent = a.name ?? '';
      const tdV = document.createElement('td'); tdV.textContent = a.verdict ?? '';
      const tdF = document.createElement('td');
      const ul = document.createElement('ul');
      ul.style.margin = '0';
      ul.style.paddingLeft = '16px';
      for (const f of (a.findings || [])) {
        const li = document.createElement('li');
        li.textContent = f;
        ul.appendChild(li);
      }
      tdF.appendChild(ul);
      tr.append(tdId, tdN, tdV, tdF);
      tbody.appendChild(tr);
    }
    frag.appendChild(table);
  }
  return frag;
}

function renderAssistantChatBubble(bubble, msg) {
  bubble.innerHTML = '';
  if (msg.status === 'loading') {
    const body = document.createElement('div');
    body.className = 'user-text';
    body.textContent = '...';
    bubble.appendChild(body);
    return;
  }
  if (msg.status === 'error') {
    const body = document.createElement('div');
    body.className = 'user-text';
    body.textContent = msg.error || '오류';
    bubble.appendChild(body);
    return;
  }
  const body = document.createElement('div');
  body.className = 'report-body chat-body';
  body.innerHTML = renderMarkdown(msg.text || '');
  bubble.appendChild(body);
}

function renderMsg(msg) {
  let node = messagesEl.querySelector(`[data-id="${msg.id}"]`);
  if (!node) {
    node = createMsgNode(msg);
    messagesEl.appendChild(node);
  }
  // status 클래스 갱신
  node.classList.toggle('error', msg.status === 'error');
  node.classList.toggle('loading', msg.status === 'loading');

  const bubble = node.querySelector('.bubble');
  if (msg.role === 'user' && msg.kind === 'attachment') renderUserAttachmentBubble(bubble, msg);
  else if (msg.role === 'user' && msg.kind === 'chat') renderUserChatBubble(bubble, msg);
  else if (msg.role === 'assistant' && msg.kind === 'analysis') renderAnalysisBubble(bubble, msg);
  else if (msg.role === 'assistant' && msg.kind === 'chat') renderAssistantChatBubble(bubble, msg);
  return node;
}

function addMessage(msg) {
  state.messages.push(msg);
  renderMsg(msg);
  scrollToBottom();
  return msg;
}

function updateMessage(id, patch) {
  const msg = state.messages.find(m => m.id === id);
  if (!msg) return;
  Object.assign(msg, patch);
  renderMsg(msg);
  scrollToBottom();
}

function scrollToBottom() {
  // 부드럽지 않게 즉시 — 분석 중 빈번한 업데이트 때문에
  window.scrollTo({ top: document.body.scrollHeight });
}

// ---------------- 입력 / 첨부 ----------------

function setAttachment(file) {
  if (!isPdf(file)) {
    setComposerHint('PDF 파일만 첨부할 수 있어요.', true);
    return;
  }
  if (file.size > MAX_BYTES) {
    setComposerHint(`파일이 너무 큽니다 (최대 50MB, 현재 ${fmtBytes(file.size)}).`, true);
    return;
  }
  state.pendingPdf = file;
  attachName.textContent = file.name;
  attachSize.textContent = fmtBytes(file.size);
  attachmentChip.hidden = false;
  setComposerHint('');
  updateSendState();
}

function clearAttachment() {
  state.pendingPdf = null;
  attachmentChip.hidden = true;
  fileInput.value = '';
  updateSendState();
}

function autoGrow() {
  composerInput.style.height = 'auto';
  composerInput.style.height = Math.min(composerInput.scrollHeight, 160) + 'px';
}

function updateSendState() {
  const text = composerInput.value.trim();
  const hasPdf = !!state.pendingPdf;
  let enabled = !state.busy;
  if (hasPdf) {
    // 분석 가능 (text는 emphasis로 사용, 선택)
  } else if (state.sessionId && text) {
    // 채팅 가능
  } else if (!state.sessionId) {
    enabled = false;
  } else if (!text) {
    enabled = false;
  }
  sendBtn.disabled = !enabled;
}

// ---------------- 분석 (SSE) ----------------

async function streamAnalysis(file, emphasis, msgId) {
  const headers = {
    'Content-Type': 'application/pdf',
    'X-Filename': encodeURIComponent(file.name),
  };
  if (emphasis) headers['X-Emphasis'] = encodeURIComponent(emphasis);

  let res;
  try {
    res = await fetch('/analyze', { method: 'POST', headers, body: file });
  } catch (err) {
    updateMessage(msgId, { status: 'error', error: `네트워크 오류: ${err.message}` });
    return;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    updateMessage(msgId, { status: 'error', error: `서버 오류 (${res.status}): ${txt}` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        let payload;
        try { payload = JSON.parse(dataLines.join('\n')); } catch { continue; }
        handleSseEvent(payload, msgId);
      }
    }
  } catch (err) {
    updateMessage(msgId, { status: 'error', error: `스트림 오류: ${err.message}` });
  }
}

function handleSseEvent(payload, msgId) {
  const msg = state.messages.find(m => m.id === msgId);
  if (!msg) return;
  if (payload.stage === 'error') {
    msg.progress.push({ stage: 'error', message: payload.message });
    msg.status = 'error';
    msg.error = payload.message;
    renderMsg(msg);
    scrollToBottom();
    return;
  }
  if (payload.stage === 'done') {
    msg.progress.push({ stage: 'done', message: payload.message });
    msg.status = 'done';
    msg.report = payload.report || '';
    msg.metrics = payload.metrics;
    msg.verifiedClaims = payload.verifiedClaims;
    msg.analyst = payload.analyst;
    msg.directive = payload.directive;
    msg.auditResults = payload.auditResults;
    if (payload.sessionId) {
      msg.sessionId = payload.sessionId;
      state.sessionId = payload.sessionId;
    }
    renderMsg(msg);
    scrollToBottom();
    return;
  }
  msg.progress.push({ stage: payload.stage, message: payload.message, meta: payload.meta });
  renderMsg(msg);
  scrollToBottom();
}

// ---------------- 채팅 ----------------

async function sendChat(question, persona) {
  const userMsg = addMessage({ id: uid(), role: 'user', kind: 'chat', text: question });
  const assistantMsg = addMessage({
    id: uid(), role: 'assistant', kind: 'chat', status: 'loading',
  });

  state.busy = true;
  updateSendState();
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, question, persona }),
    });
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    if (res.ok && json && typeof json.answer === 'string') {
      updateMessage(assistantMsg.id, { status: 'done', text: json.answer });
    } else if (res.status === 410) {
      state.sessionId = null;
      updateMessage(assistantMsg.id, {
        status: 'error',
        error: (json && json.error) || '세션이 만료됐어요. 새 분석을 시작하세요.',
      });
      newAnalysisBtn.classList.add('highlight');
      // 입력 복원
      composerInput.value = question;
      autoGrow();
    } else {
      const m = (json && json.error) || `요청 실패 (${res.status})`;
      updateMessage(assistantMsg.id, { status: 'error', error: m });
      composerInput.value = question;
      autoGrow();
    }
  } catch (err) {
    updateMessage(assistantMsg.id, { status: 'error', error: `네트워크 오류: ${err.message}` });
    composerInput.value = question;
    autoGrow();
  } finally {
    state.busy = false;
    updateSendState();
  }
}

// ---------------- Send 핸들러 ----------------

async function onSend() {
  if (state.busy) return;
  const text = composerInput.value.trim();
  const file = state.pendingPdf;

  if (file) {
    // 새 분석
    addMessage({ id: uid(), role: 'user', kind: 'attachment', file: { name: file.name, size: file.size }, text });
    const assistantMsg = addMessage({
      id: uid(), role: 'assistant', kind: 'analysis',
      status: 'running', progress: [],
    });

    // 현재 입력값을 emphasis로 사용
    const emphasis = text;
    composerInput.value = '';
    autoGrow();
    clearAttachment();
    state.busy = true;
    updateSendState();

    try {
      await streamAnalysis(file, emphasis, assistantMsg.id);
    } catch (err) {
      updateMessage(assistantMsg.id, { status: 'error', error: `오류: ${err.message}` });
    } finally {
      state.busy = false;
      updateSendState();
    }
    return;
  }

  if (!state.sessionId) {
    setComposerHint('먼저 PDF를 첨부하세요.', true);
    return;
  }
  if (!text) return;

  composerInput.value = '';
  autoGrow();
  await sendChat(text, state.persona);
}

// ---------------- 새 분석 / 설정 ----------------

function clearConversation() {
  state.sessionId = null;
  state.messages = [];
  state.busy = false;
  state.pendingPdf = null;
  messagesEl.innerHTML = '';
  clearAttachment();
  composerInput.value = '';
  autoGrow();
  setComposerHint('');
  newAnalysisBtn.classList.remove('highlight');
  updateSendState();
}

let promptsLoaded = false;
async function loadPromptsIntoModal() {
  if (promptsLoaded) return;
  const res = await fetch('/api/prompts');
  if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
  const json = await res.json();
  for (const k of Object.keys(PROMPT_FIELDS)) {
    if (typeof json[k] === 'string') PROMPT_FIELDS[k].value = json[k];
  }
  promptsLoaded = true;
}

async function resetPromptField(key) {
  try {
    const res = await fetch('/api/prompts/defaults');
    if (!res.ok) return;
    const json = await res.json();
    if (typeof json[key] === 'string' && PROMPT_FIELDS[key]) {
      PROMPT_FIELDS[key].value = json[key];
    }
  } catch { /* ignore */ }
}

function flashPromptsStatus(text, isError = false) {
  promptsStatus.textContent = text;
  promptsStatus.classList.toggle('error', !!isError);
  promptsStatus.classList.add('visible');
  setTimeout(() => {
    promptsStatus.classList.remove('visible');
    promptsStatus.textContent = '';
  }, 2000);
}

async function openSettings() {
  try {
    await loadPromptsIntoModal();
  } catch (err) {
    setComposerHint(`프롬프트 로딩 실패: ${err.message}`, true);
    return;
  }
  settingsModal.hidden = false;
}
function closeSettings() {
  settingsModal.hidden = true;
}

// ---------------- 이벤트 바인딩 ----------------

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) {
    setAttachment(fileInput.files[0]);
  }
});
attachClear.addEventListener('click', clearAttachment);

composerInput.addEventListener('input', () => {
  autoGrow();
  if (composerHint.classList.contains('error')) setComposerHint('');
  updateSendState();
});

composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) onSend();
  }
});

sendBtn.addEventListener('click', () => { if (!sendBtn.disabled) onSend(); });

document.querySelectorAll('input[name="persona"]').forEach(r => {
  r.addEventListener('change', (e) => { state.persona = e.target.value; });
});

newAnalysisBtn.addEventListener('click', () => {
  if (state.busy) return;
  clearConversation();
});

// 드래그 앤 드롭 (페이지 전체)
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  const types = Array.from(e.dataTransfer?.types || []);
  if (!types.includes('Files')) return;
  e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!dropOverlay.hidden) {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  const types = Array.from(e.dataTransfer?.types || []);
  if (!types.includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const files = e.dataTransfer?.files;
  if (files && files[0]) setAttachment(files[0]);
});

// 설정 모달
openSettingsBtn.addEventListener('click', openSettings);
settingsModal.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', closeSettings);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsModal.hidden) closeSettings();
});
settingsModal.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    settingsModal.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    settingsModal.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.getAttribute('data-tab');
    settingsModal.querySelector(`.tab-pane[data-pane="${target}"]`).classList.add('active');
  });
});
settingsModal.querySelectorAll('[data-reset]').forEach(btn => {
  btn.addEventListener('click', () => resetPromptField(btn.getAttribute('data-reset')));
});
savePromptsBtn.addEventListener('click', async () => {
  savePromptsBtn.disabled = true;
  try {
    const body = {
      analyst: promptAnalyst.value,
      verifier: promptVerifier.value,
      writer: promptWriter.value,
      orchestrator: promptOrchestrator.value,
    };
    const res = await fetch('/api/prompts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      flashPromptsStatus('저장됨');
    } else {
      let msg = `오류 (${res.status})`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
      flashPromptsStatus(msg, true);
    }
  } catch (err) {
    flashPromptsStatus(`네트워크 오류: ${err.message}`, true);
  } finally {
    savePromptsBtn.disabled = false;
  }
});

// 초기 상태
autoGrow();
updateSendState();
