// core/authStatus.js
// Claude / Codex CLI 로그인 상태 확인. 결과는 10초 캐시.
import { spawn } from 'node:child_process';

const CACHE_TTL_MS = 10_000;
let cache = null;
let cacheAt = 0;
let pending = null;

function spawnCheck(bin, args, timeoutMs = 8000) {
  return new Promise(resolve => {
    let proc;
    const command = [bin, ...args].map(shellPart).join(' ');
    const timer = setTimeout(() => {
      try { proc?.kill('SIGKILL'); } catch {}
      resolve({ stdout: '', stderr: 'timeout', code: -1 });
    }, timeoutMs);
    try {
      proc = spawn(command, [], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      clearTimeout(timer);
      return resolve({ stdout: '', stderr: e.message, code: -1 });
    }
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('error', err => { clearTimeout(timer); resolve({ stdout: '', stderr: err.message, code: -1 }); });
    proc.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });
}

function shellPart(value) {
  const s = String(value);
  if (/^[\w\-.:/\\]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

export async function checkClaude() {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const r = await spawnCheck(bin, ['auth', 'status', '--json']);
  if (r.code !== 0 || !r.stdout) {
    const combined = (r.stderr || r.stdout || '').toLowerCase();
    const installed = !/not recognized|not found|enoent|no such file/.test(combined);
    return { backend: 'claude', installed, loggedIn: false, error: installed ? 'claude 로그아웃 또는 인증 실패' : 'claude CLI 미설치' };
  }
  try {
    const j = JSON.parse(r.stdout);
    return {
      backend: 'claude',
      installed: true,
      loggedIn: !!j.loggedIn,
      email: j.email ?? null,
      subscription: j.subscriptionType ?? null,
    };
  } catch {
    return { backend: 'claude', installed: true, loggedIn: false, error: '응답 파싱 실패' };
  }
}

export async function checkCodex() {
  const bin = process.env.CODEX_BIN || 'codex';
  const r = await spawnCheck(bin, ['login', 'status']);
  const combinedAll = (r.stderr + ' ' + r.stdout).toLowerCase();

  // 미설치
  if (/not recognized|not found|enoent|no such file|cannot be loaded|running scripts is disabled|execution_policies|스크립트를 실행할 수 없|파일을 로드할 수/.test(combinedAll)) {
    return { backend: 'codex', installed: false, loggedIn: false, error: 'codex CLI 미설치' };
  }

  // 명확한 로그아웃 신호
  if (/not logged in|logged out|not authenticated|not signed in|please (run |sign |log )?in|login required|no api key|unauthorized|401/.test(combinedAll)) {
    return { backend: 'codex', installed: true, loggedIn: false, error: 'codex 로그아웃' };
  }

  // 명확한 로그인 신호
  if (r.code === 0 && /\blogged in\b|\bauthenticated\b|\bsigned in\b|chatgpt|api key/.test(combinedAll)) {
    return { backend: 'codex', installed: true, loggedIn: true };
  }

  if (r.code === 0) {
    return { backend: 'codex', installed: true, loggedIn: true, uncertain: true };
  }

  return {
    backend: 'codex',
    installed: true,
    loggedIn: false,
    error: 'codex 로그인 상태 확인 실패',
    detail: (r.stderr || r.stdout || '').trim(),
  };
}

export async function checkAll(force = false) {
  if (!force && cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  if (pending) return pending;
  pending = (async () => {
    const [claude, codex] = await Promise.all([checkClaude(), checkCodex()]);
    cache = { claude, codex, checkedAt: new Date().toISOString() };
    cacheAt = Date.now();
    return cache;
  })().finally(() => { pending = null; });
  return pending;
}

export function invalidateCache() {
  cache = null;
  cacheAt = 0;
}
