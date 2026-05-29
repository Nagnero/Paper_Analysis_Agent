// public/pdfViewer.js
// PDF.js 기반 제어형 뷰어. 페이지를 canvas + 텍스트 레이어로 렌더하고,
// 인용문(verbatim quote)을 텍스트 검색으로 찾아 스크롤 + 하이라이트한다.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const SCALE_MIN = 0.4;
const SCALE_MAX = 3;
const WIDTH_GUTTER = 24; // 좌우 여백/스크롤바 여유(px)

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

export function createPdfViewer(container) {
  let doc = null;
  let loadToken = 0;
  let renderTasks = [];
  let index = null;          // { norm, map[], compact, compactToNorm[], pageOfNode:Map }
  let highlightMarks = [];
  let currentScale = 1;
  let lastSource = null;     // relayout 시 재사용
  let relayoutTimer = 0;

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
    index = { norm: normStr, map, compact, compactToNorm, pageOfNode };
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
    if (typeof source === 'string') task = pdfjsLib.getDocument({ url: source });
    else task = pdfjsLib.getDocument(source); // { data: ArrayBuffer }
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
    const q = normalizeQuery(quote || '');
    if (!q) return { found: false };

    let chosen = null;
    const hits = findAllInCompact(q);
    if (hits.length) {
      let cs = hits[0];
      if (opts.sourcePage && hits.length > 1) {
        let best = hits[0], bestDist = Infinity;
        for (const h of hits) {
          const ns = index.compactToNorm[h];
          const pg = ns != null ? pageOfNormPos(ns) : null;
          const dist = pg ? Math.abs(pg - opts.sourcePage) : Infinity;
          if (dist < bestDist) { bestDist = dist; best = h; }
        }
        cs = best;
      }
      chosen = { cs, ce: cs + q.length };
    } else {
      chosen = fuzzyFind(q);
    }
    if (!chosen) {
      if (opts.sourcePage) scrollToPage(opts.sourcePage);
      return { found: false };
    }
    const mark = applyHighlight(chosen.cs, chosen.ce);
    if (!mark) {
      if (opts.sourcePage) scrollToPage(opts.sourcePage);
      return { found: false };
    }
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(mark);
    const ns = index.compactToNorm[chosen.cs];
    return { found: true, page: ns != null ? pageOfNormPos(ns) : null };
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

  return { load, destroy, highlightQuote, scrollToPage, relayout, isLoaded };
}
