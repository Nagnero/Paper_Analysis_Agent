// agents/verifier.js
// 검증가 에이전트: 청크 + BM25 retrieval + 배치 병렬 LLM 호출로 각 claim의 원문 근거 확인.
import { BM25Index } from '../utils/bm25.js';
import { chunk } from '../utils/chunker.js';
import { callLLMJson } from '../core/llm.js';
import { fillTemplate } from '../core/promptStore.js';

const SCHEMA_HINT = `[{"claimId": "string", "status": "supported|partially_supported|unsupported|contradicted", "evidenceQuote": "string", "evidenceSection": "string", "confidence": 0.0, "note": "string|null"}]`;

const BATCH_SIZE = 5;
const CONCURRENCY = 2;
const TOP_K = 3;

export async function run({ paperText, prompts, claims, verificationFocus, llm = {}, onMeta }) {
  const chunks = chunk(paperText);
  const idx = new BM25Index();
  for (const c of chunks) idx.add(c.id, c.text);

  const batches = [];
  for (let i = 0; i < claims.length; i += BATCH_SIZE) {
    batches.push(claims.slice(i, i + BATCH_SIZE));
  }

  const focusBlock = verificationFocus && verificationFocus.trim()
    ? `## 검증 우선 영역\n${verificationFocus.trim()}\n`
    : '';

  const allMetas = [];
  const allVerdicts = [];

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(slice.map(batch => verifyBatch(batch, chunks, idx, prompts, focusBlock, llm)));
    for (let j = 0; j < settled.length; j++) {
      const res = settled[j];
      const originalBatch = slice[j];
      if (res.status === 'fulfilled') {
        allVerdicts.push(...res.value.verdicts);
        if (res.value.meta) allMetas.push(res.value.meta);
      } else {
        const errMsg = res.reason?.message || String(res.reason);
        for (const c of originalBatch) {
          allVerdicts.push({
            claimId: c.id,
            status: 'unsupported',
            evidenceQuote: '',
            evidenceSection: c.sourceSection || null,
            confidence: 0,
            note: `배치 호출 실패: ${errMsg}`,
          });
        }
      }
    }
  }

  if (onMeta) {
    onMeta({
      backend: allMetas[0]?.backend,
      model: allMetas[0]?.model,
      reasoningEffort: allMetas[0]?.reasoningEffort,
      calls: allMetas.length,
      totalInputTokens: allMetas.reduce((s, m) => s + (m.usage?.input_tokens || 0), 0),
      totalOutputTokens: allMetas.reduce((s, m) => s + (m.usage?.output_tokens || 0), 0),
      totalDurationMs: allMetas.reduce((s, m) => s + (m.durationMs || 0), 0),
    });
  }

  const byId = new Map(allVerdicts.map(v => [v.claimId, v]));
  return claims.map(c => {
    const v = byId.get(c.id);
    return v
      ? {
          claim: c,
          status: v.status,
          evidenceQuote: v.evidenceQuote || '',
          evidenceSection: v.evidenceSection || c.sourceSection || null,
          confidence: v.confidence ?? null,
          note: v.note || null,
        }
      : {
          claim: c,
          status: 'unsupported',
          evidenceQuote: '',
          evidenceSection: c.sourceSection || null,
          confidence: 0,
          note: '검증 응답 누락',
        };
  });
}

async function verifyBatch(batch, chunks, idx, prompts, focusBlock, llm = {}) {
  const chunkIdSet = new Set();
  for (const c of batch) {
    const hits = idx.search(c.text, TOP_K);
    for (const h of hits) chunkIdSet.add(h.id);
  }
  const ctxChunks = chunks.filter(ch => chunkIdSet.has(ch.id));
  const contextText = ctxChunks
    .map(ch => `[${ch.id}${ch.section ? ' ' + ch.section : ''}${ch.page ? ' p.' + ch.page : ''}]\n${ch.text}`)
    .join('\n\n---\n\n');

  const filled = fillTemplate(prompts.verifier, {
    claimsJson: JSON.stringify(batch, null, 2),
    paperText: contextText,
    verificationFocus_block: focusBlock || '',
  });

  let meta;
  let verdicts = await callLLMJson(filled, SCHEMA_HINT, {
    timeoutMs: 600_000,
    backend: llm.backend,
    model: llm.model,
    reasoningEffort: llm.reasoningEffort,
    onMeta: m => { meta = m; },
  });
  if (!Array.isArray(verdicts)) {
    verdicts = verdicts?.results ?? verdicts?.verdicts ?? verdicts?.claims ?? [];
    if (!Array.isArray(verdicts)) verdicts = [];
  }
  return { verdicts, meta };
}
