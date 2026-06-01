// core/llm.js
// Unified LLM call with backend routing (claude | codex).
import { callClaude, callClaudeJson } from './claudeClient.js';
import { callCodex, callCodexJson } from './codexCli.js';

/**
 * @param {string} prompt
 * @param {{ backend?: 'claude'|'codex', model?: string, reasoningEffort?: string, imagePaths?: string[] }} opts
 */
export async function callLLM(prompt, opts = {}) {
  const backend = opts.backend || 'claude';
  if (backend === 'codex') return callCodex(prompt, opts);
  return callClaude(prompt, opts);
}

/**
 * @param {string} prompt
 * @param {string} schemaHint
 * @param {{ backend?: 'claude'|'codex', model?: string, reasoningEffort?: string, imagePaths?: string[] }} [opts]
 */
export async function callLLMJson(prompt, schemaHint, opts = {}) {
  const backend = opts.backend || 'claude';
  if (backend === 'codex') return callCodexJson(prompt, schemaHint, opts);
  return callClaudeJson(prompt, schemaHint, opts);
}
