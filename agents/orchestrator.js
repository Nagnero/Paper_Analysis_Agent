// agents/orchestrator.js
// 오케스트레이터 에이전트: 사용자의 emphasis를 해석해 다른 에이전트들을 위한 directive 생성.
import { callLLMJson } from '../core/llm.js';
import { fillTemplate } from '../core/promptStore.js';

const SCHEMA = `{
  "interpretedEmphasis": "string",
  "extractionFocus": "string",
  "verificationFocus": "string",
  "additionalAuditTasks": [{ "id": "string", "name": "string", "focus": "string" }],
  "reportSectionsToEmphasize": ["string"],
  "additionalReportSections": [{ "title": "string", "instructions": "string" }]
}`;

export const EMPTY_DIRECTIVE = {
  interpretedEmphasis: '',
  extractionFocus: '',
  verificationFocus: '',
  additionalAuditTasks: [],
  reportSectionsToEmphasize: [],
  additionalReportSections: [],
};

export async function run({ title, abstract, emphasis, prompts, llm = {}, onMeta }) {
  if (!emphasis || !emphasis.trim()) return EMPTY_DIRECTIVE;
  const filled = fillTemplate(prompts.orchestrator, {
    title: title ?? '',
    abstract: abstract ?? '(초록 없음)',
    emphasis: emphasis.trim(),
  });
  let meta;
  const raw = await callLLMJson(filled, SCHEMA, {
    timeoutMs: 300_000,
    backend: llm.backend,
    model: llm.model,
    reasoningEffort: llm.reasoningEffort,
    onMeta: m => { meta = m; },
  });
  if (onMeta && meta) onMeta(meta);
  return {
    interpretedEmphasis: typeof raw.interpretedEmphasis === 'string' ? raw.interpretedEmphasis : '',
    extractionFocus: typeof raw.extractionFocus === 'string' ? raw.extractionFocus : '',
    verificationFocus: typeof raw.verificationFocus === 'string' ? raw.verificationFocus : '',
    additionalAuditTasks: Array.isArray(raw.additionalAuditTasks)
      ? raw.additionalAuditTasks.filter(t => t && t.id && t.name && t.focus)
      : [],
    reportSectionsToEmphasize: Array.isArray(raw.reportSectionsToEmphasize)
      ? raw.reportSectionsToEmphasize.filter(s => typeof s === 'string')
      : [],
    additionalReportSections: Array.isArray(raw.additionalReportSections)
      ? raw.additionalReportSections.filter(s => s && s.title && s.instructions)
      : [],
  };
}
