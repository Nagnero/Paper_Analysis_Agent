// core/llm.js
// Unified LLM call with backend routing (claude | codex) + 일시적(네트워크) 오류 자동 재시도.
import { callClaude, callClaudeJson } from './claudeClient.js';
import { callCodex, callCodexJson } from './codexCli.js';

// 재시도해도 되는 일시적 오류(소켓 끊김·연결 리셋·rate limit·5xx·과부하 등) 패턴.
const TRANSIENT = /socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|closed unexpectedly|connection (error|closed|reset)|overloaded|rate.?limit|too many requests|\b429\b|\b50[234]\b|network error|fetch failed|temporarily unavailable/i;

function isTransient(err) {
  return TRANSIENT.test(String(err?.message || err || ''));
}

// 일시적 오류면 1회 재시도(백오프). 비일시적 오류는 즉시 전파.
async function withRetry(fn, { retries = 1, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransient(err)) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * @param {string} prompt
 * @param {{ backend?: 'claude'|'codex', model?: string, reasoningEffort?: string, imagePaths?: string[], allowedTools?: string[] }} opts
 */
export async function callLLM(prompt, opts = {}) {
  const backend = opts.backend || 'claude';
  return withRetry(() => (backend === 'codex' ? callCodex(prompt, opts) : callClaude(prompt, opts)));
}

/**
 * @param {string} prompt
 * @param {string} schemaHint
 * @param {{ backend?: 'claude'|'codex', model?: string, reasoningEffort?: string, imagePaths?: string[] }} [opts]
 */
export async function callLLMJson(prompt, schemaHint, opts = {}) {
  const backend = opts.backend || 'claude';
  return withRetry(() => (backend === 'codex' ? callCodexJson(prompt, schemaHint, opts) : callClaudeJson(prompt, schemaHint, opts)));
}
