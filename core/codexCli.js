// core/codexCli.js
// OpenAI Codex CLI 호출 어댑터.
// 가정: `codex exec` 서브커맨드가 stdin에서 프롬프트를 읽고 stdout에 응답을 출력함.
// 다른 호출 문법이면 cmdParts 구성을 수정. CODEX_BIN 환경변수로 바이너리 경로 override.
// 세션/resume은 v1에서 미지원 (codex 세션 API가 안정화되지 않았다고 가정) —
// opts.sessionId / opts.resume 은 무시. chat은 백엔드가 codex면 매번 fresh 호출.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CODEX_MODEL, CODEX_REASONING_EFFORTS, DEFAULT_CODEX_REASONING_EFFORT } from './llmConfig.js';

const CODEX_BIN = process.env.CODEX_BIN || 'codex';

function stripOuterFence(text) {
  const trimmed = text.trim();
  const m = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  if (m) return m[1].trim();
  return trimmed;
}

function safeModel(model) {
  if (!model) return '';
  if (!/^[\w\-.:\/]+$/.test(model)) {
    throw new Error(`모델 ID에 허용되지 않은 문자: ${model}`);
  }
  return model;
}

function safeReasoningEffort(reasoningEffort) {
  const value = reasoningEffort || DEFAULT_CODEX_REASONING_EFFORT;
  if (!CODEX_REASONING_EFFORTS.includes(value)) {
    throw new Error(`Codex reasoning effort must be one of: ${CODEX_REASONING_EFFORTS.join(', ')}`);
  }
  return value;
}

/**
 * codex CLI 호출. stdout 전체를 응답 텍스트로 반환.
 * @param {string} prompt
 * @param {{ timeoutMs?: number, model?: string, reasoningEffort?: string, sessionId?: string, resume?: string, onMeta?: (meta: {usage?: object, durationMs: number}) => void }} opts
 * @returns {Promise<string>}
 */
export async function callCodex(prompt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kpac-codex-'));
  const promptFile = path.join(tempDir, 'prompt.txt');

  try {
    await writeFile(promptFile, prompt, 'utf8');

    const model = safeModel(opts.model || CODEX_MODEL);
    const reasoningEffort = safeReasoningEffort(opts.reasoningEffort);
    const cmdParts = [CODEX_BIN, 'exec', '--skip-git-repo-check', '--model', model, '-c', `model_reasoning_effort=${reasoningEffort}`];
    const command = `${cmdParts.join(' ')} < "${promptFile}"`;

    const startedAt = Date.now();
    return await new Promise((resolve, reject) => {
      const proc = spawn(command, [], {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: tempDir,
      });

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });

      const killer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`codex 타임아웃 ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on('error', err => {
        clearTimeout(killer);
        reject(new Error(`codex spawn 실패: ${err.message}`));
      });

      proc.on('close', code => {
        clearTimeout(killer);
        if (code !== 0) return reject(new Error(`codex exit ${code}: ${stderr || stdout}`));
        if (opts.onMeta) {
          try {
            opts.onMeta({
              backend: 'codex',
              model,
              reasoningEffort,
              usage: {},
              durationMs: Date.now() - startedAt,
            });
          } catch { /* ignore */ }
        }
        resolve(stripOuterFence(stdout));
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * JSON 응답을 강제. 1회 재시도. codex는 JSON 출력 옵션이 없을 수 있어 프롬프트로만 강제.
 * @param {string} prompt
 * @param {string} schemaHint
 * @param {{ timeoutMs?: number, model?: string, reasoningEffort?: string, onMeta?: (meta: {usage?: object, durationMs: number}) => void }} [opts]
 */
export async function callCodexJson(prompt, schemaHint, opts = {}) {
  const fullPrompt = `${prompt}\n\n반드시 다음 JSON 스키마에 맞게만 응답하세요. JSON 외 다른 텍스트는 절대 포함하지 마세요.\n\`\`\`json\n${schemaHint}\n\`\`\``;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callCodex(fullPrompt, opts);
    const cleaned = raw.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    try { return JSON.parse(cleaned); }
    catch (e) { lastErr = e; }
  }
  throw new Error(`JSON 파싱 ${lastErr.message}`);
}
