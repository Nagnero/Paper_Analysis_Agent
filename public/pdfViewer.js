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
const FIGURE_CAPTION_RE = /^\s*(?:fig(?:ure)?\.?|그림)\s*(?:\d+|[ivxlcdm]+)[a-z]?(?:\s|[.:：-])/i;

export function createPdfViewer(container) {
  let doc = null;
  let loadToken = 0;
  let renderTasks = [];
  let index = null;          // { norm, map[], compact, compactToNorm[], pageOfNode:Map }
  let highlightMarks = [];
  let currentScale = 1;
  let lastSource = null;     // relayout 시 재사용
  let relayoutTimer = 0;
  let selectionMode = false;
  let selectionHandler = null;
  let reverseHandler = null;  // SyncTeX 역방향: 더블클릭 → {page, x, y}(pt, 좌상단)

  // 더블클릭 → 페이지 + PDF 포인트(pt) 계산해 콜백 (텍스트 선택 모드일 땐 무시)
  container.addEventListener('dblclick', (e) => {
    if (!reverseHandler || selectionMode) return;
    const pageDiv = e.target.closest && e.target.closest('.pdf-page');
    if (!pageDiv || !container.contains(pageDiv)) return;
    const rect = pageDiv.getBoundingClientRect();
    const x = (e.clientX - rect.left) / currentScale;
    const y = (e.clientY - rect.top) / currentScale;
    const page = Number(pageDiv.dataset.page) || 1;
    reverseHandler({ page, x, y });
  });
  let activeSelection = null;

  function documentSource(source) {
    if (typeof source === 'string') return { url: source, verbosity: PDFJS_VERBOSITY };
    return { ...source, verbosity: PDFJS_VERBOSITY };
  }

  function clearContainer() {
    container.innerHTML = '';
  }

  function clearSelectionVisuals() {
    container.querySelectorAll('.pdf-selection-box').forEach(el => el.remove());
    activeSelection = null;
  }

  function setSelectionLayersActive() {
    container.querySelectorAll('.pdf-selection-layer').forEach(layer => {
      layer.classList.toggle('active', selectionMode);
    });
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
    selectionMode = false;
    clearSelectionVisuals();
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

    const selectionLayer = document.createElement('div');
    selectionLayer.className = 'pdf-selection-layer';
    selectionLayer.setAttribute('aria-label', 'PDF 선택 레이어');
    pageDiv.appendChild(selectionLayer);

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
    buildFigureCandidates(pageDiv);
    setSelectionLayersActive();
    return { pageIndex, textLayerDiv };
  }

  function normalizedRect(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }

  function localPoint(e, pageDiv) {
    const r = pageDiv.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(e.clientX - r.left, r.width)),
      y: Math.max(0, Math.min(e.clientY - r.top, r.height)),
    };
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function selectedTextForRect(pageDiv, rect) {
    const pageBox = pageDiv.getBoundingClientRect();
    const selectedBox = {
      left: pageBox.left + rect.x,
      top: pageBox.top + rect.y,
      right: pageBox.left + rect.x + rect.width,
      bottom: pageBox.top + rect.y + rect.height,
    };
    const chunks = [];
    pageDiv.querySelectorAll('.textLayer span').forEach(span => {
      const box = span.getBoundingClientRect();
      if (!box.width || !box.height || !intersects(selectedBox, box)) return;
      const text = (span.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) chunks.push(text);
    });
    return chunks.join(' ').replace(/\s+/g, ' ').trim();
  }

  function cropImageForRect(pageDiv, rect) {
    const source = pageDiv.querySelector('canvas');
    if (!source || rect.width < 2 || rect.height < 2) return null;
    const cssWidth = parseFloat(source.style.width) || source.getBoundingClientRect().width || source.width;
    const cssHeight = parseFloat(source.style.height) || source.getBoundingClientRect().height || source.height;
    const sx = source.width / cssWidth;
    const sy = source.height / cssHeight;
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(rect.width * sx));
    crop.height = Math.max(1, Math.round(rect.height * sy));
    const ctx = crop.getContext('2d');
    ctx.drawImage(
      source,
      Math.round(rect.x * sx),
      Math.round(rect.y * sy),
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height
    );
    return {
      mime: 'image/png',
      dataUrl: crop.toDataURL('image/png'),
      width: crop.width,
      height: crop.height,
    };
  }


  function relativeRect(box, pageBox) {
    return {
      x: Math.max(0, box.left - pageBox.left),
      y: Math.max(0, box.top - pageBox.top),
      width: Math.max(0, box.right - box.left),
      height: Math.max(0, box.bottom - box.top),
    };
  }

  function unionRect(a, b) {
    if (!a) return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    return {
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    };
  }

  function textLinesForPage(pageDiv) {
    const pageBox = pageDiv.getBoundingClientRect();
    const spans = Array.from(pageDiv.querySelectorAll('.textLayer span'))
      .map(span => {
        const box = span.getBoundingClientRect();
        const text = (span.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || !box.width || !box.height) return null;
        return { text, box, x: box.left - pageBox.left, yMid: box.top - pageBox.top + box.height / 2 };
      })
      .filter(Boolean)
      .sort((a, b) => (a.yMid - b.yMid) || (a.x - b.x));

    const lines = [];
    for (const item of spans) {
      const last = lines[lines.length - 1];
      if (!last || Math.abs(last.yMid - item.yMid) > Math.max(5, item.box.height * 0.45)) {
        lines.push({
          items: [item],
          yMid: item.yMid,
          rect: { left: item.box.left, top: item.box.top, right: item.box.right, bottom: item.box.bottom },
        });
        continue;
      }
      last.items.push(item);
      last.yMid = (last.yMid * (last.items.length - 1) + item.yMid) / last.items.length;
      last.rect = unionRect(last.rect, item.box);
    }

    return lines.map(line => {
      line.items.sort((a, b) => a.x - b.x);
      return {
        text: line.items.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim(),
        rect: relativeRect(line.rect, pageBox),
        itemCount: line.items.length,
      };
    });
  }

  function unionPageRect(a, b) {
    if (!a) return { ...b };
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function horizontalOverlapRatio(a, b) {
    const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    return overlap / Math.max(1, Math.min(a.width, b.width));
  }

  function horizontalOverlapWidth(a, b) {
    return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  }

  function isCaptionContinuation(prevLine, nextLine) {
    if (!prevLine || !nextLine) return false;
    if (/^\s*(?:fig(?:ure)?\.?|그림|table|표)\s*(?:\d+|[ivxlcdm]+)?/i.test(nextLine.text)) return false;
    if (/^\s*\d+(?:\.\d+)*\s+[A-Z가-힣]/.test(nextLine.text)) return false;
    const prevBottom = prevLine.rect.y + prevLine.rect.height;
    const gap = nextLine.rect.y - prevBottom;
    const lineHeight = Math.max(prevLine.rect.height, nextLine.rect.height, 10);
    if (gap < -2 || gap > Math.max(16, lineHeight * 0.9)) return false;
    return horizontalOverlapRatio(prevLine.rect, nextLine.rect) >= 0.35
      || Math.abs(nextLine.rect.x - prevLine.rect.x) <= lineHeight * 1.8;
  }

  function captionBlocksForPage(pageDiv) {
    const lines = textLinesForPage(pageDiv);
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const first = lines[i];
      if (!FIGURE_CAPTION_RE.test(first.text)) continue;
      const blockLines = [first];
      let rect = { ...first.rect };
      let text = first.text;
      let prev = first;
      for (let j = i + 1; j < lines.length && blockLines.length < 5; j++) {
        const next = lines[j];
        if (!isCaptionContinuation(prev, next)) break;
        blockLines.push(next);
        rect = unionPageRect(rect, next.rect);
        text = `${text} ${next.text}`.replace(/\s+/g, ' ').trim();
        prev = next;
        i = j;
      }
      blocks.push({ text, rect, lines: blockLines });
    }
    return blocks;
  }

  function columnBoundsForCaption(pageDiv, captionRect) {
    const pageW = pageDiv.getBoundingClientRect().width;
    const center = captionRect.x + captionRect.width / 2;
    if (captionRect.width < pageW * 0.62) {
      return center < pageW / 2
        ? { x: pageW * 0.04, width: pageW * 0.46 }
        : { x: pageW * 0.50, width: pageW * 0.46 };
    }
    return { x: pageW * 0.04, width: pageW * 0.92 };
  }

  function scanInkBounds(pageDiv, searchRect, { direction = 'bottom' } = {}) {
    const canvas = pageDiv.querySelector('canvas');
    if (!canvas || searchRect.width < 10 || searchRect.height < 10) return null;
    const cssWidth = parseFloat(canvas.style.width) || canvas.getBoundingClientRect().width || canvas.width;
    const cssHeight = parseFloat(canvas.style.height) || canvas.getBoundingClientRect().height || canvas.height;
    const sx = canvas.width / cssWidth;
    const sy = canvas.height / cssHeight;
    const x = Math.max(0, Math.floor(searchRect.x * sx));
    const y = Math.max(0, Math.floor(searchRect.y * sy));
    const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(searchRect.width * sx)));
    const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(searchRect.height * sy)));
    let data;
    try {
      data = canvas.getContext('2d').getImageData(x, y, w, h).data;
    } catch {
      return null;
    }

    const rows = new Uint16Array(h);
    const step = Math.max(1, Math.floor(Math.min(w, h) / 900));
    for (let yy = 0; yy < h; yy += step) {
      for (let xx = 0; xx < w; xx += step) {
        const i = (yy * w + xx) * 4;
        if (data[i + 3] < 20) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r > 245 && g > 245 && b > 245) continue;
        rows[yy] += 1;
      }
    }

    const rowThreshold = Math.max(2, Math.floor(w / step * 0.006));
    const maxGap = Math.max(8, Math.round(18 * sy));
    let top = -1;
    let bottom = -1;
    let gap = 0;
    if (direction === 'top') {
      for (let yy = 0; yy < h; yy++) {
        if (rows[yy] >= rowThreshold) { top = yy; bottom = yy; break; }
      }
      if (top < 0) return null;
      for (let yy = top + 1; yy < h; yy++) {
        if (rows[yy] >= rowThreshold) {
          bottom = yy;
          gap = 0;
        } else if (++gap > maxGap) {
          break;
        }
      }
    } else {
      for (let yy = h - 1; yy >= 0; yy--) {
        if (rows[yy] >= rowThreshold) { bottom = yy; top = yy; break; }
      }
      if (bottom < 0) return null;
      for (let yy = bottom - 1; yy >= 0; yy--) {
        if (rows[yy] >= rowThreshold) {
          top = yy;
          gap = 0;
        } else if (++gap > maxGap) {
          break;
        }
      }
    }
    if ((bottom - top) / sy < 35) return null;

    const colThreshold = 1;
    let left = w - 1;
    let right = 0;
    for (let xx = 0; xx < w; xx++) {
      let inkCount = 0;
      for (let yy = top; yy <= bottom; yy += step) {
        const i = (yy * w + xx) * 4;
        if (data[i + 3] < 20) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r > 245 && g > 245 && b > 245) continue;
        inkCount += 1;
      }
      if (inkCount >= colThreshold) {
        left = Math.min(left, xx);
        right = Math.max(right, xx);
      }
    }
    if (right <= left) { left = 0; right = w - 1; }

    return {
      x: searchRect.x + left / sx,
      y: searchRect.y + top / sy,
      width: (right - left + 1) / sx,
      height: (bottom - top + 1) / sy,
    };
  }

  function expandRect(rect, pageDiv, pad) {
    const pageBox = pageDiv.getBoundingClientRect();
    const x = Math.max(0, rect.x - pad);
    const y = Math.max(0, rect.y - pad);
    const right = Math.min(pageBox.width, rect.x + rect.width + pad);
    const bottom = Math.min(pageBox.height, rect.y + rect.height + pad);
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  }

  function figureRectFromCaption(pageDiv, caption) {
    const pageH = pageDiv.getBoundingClientRect().height;
    const column = columnBoundsForCaption(pageDiv, caption.rect);
    const captionTop = caption.rect.y;
    const captionBottom = caption.rect.y + caption.rect.height;
    const captionNearTop = captionTop < pageH * 0.22;
    const search = captionNearTop
      ? {
          x: column.x,
          y: Math.min(pageH, captionBottom + 4),
          width: column.width,
          height: Math.min(pageH - captionBottom - 4, pageH * 0.38),
        }
      : {
          x: column.x,
          y: Math.max(0, captionTop - pageH * 0.46),
          width: column.width,
          height: Math.max(0, captionTop - Math.max(0, captionTop - pageH * 0.46) - 4),
        };

    const ink = scanInkBounds(pageDiv, search, { direction: captionNearTop ? 'top' : 'bottom' });
    let rect;
    if (ink) {
      const top = Math.min(captionTop, ink.y);
      const bottom = Math.max(captionBottom, ink.y + ink.height);
      const left = Math.min(ink.x, caption.rect.x);
      const right = Math.max(ink.x + ink.width, caption.rect.x + caption.rect.width);
      rect = { x: left, y: top, width: right - left, height: bottom - top };
    } else {
      const fallbackHeight = Math.min(pageH * 0.34, Math.max(120, pageH * 0.22));
      rect = captionNearTop
        ? {
            x: column.x,
            y: Math.max(0, captionTop - 4),
            width: column.width,
            height: Math.min(pageH - captionTop + 4, fallbackHeight + caption.rect.height),
          }
        : {
            x: column.x,
            y: Math.max(0, captionTop - fallbackHeight),
            width: column.width,
            height: Math.min(pageH - Math.max(0, captionTop - fallbackHeight), fallbackHeight + caption.rect.height),
          };
    }
    return expandRect(rect, pageDiv, 8);
  }

  function buildFigureCandidates(pageDiv) {
    const layer = pageDiv.querySelector('.pdf-selection-layer');
    if (!layer) return;
    layer.querySelectorAll('.pdf-figure-candidate').forEach(el => el.remove());
    const captions = captionBlocksForPage(pageDiv).slice(0, 12);

    captions.forEach((caption, idx) => {
      const rect = figureRectFromCaption(pageDiv, caption);
      if (!rect || rect.width < 40 || rect.height < 40) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pdf-figure-candidate';
      btn.style.left = `${rect.x}px`;
      btn.style.top = `${rect.y}px`;
      btn.style.width = `${rect.width}px`;
      btn.style.height = `${rect.height}px`;
      btn.title = `${caption.text} 선택`;
      btn.setAttribute('aria-label', `${caption.text} 영역 선택`);
      btn.dataset.figureLabel = caption.text;
      btn.dataset.figureIndex = String(idx + 1);
      btn.addEventListener('pointerdown', ev => ev.stopPropagation());
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        selectRegionFromRect(pageDiv, rect, 'figure');
      });
      btn.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        selectRegionFromRect(pageDiv, rect, 'figure');
      });
      layer.appendChild(btn);
    });
  }

  function selectRegionFromRect(pageDiv, rect, source = 'manual') {
    clearSelectionVisuals();
    const layer = pageDiv.querySelector('.pdf-selection-layer');
    if (layer) {
      const box = document.createElement('div');
      box.className = source === 'figure' ? 'pdf-selection-box pdf-selection-box--figure' : 'pdf-selection-box';
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      layer.appendChild(box);
    }
    const image = cropImageForRect(pageDiv, rect);
    const payload = {
      type: 'pdf-region',
      source,
      page: Number(pageDiv.dataset.page),
      rect: { ...rect, units: 'css-px' },
      text: selectedTextForRect(pageDiv, rect),
      image,
    };
    if (selectionHandler) selectionHandler(payload);
  }

  function beginSelectionDrag(e) {
    if (!selectionMode || e.button !== 0) return;
    const layer = e.target.closest?.('.pdf-selection-layer');
    if (!layer || !container.contains(layer)) return;
    const pageDiv = layer.closest('.pdf-page');
    if (!pageDiv) return;
    e.preventDefault();
    clearSelectionVisuals();
    const start = localPoint(e, pageDiv);
    const box = document.createElement('div');
    box.className = 'pdf-selection-box';
    layer.appendChild(box);
    activeSelection = { pageDiv, layer, start, box };

    const renderBox = (point) => {
      const r = normalizedRect(start, point);
      box.style.left = `${r.x}px`;
      box.style.top = `${r.y}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      return r;
    };
    renderBox(start);

    const onMove = (ev) => {
      if (!activeSelection) return;
      renderBox(localPoint(ev, pageDiv));
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (!activeSelection) return;
      const rect = renderBox(localPoint(ev, pageDiv));
      activeSelection = null;
      if (rect.width < 8 || rect.height < 8) {
        box.remove();
        return;
      }
      selectRegionFromRect(pageDiv, rect);
    };
    const onCancel = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (activeSelection?.box) activeSelection.box.remove();
      activeSelection = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  container.addEventListener('pointerdown', beginSelectionDrag);

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
    selectionMode = false;
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

  function setSelectionMode(enabled) {
    selectionMode = !!enabled && !!doc;
    setSelectionLayersActive();
    return selectionMode;
  }

  function onRegionSelected(callback) {
    selectionHandler = typeof callback === 'function' ? callback : null;
  }

  function clearSelection() {
    clearSelectionVisuals();
  }

  function isSelectionMode() { return selectionMode; }

  function onReverseSearch(callback) {
    reverseHandler = typeof callback === 'function' ? callback : null;
  }

  return {
    load,
    destroy,
    highlightQuote,
    canHighlightQuote,
    scrollToPage,
    relayout,
    isLoaded,
    setSelectionMode,
    onRegionSelected,
    clearSelection,
    isSelectionMode,
    onReverseSearch,
  };
}
