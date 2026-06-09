// core/claudeClient.js
// Claude Code CLI를 subprocess로 호출하는 어댑터.
// 사용자의 claude.ai Pro/Max 구독으로 동작 — API 키 사용 안 함, 토큰당 과금 없음.
//
// 구현 메모: 프롬프트는 stdin pipe로 전달하고, 이미지 파일은 Read 도구가
// 읽을 수 있도록 argv의 --add-dir 허용 경로로만 넘긴다. Windows에서는
// npm .cmd 래퍼 실행을 위해 shell을 켜되, 인자는 분리된 argv로 유지한다.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `claude`로 두면 cmd.exe가 PATHEXT 순서로 .exe → .cmd 등을 알아서 찾는다.
// native installer( ~/.local/bin/claude.exe )와 npm global( claude.cmd ) 양쪽 호환.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

function safeModel(model) {
  if (!model) return '';
  if (!/^[\w\-.:\/]+$/.test(model)) {
    throw new Error(`모델 ID에 허용되지 않은 문자: ${model}`);
  }
  return model;
}

// Claude Code CLI의 추론 강도는 `--effort` 플래그로 제어한다(low/medium/high/xhigh/max).
// Opus 4.8/4.7은 adaptive 전용이라 MAX_THINKING_TOKENS는 무시되므로 effort만 사용.
// Haiku 등 미지원 모델은 빈 effort가 들어오므로 플래그를 붙이지 않는다.
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function safeImagePaths(imagePaths = []) {
  if (!Array.isArray(imagePaths)) return [];
  return imagePaths.map((imagePath) => {
    if (typeof imagePath !== 'string' || !imagePath) {
      throw new Error('imagePaths must contain non-empty strings');
    }
    if (imagePath.includes('\0') || !path.isAbsolute(imagePath)) {
      throw new Error('imagePaths must be absolute safe paths');
    }
    if (!existsSync(imagePath)) throw new Error(`이미지 파일을 찾을 수 없습니다: ${imagePath}`);
    return imagePath;
  });
}

/**
 * Claude CLI 호출. JSON 응답에서 result 필드의 텍스트를 반환.
 * @param {string} prompt
 * @param {{ systemPrompt?: string, timeoutMs?: number, sessionId?: string, resume?: string, model?: string, imagePaths?: string[], onMeta?: (meta: {usage?: object, durationMs: number, sessionIdFromResponse?: string}) => void }} opts
 * @returns {Promise<string>}
 */
export async function callClaude(prompt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kpac-claude-'));

  try {
    const images = safeImagePaths(opts.imagePaths);
    let finalPrompt = prompt;
    if (images.length) {
      finalPrompt = `${prompt}

## 로컬 선택 영역 이미지
아래 로컬 이미지 파일을 Read 도구로 읽고, 이미지 내용을 선택 영역 질문의 1차 근거로 사용하세요.
${images.map((imagePath, i) => `- image ${i + 1}: ${imagePath}`).join('\n')}`;
    }

    const args = ['-p', '--output-format', 'json'];
    if (opts.systemPrompt) {
      args.push('--system-prompt', opts.systemPrompt);
    }
    if (opts.sessionId) args.push('--session-id', opts.sessionId);
    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.model) {
      const m = safeModel(opts.model);
      if (m) args.push('--model', m);
    }
    if (CLAUDE_EFFORTS.has(opts.reasoningEffort)) {
      args.push('--effort', opts.reasoningEffort);
    }
    if (images.length) {
      for (const dir of [...new Set(images.map(imagePath => path.dirname(imagePath)))]) {
        args.push('--add-dir', dir);
      }
    }
    // 허용 도구: 이미지가 있으면 Read, 그 외 opts.allowedTools(예: WebFetch/WebSearch).
    const allowed = new Set(Array.isArray(opts.allowedTools) ? opts.allowedTools : []);
    if (images.length) allowed.add('Read');
    if (allowed.size) args.push('--allowedTools', [...allowed].join(','));

    const startedAt = Date.now();
    return await new Promise((resolve, reject) => {
      const proc = spawn(CLAUDE_BIN, args, {
        // npm-installed CLIs may resolve to .cmd wrappers on Windows; keep argv
        // args separate while allowing cmd.exe wrapper execution there.
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tempDir,
      });

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      proc.stdin.end(finalPrompt, 'utf8');

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
              backend: 'claude',
              model: opts.model || '',
              reasoningEffort: opts.reasoningEffort || '',
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
 * @param {{ systemPrompt?: string, timeoutMs?: number, sessionId?: string, resume?: string, model?: string, imagePaths?: string[], onMeta?: (meta: {usage?: object, durationMs: number, sessionIdFromResponse?: string}) => void }} [opts]
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
