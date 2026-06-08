// core/llmConfig.js
// In-memory per-agent LLM backend/model 설정.
// 역할별 키: orchestrator, analyst, verifier, writer, coreInsight, audit, chat
const ROLES = [
  'orchestrator', 'analyst', 'verifier', 'writer', 'coreInsight', 'audit', 'chat',
  // 분석팀 공용 — 근거 탐색(작성팀에서도 사용)
  'evidence',
  // 논문 작성팀 (본문/그림은 계획→작성→검토 멀티에이전트)
  'writeOrchestrator', 'writePlan', 'writeBody', 'writeFigure', 'writeReview', 'writeCitation', 'writeCompile',
];

export const CODEX_MODELS = Object.freeze(['gpt-5.5', 'gpt-5.4']);
export const CODEX_MODEL = 'gpt-5.5';
export const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
export const DEFAULT_CODEX_REASONING_EFFORT = 'high';

export const CLAUDE_MODELS = Object.freeze(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';
// Claude Code `--effort` 등급은 모델마다 다르다. Haiku는 effort 미지원(빈 배열).
export const CLAUDE_EFFORTS_BY_MODEL = Object.freeze({
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
  'claude-haiku-4-5-20251001': [],
});
export const CLAUDE_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_CLAUDE_REASONING_EFFORT = 'high';

// 두 백엔드 통틀어 유효한 effort 값 (서버 검증용).
const ALL_REASONING_EFFORTS = Object.freeze(
  [...new Set([...CLAUDE_REASONING_EFFORTS, ...CODEX_REASONING_EFFORTS])]
);
export const REASONING_EFFORTS = ALL_REASONING_EFFORTS;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function claudeConfig(model = DEFAULT_CLAUDE_MODEL, reasoningEffort = DEFAULT_CLAUDE_REASONING_EFFORT) {
  const m = model || DEFAULT_CLAUDE_MODEL;
  return { backend: 'claude', model: m, reasoningEffort: normalizeClaudeEffort(reasoningEffort, m) };
}

function codexConfig(reasoningEffort = DEFAULT_CODEX_REASONING_EFFORT, model = CODEX_MODEL) {
  return {
    backend: 'codex',
    model: normalizeCodexModel(model),
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

// 모델별 지원 등급에 맞춰 effort를 정규화. Haiku 등 미지원 모델은 ''(플래그 미전달).
function normalizeClaudeEffort(value, model = DEFAULT_CLAUDE_MODEL) {
  const supported = CLAUDE_EFFORTS_BY_MODEL[model];
  if (supported) {
    if (supported.length === 0) return '';
    if (supported.includes(value)) return value;
    return supported.includes(DEFAULT_CLAUDE_REASONING_EFFORT) ? DEFAULT_CLAUDE_REASONING_EFFORT : supported[supported.length - 1];
  }
  // 알 수 없는 모델: 표준 등급이면 그대로 허용.
  return CLAUDE_REASONING_EFFORTS.includes(value) ? value : '';
}

function normalizeCodexModel(value) {
  return CODEX_MODELS.includes(value) ? value : CODEX_MODEL;
}

export function isReasoningEffort(value) {
  return ALL_REASONING_EFFORTS.includes(value);
}

function normalizeEntry(entry, previous = claudeConfig()) {
  const backend = entry?.backend === 'codex' ? 'codex' : 'claude';
  if (backend === 'codex') {
    // 레거시: 예전엔 reasoningEffort가 model 필드에 담겼음.
    const legacyEffort = CODEX_REASONING_EFFORTS.includes(entry?.model) ? entry.model : '';
    const model = CODEX_MODELS.includes(entry?.model) ? entry.model : CODEX_MODEL;
    return codexConfig(entry?.reasoningEffort || legacyEffort || previous.reasoningEffort, model);
  }
  const model = typeof entry?.model === 'string' ? entry.model.trim() : '';
  return claudeConfig(model || previous.model, entry?.reasoningEffort || previous.reasoningEffort);
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
