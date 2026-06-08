// core/latexProject.js
// LaTeX 프로젝트 ZIP 해제 + 소스 파일 read/write (경로 탐색 차단).
import path from 'node:path';
import fs from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { projectSrcDir, ensureDir } from './fileManager.js';

const MAX_FILES = 3000;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024; // 해제 후 총량 상한
const EDITABLE_EXT = new Set(['.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.def', '.ltx', '.tikz']);
// in-place 컴파일 산출물 — 파일 트리에서 숨긴다.
const ARTIFACT_EXT = new Set([
  '.aux', '.log', '.out', '.bbl', '.blg', '.bcf', '.toc', '.lof', '.lot',
  '.fls', '.fdb_latexmk', '.synctex', '.gz', '.nav', '.snm', '.vrb', '.xdv',
  '.dvi', '.idx', '.ind', '.ilg', '.run.xml', '.pdf',
]);

export function isEditablePath(rel) {
  return EDITABLE_EXT.has(path.extname(rel).toLowerCase());
}

export function isArtifactPath(rel) {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.synctex.gz') || lower.endsWith('.run.xml')) return true;
  return ARTIFACT_EXT.has(path.extname(lower));
}

// zip 엔트리 이름을 안전한 상대 경로(posix)로. 거부 시 null.
function sanitizeEntryName(name) {
  const norm = name.replace(/\\/g, '/');
  if (norm.startsWith('__MACOSX/')) return null;
  const base = norm.split('/').pop() || '';
  if (base === '.DS_Store' || base.startsWith('._')) return null;
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null; // 절대경로
  const parts = norm.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return null; // 상위 탈출
  if (!parts.length) return null;
  return parts.join('/');
}

// 모든 엔트리가 동일한 최상위 폴더 하나에 들어있으면 그 prefix 를 반환(벗겨내기 용).
function commonTopPrefix(names) {
  let prefix = null;
  for (const n of names) {
    const top = n.includes('/') ? n.slice(0, n.indexOf('/')) : null;
    if (top === null) return null; // 루트에 파일이 있음 → 벗기지 않음
    if (prefix === null) prefix = top;
    else if (prefix !== top) return null;
  }
  return prefix;
}

/**
 * ZIP 버퍼를 projects/{id}/src 로 해제. 보안 검증 포함.
 * @returns {Promise<{fileCount:number, mainGuess:string}>}
 */
export async function extractZip(buf, projectId) {
  const entries = unzipSync(new Uint8Array(buf)); // { name: Uint8Array }
  const names = Object.keys(entries)
    .map(sanitizeEntryName)
    .filter(Boolean)
    .filter(n => !n.endsWith('/'));
  if (!names.length) throw new Error('ZIP 안에서 유효한 파일을 찾지 못했습니다.');
  if (names.length > MAX_FILES) throw new Error(`파일 수가 너무 많습니다 (${names.length} > ${MAX_FILES}).`);

  const strip = commonTopPrefix(names);
  const srcDir = projectSrcDir(projectId);
  await ensureDir(srcDir);

  let total = 0;
  const written = [];
  for (const origName of Object.keys(entries)) {
    const safe = sanitizeEntryName(origName);
    if (!safe || safe.endsWith('/')) continue;
    const data = entries[origName];
    if (!data || !data.length) {
      // 빈 파일도 기록(디렉터리 표시는 제외)
    }
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('해제 후 총 용량이 한계를 초과했습니다.');

    let rel = safe;
    if (strip && rel.startsWith(strip + '/')) rel = rel.slice(strip.length + 1);
    if (!rel) continue;

    const abs = path.join(srcDir, rel);
    // 최종 방어: 해석 경로가 srcDir 하위인지 확인
    if (abs !== srcDir && !abs.startsWith(srcDir + path.sep)) continue;
    await ensureDir(path.dirname(abs));
    await fs.writeFile(abs, Buffer.from(data));
    written.push(rel.replace(/\\/g, '/'));
  }
  if (!written.length) throw new Error('ZIP 해제 결과가 비어 있습니다.');

  const mainGuess = await detectMainTex(projectId, written);
  return { fileCount: written.length, mainGuess };
}

// \documentclass 를 포함한 .tex 우선. 없으면 main.tex / 첫 .tex.
export async function detectMainTex(projectId, knownFiles = null) {
  const srcDir = projectSrcDir(projectId);
  const files = knownFiles || (await listFiles(projectId)).map(f => f.path);
  const texFiles = files.filter(f => /\.tex$/i.test(f));
  if (!texFiles.length) return files[0] || 'main.tex';
  // 얕은 경로 우선
  texFiles.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const rel of texFiles) {
    try {
      const txt = await fs.readFile(path.join(srcDir, rel), 'utf8');
      if (/\\documentclass/.test(txt)) return rel;
    } catch { /* ignore */ }
  }
  return texFiles.find(f => /(^|\/)main\.tex$/i.test(f)) || texFiles[0];
}

// 소스 트리 평탄 목록. 각 항목 { path(상대,posix), size, editable, dir }
export async function listFiles(projectId) {
  const srcDir = projectSrcDir(projectId);
  const out = [];
  async function walk(absDir, relDir) {
    let entries;
    try { entries = await fs.readdir(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(path.join(absDir, e.name), rel); continue; }
      if (isArtifactPath(rel)) continue; // 컴파일 산출물 숨김
      let size = 0;
      try { size = (await fs.stat(path.join(absDir, e.name))).size; } catch { /* ignore */ }
      out.push({ path: rel, size, editable: isEditablePath(rel) });
    }
  }
  await walk(srcDir, '');
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// relPath 를 srcDir 하위 절대경로로. 탈출 시 throw.
function resolveInSrc(projectId, relPath) {
  const srcDir = projectSrcDir(projectId);
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) {
    throw new Error('잘못된 파일 경로');
  }
  const abs = path.join(srcDir, rel);
  if (abs !== srcDir && !abs.startsWith(srcDir + path.sep)) throw new Error('잘못된 파일 경로');
  return abs;
}

export async function readProjectFile(projectId, relPath) {
  const abs = resolveInSrc(projectId, relPath);
  return await fs.readFile(abs, 'utf8');
}

export async function writeProjectFile(projectId, relPath, content) {
  if (!isEditablePath(relPath)) throw new Error('편집할 수 없는 파일 형식입니다.');
  const abs = resolveInSrc(projectId, relPath);
  await ensureDir(path.dirname(abs));
  await fs.writeFile(abs, String(content ?? ''), 'utf8');
}

// zip 다운로드용: 소스 + 결과 PDF 포함, 중간 산출물(.aux/.log/.synctex.gz 등)은 제외.
const ZIP_SKIP_EXT = new Set([
  '.aux', '.log', '.out', '.blg', '.fls', '.fdb_latexmk', '.toc', '.lof', '.lot',
  '.nav', '.snm', '.vrb', '.xdv', '.dvi', '.idx', '.ind', '.ilg', '.bcf',
]);
function skipForZip(rel) {
  const l = rel.toLowerCase();
  if (l.endsWith('.synctex.gz') || l.endsWith('.run.xml')) return true;
  return ZIP_SKIP_EXT.has(path.extname(l));
}

export async function zipProject(projectId) {
  const srcDir = projectSrcDir(projectId);
  const entries = {};
  async function walk(absDir, relDir) {
    let list;
    try { list = await fs.readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(path.join(absDir, e.name), rel); continue; }
      if (skipForZip(rel)) continue;
      entries[rel] = new Uint8Array(await fs.readFile(path.join(absDir, e.name)));
    }
  }
  await walk(srcDir, '');
  return Buffer.from(zipSync(entries));
}
