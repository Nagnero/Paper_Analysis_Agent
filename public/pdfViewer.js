// public/pdfViewer.js
// PDF.js 기반 제어형 뷰어. 페이지를 canvas + 텍스트 레이어로 렌더하고,
// 인용문(verbatim quote)을 텍스트 검색으로 찾아 스크롤 + 하이라이트한다.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const SCALE_MIN = 0.4;
const SCALE_MAX = 3;
const WIDTH_GUTTER = 24; // 좌우 여백/스크롤바 여유(px)
const PDFJS_VERBOSITY = pdfjsLib.VerbosityLevel?.ERRORS ?? 0;

// ---- 텍스트 정규화 (인덱스/쿼리 공통) ----
// 단일 문자를 정규화한 문자열로. 빈 문자열(soft hyphen, 결합 분음)일 수 있음.
function normalizeChar(c) {
  if (c === '­') return '';                       // soft hyphen
  let d = c.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // 결합 분음 제거
  d = d
    .replace(/[‐-―−]/g, '-')            // 각종 대시/마이너스 → '-'
    .replace(/[‘’‛′]/g, "'")       // 작은따옴표류
    .replace(/[“”″]/g, '"');            // 큰따옴표류
  return d.toLowerCase();
}

function normalizeQuery(s) {
  return Array.from(s).map(normalizeChar).join('')
    .replace(/\s+/g, ' ')
    .replace(/(\w)- (\w)/g, '$1$2')
    .trim();
}

const isWord = (ch) => !!ch && /\w/.test(ch);
const isSearchChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);
const tokenRe = /[\p{L}\p{N}]{3,}/gu;

export function createPdfViewer(container) {
  let doc = null;
  let loadToken = 0;
  let renderTasks = [];
  let index = null;          // { norm, map[], compact, compactToNorm[], pageOfNode:Map }
  let highlightMarks = [];
  let currentScale = 1;
  let lastSource = null;     // relayout 시 재사용
  let relayoutTimer = 0;

  function documentSource(source) {
    if (typeof source === 'string') return { url: source, verbosity: PDFJS_VERBOSITY };
    return { ...source, verbosity: PDFJS_VERBOSITY };
  }

  function clearContainer() {
    container.innerHTML = '';
  }

  function unwrapHighlights() {
    for (const m of highlightMarks) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
    highlightMarks = [];
  }

  async function destroy() {
    loadToken++;
    unwrapHighlights();
    for (const t of renderTasks) {
      try { t.cancel(); } catch { /* ignore */ }
    }
    renderTasks = [];
    if (doc) {
      try { await doc.destroy(); } catch { /* ignore */ }
      doc = null;
    }
    index = null;
    clearContainer();
  }

  function fitScale(page1) {
    const vp = page1.getViewport({ scale: 1 });
    const avail = (container.clientWidth || vp.width) - WIDTH_GUTTER;
    const s = avail / vp.width;
    return Math.max(SCALE_MIN, Math.min(SCALE_MAX, s));
  }

  async function renderPage(page, pageIndex, scale, token) {
    const viewport = page.getViewport({ scale });
    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.dataset.page = String(pageIndex + 1);
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageDiv.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.setProperty('--scale-factor', String(scale));
    pageDiv.appendChild(textLayerDiv);

    container.appendChild(pageDiv);

    const ctx = canvas.getContext('2d');
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    renderTasks.push(task);
    try {
      await task.promise;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return null;
      throw e;
    }
    if (token !== loadToken) return null;

    const textContent = await page.getTextContent();
    if (token !== loadToken) return null;
    const textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerDiv, viewport });
    await textLayer.render();
    return { pageIndex, textLayerDiv };
  }

  // 모든 텍스트 레이어 span을 평탄화해 검색 인덱스 구축.
  function buildIndex() {
    const norm = [];                 // 정규화 문자 배열
    const map = [];                  // norm[i] → {node, start, end} | null(구분자)
    const pageOfNode = new Map();    // textNode → pageIndex(1-based)

    const pages = container.querySelectorAll('.pdf-page');
    pages.forEach((pageDiv) => {
      const pageNo = Number(pageDiv.dataset.page);
      const tl = pageDiv.querySelector('.textLayer');
      if (!tl) return;
      const walker = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
      let node;
      // 페이지 시작 시 구분자 1개(앞 페이지와 단어가 붙지 않도록)
      pushSep();
      while ((node = walker.nextNode())) {
        const s = node.nodeValue || '';
        if (!s) continue;
        pageOfNode.set(node, pageNo);
        let lastWasSpace = norm.length === 0 || norm[norm.length - 1] === ' ';
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          if (/\s/.test(c)) {
            if (!lastWasSpace) { norm.push(' '); map.push({ node, start: i, end: i + 1 }); lastWasSpace = true; }
            continue;
          }
          const nc = normalizeChar(c);
          if (!nc) continue;
          for (const ch of nc) { norm.push(ch); map.push({ node, start: i, end: i + 1 }); }
          lastWasSpace = false;
        }
      }
    });

    function pushSep() {
      if (norm.length && norm[norm.length - 1] !== ' ') { norm.push(' '); map.push(null); }
    }

    // compact: 줄바꿈 하이픈 제거(`x- y` → `xy`)
    const normStr = norm.join('');
    let compact = '';
    const compactToNorm = [];
    for (let i = 0; i < normStr.length; i++) {
      if (normStr[i] === '-' && normStr[i + 1] === ' ' && isWord(normStr[i - 1]) && isWord(normStr[i + 2])) {
        i++; // 하이픈과 공백 모두 제거
        continue;
      }
      compact += normStr[i];
      compactToNorm.push(i);
    }

    // loose: 공백/구두점 차이 때문에 verbatim quote가 어긋날 때를 위한 보조 인덱스.
    // 하이라이트 범위는 loose → compact → norm으로 되돌린다.
    let loose = '';
    const looseToCompact = [];
    for (let i = 0; i < compact.length; i++) {
      if (!isSearchChar(compact[i])) continue;
      loose += compact[i];
      looseToCompact.push(i);
    }

    index = { norm: normStr, map, compact, compactToNorm, loose, looseToCompact, pageOfNode };
  }

  function pageOfNormPos(normPos) {
    const m = index.map[normPos];
    if (m && m.node && index.pageOfNode.has(m.node)) return index.pageOfNode.get(m.node);
    // 인접 위치로 보정
    for (let d = 1; d < 8; d++) {
      const a = index.map[normPos - d], b = index.map[normPos + d];
      if (a && a.node && index.pageOfNode.has(a.node)) return index.pageOfNode.get(a.node);
      if (b && b.node && index.pageOfNode.has(b.node)) return index.pageOfNode.get(b.node);
    }
    return null;
  }

  function findAllInCompact(q) {
    const hits = [];
    let from = 0;
    while (true) {
      const idx = index.compact.indexOf(q, from);
      if (idx === -1) break;
      hits.push(idx);
      from = idx + 1;
    }
    return hits;
  }

  function findAllInLoose(q) {
    const looseQ = Array.from(q).filter(isSearchChar).join('');
    if (looseQ.length < 8) return [];
    const hits = [];
    let from = 0;
    while (true) {
      const idx = index.loose.indexOf(looseQ, from);
      if (idx === -1) break;
      const cs = index.looseToCompact[idx];
      const last = index.looseToCompact[idx + looseQ.length - 1];
      if (cs != null && last != null) hits.push({ cs, ce: last + 1 });
      from = idx + 1;
    }
    return hits;
  }

  function chooseBySourcePage(ranges, sourcePage) {
    if (!ranges.length) return null;
    if (!sourcePage || ranges.length === 1) return ranges[0];
    let best = ranges[0], bestDist = Infinity;
    for (const r of ranges) {
      const ns = index.compactToNorm[r.cs];
      const pg = ns != null ? pageOfNormPos(ns) : null;
      const dist = pg ? Math.abs(pg - sourcePage) : Infinity;
      if (dist < bestDist) { bestDist = dist; best = r; }
    }
    return best;
  }

  function compactRangeForPage(pageNo) {
    if (!pageNo) return null;
    let start = null;
    let end = null;
    for (let ci = 0; ci < index.compactToNorm.length; ci++) {
      const pg = pageOfNormPos(index.compactToNorm[ci]);
      if (pg !== pageNo) continue;
      if (start == null) start = ci;
      end = ci + 1;
    }
    return start == null ? null : { start, end };
  }

  function significantTokens(q) {
    const tokens = Array.from(new Set(q.match(tokenRe) || []));
    return tokens
      .filter(t => t.length >= 4)
      .sort((a, b) => b.length - a.length)
      .slice(0, 12);
  }

  function looseText(s) {
    return Array.from(s).filter(isSearchChar).join('');
  }

  function sentenceRangesInCompact(start, end) {
    const ranges = [];
    let s = start;
    for (let i = start; i < end; i++) {
      const ch = index.compact[i];
      const next = index.compact[i + 1] || '';
      const boundary = /[.!?。！？]/.test(ch) && (next === '' || /\s/.test(next) || i + 1 >= end);
      if (boundary) {
        if (i + 1 - s >= 12) ranges.push({ cs: s, ce: i + 1 });
        s = i + 1;
        while (s < end && /\s/.test(index.compact[s])) s++;
      }
    }
    if (end - s >= 12) ranges.push({ cs: s, ce: end });
    return ranges;
  }

  // 정확/loose/fuzzy 검색이 모두 실패했을 때, 출처 페이지 안에서
  // quote 토큰과 가장 많이 겹치는 "문장"만 선택한다. 페이지 전체는 강조하지 않는다.
  function approximateSentenceFind(q, sourcePage) {
    const pageRange = compactRangeForPage(sourcePage);
    if (!pageRange) return null;
    const tokens = significantTokens(q);
    if (tokens.length < 2) return null;
    const candidates = sentenceRangesInCompact(pageRange.start, pageRange.end);
    let best = null;
    let bestScore = 0;
    let bestMatches = 0;
    for (const r of candidates) {
      const cand = looseText(index.compact.slice(r.cs, r.ce));
      let score = 0;
      let matches = 0;
      for (const t of tokens) {
        const lt = looseText(t);
        if (lt && cand.includes(lt)) {
          matches += 1;
          score += lt.length;
        }
      }
      if (score > bestScore) {
        best = r;
        bestScore = score;
        bestMatches = matches;
      }
    }
    const minMatches = Math.max(2, Math.ceil(tokens.length * 0.35));
    return best && bestMatches >= minMatches ? best : null;
  }

  function selectQuoteRange(quote, opts = {}) {
    if (!doc || !index) return null;
    const q = normalizeQuery(quote || '');
    if (!q) return null;

    const hits = findAllInCompact(q).map(cs => ({ cs, ce: cs + q.length }));
    if (hits.length) return chooseBySourcePage(hits, opts.sourcePage);

    const looseHits = findAllInLoose(q);
    return chooseBySourcePage(looseHits, opts.sourcePage)
      || fuzzyFind(q)
      || approximateSentenceFind(q, opts.sourcePage);
  }

  // 가장 큰 연속 토큰 구간(≥60%)이 그대로 등장하는지 (best-effort 폴백)
  function fuzzyFind(q) {
    const tokens = q.split(' ').filter(Boolean);
    if (tokens.length < 2) return null;
    const minLen = Math.ceil(tokens.length * 0.6);
    for (let len = tokens.length; len >= minLen; len--) {
      for (let start = 0; start + len <= tokens.length; start++) {
        const sub = tokens.slice(start, start + len).join(' ');
        const idx = index.compact.indexOf(sub);
        if (idx !== -1) return { cs: idx, ce: idx + sub.length };
      }
    }
    return null;
  }

  // compact 범위 → norm 범위 → 원본 텍스트노드 Range들로 <mark> 래핑
  function applyHighlight(cs, ce) {
    unwrapHighlights();
    const ns = index.compactToNorm[cs];
    const ne = index.compactToNorm[ce - 1];
    if (ns == null || ne == null) return null;

    // 노드별 원본 char 범위 집계
    const perNode = new Map(); // node → {min,max}
    for (let k = ns; k <= ne; k++) {
      const m = index.map[k];
      if (!m || !m.node) continue;
      const cur = perNode.get(m.node);
      if (!cur) perNode.set(m.node, { min: m.start, max: m.end });
      else { cur.min = Math.min(cur.min, m.start); cur.max = Math.max(cur.max, m.end); }
    }

    let firstMark = null;
    for (const [node, range] of perNode) {
      if (!node.parentNode) continue;
      const len = (node.nodeValue || '').length;
      const start = Math.max(0, Math.min(range.min, len));
      const end = Math.max(start, Math.min(range.max, len));
      try {
        const r = document.createRange();
        r.setStart(node, start);
        r.setEnd(node, end);
        const mark = document.createElement('mark');
        mark.className = 'pdf-hl';
        r.surroundContents(mark);
        highlightMarks.push(mark);
        if (!firstMark) firstMark = mark;
      } catch { /* span 경계 문제 시 해당 노드 스킵 */ }
    }
    return firstMark;
  }

  function flash(mark) {
    if (!mark) return;
    mark.classList.add('pdf-hl--flash');
    setTimeout(() => mark.classList.remove('pdf-hl--flash'), 1300);
  }

  // ---- 공개 API ----

  async function load(source) {
    await destroy();
    lastSource = source;
    const token = loadToken;
    let task;
    task = pdfjsLib.getDocument(documentSource(source)); // string URL or { data: ArrayBuffer }
    let loaded;
    try {
      loaded = await task.promise;
    } catch (e) {
      if (token !== loadToken) return;
      throw e;
    }
    if (token !== loadToken) { try { await loaded.destroy(); } catch { /* ignore */ } return; }
    doc = loaded;
    const first = await doc.getPage(1);
    currentScale = fitScale(first);
    for (let i = 0; i < doc.numPages; i++) {
      if (token !== loadToken) return;
      const page = i === 0 ? first : await doc.getPage(i + 1);
      await renderPage(page, i, currentScale, token);
    }
    if (token !== loadToken) return;
    buildIndex();
  }

  function highlightQuote(quote, opts = {}) {
    if (!doc || !index) return { found: false };
    const chosen = selectQuoteRange(quote, opts);
    if (!chosen) {
      if (opts.sourcePage) {
        scrollToPage(opts.sourcePage);
        return { found: false, navigated: true, highlighted: false, page: opts.sourcePage };
      }
      return { found: false, navigated: false };
    }
    const mark = applyHighlight(chosen.cs, chosen.ce);
    if (!mark) {
      if (opts.sourcePage) {
        scrollToPage(opts.sourcePage);
        return { found: false, navigated: true, highlighted: false, page: opts.sourcePage };
      }
      return { found: false, navigated: false };
    }
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(mark);
    const ns = index.compactToNorm[chosen.cs];
    return { found: true, page: ns != null ? pageOfNormPos(ns) : null };
  }

  function canHighlightQuote(quote, opts = {}) {
    return !!selectQuoteRange(quote, opts);
  }

  function scrollToPage(pageNo) {
    const el = container.querySelector(`.pdf-page[data-page="${pageNo}"]`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function relayout() {
    if (!doc || !lastSource) return;
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      // 같은 소스를 다시 로드(현재 폭에 맞춰 재렌더). 로컬 ArrayBuffer는 destroy 후 전달된 버퍼가
      // detach 될 수 있으므로 string(url) 소스에서만 재렌더한다.
      if (typeof lastSource === 'string') load(lastSource);
    }, 250);
  }

  function isLoaded() { return !!doc; }

  return { load, destroy, highlightQuote, canHighlightQuote, scrollToPage, relayout, isLoaded };
}
