// agents/writer.js
// 작가 에이전트: 검증된 claim + 재현가능성 정보로 한국어 11섹션 Markdown 리포트 작성.
import { callClaude } from '../core/claudeClient.js';
import { fillTemplate, buildEmphasisBlock } from '../core/promptStore.js';

export async function run({ title, verifiedClaims, reproducibility, prompts, emphasis, auditResults, reportSectionsToEmphasize, additionalReportSections, onMeta }) {
  const flatClaims = verifiedClaims.map(v => ({
    id: v.claim?.id ?? v.claimId ?? '',
    text: v.claim?.text ?? '',
    category: v.claim?.category ?? '',
    sourceSection: v.evidenceSection || v.claim?.sourceSection || null,
    sourcePage: v.claim?.sourcePage ?? null,
    status: v.status,
    evidenceQuote: v.evidenceQuote ?? '',
    confidence: v.confidence ?? null,
    note: v.note ?? null,
  }));

  const auditBlock = Array.isArray(auditResults) && auditResults.length
    ? `## 감사 결과 (작가가 11섹션 외 참고)\n${auditResults.map(a =>
        `### ${a.name}\n- 판정: ${a.verdict}\n- 발견:\n${(a.findings || []).map(f => `  - ${f}`).join('\n')}${a.notes ? `\n- 비고: ${a.notes}` : ''}`
      ).join('\n\n')}\n`
    : '';

  const emphasizedBlock = Array.isArray(reportSectionsToEmphasize) && reportSectionsToEmphasize.length
    ? `## 강조해야 할 기존 섹션\n다음 섹션들을 더 깊이 작성하세요: ${reportSectionsToEmphasize.join(', ')}\n`
    : '';

  const additionalBlock = Array.isArray(additionalReportSections) && additionalReportSections.length
    ? `## 추가로 작성할 섹션\n11번 뒤에 다음 추가 섹션을 차례로 작성하세요:\n${additionalReportSections.map(s =>
        `- 제목: ${s.title} / 지시: ${s.instructions}`
      ).join('\n')}\n`
    : '';

  const filled = fillTemplate(prompts.writer, {
    title: title ?? '<논문 제목>',
    verifiedClaimsJson: JSON.stringify(flatClaims, null, 2),
    reproducibilityJson: JSON.stringify(reproducibility, null, 2),
    userEmphasis_block: buildEmphasisBlock(emphasis),
    auditResults_block: auditBlock,
    emphasizedSections_block: emphasizedBlock,
    additionalSections_block: additionalBlock,
  });
  let meta;
  const out = await callClaude(filled, {
    timeoutMs: 900_000,
    onMeta: m => { meta = m; },
  });
  if (onMeta && meta) onMeta(meta);
  return out;
}
