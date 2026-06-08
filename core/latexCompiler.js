// core/latexCompiler.js
// 시스템 LaTeX CLI 자동 감지 + 프로젝트 컴파일. (claude/codex 와 동일한 spawn 철학)
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectSrcDir, projectMainPdf } from './fileManager.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

// 선호 순서: pdflatex(직접 bibtex/biber 다중패스 — 결정적, Perl 불필요) →
// latexmk(풀 자동화, 단 Perl 필요·MiKTeX에서 불안정) → tectonic(XeTeX, 무설치 폴백) .
// pdfLaTeX = IEEE/ACM 등 pdfTeX 전용 패키지(spotcolor) 호환. 특정 엔진 강제는 PAA_LATEX_ENGINE.
const ENGINES = [
  { engine: 'pdflatex', versionArgs: ['--version'] },
  { engine: 'latexmk', versionArgs: ['-version'] },
  { engine: 'tectonic', versionArgs: ['--version'] },
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
    // 풀 TeX 배포판 기본 bin (PATH 미반영 대비)
    'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
    path.join(home, 'AppData', 'Local', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'),
    'C:\\texlive\\2025\\bin\\windows',
    'C:\\texlive\\2024\\bin\\windows',
    '/Library/TeX/texbin',
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

// 같은 bin 디렉터리의 보조 도구(bibtex/biber) 경로. cmd 가 전체경로면 형제 파일로.
function siblingTool(cmd, name) {
  return path.isAbsolute(cmd) ? path.join(path.dirname(cmd), name + EXE) : name;
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

// .aux 에 인용/참고문헌이 있으면 bibtex, .bcf 가 있으면 biber 를 src 안에서 실행.
async function runBibStep(cmd, srcDir, base, timeoutMs) {
  // biblatex(biber)
  try {
    await fs.stat(path.join(srcDir, base + '.bcf'));
    const r = await runOnce(siblingTool(cmd, 'biber'), [base], srcDir, timeoutMs);
    return `$ biber ${base}\n${r.output}\n`;
  } catch { /* no .bcf */ }
  // bibtex
  try {
    const aux = await fs.readFile(path.join(srcDir, base + '.aux'), 'utf8');
    if (/\\bibdata|\\citation/.test(aux)) {
      const r = await runOnce(siblingTool(cmd, 'bibtex'), [base], srcDir, timeoutMs);
      return `$ bibtex ${base}\n${r.output}\n`;
    }
  } catch { /* no .aux */ }
  return '';
}

/**
 * 프로젝트 컴파일. src 안에서 in-place 로 수행(참고문헌/MiKTeX 호환).
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
  try { await fs.stat(path.join(srcDir, main)); }
  catch { throw new Error(`메인 파일이 없습니다: ${main}`); }
  const base = main.replace(/\.tex$/i, '');

  let log = '';
  let lastCode = 0;
  const run = async (cmd, args) => {
    const r = await runOnce(cmd, args, srcDir, timeoutMs);
    log += `$ ${path.basename(cmd)} ${args.join(' ')}\n${r.output}\n`;
    if (r.timedOut) log += `\n[타임아웃 ${timeoutMs}ms — 중단]\n`;
    lastCode = r.code;
    return r;
  };

  if (det.engine === 'tectonic') {
    // tectonic: 단일 실행, bib·다중패스 내부 처리
    await run(det.cmd, [main, '--synctex', '--keep-logs']);
  } else if (det.engine === 'latexmk') {
    // latexmk: bib·다중패스·synctex 내부 처리 (Perl 필요)
    await run(det.cmd, ['-pdf', '-interaction=nonstopmode', '-synctex=1', main]);
  } else {
    // pdflatex: 직접 다중패스 + bibtex/biber (참고문헌 해결)
    const pdfArgs = ['-interaction=nonstopmode', '-synctex=1', main];
    const first = await run(det.cmd, pdfArgs);
    if (!first.timedOut) {
      const bibLog = await runBibStep(det.cmd, srcDir, base, timeoutMs);
      if (bibLog) {
        log += bibLog;
        await run(det.cmd, pdfArgs); // 참고문헌 반영
      }
      await run(det.cmd, pdfArgs);   // 상호참조 안정화
    }
  }

  let hasPdf = false;
  try { await fs.stat(projectMainPdf(projectId, main)); hasPdf = true; } catch { /* no pdf */ }

  // tectonic(XeTeX)에서 pdfLaTeX 전용 패키지로 실패한 경우 안내.
  if (!hasPdf && det.engine === 'tectonic' && /spotcolor|pdftex\.def|Undefined control sequence/.test(log)) {
    log += '\n[안내] 이 문서는 pdfLaTeX 전용 패키지(예: spotcolor — IEEE/ACM 템플릿)를 사용하는 것으로 보입니다.\n'
      + 'tectonic(XeTeX)으로는 컴파일할 수 없습니다. 아래 중 하나를 설치하고 앱을 재시작하면 pdfLaTeX(latexmk)로 컴파일됩니다:\n'
      + '  • MiKTeX (추천): https://miktex.org/download\n'
      + '  • TeX Live:      https://tug.org/texlive/\n';
  }
  return { engine: det.engine, hasPdf, log, exitCode: lastCode };
}
