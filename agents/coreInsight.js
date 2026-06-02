// agents/coreInsight.js
// 핵심 분석 에이전트: 기존 한국어 리포트 + 검증된 claim으로 표 전용 한국어 JSON 생성.
import { callLLMJson } from '../core/llm.js';
import { fillTemplate } from '../core/promptStore.js';
import { buildCitationRefMap } from '../public/citationContract.js';

const REPORT_MAX_CHARS = 120_000;

const SCHEMA_HINT = `{
  "coreInsights": [
    {
      "kindKo": "string",
      "claimKo": "string",
      "evidenceKo": "string",
      "caveatKo": "string",
      "claimIds": ["string"]
    }
  ]
}`;

function compactClaim(v) {
  return {
    id: v?.claim?.id ?? v?.claimId ?? v?.id ?? '',
    category: v?.claim?.category ?? v?.category ?? '',
    text: v?.claim?.text ?? v?.text ?? '',
    status: v?.status ?? '',
    evidenceQuote: v?.evidenceQuote ?? v?.quote ?? '',
    evidenceSection: v?.evidenceSection ?? v?.claim?.sourceSection ?? null,
    sourcePage: v?.claim?.sourcePage ?? v?.sourcePage ?? null,
    confidence: v?.confidence ?? null,
    note: v?.note ?? null,
  };
}

function sanitizeInsights(raw, verifiedClaims) {
  const validRefs = buildCitationRefMap(verifiedClaims);
  const arr = Array.isArray(raw?.coreInsights)
    ? raw.coreInsights
    : Array.isArray(raw?.insights)
      ? raw.insights
      : Array.isArray(raw)
        ? raw
        : [];
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const claimIds = Array.isArray(item.claimIds)
      ? item.claimIds.map(String).filter(id => validRefs.has(id))
      : [];
    if (!claimIds.length) continue;
    const claimKo = String(item.claimKo || '').replace(/\s+/g, ' ').trim();
    const evidenceKo = String(item.evidenceKo || '').replace(/\s+/g, ' ').trim();
    const caveatKo = String(item.caveatKo || '').replace(/\s+/g, ' ').trim();
    if (!claimKo || !evidenceKo) continue;
    out.push({
      kindKo: String(item.kindKo || '기타').replace(/\s+/g, ' ').trim(),
      claimKo,
      evidenceKo,
      caveatKo: caveatKo || '추가 일반화 가능성은 별도 확인이 필요합니다.',
      claimIds: [...new Set(claimIds)].slice(0, 3),
    });
    if (out.length >= 5) break;
  }
  return { coreInsights: out };
}

export async function run({ title, report, verifiedClaims, prompts, llm = {}, onMeta }) {
  const compactClaims = (verifiedClaims || []).map(compactClaim);
  const filled = fillTemplate(prompts.coreInsight, {
    title: title || '제목 없음',
    report: String(report || '').slice(0, REPORT_MAX_CHARS),
    verifiedClaimsJson: JSON.stringify(compactClaims, null, 2),
  });
  let meta;
  const raw = await callLLMJson(filled, SCHEMA_HINT, {
    timeoutMs: 600_000,
    backend: llm.backend,
    model: llm.model,
    reasoningEffort: llm.reasoningEffort,
    onMeta: m => { meta = m; },
  });
  if (onMeta && meta) onMeta(meta);
  return sanitizeInsights(raw, verifiedClaims);
}
