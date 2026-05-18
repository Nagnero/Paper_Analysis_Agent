// utils/parsePdf.js
// PDF 텍스트 추출. pdf-parse 사용.
import { readFile } from 'node:fs/promises';
import pdf from 'pdf-parse/lib/pdf-parse.js';

/**
 * @param {string} pdfPath
 * @returns {Promise<{ title: string|null, fullText: string, numPages: number }>}
 */
export async function parsePdf(pdfPath) {
  const buf = await readFile(pdfPath);
  const data = await pdf(buf);
  const text = (data.text ?? '').replace(/\r\n/g, '\n');

  // 메타데이터 title이 있으면 우선, 없으면 첫 비빈 줄 휴리스틱
  let title = data.info?.Title || null;
  if (!title) {
    const firstLine = text.split('\n').map(s => s.trim()).find(s => s.length > 5 && s.length < 200);
    title = firstLine || null;
  }
  return { title, fullText: text, numPages: data.numpages };
}
