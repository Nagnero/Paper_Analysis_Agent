// core/synctex.js
// SyncTeX 역방향 조회: PDF 위치(page, x, y[pt, 좌상단]) → 소스 (파일, 줄).
// MiKTeX/TeX Live 의 synctex CLI 를 사용(좌표 변환을 CLI 가 처리).
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { projectSrcDir } from './fileManager.js';
import { detectEngine } from './latexCompiler.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

let _cmd; // string | null | undefined

function spawnShell(cmd) {
  return path.isAbsolute(cmd) ? false : IS_WIN;
}

function run(cmd, args, cwd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(cmd, args, { shell: spawnShell(cmd), cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve(null); }
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', () => {});
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } resolve(out); }, timeoutMs);
    proc.on('error', () => { clearTimeout(killer); resolve(null); });
    proc.on('close', () => { clearTimeout(killer); resolve(out); });
  });
}

// synctex 실행 파일 위치: 컴파일 엔진과 같은 bin → PATH 순.
export async function resolveSynctex(force = false) {
  if (_cmd !== undefined && !force) return _cmd;
  const det = await detectEngine();
  if (det && path.isAbsolute(det.cmd)) {
    const sibling = path.join(path.dirname(det.cmd), 'synctex' + EXE);
    try { await fs.stat(sibling); _cmd = sibling; return _cmd; } catch { /* not there */ }
  }
  // PATH 시도(존재 여부는 edit 호출에서 판단)
  const probe = await run('synctex', ['help'], undefined, 8000);
  _cmd = probe == null ? null : 'synctex';
  return _cmd;
}

/**
 * @param {number} projectId
 * @param {string} mainFile  컴파일 진입 .tex (src 상대)
 * @param {number} page  1-based
 * @param {number} x  PDF pt, 페이지 좌상단 기준
 * @param {number} y  PDF pt, 페이지 좌상단 기준
 * @returns {Promise<{file:string, line:number}|null>}
 */
export async function reverseLookup(projectId, mainFile, page, x, y) {
  const cmd = await resolveSynctex();
  if (!cmd) return null;
  const srcDir = projectSrcDir(projectId);
  const pdfRel = String(mainFile || 'main.tex').replace(/\.tex$/i, '.pdf');
  try { await fs.stat(path.join(srcDir, pdfRel)); } catch { return null; }

  const px = Math.max(0, Math.round(Number(x) || 0));
  const py = Math.max(0, Math.round(Number(y) || 0));
  const pg = Math.max(1, Math.round(Number(page) || 1));
  // cwd=srcDir + 상대 pdf 경로 → Windows 절대경로의 `C:` 콜론 충돌 회피
  const out = await run(cmd, ['edit', '-o', `${pg}:${px}:${py}:${pdfRel}`], srcDir);
  if (!out) return null;

  const inputM = out.match(/^Input:(.+)$/m);
  const lineM = out.match(/^Line:(\d+)$/m);
  if (!inputM || !lineM) return null;

  const abs = inputM[1].trim();
  let rel;
  const normAbs = abs.replace(/\\/g, '/').toLowerCase();
  const normSrc = srcDir.replace(/\\/g, '/').toLowerCase();
  if (normAbs.startsWith(normSrc)) {
    rel = path.relative(srcDir, abs).replace(/\\/g, '/');
  } else {
    rel = path.basename(abs); // 외부 경로면 파일명만
  }
  return { file: rel, line: Number(lineM[1]) };
}
