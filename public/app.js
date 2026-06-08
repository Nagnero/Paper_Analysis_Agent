// 채팅 UI 메인 스크립트 (ESM).
// markdown 렌더러는 백엔드 정적 라우트 화이트리스트가 /markdown.js를 포함하지 않아
// 별도 파일로 import할 수 없어 이 파일에 inline으로 포함.
import { createPdfViewer } from '/pdfViewer.js';
import { buildCitationRefMap, createCitationMarkerRegex } from '/citationContract.js';
import { createLatexEditor } from '/latexEditor.js';

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

// ---------------- 인라인 근거 링크 렌더링 ----------------

function shouldSkipCitationEnhance(node) {
  const tag = node?.parentElement?.tagName;
  return ['CODE', 'PRE', 'SCRIPT', 'STYLE', 'A', 'BUTTON'].includes(tag);
}

function createInlineEvidenceButton(ref, number) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'evidence-ref-inline';
  btn.textContent = `[${number}]`;
  btn.title = '논문에서 이 근거 위치로 이동';
  btn.setAttribute('aria-label', `논문 근거 ${number}번으로 이동`);
  btn.addEventListener('click', () => onEvidenceClick(ref.quote, ref));
  return btn;
}

function evidenceLookupOpts(ref) {
  return {
    sourcePage: ref?.sourcePage ?? ref?.claim?.sourcePage,
    sourceSection: ref?.sourceSection ?? ref?.evidenceSection ?? ref?.claim?.sourceSection,
  };
}

function isEvidenceHighlightable(ref) {
  // PDF가 아직 로드 중이면 판단을 보류하고, 로드 완료 후 메시지를 다시 렌더링한다.
  if (!pdfViewer || !pdfState.available || !pdfViewer.isLoaded()) return true;
  return pdfViewer.canHighlightQuote(ref?.quote ?? ref?.evidenceQuote ?? '', evidenceLookupOpts(ref));
}

function enhanceEvidenceRefs(root, verifiedClaims) {
  const refs = buildCitationRefMap(verifiedClaims);
  if (!refs.size || !root.textContent.includes('[[cite:')) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const markerRe = createCitationMarkerRegex();
    if (!shouldSkipCitationEnhance(node) && markerRe.test(node.nodeValue || '')) {
      textNodes.push(node);
    }
  }

  const refNumbers = new Map();
  let nextNumber = 1;
  for (const node of textNodes) {
    const text = node.nodeValue || '';
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    const markerRe = createCitationMarkerRegex();
    let match;
    while ((match = markerRe.exec(text)) !== null) {
      const [marker, id] = match;
      if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      const ref = refs.get(id);
      if (ref && isEvidenceHighlightable(ref)) {
        if (!refNumbers.has(id)) refNumbers.set(id, nextNumber++);
        frag.appendChild(createInlineEvidenceButton(ref, refNumbers.get(id)));
      }
      lastIndex = match.index + marker.length;
    }
    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    node.parentNode.replaceChild(frag, node);
  }
}

function renderMarkdownWithEvidence(src, verifiedClaims) {
  const root = document.createElement('div');
  root.innerHTML = renderMarkdown(src);
  enhanceEvidenceRefs(root, verifiedClaims);
  return root;
}

// ---------------- Analysis Matrix 렌더링 ----------------

function claimId(v) {
  return v?.claim?.id ?? v?.claimId ?? v?.id ?? '';
}

function claimSource(v) {
  const section = v?.evidenceSection ?? v?.claim?.sourceSection ?? v?.sourceSection ?? '';
  const page = v?.claim?.sourcePage ?? v?.sourcePage ?? null;
  if (section && page) return `${section}, p.${page}`;
  return section || (page ? `p.${page}` : '');
}

function findVerifiedClaimById(id) {
  return (state.currentVerifiedClaims || []).find(v => claimId(v) === id) || null;
}

function normalizeCoreInsights(coreInsights) {
  const arr = Array.isArray(coreInsights?.coreInsights)
    ? coreInsights.coreInsights
    : Array.isArray(coreInsights)
      ? coreInsights
      : [];
  return arr
    .filter(item => item && typeof item === 'object')
    .map((item, idx) => ({
      index: idx + 1,
      kindKo: String(item.kindKo || '기타').trim(),
      claimKo: String(item.claimKo || '').trim(),
      evidenceKo: String(item.evidenceKo || '').trim(),
      caveatKo: String(item.caveatKo || '').trim(),
      claimIds: Array.isArray(item.claimIds) ? item.claimIds.map(String) : [],
    }))
    .filter(row => row.claimKo && row.evidenceKo);
}

function appendCoreInsightEvidence(cell, row) {
  const evidenceText = document.createElement('div');
  evidenceText.textContent = row.evidenceKo || '근거 요약이 없습니다.';
  cell.appendChild(evidenceText);

  const claim = row.claimIds.map(findVerifiedClaimById).find(Boolean);
  if (!claim?.evidenceQuote) return;
  const wrap = document.createElement('div');
  wrap.className = 'matrix-evidence-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'evidence-ref';
  btn.title = '논문에서 이 근거 위치로 이동';
  btn.innerHTML = `<span class="ref-num">[${row.index}]</span><span class="ref-quote">원문 근거 보기</span><span class="ref-loupe">🔎</span>`;
  btn.addEventListener('click', () => onEvidenceClick(claim.evidenceQuote, claim));
  wrap.appendChild(btn);
  const source = claimSource(claim);
  if (source) {
    const sourceEl = document.createElement('span');
    sourceEl.className = 'matrix-category';
    sourceEl.textContent = source;
    wrap.appendChild(sourceEl);
  }
  cell.appendChild(wrap);
}

function createCoreInsightTable(rows) {
  const table = document.createElement('table');
  table.className = 'core-insight-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>구분</th>
        <th>핵심 주장 / 철학</th>
        <th>근거</th>
        <th>한계 / 주의점</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'core-insight-row';

    const kindCell = document.createElement('td');
    const kindBadge = document.createElement('span');
    kindBadge.className = 'core-kind-badge';
    kindBadge.textContent = row.kindKo || '기타';
    kindCell.appendChild(kindBadge);

    const claimCell = document.createElement('td');
    const claimTitle = document.createElement('div');
    claimTitle.className = 'core-claim-text';
    claimTitle.textContent = row.claimKo || '주장 내용 없음';
    claimCell.appendChild(claimTitle);

    const evidenceCell = document.createElement('td');
    appendCoreInsightEvidence(evidenceCell, row);

    const caveatCell = document.createElement('td');
    caveatCell.textContent = row.caveatKo || '추가 한계점이 명시되지 않았습니다.';

    tr.append(kindCell, claimCell, evidenceCell, caveatCell);
    tbody.appendChild(tr);
  }
  return table;
}

function renderCoreInsightEmpty() {
  const empty = document.createElement('div');
  empty.className = 'analysis-empty';
  if (!state.currentAnalysisId) {
    empty.innerHTML = `
      <div class="analysis-empty-icon">🧩</div>
      <h3>핵심 분석을 만들 분석 결과가 없습니다</h3>
      <p>먼저 PDF를 업로드해 기본 논문 분석을 완료하세요.</p>
    `;
    analysisMatrixRoot.appendChild(empty);
    return;
  }

  const btnDisabled = state.coreInsightsBusy ? 'disabled' : '';
  empty.innerHTML = `
    <div class="analysis-empty-icon">🧩</div>
    <h3>핵심 분석 표가 아직 없습니다</h3>
    <p>별도 핵심 분석 에이전트가 한국어로 노벨티·근거·한계를 3~5개 표 항목으로 재구성합니다.</p>
    <button type="button" id="generateCoreInsightsBtn" class="primary" ${btnDisabled}>${state.coreInsightsBusy ? '생성 중...' : '핵심 분석 생성'}</button>
    ${state.coreInsightsError ? `<p class="analysis-error">${escapeHtml(state.coreInsightsError)}</p>` : ''}
  `;
  analysisMatrixRoot.appendChild(empty);
  $('generateCoreInsightsBtn')?.addEventListener('click', generateCoreInsights);
}

function renderAnalysisMatrix() {
  if (!analysisMatrixRoot) return;
  analysisMatrixRoot.innerHTML = '';
  const rows = normalizeCoreInsights(state.currentCoreInsights);
  const totalClaims = (state.currentVerifiedClaims || []).length;
  if (!rows.length) {
    renderCoreInsightEmpty();
    return;
  }

  const head = document.createElement('div');
  head.className = 'analysis-panel-head';
  head.innerHTML = `
    <div class="analysis-panel-kicker">핵심 분석</div>
    <h2>핵심 주장 한눈 요약</h2>
  `;
  analysisMatrixRoot.appendChild(head);
  analysisMatrixRoot.appendChild(createCoreInsightTable(rows));
}

async function generateCoreInsights() {
  if (!state.currentPaperId || !state.currentAnalysisId || state.coreInsightsBusy) return;
  state.coreInsightsBusy = true;
  state.coreInsightsError = '';
  renderAnalysisMatrix();
  try {
    const res = await fetch(`/api/library/papers/${state.currentPaperId}/core-insights`, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error || `핵심 분석 생성 실패 (${res.status})`);
    }
    state.currentCoreInsights = json.coreInsights || null;
  } catch (err) {
    state.coreInsightsError = err.message;
    showToast(`핵심 분석 실패: ${err.message}`);
  } finally {
    state.coreInsightsBusy = false;
    renderAnalysisMatrix();
  }
}

function setWorkspaceTab(tab) {
  const next = tab === 'analysis' ? 'analysis' : 'chat';
  state.workspaceTab = next;
  if (chatPane) chatPane.classList.toggle('analysis-active', next === 'analysis');
  if (chatMain) chatMain.hidden = next !== 'chat';
  if (analysisPane) analysisPane.hidden = next !== 'analysis';
  for (const btn of workspaceTabs) {
    const active = btn.getAttribute('data-workspace-tab') === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (next === 'analysis') renderAnalysisMatrix();
}

// ---------------- State ----------------

const state = {
  sessionId: null,
  pendingPdf: null,
  busy: false,
  messages: [],
  libraryTree: { folders: [], unfoldered: [] },
  currentPaperId: null,
  currentAnalysisId: null,
  currentVerifiedClaims: [],
  currentReport: '',
  currentCoreInsights: null,
  coreInsightsBusy: false,
  coreInsightsError: '',
  pendingPdfSelection: null,
  workspaceTab: 'chat',
  mode: 'new',
  // LaTeX
  currentProjectId: null,
  currentLatexFile: null,
  latexFiles: [],
  latexProjects: [],
  latexDirty: false,
  latexBusy: false,
  latexEngine: null,
  latexChatBusy: false,
};

let authStatus = null;

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
const attachZone = $('attachZone');
const composerRow = $('composerRow');
const fileInput = $('fileInput');
const attachmentChip = $('attachmentChip');
const attachName = $('attachName');
const attachSize = $('attachSize');
const attachClear = $('attachClear');
const composerHint = $('composerHint');
const dropOverlay = $('dropOverlay');
const openSettingsBtn = $('sidebarSettingsBtn');
const newAnalysisBtn = $('newAnalysisBtn');
const newFolderBtn = $('newFolderBtn');
const libraryTreeEl = $('libraryTree');
const contextMenuEl = $('contextMenu');
const folderPickerEl = $('folderPicker');
const folderPickerListEl = $('folderPickerList');
const folderPickerNullBtn = $('folderPickerNullBtn');
const libraryResetBtn = $('libraryResetBtn');
const chatPane = $('chatPane');
const chatMain = $('chatMain');
const analysisPane = $('analysisPane');
const analysisMatrixRoot = $('analysisMatrixRoot');
const workspaceTabs = Array.from(document.querySelectorAll('.workspace-tab'));
const workspaceTabsBar = $('workspaceTabsBar');
// LaTeX 모드
const latexPane = $('latexPane');
const latexTitle = $('latexTitle');
const latexSaveState = $('latexSaveState');
const latexCompileStatus = $('latexCompileStatus');
const latexCompileBtn = $('latexCompileBtn');
const latexZipBtn = $('latexZipBtn');
const latexLogBtn = $('latexLogBtn');
const latexEngineBanner = $('latexEngineBanner');
const latexFileTree = $('latexFileTree');
const latexEditorHost = $('latexEditorHost');
const latexLog = $('latexLog');
const latexLogBody = $('latexLogBody');
const latexLogClose = $('latexLogClose');
const latexTreeEl = $('latexTree');
const newLatexBtn = $('newLatexBtn');
const zipInput = $('zipInput');
const latexChatLog = $('latexChatLog');
const latexChatInput = $('latexChatInput');
const latexChatSend = $('latexChatSend');
const chatMainEl = document.querySelector('.chat-main');
const settingsModal = $('settingsModal');
const savePromptsBtn = $('savePromptsBtn');
const promptsStatus = $('promptsStatus');
const promptAnalyst = $('promptAnalyst');
const promptVerifier = $('promptVerifier');
const promptWriter = $('promptWriter');
const promptCoreInsight = $('promptCoreInsight');
const promptOrchestrator = $('promptOrchestrator');
const PROMPT_FIELDS = {
  analyst: promptAnalyst, verifier: promptVerifier, writer: promptWriter, coreInsight: promptCoreInsight, orchestrator: promptOrchestrator,
  // 논문 작성팀 (본문/그림은 계획→작성→검토 멀티에이전트)
  writeOrchestrator: $('promptWriteOrchestrator'), writePlan: $('promptWritePlan'),
  writeBody: $('promptWriteBody'), writeFigure: $('promptWriteFigure'), writeReview: $('promptWriteReview'),
  writeCitation: $('promptWriteCitation'), writeCompile: $('promptWriteCompile'),
};
const LLM_ROLES = [
  'orchestrator', 'analyst', 'verifier', 'writer', 'coreInsight', 'chat',
  'writeOrchestrator', 'writePlan', 'writeBody', 'writeFigure', 'writeReview', 'writeCitation', 'writeCompile',
];
const saveLlmBtn = $('saveLlmBtn');
const resetLlmBtn = $('resetLlmBtn');
const llmStatus = $('llmStatus');
const authBanner = $('authBanner');
const authBannerText = authBanner ? authBanner.querySelector('.auth-banner-text') : null;
const authBannerRefreshBtn = $('authBannerRefreshBtn');
const authBannerHelpBtn = $('authBannerHelpBtn');
const authBlocker = $('authBlocker');
const authBlockerRefreshBtn = $('authBlockerRefreshBtn');
const authBlockerCloseBtn = $('authBlockerCloseBtn');
const authBlockerStatus = $('authBlockerStatus');

// ---------------- 논문 PDF 패널 (우측, PDF.js 제어형) ----------------
const workspaceEl = $('workspace');
const pdfPane = $('pdfPane');
const pdfBody = $('pdfBody');
const pdfToggleBtn = $('pdfToggleBtn');
const pdfCloseBtn = $('pdfCloseBtn');
const pdfSelectBtn = $('pdfSelectBtn');
const paneResizer = $('paneResizer');
const pdfTitleEl = $('pdfTitle');
const pdfOpenExternal = $('pdfOpenExternal');
const PDF_WIDTH_KEY = 'paa.pdfPaneWidth';

const pdfViewer = pdfBody ? createPdfViewer(pdfBody) : null;
const selectionChip = $('selectionChip');
const selectionName = $('selectionName');
const selectionMeta = $('selectionMeta');
const selectionClear = $('selectionClear');

const pdfState = {
  blobUrl: '',      // 외부 링크용 blob URL (해제 대상)
  paperId: null,    // 현재 로드된 논문 id (저장본일 때)
  available: false, // 표시할 PDF가 있는지
  open: false,      // 패널이 펼쳐져 있는지
};

function revokePdfBlob() {
  if (pdfState.blobUrl) {
    URL.revokeObjectURL(pdfState.blobUrl);
    pdfState.blobUrl = '';
  }
}

function setPdfTitle(title) {
  if (title != null && pdfTitleEl) {
    pdfTitleEl.textContent = title;
    pdfTitleEl.title = title;
  }
}

function applyPdfLayout() {
  const show = pdfState.available && pdfState.open;
  if (pdfPane) pdfPane.hidden = !show;
  if (paneResizer) paneResizer.hidden = !show;
  if (pdfSelectBtn) {
    pdfSelectBtn.hidden = !pdfState.available;
    pdfSelectBtn.classList.toggle('active', !!pdfViewer?.isSelectionMode?.());
  }
  if (pdfToggleBtn) {
    pdfToggleBtn.hidden = !pdfState.available;
    pdfToggleBtn.classList.toggle('active', show);
  }
}

function selectionSummary(selection) {
  if (!selection) return { name: '', meta: '' };
  const page = Number(selection.page) || '?';
  const text = (selection.text || '').replace(/\s+/g, ' ').trim();
  const isFigure = selection.source === 'figure';
  const sourceLabel = isFigure ? 'Figure' : '선택 영역';
  const size = selection.image ? `${selection.image.width}×${selection.image.height}` : '';
  return {
    name: text ? text.slice(0, 80) : `p.${page} ${sourceLabel}`,
    meta: text
      ? `p.${page} · ${isFigure ? 'figure 후보' : '텍스트+이미지'}`
      : `p.${page} · ${isFigure ? 'figure 후보' : '이미지'} ${size}`.trim(),
  };
}

function selectionRequestPayload(selection) {
  if (!selection) return null;
  return {
    type: 'pdf-region',
    source: selection.source || 'manual',
    page: selection.page,
    rect: selection.rect,
    text: selection.text || '',
    image: selection.image || null,
  };
}

function setPdfSelection(selection) {
  state.pendingPdfSelection = selection || null;
  if (!selectionChip || !selectionName || !selectionMeta) return;
  if (!selection) {
    selectionChip.hidden = true;
    selectionName.textContent = '';
    selectionMeta.textContent = '';
    return;
  }
  const summary = selectionSummary(selection);
  selectionName.textContent = summary.name;
  selectionName.title = summary.name;
  selectionMeta.textContent = summary.meta;
  selectionChip.hidden = false;
  setComposerHint('선택 영역이 다음 질문에 함께 전달됩니다.');
}

function clearPdfSelection({ clearViewer = true } = {}) {
  state.pendingPdfSelection = null;
  if (selectionChip) selectionChip.hidden = true;
  if (selectionName) selectionName.textContent = '';
  if (selectionMeta) selectionMeta.textContent = '';
  if (clearViewer) pdfViewer?.clearSelection?.();
}

function setPdfSelectionMode(enabled) {
  if (!enabled) {
    pdfViewer?.setSelectionMode?.(false);
    if (pdfSelectBtn) pdfSelectBtn.classList.remove('active');
    setComposerHint('');
    return;
  }
  if (!pdfViewer || !pdfState.available || !pdfViewer.isLoaded()) {
    showToast('논문 PDF를 먼저 열어주세요');
    return;
  }
  const active = pdfViewer.setSelectionMode(true);
  if (pdfSelectBtn) pdfSelectBtn.classList.toggle('active', active);
  setComposerHint(active ? 'PDF에서 질문할 영역을 드래그하세요.' : '');
}

function clampPdfWidth(px) {
  const total = workspaceEl ? workspaceEl.clientWidth : window.innerWidth;
  const min = 280;
  const max = Math.max(min, total - 360); // 채팅 영역 최소 360px 보장
  return Math.min(Math.max(px, min), max);
}

function setPdfWidth(px) {
  if (pdfPane) pdfPane.style.width = clampPdfWidth(px) + 'px';
}

// 저장된 논문 PDF를 서버에서 로드. title 생략 시 기존 제목 유지.
function showPaperPdf(paperId, title) {
  if (!pdfViewer) return;
  clearPdfSelection();
  revokePdfBlob();
  setPdfTitle(title);
  const url = `/api/library/papers/${paperId}/pdf`;
  if (pdfOpenExternal) pdfOpenExternal.href = url;
  pdfState.paperId = paperId;
  pdfState.available = true;
  pdfState.open = true;
  applyPdfLayout();
  // 같은 논문을 다시 열면 재로드 생략(깜빡임 방지)
  if (pdfViewer.currentPaperId !== paperId) {
    pdfViewer.currentPaperId = paperId;
    pdfViewer.load(url)
      .then(() => rerenderEvidenceMessages())
      .catch(err => console.warn('PDF 로드 실패', err));
  } else if (pdfViewer.isLoaded()) {
    rerenderEvidenceMessages();
  }
}

// 업로드 중인 로컬 파일 즉시 미리보기.
// blob URL(문자열 소스)로 로드해야 분석 중에도 relayout()이 재렌더되어
// 패널 폭 변경 시 PDF가 다시 맞춰진다. (ArrayBuffer는 pdf.js가 detach 해버려 재사용 불가)
function showLocalPdf(file) {
  if (!pdfViewer) return;
  clearPdfSelection();
  revokePdfBlob();
  setPdfTitle(file.name || '논문');
  pdfState.blobUrl = URL.createObjectURL(file);
  if (pdfOpenExternal) pdfOpenExternal.href = pdfState.blobUrl;
  pdfState.paperId = null;
  pdfViewer.currentPaperId = null;
  pdfState.available = true;
  pdfState.open = true;
  applyPdfLayout();
  pdfViewer.load(pdfState.blobUrl)
    .then(() => rerenderEvidenceMessages())
    .catch(err => console.warn('로컬 PDF 미리보기 실패', err));
}

// 표시할 PDF 없음 (새 분석 초기 상태 등).
function clearPdf() {
  if (!pdfViewer) return;
  clearPdfSelection();
  revokePdfBlob();
  pdfViewer.currentPaperId = null;
  pdfViewer.destroy();
  pdfState.paperId = null;
  pdfState.available = false;
  pdfState.open = false;
  applyPdfLayout();
}

function togglePdfPane() {
  if (!pdfState.available) return;
  pdfState.open = !pdfState.open;
  applyPdfLayout();
}

if (pdfViewer) {
  pdfViewer.onRegionSelected((selection) => {
    setPdfSelectionMode(false);
    setPdfSelection(selection);
    composerInput?.focus();
  });
  // SyncTeX: LaTeX 모드에서 PDF 더블클릭 → 해당 .tex 줄로 이동
  if (pdfViewer.onReverseSearch) pdfViewer.onReverseSearch((pt) => reverseToSource(pt));
}

async function reverseToSource({ page, x, y }) {
  if (state.mode !== 'latex' || !state.currentProjectId) return;
  try {
    const q = `page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`;
    const res = await fetch(`/api/library/projects/${state.currentProjectId}/synctex?${q}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.found || !j.file) {
      showToast(j.error || '소스 위치를 찾지 못했습니다 (synctex 데이터/도구 필요)');
      return;
    }
    if (j.file !== state.currentLatexFile) await loadLatexFile(j.file);
    if (latexEditor && latexEditor.gotoLine) latexEditor.gotoLine(j.line);
  } catch (err) {
    showToast('SyncTeX 오류: ' + err.message);
  }
}

// claim 근거 클릭 → PDF에서 해당 인용문으로 점프 + 하이라이트
function onEvidenceClick(quote, v) {
  if (!pdfViewer || !pdfState.available) {
    showToast('논문 PDF를 먼저 열어주세요');
    return;
  }
  setPdfSelectionMode(false);
  pdfState.open = true;
  applyPdfLayout();
  const evidenceQuote = quote ?? v?.quote ?? v?.evidenceQuote ?? '';
  const r = pdfViewer.highlightQuote(evidenceQuote, evidenceLookupOpts(v));
  if (!r.found && !r.navigated) showToast('논문에서 해당 근거 위치를 찾지 못했습니다');
}

let toastTimer = 0;
function showToast(text) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

if (pdfToggleBtn) pdfToggleBtn.addEventListener('click', togglePdfPane);
if (pdfCloseBtn) pdfCloseBtn.addEventListener('click', () => { pdfState.open = false; applyPdfLayout(); });
if (pdfSelectBtn) pdfSelectBtn.addEventListener('click', () => {
  setPdfSelectionMode(!pdfViewer?.isSelectionMode?.());
});

if (paneResizer) {
  paneResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = pdfPane.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const onMove = (ev) => setPdfWidth(startW + (startX - ev.clientX)); // 좌로 끌면 넓어짐
    const onUp = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try { localStorage.setItem(PDF_WIDTH_KEY, String(Math.round(pdfPane.getBoundingClientRect().width))); } catch { /* ignore */ }
      if (pdfViewer) pdfViewer.relayout();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (pdfViewer && pdfState.available && pdfState.open) pdfViewer.relayout(); }, 250);
});

// 저장된 패널 폭 복원
(function initPdfWidth() {
  let saved = 0;
  try { saved = Number(localStorage.getItem(PDF_WIDTH_KEY)) || 0; } catch { /* ignore */ }
  if (saved > 0 && pdfPane) pdfPane.style.width = saved + 'px';
})();

const CLAUDE_MODELS = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8 (기본값, 최고 성능)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (균형)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (빠름/저렴)' },
];
const CODEX_MODELS = [
  { value: 'gpt-5.5', label: 'GPT-5.5 (기본값)' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
];
// 추론 강도(reasoning effort).
// Claude는 Claude Code `--effort`(모델별 지원 등급 다름), Codex는 model_reasoning_effort로 연동.
const CLAUDE_EFFORTS_BY_MODEL = {
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
  'claude-haiku-4-5-20251001': [], // Haiku는 effort 미지원
};
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const EFFORT_LABEL = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';
const CODEX_MODEL = 'gpt-5.5';
const DEFAULT_CLAUDE_REASONING_EFFORT = 'high';
const DEFAULT_CODEX_REASONING_EFFORT = 'high';

function modelsFor(backend) {
  return backend === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}
function defaultModelFor(backend) {
  return backend === 'codex' ? CODEX_MODEL : DEFAULT_CLAUDE_MODEL;
}
function defaultEffortFor(backend) {
  return backend === 'codex' ? DEFAULT_CODEX_REASONING_EFFORT : DEFAULT_CLAUDE_REASONING_EFFORT;
}
// (backend, model) → 지원 effort 값 배열.
function effortValuesFor(backend, model) {
  if (backend === 'codex') return CODEX_EFFORTS;
  return CLAUDE_EFFORTS_BY_MODEL[model] || [];
}

function fillSelect(selectEl, options, currentValue, fallback) {
  selectEl.innerHTML = '';
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    selectEl.appendChild(el);
  }
  const knownValues = options.map(o => o.value);
  selectEl.value = knownValues.includes(currentValue) ? currentValue : fallback;
}

function populateModelSelect(selectEl, backend, currentModel) {
  fillSelect(selectEl, modelsFor(backend), currentModel, defaultModelFor(backend));
}
function populateReasoningSelect(selectEl, backend, model, currentEffort) {
  const values = effortValuesFor(backend, model);
  const def = defaultEffortFor(backend);
  if (values.length === 0) {
    // effort 미지원 모델(Haiku): 비활성 + 빈 값.
    selectEl.innerHTML = '<option value="">강도 미지원</option>';
    selectEl.value = '';
    selectEl.disabled = true;
    return;
  }
  selectEl.disabled = false;
  const options = values.map(v => ({
    value: v,
    label: `강도: ${EFFORT_LABEL[v]}${v === def ? ' (기본값)' : ''}`,
  }));
  fillSelect(selectEl, options, currentEffort, def);
}

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
  if (msg.selectionMeta) {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = '<span class="chip-icon">🎯</span><span class="chip-name"></span><span class="chip-size"></span>';
    chip.querySelector('.chip-name').textContent = msg.selectionMeta.name || '선택 영역';
    chip.querySelector('.chip-size').textContent = msg.selectionMeta.meta || '';
    bubble.appendChild(chip);
  }
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
    const rendered = renderMarkdownWithEvidence(msg.report, msg.verifiedClaims || state.currentVerifiedClaims);
    while (rendered.firstChild) report.appendChild(rendered.firstChild);
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
    let refNo = 0;
    for (const v of verifiedClaims) {
      const tr = document.createElement('tr');
      tr.className = `claim-row claim-${v.status}`;
      const tdS = document.createElement('td'); tdS.textContent = STATUS_LABEL[v.status] ?? v.status;
      const tdC = document.createElement('td'); tdC.textContent = v.claim?.text ?? '';
      const tdE = document.createElement('td');
      const quote = v.evidenceQuote ?? '';
      if (quote) {
        refNo += 1;
        // 근거를 클릭형 레퍼런스로: 누르면 PDF에서 위치로 점프 + 하이라이트
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'evidence-ref';
        btn.title = '논문에서 이 근거 위치로 이동';
        btn.innerHTML = `<span class="ref-num">[${refNo}]</span><span class="ref-quote">${escapeHtml(quote)}</span><span class="ref-loupe">🔎</span>`;
        const vRef = v;
        btn.addEventListener('click', () => onEvidenceClick(quote, vRef));
        tdE.appendChild(btn);
      }
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
  const rendered = renderMarkdownWithEvidence(msg.text || '', msg.citations || state.currentVerifiedClaims);
  while (rendered.firstChild) body.appendChild(rendered.firstChild);
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
  if (chatMainEl) chatMainEl.scrollTop = chatMainEl.scrollHeight;
}

function rerenderEvidenceMessages() {
  for (const msg of state.messages) {
    if (msg.role === 'assistant' && (msg.kind === 'analysis' || msg.kind === 'chat')) {
      renderMsg(msg);
    }
  }
  if (state.workspaceTab === 'analysis') renderAnalysisMatrix();
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
  showLocalPdf(file); // 우측 패널에 즉시 미리보기
  updateComposerMode();
  updateSendState();
}

function clearAttachment() {
  state.pendingPdf = null;
  attachmentChip.hidden = true;
  fileInput.value = '';
  updateComposerMode();
  updateSendState();
}

function updateComposerMode() {
  const hasPdf = !!state.pendingPdf;
  const hasSession = !!state.sessionId;
  const isPaper = state.mode === 'paper' && !!state.currentPaperId;
  const paperHasAnalysis = isPaper && !!state.currentAnalysisId;
  const initial = !hasPdf && !hasSession && !isPaper && !state.busy;
  attachZone.hidden = !initial;
  composerRow.hidden = initial;
  composerInput.placeholder = hasPdf
    ? '강조하고 싶은 부분이 있다면 입력하세요 (선택)'
    : (isPaper && !paperHasAnalysis)
      ? '이 논문은 분석 결과가 없습니다. 새 분석을 시작하세요.'
      : '후속 질문을 입력하세요...';
}

function autoGrow() {
  composerInput.style.height = 'auto';
  composerInput.style.height = Math.min(composerInput.scrollHeight, 160) + 'px';
}

function updateSendState() {
  const text = composerInput.value.trim();
  const hasPdf = !!state.pendingPdf;
  const isPaper = state.mode === 'paper' && !!state.currentPaperId;
  const paperHasAnalysis = isPaper && !!state.currentAnalysisId;
  let enabled = !state.busy;
  if (hasPdf) {
    // 분석 가능 (text는 emphasis로 사용, 선택)
  } else if (isPaper && !paperHasAnalysis) {
    // paper 모드인데 분석이 없으면 채팅 불가
    enabled = false;
  } else if ((state.sessionId || paperHasAnalysis) && text) {
    // 채팅 가능
  } else if (!state.sessionId && !paperHasAnalysis) {
    enabled = false;
  } else if (!text) {
    enabled = false;
  }
  sendBtn.disabled = !enabled;
  updateComposerMode();
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
    if (typeof payload.message === 'string' && /로그인/.test(payload.message)) {
      fetchAuthStatus(true);
    }
    return;
  }
  if (payload.stage === 'done') {
    msg.progress.push({ stage: 'done', message: payload.message });
    msg.status = 'done';
    msg.report = payload.report || '';
    msg.metrics = payload.metrics;
    msg.verifiedClaims = payload.verifiedClaims || [];
    state.currentVerifiedClaims = msg.verifiedClaims;
    state.currentReport = msg.report;
    state.currentCoreInsights = null;
    state.coreInsightsError = '';
    msg.analyst = payload.analyst;
    msg.directive = payload.directive;
    msg.auditResults = payload.auditResults;
    if (payload.sessionId) {
      msg.sessionId = payload.sessionId;
      state.sessionId = payload.sessionId;
      updateComposerMode();
    }
    if (payload.paperId) {
      state.currentPaperId = payload.paperId;
      state.currentAnalysisId = payload.analysisId;
      state.mode = 'paper';
      showPaperPdf(payload.paperId); // 로컬 blob → 저장된 서버 PDF로 전환 (제목 유지)
      refreshLibrary();
    }
    renderMsg(msg);
    renderAnalysisMatrix();
    scrollToBottom();
    return;
  }
  msg.progress.push({ stage: payload.stage, message: payload.message, meta: payload.meta });
  renderMsg(msg);
  scrollToBottom();
}

// ---------------- 채팅 ----------------

async function sendChat(question) {
  const selection = state.pendingPdfSelection;
  const selectionPayload = selectionRequestPayload(selection);
  const selectionMetaForBubble = selection ? selectionSummary(selection) : null;
  const userMsg = addMessage({ id: uid(), role: 'user', kind: 'chat', text: question, selectionMeta: selectionMetaForBubble });
  const assistantMsg = addMessage({
    id: uid(), role: 'assistant', kind: 'chat', status: 'loading',
  });

  state.busy = true;
  updateSendState();
  try {
    const url = state.mode === 'paper' && state.currentPaperId
      ? `/api/library/papers/${state.currentPaperId}/chat`
      : '/chat';
    const body = state.mode === 'paper' && state.currentPaperId
      ? { question }
      : { sessionId: state.sessionId, question };
    if (selectionPayload) body.selection = selectionPayload;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    if (res.ok && json && typeof json.answer === 'string') {
      updateMessage(assistantMsg.id, { status: 'done', text: json.answer, citations: json.citations || [] });
      clearPdfSelection();
    } else if (res.status === 410) {
      state.sessionId = null;
      updateComposerMode();
      updateMessage(assistantMsg.id, {
        status: 'error',
        error: (json && json.error) || '세션이 만료됐어요. 새 분석을 시작하세요.',
      });
      newAnalysisBtn.classList.add('highlight');
      // 입력 복원
      composerInput.value = question;
      if (selection) setPdfSelection(selection);
      autoGrow();
    } else if (res.status === 401) {
      const m = (json && json.error) || '로그인이 필요합니다.';
      updateMessage(assistantMsg.id, { status: 'error', error: m });
      composerInput.value = question;
      if (selection) setPdfSelection(selection);
      autoGrow();
      fetchAuthStatus(true);
    } else {
      const m = (json && json.error) || `요청 실패 (${res.status})`;
      updateMessage(assistantMsg.id, { status: 'error', error: m });
      composerInput.value = question;
      if (selection) setPdfSelection(selection);
      autoGrow();
    }
  } catch (err) {
    updateMessage(assistantMsg.id, { status: 'error', error: `네트워크 오류: ${err.message}` });
    composerInput.value = question;
    if (selection) setPdfSelection(selection);
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

  const canChatWithPaper = state.mode === 'paper' && !!state.currentPaperId && !!state.currentAnalysisId;
  if (!state.sessionId && !canChatWithPaper) {
    setComposerHint('먼저 PDF를 첨부하세요.', true);
    return;
  }
  if (!text) return;

  composerInput.value = '';
  autoGrow();
  await sendChat(text);
}

// ---------------- 새 분석 / 설정 ----------------

function clearConversation() {
  state.sessionId = null;
  state.messages = [];
  state.busy = false;
  state.pendingPdf = null;
  state.pendingPdfSelection = null;
  state.currentPaperId = null;
  state.currentAnalysisId = null;
  state.currentVerifiedClaims = [];
  state.currentReport = '';
  state.currentCoreInsights = null;
  state.coreInsightsBusy = false;
  state.coreInsightsError = '';
  exitLatexMode();
  state.mode = 'new';
  messagesEl.innerHTML = '';
  renderAnalysisMatrix();
  clearAttachment();
  clearPdfSelection();
  clearPdf();
  composerInput.value = '';
  autoGrow();
  setComposerHint('');
  newAnalysisBtn.classList.remove('highlight');
  setWorkspaceTab('chat');
  updateSendState();
  renderSidebar();
}

// ---------------- LaTeX 모드 ----------------

let latexEditor = null;
let latexEditorPromise = null;
let latexSaveTimer = 0;

function isZip(file) {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

function enterLatexMode() {
  if (chatPane) chatPane.hidden = true;
  if (latexPane) latexPane.hidden = false;
  // 우측 PDF 패널을 컴파일 결과 전용으로: 분석용 컨트롤 숨기고 절반 폭으로
  if (pdfSelectBtn) pdfSelectBtn.hidden = true;
  if (pdfCloseBtn) pdfCloseBtn.hidden = true;
  if (pdfPane && workspaceEl) pdfPane.style.width = Math.round(workspaceEl.clientWidth * 0.5) + 'px';
}

function exitLatexMode() {
  if (state.mode === 'latex' && state.latexDirty) { saveCurrentLatexFile(); }
  if (latexPane) latexPane.hidden = true;
  if (chatPane) chatPane.hidden = false;
  if (pdfSelectBtn) pdfSelectBtn.hidden = false;
  if (pdfCloseBtn) pdfCloseBtn.hidden = false;
  state.currentProjectId = null;
  state.currentLatexFile = null;
  state.latexMainFile = null;
  state.latexFiles = [];
  state.latexDirty = false;
}

async function ensureLatexEditor() {
  if (latexEditor) return latexEditor;
  if (!latexEditorPromise) {
    latexEditorPromise = createLatexEditor(latexEditorHost).then((ed) => {
      latexEditor = ed;
      ed.onChange(() => { state.latexDirty = true; updateLatexSaveState(); scheduleLatexAutosave(); });
      ed.onSave(() => { saveCurrentLatexFile(); });
      return ed;
    });
  }
  return latexEditorPromise;
}

function updateLatexSaveState(text, isErr) {
  if (!latexSaveState) return;
  if (text != null) {
    latexSaveState.textContent = text;
    latexSaveState.classList.toggle('error', !!isErr);
  } else {
    latexSaveState.textContent = state.latexDirty ? '● 저장 안 됨' : '';
    latexSaveState.classList.remove('error');
  }
}

function scheduleLatexAutosave() {
  clearTimeout(latexSaveTimer);
  latexSaveTimer = setTimeout(() => saveCurrentLatexFile(), 1200);
}

async function saveCurrentLatexFile() {
  if (!state.currentProjectId || !state.currentLatexFile || !latexEditor || !state.latexDirty) return;
  const projectId = state.currentProjectId;
  const filePath = state.currentLatexFile;
  const content = latexEditor.getValue();
  try {
    const res = await fetch(`/api/library/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
    if (state.currentLatexFile === filePath) { state.latexDirty = false; updateLatexSaveState('저장됨'); }
  } catch (err) {
    updateLatexSaveState('저장 실패: ' + err.message, true);
  }
}

async function openLatexProject(id) {
  try {
    const res = await fetch(`/api/library/projects/${id}`);
    if (!res.ok) { showToast('프로젝트 로딩 실패'); return; }
    const { project, files, mainFile, mainContent, hasPdf } = await res.json();
    state.currentPaperId = null;
    state.currentAnalysisId = null;
    state.sessionId = null;
    state.mode = 'latex';
    state.currentProjectId = id;
    state.latexMainFile = mainFile;
    state.currentLatexFile = mainFile;
    state.latexFiles = files || [];
    state.latexDirty = false;
    enterLatexMode();
    if (latexTitle) { latexTitle.textContent = project.name || 'LaTeX 프로젝트'; latexTitle.title = project.name || ''; }
    renderLatexFileTree();
    try {
      await ensureLatexEditor();
      latexEditor.setContent(mainFile, mainContent || '');
    } catch (err) {
      showToast('에디터 로딩 실패: ' + err.message);
    }
    updateLatexSaveState();
    setLatexCompileStatus(hasPdf ? 'ok' : '');
    await refreshLatexEngineBanner();
    showProjectPdf(id, hasPdf); // 우측 PDF 패널 항상 표시(없으면 placeholder)
    renderSidebar();
    setTimeout(() => { if (latexEditor) latexEditor.layout(); }, 60);
  } catch (err) {
    showToast('프로젝트 로딩 실패: ' + err.message);
  }
}

function renderLatexFileTree() {
  if (!latexFileTree) return;
  latexFileTree.innerHTML = '';
  for (const f of state.latexFiles) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'latex-file'
      + (f.path === state.currentLatexFile ? ' active' : '')
      + (f.editable ? '' : ' readonly');
    const label = f.path === state.latexMainFile ? `★ ${f.path}` : f.path;
    item.textContent = label;
    item.title = f.editable ? f.path : `${f.path} (읽기 전용)`;
    if (f.editable) item.addEventListener('click', () => loadLatexFile(f.path));
    else item.disabled = true;
    latexFileTree.appendChild(item);
  }
}

async function loadLatexFile(filePath) {
  if (!state.currentProjectId || filePath === state.currentLatexFile) return;
  if (state.latexDirty) await saveCurrentLatexFile();
  try {
    const res = await fetch(`/api/library/projects/${state.currentProjectId}/file?path=${encodeURIComponent(filePath)}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    state.currentLatexFile = filePath;
    state.latexDirty = false;
    if (latexEditor) latexEditor.setContent(filePath, j.content || '');
    updateLatexSaveState();
    renderLatexFileTree();
  } catch (err) {
    showToast('파일 열기 실패: ' + err.message);
  }
}

async function refreshLatexEngineBanner() {
  if (!latexEngineBanner) return;
  try {
    const res = await fetch('/api/latex-status');
    const j = await res.json();
    state.latexEngine = j.engine || null;
    if (j.engine) {
      latexEngineBanner.hidden = true;
      if (latexCompileBtn) { latexCompileBtn.disabled = false; latexCompileBtn.title = `엔진: ${j.engine}`; }
    } else {
      latexEngineBanner.hidden = false;
      latexEngineBanner.innerHTML = 'LaTeX 컴파일러가 없어 컴파일할 수 없습니다 (편집은 가능). 아래에서 설치 후 앱을 재시작하세요.<br>'
        + '<b>MiKTeX</b>(추천 · IEEE/ACM 등 pdfLaTeX 템플릿 호환): '
        + '<a href="https://miktex.org/download" target="_blank" rel="noopener">miktex.org/download</a> · '
        + '<b>TeX Live</b>: <a href="https://tug.org/texlive/" target="_blank" rel="noopener">tug.org/texlive</a> · '
        + '<b>tectonic</b>(무설치 단일 바이너리, 단 XeTeX): '
        + '<a href="https://tectonic-typesetting.github.io/en-US/install.html" target="_blank" rel="noopener">설치 안내</a>';
      if (latexCompileBtn) latexCompileBtn.disabled = true;
    }
  } catch { /* ignore */ }
}

async function compileLatex() {
  if (!state.currentProjectId || state.latexBusy) return;
  if (state.latexDirty) await saveCurrentLatexFile();
  state.latexBusy = true;
  if (latexCompileBtn) { latexCompileBtn.disabled = true; latexCompileBtn.textContent = '컴파일 중...'; }
  try {
    const res = await fetch(`/api/library/projects/${state.currentProjectId}/compile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mainFile: state.latexMainFile }),
    });
    const j = await res.json().catch(() => ({}));
    showLatexLog(j.log || j.error || '(로그 없음)');
    if (j.hasPdf) {
      showProjectPdf(state.currentProjectId, true);
      setLatexCompileStatus(j.ok ? 'ok' : 'warn');
      if (!j.ok) showToast('경고와 함께 컴파일됨 — 로그 확인');
    } else {
      setLatexCompileStatus('fail');
      if (latexLog) latexLog.hidden = false;
      showToast('컴파일 실패 — 로그를 확인하세요');
    }
  } catch (err) {
    setLatexCompileStatus('fail');
    showToast('컴파일 요청 실패: ' + err.message);
  } finally {
    state.latexBusy = false;
    if (latexCompileBtn) { latexCompileBtn.disabled = false; latexCompileBtn.textContent = '컴파일'; }
  }
}

// 컴파일 상태 배지: ''(숨김) | 'ok' | 'warn' | 'fail'
function setLatexCompileStatus(kind) {
  if (!latexCompileStatus) return;
  const map = {
    ok:   { text: '✓ 컴파일 성공', cls: 'ok' },
    warn: { text: '⚠ 경고와 함께 컴파일', cls: 'warn' },
    fail: { text: '✗ 컴파일 실패 (로그 확인)', cls: 'fail' },
  };
  const m = map[kind];
  latexCompileStatus.hidden = !m;
  latexCompileStatus.className = 'latex-compile-status' + (m ? ' ' + m.cls : '');
  latexCompileStatus.textContent = m ? m.text : '';
}

function showLatexLog(text) {
  if (latexLogBody) latexLogBody.textContent = text || '';
}

// AI 편집 채팅: 현재 파일 + 지시 → 수정된 파일 적용 + 재컴파일
function appendLatexChat(role, text) {
  if (!latexChatLog) return null;
  const el = document.createElement('div');
  el.className = 'latex-chat-msg ' + role;
  el.textContent = (role === 'user' ? '🧑 ' : '🤖 ') + text;
  latexChatLog.appendChild(el);
  latexChatLog.scrollTop = latexChatLog.scrollHeight;
  return el;
}

async function sendLatexChat() {
  const instruction = (latexChatInput && latexChatInput.value || '').trim();
  if (!instruction || state.latexChatBusy) return;
  if (!state.currentProjectId || !state.currentLatexFile) { showToast('편집할 파일을 먼저 여세요'); return; }
  state.latexChatBusy = true;
  if (latexChatSend) latexChatSend.disabled = true;
  appendLatexChat('user', instruction);
  latexChatInput.value = '';
  const pending = appendLatexChat('ai', '수정 중…');
  try {
    if (state.latexDirty) await saveCurrentLatexFile(); // 현재 편집분 먼저 저장
    const res = await fetch(`/api/library/projects/${state.currentProjectId}/chat-edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: state.currentLatexFile, instruction }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
    const moduleLabel = { writing: '✍️ 본문', figure: '📊 그림/표', citation: '📚 인용' }[j.module] || '';
    if (pending) pending.textContent = `🤖 ${moduleLabel ? '[' + moduleLabel + '] ' : ''}${j.note || '수정 완료'}`;
    // 편집한 파일이 현재 열린 파일이면 에디터에 반영
    if (latexEditor && typeof j.content === 'string' && j.file === state.currentLatexFile) {
      latexEditor.setContent(state.currentLatexFile, j.content);
      state.latexDirty = false;
      updateLatexSaveState();
    }
    // 서버가 이미 컴파일(+에러수정 루프)했으므로 결과 PDF만 다시 로드
    showLatexLog(j.log || '');
    setLatexCompileStatus(j.compiled ? 'ok' : 'fail');
    showProjectPdf(state.currentProjectId, !!j.compiled);
    if (!j.compiled && latexLog) latexLog.hidden = false;
  } catch (err) {
    if (pending) { pending.textContent = '🤖 실패: ' + err.message; pending.classList.add('error'); }
  } finally {
    state.latexChatBusy = false;
    if (latexChatSend) latexChatSend.disabled = false;
  }
}

// 컴파일 결과 PDF 를 우측 패널(PDF.js)에 로드. 컴파일 전이면 빈 상태로 패널만 연다.
function showProjectPdf(projectId, hasPdf = true) {
  if (!pdfViewer) return;
  revokePdfBlob();
  setPdfTitle('컴파일 결과');
  pdfState.paperId = null;
  pdfState.available = true;
  pdfState.open = true;
  applyPdfLayout();
  pdfViewer.currentPaperId = null;
  if (hasPdf) {
    const url = `/api/library/projects/${projectId}/pdf?t=${Date.now()}`;
    if (pdfOpenExternal) pdfOpenExternal.href = url;
    pdfViewer.load(url).catch(err => console.warn('컴파일 PDF 로드 실패', err));
  } else {
    pdfViewer.destroy();
    if (pdfBody) pdfBody.innerHTML = '<div class="pdf-placeholder">컴파일하면 여기에 PDF가 표시됩니다</div>';
  }
}

async function uploadLatexZip(file) {
  if (!isZip(file)) { showToast('ZIP 파일만 업로드할 수 있어요.'); return; }
  showToast('LaTeX 프로젝트 업로드 중...');
  try {
    const res = await fetch('/api/library/projects', {
      method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    await refreshLatexProjects();
    await openLatexProject(j.project.id);
    // 엔진이 있으면 채팅 없이 바로 컴파일
    if (state.latexEngine) {
      await compileLatex();
    } else {
      showToast('프로젝트 생성됨 — LaTeX 컴파일러를 설치하면 컴파일할 수 있어요');
    }
  } catch (err) {
    showToast('업로드 실패: ' + err.message);
  }
}

async function refreshLatexProjects() {
  try {
    const res = await fetch('/api/library/projects');
    const j = await res.json();
    state.latexProjects = j.projects || [];
  } catch { state.latexProjects = []; }
  renderLatexSidebar();
}

function renderLatexSidebar() {
  if (!latexTreeEl) return;
  latexTreeEl.innerHTML = '';
  for (const p of state.latexProjects) latexTreeEl.appendChild(buildProjectItem(p));
}

function buildProjectItem(p) {
  const item = document.createElement('div');
  item.className = 'paper-item project-item' + (p.id === state.currentProjectId && state.mode === 'latex' ? ' active' : '');
  item.dataset.projectId = p.id;
  const icon = document.createElement('span'); icon.className = 'paper-icon'; icon.textContent = '📝';
  const title = document.createElement('span'); title.className = 'paper-title'; title.textContent = p.name || 'LaTeX'; title.title = p.name || '';
  const del = document.createElement('button'); del.type = 'button'; del.className = 'row-menu'; del.textContent = '×'; del.title = '삭제';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`"${p.name}" 프로젝트를 삭제할까요? (되돌릴 수 없음)`)) return;
    await deleteLatexProject(p.id);
  });
  item.append(icon, title, del);
  item.addEventListener('click', (e) => { if (e.target.closest('.row-menu')) return; openLatexProject(p.id); });
  return item;
}

async function deleteLatexProject(id) {
  try {
    await fetch(`/api/library/projects/${id}`, { method: 'DELETE' });
    if (state.currentProjectId === id) clearConversation();
    await refreshLatexProjects();
  } catch (err) {
    showToast('삭제 실패: ' + err.message);
  }
}

function startNewAnalysis() {
  if (state.busy) {
    if (!confirm('진행 중인 분석이 있습니다. 버리고 새로 시작할까요?')) return;
  }
  clearConversation();
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

let llmLoaded = false;
function fillLlmRows(cfg) {
  for (const role of LLM_ROLES) {
    const row = settingsModal.querySelector(`.llm-row[data-role="${role}"]`);
    if (!row) continue;
    const backendEl = row.querySelector('.llm-backend');
    const modelEl = row.querySelector('.llm-model');
    const reasoningEl = row.querySelector('.llm-reasoning');
    const roleCfg = cfg[role] || { backend: 'claude', model: '', reasoningEffort: '' };
    backendEl.value = ['claude', 'codex'].includes(roleCfg.backend) ? roleCfg.backend : 'claude';
    populateModelSelect(modelEl, backendEl.value, roleCfg.model || '');
    populateReasoningSelect(reasoningEl, backendEl.value, modelEl.value, roleCfg.reasoningEffort || '');
  }
}
function bindLlmRowEvents() {
  for (const row of settingsModal.querySelectorAll('.llm-row')) {
    const backendEl = row.querySelector('.llm-backend');
    const modelEl = row.querySelector('.llm-model');
    const reasoningEl = row.querySelector('.llm-reasoning');
    if (backendEl.dataset.bound) continue;
    backendEl.dataset.bound = '1';
    backendEl.addEventListener('change', () => {
      populateModelSelect(modelEl, backendEl.value, '');
      populateReasoningSelect(reasoningEl, backendEl.value, modelEl.value, '');
    });
    // 모델이 바뀌면 지원 effort 등급도 달라지므로 강도 칸을 다시 채운다.
    modelEl.addEventListener('change', () => {
      populateReasoningSelect(reasoningEl, backendEl.value, modelEl.value, '');
    });
  }
}
async function loadLlmIntoModal() {
  if (llmLoaded) return;
  const res = await fetch('/api/llm-config');
  if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
  const json = await res.json();
  fillLlmRows(json);
  bindLlmRowEvents();
  llmLoaded = true;
  applyAuthStatus();
}

function flashLlmStatus(text, isError = false) {
  flashPromptsStatus(text, isError); // 모델 저장 상태도 하단 공용 상태에 표시
}

async function openSettings() {
  try {
    await loadPromptsIntoModal();
    await loadLlmIntoModal();
  } catch (err) {
    setComposerHint(`설정 로딩 실패: ${err.message}`, true);
    return;
  }
  settingsModal.hidden = false;
}
function closeSettings() {
  settingsModal.hidden = true;
}

// ---------------- 로그인 상태 ----------------

async function fetchAuthStatus(force = false) {
  try {
    const res = force
      ? await fetch('/api/auth-status/refresh', { method: 'POST' })
      : await fetch('/api/auth-status');
    if (!res.ok) return;
    authStatus = await res.json();
    applyAuthStatus();
  } catch { /* ignore */ }
}

function applyAuthStatus() {
  if (!authStatus) return;
  const claudeOk = !!authStatus.claude?.loggedIn;
  const codexOk = !!authStatus.codex?.loggedIn;

  if (!claudeOk && !codexOk) {
    if (authBlocker) authBlocker.hidden = false;
    if (authBanner) authBanner.hidden = true;
  } else if (claudeOk && codexOk) {
    if (authBlocker) authBlocker.hidden = true;
    if (authBanner) authBanner.hidden = true;
  } else {
    if (authBlocker) authBlocker.hidden = true;
    if (authBanner) {
      authBanner.hidden = false;
      authBanner.dataset.severity = 'warning';
      if (authBannerText) {
        authBannerText.textContent = claudeOk
          ? 'Codex 로그아웃 — Codex로 설정된 역할은 분석 실패합니다. 터미널에서 codex login 후 [다시 확인]'
          : 'Claude 로그아웃 — Codex가 사용 가능해 기본값을 Codex/GPT-5.5로 전환했습니다. Claude를 쓰려면 터미널에서 claude 후 로그인하고 [다시 확인]';
      }
    }
  }

  // 모달 모델 탭의 backend 옵션 활성/비활성 토글.
  // Claude가 없고 Codex가 있으면 서버 기본값과 맞춰 Codex/GPT-5.5로 전환한다.
  for (const row of settingsModal.querySelectorAll('.llm-row')) {
    const backendEl = row.querySelector('.llm-backend');
    const modelEl = row.querySelector('.llm-model');
    const reasoningEl = row.querySelector('.llm-reasoning');
    if (!backendEl) continue;
    if (!claudeOk && codexOk && backendEl.value === 'claude') {
      backendEl.value = 'codex';
      if (modelEl) populateModelSelect(modelEl, 'codex', CODEX_MODEL);
      if (reasoningEl) populateReasoningSelect(reasoningEl, 'codex', CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT);
    }
    for (const opt of backendEl.options) {
      const okMap = { claude: claudeOk, codex: codexOk };
      const ok = okMap[opt.value];
      const baseLabel = opt.dataset.baseLabel || opt.textContent.replace(/\s*\(로그아웃\)\s*$/, '');
      opt.dataset.baseLabel = baseLabel;
      opt.disabled = !ok;
      opt.textContent = ok ? baseLabel : `${baseLabel} (로그아웃)`;
    }
    const selected = backendEl.selectedOptions[0];
    row.classList.toggle('has-conflict', !!(selected && selected.disabled));
  }
}

// ---------------- 이벤트 바인딩 ----------------

attachZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  if (isZip(f)) uploadLatexZip(f);   // zip → 바로 컴파일 프로젝트
  else setAttachment(f);             // pdf → 분석
  fileInput.value = '';
});
attachClear.addEventListener('click', () => {
  clearAttachment();
  // 분석 시작 전 첨부를 취소하면 미리보기도 닫는다 (논문 열람 중에는 유지).
  if (!state.busy && state.mode === 'new') clearPdf();
});
if (selectionClear) selectionClear.addEventListener('click', () => {
  clearPdfSelection();
  setComposerHint('');
});

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

newAnalysisBtn.addEventListener('click', startNewAnalysis);

for (const tab of workspaceTabs) {
  tab.addEventListener('click', () => setWorkspaceTab(tab.getAttribute('data-workspace-tab')));
}

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
  const f = files && files[0];
  if (!f) return;
  if (isZip(f)) uploadLatexZip(f);
  else setAttachment(f);
});

// LaTeX 모드 이벤트
if (newLatexBtn) newLatexBtn.addEventListener('click', () => zipInput && zipInput.click());
if (zipInput) zipInput.addEventListener('change', () => {
  const f = zipInput.files && zipInput.files[0];
  if (f) uploadLatexZip(f);
  zipInput.value = '';
});
if (latexCompileBtn) latexCompileBtn.addEventListener('click', compileLatex);
if (latexChatSend) latexChatSend.addEventListener('click', sendLatexChat);
if (latexChatInput) latexChatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendLatexChat(); }
});
if (latexZipBtn) latexZipBtn.addEventListener('click', () => {
  if (!state.currentProjectId) return;
  const a = document.createElement('a');
  a.href = `/api/library/projects/${state.currentProjectId}/zip`;
  a.download = ((latexTitle && latexTitle.textContent) || 'project') + '.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
});
if (latexLogBtn) latexLogBtn.addEventListener('click', () => { if (latexLog) latexLog.hidden = !latexLog.hidden; });
if (latexLogClose) latexLogClose.addEventListener('click', () => { if (latexLog) latexLog.hidden = true; });
if (latexCompileStatus) latexCompileStatus.addEventListener('click', () => {
  if (latexCompileStatus.classList.contains('fail') || latexCompileStatus.classList.contains('warn')) {
    if (latexLog) latexLog.hidden = false;
  }
});

// 설정 모달
openSettingsBtn.addEventListener('click', openSettings);
settingsModal.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', closeSettings);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsModal.hidden) closeSettings();
  else if (e.key === 'Escape' && pdfViewer?.isSelectionMode?.()) setPdfSelectionMode(false);
});
// 2단 탭: 상위(분석팀/작성팀) × 하위(오케스트레이터/팀원/모델)
let settingsTeam = 'analysis';
let settingsSection = 'orchestrator';
function applySettingsTabs() {
  settingsModal.querySelectorAll('.team-tab').forEach(t => t.classList.toggle('active', t.dataset.team === settingsTeam));
  settingsModal.querySelectorAll('.section-tab').forEach(t => t.classList.toggle('active', t.dataset.section === settingsSection));
  settingsModal.querySelectorAll('.settings-pane').forEach(p => {
    p.classList.toggle('active', p.dataset.team === settingsTeam && p.dataset.section === settingsSection);
  });
}
settingsModal.querySelectorAll('.team-tab').forEach(t => t.addEventListener('click', () => { settingsTeam = t.dataset.team; applySettingsTabs(); }));
settingsModal.querySelectorAll('.section-tab').forEach(t => t.addEventListener('click', () => { settingsSection = t.dataset.section; applySettingsTabs(); }));
settingsModal.querySelectorAll('[data-reset]').forEach(btn => {
  btn.addEventListener('click', () => resetPromptField(btn.getAttribute('data-reset')));
});
async function savePrompts() {
  savePromptsBtn.disabled = true;
  try {
    const body = {};
    for (const [key, el] of Object.entries(PROMPT_FIELDS)) {
      if (el) body[key] = el.value;
    }
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
}

async function saveLlmConfig() {
  if (saveLlmBtn) saveLlmBtn.disabled = true;
  savePromptsBtn.disabled = true;
  try {
    const body = {};
    for (const role of LLM_ROLES) {
      const row = settingsModal.querySelector(`.llm-row[data-role="${role}"]`);
      if (!row) continue;
      const backend = row.querySelector('.llm-backend').value;
      const model = row.querySelector('.llm-model').value;
      const reasoningEffort = row.querySelector('.llm-reasoning').value;
      body[role] = { backend, model, reasoningEffort };
    }
    const res = await fetch('/api/llm-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      flashLlmStatus('저장됨');
    } else {
      let msg = `오류 (${res.status})`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
      flashLlmStatus(msg, true);
    }
  } catch (err) {
    flashLlmStatus(`네트워크 오류: ${err.message}`, true);
  } finally {
    if (saveLlmBtn) saveLlmBtn.disabled = false;
    savePromptsBtn.disabled = false;
  }
}

// 하단 저장 버튼 하나로 프롬프트 + 모델 설정을 함께 저장
savePromptsBtn.addEventListener('click', async () => {
  await savePrompts();
  await saveLlmConfig();
});

// 모델 기본값 리셋 (각 모델 패널의 버튼)
settingsModal.querySelectorAll('.reset-llm-btn').forEach(btn => btn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/llm-config/defaults');
    if (!res.ok) return;
    const json = await res.json();
    fillLlmRows(json);
  } catch { /* ignore */ }
}));

// 로그인 상태 버튼들
if (authBannerRefreshBtn) authBannerRefreshBtn.addEventListener('click', () => fetchAuthStatus(true));
if (authBlockerRefreshBtn) {
  authBlockerRefreshBtn.addEventListener('click', async () => {
    if (authBlockerStatus) {
      authBlockerStatus.textContent = '확인 중...';
      authBlockerStatus.classList.add('visible');
    }
    await fetchAuthStatus(true);
    if (authBlockerStatus) {
      authBlockerStatus.textContent = '확인 완료';
      setTimeout(() => { authBlockerStatus.classList.remove('visible'); authBlockerStatus.textContent = ''; }, 1500);
    }
  });
}
if (authBannerHelpBtn) authBannerHelpBtn.addEventListener('click', () => { if (authBlocker) authBlocker.hidden = false; });
if (authBlockerCloseBtn) authBlockerCloseBtn.addEventListener('click', () => {
  // 둘 다 로그아웃 상태면 닫지 못하게(다시 열림)
  if (!authStatus) return;
  const anyOk = authStatus.claude?.loggedIn || authStatus.codex?.loggedIn;
  if (anyOk && authBlocker) authBlocker.hidden = true;
});

// ---------------- 라이브러리 사이드바 ----------------

const FOLDER_STATE_KEY = 'paaFolderState';

function loadFolderOpenState() {
  try {
    const raw = localStorage.getItem(FOLDER_STATE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch { return {}; }
}
function saveFolderOpenState(map) {
  try { localStorage.setItem(FOLDER_STATE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

function renderSidebar() {
  renderLatexSidebar();
  // 대화/핵심분석 탭은 논문 분석 컨텍스트(mode 'paper')에서만 노출
  if (workspaceTabsBar) workspaceTabsBar.hidden = state.mode !== 'paper';
  const openState = loadFolderOpenState();
  libraryTreeEl.innerHTML = '';
  const tree = state.libraryTree || { folders: [], unfoldered: [] };

  for (const p of tree.unfoldered || []) {
    libraryTreeEl.appendChild(buildPaperItem(p));
  }

  for (const folder of tree.folders || []) {
    const wrap = document.createElement('div');
    wrap.className = 'folder';
    wrap.dataset.folderId = folder.id;

    const head = document.createElement('div');
    head.className = 'folder-head';
    head.dataset.folderId = folder.id;
    const isOpen = openState[folder.id] !== false; // 기본 열림

    const toggle = document.createElement('span');
    toggle.className = 'folder-toggle';
    toggle.textContent = isOpen ? '▼' : '▶';
    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.textContent = '📁';
    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;
    const count = document.createElement('span');
    count.className = 'folder-count';
    count.textContent = `(${(folder.papers || []).length})`;
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'row-menu';
    menu.textContent = '⋯';
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, { kind: 'folder', id: folder.id, name: folder.name });
    });

    head.append(toggle, icon, name, count, menu);

    const body = document.createElement('div');
    body.className = 'folder-body';
    if (!isOpen) body.hidden = true;
    for (const p of folder.papers || []) {
      body.appendChild(buildPaperItem(p));
    }

    head.addEventListener('click', (e) => {
      if (e.detail !== 1) return;
      if (e.target === menu) return;
      const nowOpen = body.hidden;
      body.hidden = !nowOpen;
      toggle.textContent = nowOpen ? '▼' : '▶';
      const st = loadFolderOpenState();
      st[folder.id] = nowOpen;
      saveFolderOpenState(st);
    });
    head.addEventListener('dblclick', (e) => {
      if (e.target === name) {
        e.preventDefault();
        e.stopPropagation();
        beginRename(name, folder.name, async (newName) => {
          await patchFolder(folder.id, { name: newName });
        });
      }
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, { kind: 'folder', id: folder.id, name: folder.name });
    });

    wrap.append(head, body);
    libraryTreeEl.appendChild(wrap);
  }
}

function buildPaperItem(paper) {
  const item = document.createElement('div');
  item.className = 'paper-item';
  item.dataset.paperId = paper.id;
  if (paper.id === state.currentPaperId) item.classList.add('active');

  const icon = document.createElement('span');
  icon.className = 'paper-icon';
  icon.textContent = '📄';
  const title = document.createElement('span');
  title.className = 'paper-title';
  title.textContent = paper.title || paper.source_file || '(제목 없음)';
  title.title = paper.title || paper.source_file || '';

  const menu = document.createElement('button');
  menu.type = 'button';
  menu.className = 'row-menu';
  menu.textContent = '⋯';
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, { kind: 'paper', id: paper.id, name: paper.title, folderId: paper.folder_id });
  });

  item.append(icon, title, menu);

  item.addEventListener('click', (e) => {
    if (e.detail !== 1) return;
    if (e.target.closest('.row-menu')) return;
    openPaper(paper.id);
  });
  item.addEventListener('dblclick', (e) => {
    if (e.target === title) {
      e.preventDefault();
      e.stopPropagation();
      beginRename(title, paper.title || '', async (newTitle) => {
        await patchPaper(paper.id, { title: newTitle });
      });
    }
  });
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, { kind: 'paper', id: paper.id, name: paper.title, folderId: paper.folder_id });
  });

  return item;
}

async function refreshLibrary() {
  try {
    const res = await fetch('/api/library/tree');
    if (!res.ok) return;
    state.libraryTree = await res.json();
    renderSidebar();
  } catch { /* ignore */ }
}

async function openPaper(paperId) {
  if (state.busy) return;
  try {
    const res = await fetch(`/api/library/papers/${paperId}`);
    if (!res.ok) {
      setComposerHint(`논문 로딩 실패 (${res.status})`, true);
      return;
    }
    const { paper, analysis, chats } = await res.json();
    if (state.mode === 'latex') exitLatexMode();
    state.mode = 'paper';
    state.currentPaperId = paper.id;
    state.currentAnalysisId = analysis ? analysis.id : null;
    state.currentVerifiedClaims = analysis?.claims || [];
    state.currentReport = analysis?.report || '';
    state.currentCoreInsights = analysis?.coreInsights || null;
    state.coreInsightsBusy = false;
    state.coreInsightsError = '';
    state.sessionId = null;
    state.messages = [];
    messagesEl.innerHTML = '';
    clearAttachment();

    addMessage({
      id: uid(),
      role: 'user',
      kind: 'attachment',
      file: { name: paper.source_file || paper.title || '논문', size: 0 },
      text: '',
    });

    if (analysis) {
      addMessage({
        id: uid(),
        role: 'assistant',
        kind: 'analysis',
        status: 'done',
        progress: [{ stage: 'done', message: '저장된 분석' }],
        report: analysis.report || '',
        verifiedClaims: state.currentVerifiedClaims,
        metrics: analysis.metrics,
        directive: analysis.directive ?? null,
        auditResults: analysis.auditResults ?? null,
      });
    }
    for (const c of chats || []) {
      if (c.role === 'user') {
        addMessage({ id: uid(), role: 'user', kind: 'chat', text: c.content });
      } else {
        addMessage({ id: uid(), role: 'assistant', kind: 'chat', status: 'done', text: c.content });
      }
    }
    renderAnalysisMatrix();
    setWorkspaceTab('chat');
    showPaperPdf(paper.id, paper.source_file || paper.title || '논문');
    updateComposerMode();
    updateSendState();
    renderSidebar();
  } catch (err) {
    setComposerHint(`논문 로딩 실패: ${err.message}`, true);
  }
}

// ---------------- 인라인 이름 편집 ----------------

function beginRename(spanEl, currentValue, onSave) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = spanEl.classList.contains('folder-name') ? 'folder-name-input' : 'paper-title-input';
  input.value = currentValue;
  spanEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const newValue = input.value.trim();
    try {
      if (commit && newValue && newValue !== currentValue) {
        await onSave(newValue);
        spanEl.textContent = newValue;
      }
    } catch (e) {
      console.warn(e);
    } finally {
      if (input.parentNode) input.replaceWith(spanEl);
      if (commit && newValue && newValue !== currentValue) {
        await refreshLibrary();
      }
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------------- 컨텍스트 메뉴 ----------------

let contextTarget = null;

function showContextMenu(x, y, target) {
  contextTarget = target;
  const moveBtn = contextMenuEl.querySelector('button[data-action="move"]');
  if (moveBtn) moveBtn.style.display = target.kind === 'paper' ? '' : 'none';
  contextMenuEl.hidden = false;
  // 위치
  contextMenuEl.style.left = x + 'px';
  contextMenuEl.style.top = y + 'px';
  // 화면 밖 보정
  const rect = contextMenuEl.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    contextMenuEl.style.left = (window.innerWidth - rect.width - 8) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    contextMenuEl.style.top = (window.innerHeight - rect.height - 8) + 'px';
  }
}

function hideContextMenu() {
  contextMenuEl.hidden = true;
  contextTarget = null;
}

document.addEventListener('click', (e) => {
  if (contextMenuEl.hidden) return;
  if (!contextMenuEl.contains(e.target)) hideContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !contextMenuEl.hidden) hideContextMenu();
});

contextMenuEl.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const target = contextTarget;
    hideContextMenu();
    if (!target) return;
    if (action === 'rename') {
      const selector = target.kind === 'folder'
        ? `.folder-head[data-folder-id="${target.id}"] .folder-name`
        : `.paper-item[data-paper-id="${target.id}"] .paper-title`;
      const el = libraryTreeEl.querySelector(selector);
      if (el) {
        beginRename(el, target.name || '', async (newName) => {
          if (target.kind === 'folder') await patchFolder(target.id, { name: newName });
          else await patchPaper(target.id, { title: newName });
        });
      }
    } else if (action === 'move' && target.kind === 'paper') {
      openFolderPicker(target.id);
    } else if (action === 'delete') {
      const label = target.name || (target.kind === 'folder' ? '폴더' : '논문');
      if (!confirm(`정말 "${label}" 을(를) 삭제하시겠습니까?`)) return;
      try {
        const url = target.kind === 'folder'
          ? `/api/library/folders/${target.id}`
          : `/api/library/papers/${target.id}`;
        const res = await fetch(url, { method: 'DELETE' });
        if (!res.ok) {
          setComposerHint(`삭제 실패 (${res.status})`, true);
          return;
        }
        if (target.kind === 'paper' && target.id === state.currentPaperId) {
          startNewAnalysis();
        }
        await refreshLibrary();
      } catch (err) {
        setComposerHint(`삭제 실패: ${err.message}`, true);
      }
    }
  });
});

async function patchFolder(id, body) {
  const res = await fetch(`/api/library/folders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
  return await res.json();
}
async function patchPaper(id, body) {
  const res = await fetch(`/api/library/papers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
  return await res.json();
}

// ---------------- 폴더 picker ----------------

let folderPickerPaperId = null;

function openFolderPicker(paperId) {
  folderPickerPaperId = paperId;
  folderPickerListEl.innerHTML = '';
  const folders = (state.libraryTree && state.libraryTree.folders) || [];
  if (folders.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '(폴더가 없습니다 — 좌측 "+ 새 폴더"로 만드세요)';
    folderPickerListEl.appendChild(li);
  } else {
    for (const f of folders) {
      const li = document.createElement('li');
      li.textContent = `📁 ${f.name}`;
      li.addEventListener('click', async () => {
        await movePaperToFolder(paperId, f.id);
        closeFolderPicker();
      });
      folderPickerListEl.appendChild(li);
    }
  }
  folderPickerEl.hidden = false;
}
function closeFolderPicker() {
  folderPickerEl.hidden = true;
  folderPickerPaperId = null;
}
folderPickerEl.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', closeFolderPicker);
});
folderPickerNullBtn.addEventListener('click', async () => {
  if (folderPickerPaperId == null) return;
  await movePaperToFolder(folderPickerPaperId, null);
  closeFolderPicker();
});

async function movePaperToFolder(paperId, folderId) {
  try {
    await patchPaper(paperId, { folderId });
    await refreshLibrary();
  } catch (err) {
    setComposerHint(`이동 실패: ${err.message}`, true);
  }
}

// ---------------- 새 폴더 ----------------

// Electron 렌더러(sandbox)에선 window.prompt 가 막혀있어, 기본 이름으로 만든 뒤
// 바로 인라인 리네임 모드로 들어가 사용자가 그 자리에서 이름 입력하도록 한다.
newFolderBtn.addEventListener('click', async () => {
  const defaultName = '새 폴더';
  try {
    const res = await fetch('/api/library/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: defaultName }),
    });
    if (!res.ok) {
      setComposerHint(`폴더 생성 실패 (${res.status})`, true);
      return;
    }
    const created = await res.json().catch(() => null);
    await refreshLibrary();
    const newId = created && created.id;
    if (newId != null) {
      const el = libraryTreeEl.querySelector(`.folder-head[data-folder-id="${newId}"] .folder-name`);
      if (el) {
        beginRename(el, defaultName, async (newName) => {
          if (newName && newName !== defaultName) {
            await patchFolder(newId, { name: newName });
          }
        });
      }
    }
  } catch (err) {
    setComposerHint(`폴더 생성 실패: ${err.message}`, true);
  }
});

// ---------------- 라이브러리 전체 리셋 ----------------

if (libraryResetBtn) {
  libraryResetBtn.addEventListener('click', async () => {
    if (!confirm('정말 라이브러리 전체를 초기화할까요? 모든 폴더/논문/분석/채팅이 영구 삭제됩니다.')) return;
    if (!confirm('마지막 확인: 정말 모든 데이터를 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;
    try {
      const res = await fetch('/api/library?confirm=yes', { method: 'DELETE' });
      if (!res.ok) {
        let msg = `초기화 실패 (${res.status})`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
        flashPromptsStatus(msg, true);
        return;
      }
      // 리셋 성공 후 무조건 정리 (busy 무시, confirm 우회)
      state.busy = false;
      state.sessionId = null;
      state.messages = [];
      state.pendingPdf = null;
      state.currentPaperId = null;
      state.currentAnalysisId = null;
      state.currentVerifiedClaims = [];
      state.currentReport = '';
      state.currentCoreInsights = null;
      state.coreInsightsBusy = false;
      state.coreInsightsError = '';
      state.mode = 'new';
      messagesEl.innerHTML = '';
      renderAnalysisMatrix();
      clearAttachment();
      clearPdf();
      composerInput.value = '';
      autoGrow();
      setComposerHint('');
      newAnalysisBtn.classList.remove('highlight');
      updateSendState();
      await refreshLibrary();
      closeSettings();
    } catch (err) {
      flashPromptsStatus(`초기화 실패: ${err.message}`, true);
    }
  });
}

// 초기 상태
autoGrow();
setWorkspaceTab('chat');
renderAnalysisMatrix();
updateComposerMode();
updateSendState();
fetchAuthStatus();
refreshLibrary();
refreshLatexProjects();
