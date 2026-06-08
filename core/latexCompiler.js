// core/latexCompiler.js
// 시스템 LaTeX CLI 자동 감지 + 프로젝트 컴파일. (claude/codex 와 동일한 spawn 철학)
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectSrcDir, projectOutDir, projectMainPdf, ensureDir } from './fileManager.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

// 선호 순서: tectonic(단일 바이너리·패키지 자동) → latexmk(풀 TeX) → pdflatex(폴백)
const ENGINES = [
  { engine: 'tectonic', versionArgs: ['--version'] },
  { engine: 'latexmk', versionArgs: ['-version'] },
  { engine: 'pdflatex', versionArgs: ['--version'] },
];

let _cached; // {engine, cmd} | null | undefined

// 전체 경로면 셸 없이(공백/PATHEXT 무관), 맨 이름이면 win 에서 셸로(PATHEXT/.cmd 해석).
function spawnShell(cmd) {
  return path.isAbsolute(cmd) ? false : IS_WIN;
}

// GUI 앱은 셸 PATH 를 상속 못 받는 경우가 많아, PATH 외 흔한 위치도 탐색.
function fallbackDirs() {
  const home = os.homedir();
  return [
    home,
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    'C:\\tectonic',
  ];
}

function canRun(cmd, args) {
  return new Promise((resolve) => {
    let done = false;
    let proc;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      proc = spawn(cmd, args, { shell: spawnShell(cmd), stdio: 'ignore' });
    } catch { return finish(false); }
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } finish(false); }, 8000);
    proc.on('error', () => { clearTimeout(killer); finish(false); });
    proc.on('close', (code) => { clearTimeout(killer); finish(code === 0); });
  });
}

// PATH → 흔한 위치 순으로 실행 가능한 cmd(이름 또는 전체경로)를 찾음.
async function resolveCmd(engine, versionArgs) {
  if (await canRun(engine, versionArgs)) return engine; // PATH
  for (const dir of fallbackDirs()) {
    const cand = path.join(dir, engine + EXE);
    try { await fs.stat(cand); } catch { continue; }
    if (await canRun(cand, versionArgs)) return cand;
  }
  return null;
}

/** 사용 가능한 첫 엔진을 캐시해 반환. {engine, cmd} 또는 null. */
export async function detectEngine(force = false) {
  if (_cached !== undefined && !force) return _cached;

  // 환경변수 직접 지정(전체 경로) 최우선. 파일명으로 엔진 종류 추론.
  const override = process.env.PAA_LATEX_ENGINE;
  if (override) {
    const base = path.basename(override).replace(/\.exe$/i, '').toLowerCase();
    const known = ENGINES.find(e => e.engine === base) || ENGINES[0];
    if (await canRun(override, known.versionArgs)) { _cached = { engine: known.engine, cmd: override }; return _cached; }
  }

  for (const e of ENGINES) {
    const cmd = await resolveCmd(e.engine, e.versionArgs);
    if (cmd) { _cached = { engine: e.engine, cmd }; return _cached; }
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

function runOnce(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { shell: spawnShell(cmd), cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const r = await runOnce(det.cmd, args, srcDir, timeoutMs);
    log += `$ ${det.engine} ${args.join(' ')}\n${r.output}\n`;
    lastCode = r.code;
    if (r.timedOut) { log += `\n[타임아웃 ${timeoutMs}ms — 중단]\n`; break; }
    if (r.code !== 0 && det.engine !== 'pdflatex') break;
  }

  let hasPdf = false;
  try { await fs.stat(projectMainPdf(projectId, main)); hasPdf = true; } catch { /* no pdf */ }
  return { engine: det.engine, hasPdf, log, exitCode: lastCode };
}
