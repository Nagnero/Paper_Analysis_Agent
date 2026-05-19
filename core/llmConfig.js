// core/llmConfig.js
// In-memory per-agent LLM backend/model 설정.
// 역할별 키: orchestrator, analyst, verifier, writer, audit, chat
const ROLES = ['orchestrator', 'analyst', 'verifier', 'writer', 'audit', 'chat'];

export const CODEX_MODEL = 'gpt-5.5';
export const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
export const DEFAULT_CODEX_REASONING_EFFORT = 'high';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-7';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function claudeConfig(model = DEFAULT_CLAUDE_MODEL) {
  return { backend: 'claude', model, reasoningEffort: '' };
}

function codexConfig(reasoningEffort = DEFAULT_CODEX_REASONING_EFFORT) {
  return {
    backend: 'codex',
    model: CODEX_MODEL,
    reasoningEffort: normalizeReasoningEffort(reasoningEffort),
  };
}

function makeDefaults(backend = 'claude') {
  return Object.fromEntries(
    ROLES.map(role => [role, backend === 'codex' ? codexConfig() : claudeConfig()])
  );
}

const DEFAULTS = Object.freeze(makeDefaults('claude'));
let current = clone(DEFAULTS);

function normalizeReasoningEffort(value) {
  return CODEX_REASONING_EFFORTS.includes(value) ? value : DEFAULT_CODEX_REASONING_EFFORT;
}

export function isCodexReasoningEffort(value) {
  return CODEX_REASONING_EFFORTS.includes(value);
}

function normalizeEntry(entry, previous = claudeConfig()) {
  const backend = entry?.backend === 'codex' ? 'codex' : 'claude';
  if (backend === 'codex') {
    const legacyEffort = CODEX_REASONING_EFFORTS.includes(entry?.model) ? entry.model : '';
    return codexConfig(entry?.reasoningEffort || legacyEffort || previous.reasoningEffort);
  }
  const model = typeof entry?.model === 'string' ? entry.model.trim() : '';
  return claudeConfig(model);
}

export function getDefaults(auth = null) {
  const useCodex = auth && !auth.claude?.loggedIn && !!auth.codex?.loggedIn;
  return clone(makeDefaults(useCodex ? 'codex' : 'claude'));
}

export function getConfig() {
  return clone(current);
}

export function setConfig(next) {
  for (const role of ROLES) {
    if (next && next[role]) {
      current[role] = normalizeEntry(next[role], current[role]);
    }
  }
  return getConfig();
}

export function getRole(role) {
  return current[role] ? { ...current[role] } : claudeConfig();
}

export function applyAvailability(auth) {
  const claudeOk = !!auth?.claude?.loggedIn;
  const codexOk = !!auth?.codex?.loggedIn;
  if (claudeOk || !codexOk) return false;

  let changed = false;
  for (const role of ROLES) {
    if (current[role]?.backend === 'claude') {
      current[role] = codexConfig(current[role].reasoningEffort);
      changed = true;
    }
  }
  return changed;
}

export { ROLES };
