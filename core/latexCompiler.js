// core/latexCompiler.js
// 시스템 LaTeX CLI 자동 감지 + 프로젝트 컴파일. (claude/codex 와 동일한 spawn 철학)
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectSrcDir, projectOutDir, projectMainPdf, ensureDir } from './fileManager.js';

const IS_WIN = process.platform === 'win32';

// 선호 순서: tectonic(단일 바이너리·패키지 자동) → latexmk(풀 TeX) → pdflatex(폴백)
const ENGINES = [
  { engine: 'tectonic', versionArgs: ['--version'] },
  { engine: 'latexmk', versionArgs: ['-version'] },
  { engine: 'pdflatex', versionArgs: ['--version'] },
];

let _cached; // {engine} | null | undefined

function canRun(bin, args) {
  return new Promise((resolve) => {
    let done = false;
    let proc;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      proc = spawn(bin, args, { shell: IS_WIN, stdio: 'ignore' });
    } catch { return finish(false); }
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } finish(false); }, 8000);
    proc.on('error', () => { clearTimeout(killer); finish(false); });
    proc.on('close', (code) => { clearTimeout(killer); finish(code === 0); });
  });
}

/** 사용 가능한 첫 엔진을 캐시해 반환. 없으면 null. */
export async function detectEngine(force = false) {
  if (_cached !== undefined && !force) return _cached;
  for (const e of ENGINES) {
    if (await canRun(e.engine, e.versionArgs)) { _cached = { engine: e.engine }; return _cached; }
  }
  _cached = null;
  return null;
}

function buildRuns(engine, main) {
  switch (engine) {
    case 'tectonic':
      return [[main, '--outdir', '../out', '--keep-logs']];
    case 'latexmk':
      return [['-pdf', '-interaction=nonstopmode', '-halt-on-error', '-outdir=../out', main]];
    case 'pdflatex':
    default:
      // bib/상호참조 없이 2회 (간이 폴백)
      return [
        ['-interaction=nonstopmode', '-halt-on-error', '-output-directory=../out', main],
        ['-interaction=nonstopmode', '-halt-on-error', '-output-directory=../out', main],
      ];
  }
}

function runOnce(bin, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { shell: IS_WIN, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return reject(e); }
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    let output = '';
    proc.stdout.on('data', d => { output += d; });
    proc.stderr.on('data', d => { output += d; });
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    proc.on('error', err => { clearTimeout(killer); reject(err); });
    proc.on('close', code => { clearTimeout(killer); resolve({ code, output, timedOut }); });
  });
}

/**
 * 프로젝트 컴파일. cwd=src, 산출물=../out.
 * @returns {Promise<{engine:string, hasPdf:boolean, log:string, exitCode:number}>}
 */
export async function compileProject(projectId, mainFile, { timeoutMs = 120_000 } = {}) {
  const det = await detectEngine();
  if (!det) {
    throw new Error('LaTeX 컴파일러를 찾지 못했습니다. tectonic 또는 TeX Live/MiKTeX 설치가 필요합니다.');
  }
  const main = String(mainFile || 'main.tex');
  // 공백/특수문자는 셸 인자 문제를 피하기 위해 거부 (rename 안내).
  if (!/^[\w./-]+\.tex$/i.test(main)) {
    throw new Error('메인 파일 경로에 공백/특수문자가 있어 컴파일할 수 없습니다. 파일명을 영문/숫자로 바꿔주세요.');
  }
  const srcDir = projectSrcDir(projectId);
  await ensureDir(projectOutDir(projectId));
  try { await fs.stat(path.join(srcDir, main)); }
  catch { throw new Error(`메인 파일이 없습니다: ${main}`); }

  let log = '';
  let lastCode = 0;
  for (const args of buildRuns(det.engine, main)) {
    const r = await runOnce(det.engine, args, srcDir, timeoutMs);
    log += `$ ${det.engine} ${args.join(' ')}\n${r.output}\n`;
    lastCode = r.code;
    if (r.timedOut) { log += `\n[타임아웃 ${timeoutMs}ms — 중단]\n`; break; }
    if (r.code !== 0 && det.engine !== 'pdflatex') break;
  }

  let hasPdf = false;
  try { await fs.stat(projectMainPdf(projectId, main)); hasPdf = true; } catch { /* no pdf */ }
  return { engine: det.engine, hasPdf, log, exitCode: lastCode };
}
