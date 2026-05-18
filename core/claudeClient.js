// core/claudeClient.js
// Claude Code CLI를 subprocess로 호출하는 어댑터.
// 사용자의 claude.ai Pro/Max 구독으로 동작 — API 키 사용 안 함, 토큰당 과금 없음.
//
// 구현 메모: Node의 stdin pipe는 Windows에서 `.cmd` 래퍼와의 사이에
// 끊기는 케이스가 있어, 프롬프트를 임시 파일에 쓰고 셸 리다이렉트(`<`)로 전달.
// argv 크기 한계(Windows ~32KB)도 동시에 우회됨.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// `claude`로 두면 cmd.exe가 PATHEXT 순서로 .exe → .cmd 등을 알아서 찾는다.
// native installer( ~/.local/bin/claude.exe )와 npm global( claude.cmd ) 양쪽 호환.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * Claude CLI 호출. JSON 응답에서 result 필드의 텍스트를 반환.
 * @param {string} prompt
 * @param {{ systemPrompt?: string, timeoutMs?: number, sessionId?: string, resume?: string, onMeta?: (meta: {usage?: object, durationMs: number, sessionIdFromResponse?: string}) => void }} opts
 * @returns {Promise<string>}
 */
export async function callClaude(prompt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kpac-claude-'));
  const promptFile = path.join(tempDir, 'prompt.txt');

  try {
    await writeFile(promptFile, prompt, 'utf8');

    const cmdParts = [CLAUDE_BIN, '-p', '--output-format', 'json'];
    if (opts.systemPrompt) {
      const escaped = opts.systemPrompt.replace(/"/g, '\\"');
      cmdParts.push('--system-prompt', `"${escaped}"`);
    }
    if (opts.sessionId) cmdParts.push('--session-id', opts.sessionId);
    if (opts.resume) cmdParts.push('--resume', opts.resume);
    const command = `${cmdParts.join(' ')} < "${promptFile}"`;

    const startedAt = Date.now();
    return await new Promise((resolve, reject) => {
      const proc = spawn(command, [], {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });

      const killer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`claude 타임아웃 ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on('error', err => {
        clearTimeout(killer);
        reject(new Error(`claude spawn 실패: ${err.message}`));
      });

      proc.on('close', code => {
        clearTimeout(killer);
        if (code !== 0) return reject(new Error(`claude exit ${code}: ${stderr || stdout}`));
        let json;
        try { json = JSON.parse(stdout); }
        catch (e) { return reject(new Error(`JSON 파싱 실패: ${e.message}\nstdout 앞 300자: ${stdout.slice(0, 300)}`)); }
        if (json.is_error) return reject(new Error(`Claude 에러: ${json.result ?? json.subtype}`));
        if (typeof json.result !== 'string') return reject(new Error(`예상치 못한 응답 형식: result 필드 없음`));
        if (opts.onMeta) {
          try {
            opts.onMeta({
              usage: json.usage,
              durationMs: Date.now() - startedAt,
              sessionIdFromResponse: json.session_id,
            });
          } catch { /* ignore */ }
        }
        resolve(json.result);
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * claude CLI 존재 + 인증 상태를 한 번에 확인.
 * @returns {Promise<{ binary: boolean, authenticated: boolean, email?: string, subscriptionType?: string, errorMessage?: string }>}
 */
export async function checkAuthStatus() {
  // 1단계: binary 존재 여부
  const binaryOk = await new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const proc = spawn(`${CLAUDE_BIN} --version`, [], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('error', () => done(false));
      proc.on('close', code => done(code === 0));
      setTimeout(() => { try { proc.kill(); } catch {} ; done(false); }, 5000);
    } catch { done(false); }
  });
  if (!binaryOk) return { binary: false, authenticated: false };

  // 2단계: 인증 상태 (claude auth status --json)
  return await new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    try {
      const proc = spawn(`${CLAUDE_BIN} auth status --json`, [], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
      proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
      proc.on('error', err => done({ binary: true, authenticated: false, errorMessage: err.message }));
      proc.on('close', () => {
        try {
          const json = JSON.parse(stdout);
          done({
            binary: true,
            authenticated: !!json.loggedIn,
            email: json.email,
            subscriptionType: json.subscriptionType,
          });
        } catch {
          done({ binary: true, authenticated: false, errorMessage: stderr || 'auth status 파싱 실패' });
        }
      });
      setTimeout(() => { try { proc.kill(); } catch {} ; done({ binary: true, authenticated: false, errorMessage: 'auth status 타임아웃' }); }, 8000);
    } catch (err) {
      done({ binary: true, authenticated: false, errorMessage: err.message });
    }
  });
}

/**
 * JSON 응답을 강제. 1회 재시도.
 * @param {string} prompt
 * @param {string} schemaHint
 * @param {{ systemPrompt?: string, timeoutMs?: number, sessionId?: string, resume?: string, onMeta?: (meta: {usage?: object, durationMs: number, sessionIdFromResponse?: string}) => void }} [opts]
 */
export async function callClaudeJson(prompt, schemaHint, opts = {}) {
  const fullPrompt = `${prompt}\n\n반드시 다음 JSON 스키마에 맞게만 응답하세요. JSON 외 다른 텍스트는 절대 포함하지 마세요.\n\`\`\`json\n${schemaHint}\n\`\`\``;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callClaude(fullPrompt, opts);
    const cleaned = raw.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    try { return JSON.parse(cleaned); }
    catch (e) { lastErr = e; }
  }
  throw new Error(`JSON 파싱 ${lastErr.message}`);
}
