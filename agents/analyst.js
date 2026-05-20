// agents/analyst.js
// 분석가 에이전트: 영어 논문에서 구조화된 claim + 재현가능성 정보 추출.
import { callLLMJson } from '../core/llm.js';
import { fillTemplate, buildEmphasisBlock } from '../core/promptStore.js';

const ANALYST_MAX_CHARS = 400_000;

const SCHEMA_HINT = `{
  "title": "string",
  "claims": [{"id": "string", "category": "string", "text": "string", "sourceSection": "string", "sourcePage": 0}],
  "reproducibility": {"codeUrl": "string|null", "datasetAvailability": "string", "hyperparametersSpecified": false, "hardware": "string|null", "trainingTime": "string|null", "seedSpecified": false, "envSpecified": false, "notes": "string"}
}`;

export async function run({ paperText, prompts, emphasis, extractionFocus, llm = {}, onMeta }) {
  let text = paperText;
  if (text.length > ANALYST_MAX_CHARS) {
    console.warn(`[analyst] paperText ${text.length} chars -> truncated to ${ANALYST_MAX_CHARS}`);
    text = text.slice(0, ANALYST_MAX_CHARS);
  }
  const focusBlock = extractionFocus && extractionFocus.trim()
    ? `## 추출 시 우선 집중할 주제\n${extractionFocus.trim()}\n`
    : '';
  const filled = fillTemplate(prompts.analyst, {
    paperText: text,
    userEmphasis_block: buildEmphasisBlock(emphasis),
    extractionFocus_block: focusBlock,
  });
  let meta;
  const out = await callLLMJson(filled, SCHEMA_HINT, {
    timeoutMs: 900_000,
    backend: llm.backend,
    model: llm.model,
    reasoningEffort: llm.reasoningEffort,
    onMeta: m => { meta = m; },
  });
  if (onMeta && meta) onMeta(meta);
  return out;
}
