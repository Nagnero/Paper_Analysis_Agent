// utils/chunker.js
// 논문 텍스트를 섹션 감지 + 슬라이딩 윈도우로 청크 분할.

/**
 * @typedef {Object} Chunk
 * @property {string} id
 * @property {string|null} section
 * @property {number|null} page
 * @property {number} startChar
 * @property {number} endChar
 * @property {string} text
 */

const SECTION_RE = /^\s*(\d+(\.\d+)*\.?\s+)?(Abstract|Introduction|Related Work|Background|Method(?:s|ology)?|Approach|Experiments?|Results?|Evaluation|Discussion|Conclusion|References|Appendix)\b.*$/im;
const PAGE_MARKER_RE = /Page\s+(\d+)/i;

/**
 * 텍스트 내 섹션 헤더 위치를 찾는다.
 * @param {string} text
 * @returns {{offset: number, title: string}[]}
 */
function findSectionBoundaries(text) {
  const boundaries = [];
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) {
      boundaries.push({ offset, title: line.trim() });
    }
    offset += line.length + 1; // +1 for '\n'
  }
  return boundaries;
}

/**
 * 주어진 char offset의 추정 페이지 번호. \f 또는 "Page N" 마커 기반.
 * @param {string} text
 * @param {number} offset
 * @returns {number|null}
 */
function estimatePage(text, offset) {
  const prefix = text.slice(0, offset);
  const ffCount = (prefix.match(/\f/g) || []).length;
  if (ffCount > 0) return ffCount + 1;
  // "Page N" 마커 마지막 매칭
  let lastPage = null;
  const re = /Page\s+(\d+)/gi;
  let m;
  while ((m = re.exec(prefix)) !== null) lastPage = parseInt(m[1], 10);
  return lastPage;
}

/**
 * 단어/문장 경계에서 끊는 슬라이딩 윈도우.
 * @param {string} text
 * @param {number} start 절대 offset (text 기준)
 * @param {number} end 절대 offset
 * @param {number} chunkSize
 * @param {number} overlap
 * @returns {{startChar: number, endChar: number, text: string}[]}
 */
function sliceWindow(text, start, end, chunkSize, overlap) {
  const out = [];
  let i = start;
  while (i < end) {
    let j = Math.min(i + chunkSize, end);
    if (j < end) {
      // 마지막 마침표/줄바꿈에서 끊기
      const window = text.slice(i, j);
      const lastBreak = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('.\n'),
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
      );
      if (lastBreak > chunkSize * 0.5) j = i + lastBreak + 1;
    }
    const slice = text.slice(i, j).trim();
    if (slice) out.push({ startChar: i, endChar: j, text: slice });
    if (j >= end) break;
    i = Math.max(j - overlap, i + 1);
  }
  return out;
}

/**
 * @param {string} text
 * @param {{chunkSize?: number, overlap?: number}} [opts]
 * @returns {Chunk[]}
 */
export function chunk(text, opts = {}) {
  const chunkSize = opts.chunkSize ?? 1500;
  const overlap = opts.overlap ?? 200;
  if (!text || text.length === 0) return [];

  const bounds = findSectionBoundaries(text);
  const sections = [];
  if (bounds.length === 0) {
    sections.push({ start: 0, end: text.length, title: null });
  } else {
    if (bounds[0].offset > 0) {
      sections.push({ start: 0, end: bounds[0].offset, title: null });
    }
    for (let k = 0; k < bounds.length; k++) {
      const start = bounds[k].offset;
      const end = k + 1 < bounds.length ? bounds[k + 1].offset : text.length;
      sections.push({ start, end, title: bounds[k].title });
    }
  }

  const chunks = [];
  let cid = 0;
  for (const sec of sections) {
    const pieces = sliceWindow(text, sec.start, sec.end, chunkSize, overlap);
    for (const p of pieces) {
      chunks.push({
        id: `c${cid++}`,
        section: sec.title,
        page: estimatePage(text, p.startChar),
        startChar: p.startChar,
        endChar: p.endChar,
        text: p.text,
      });
    }
  }
  return chunks;
}
