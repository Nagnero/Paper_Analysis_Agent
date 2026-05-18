// agents/focusedAudit.js
// ad-hoc 감사 작업 에이전트: 오케스트레이터가 지시한 한 가지 검토 작업을 실행.
import { BM25Index } from '../utils/bm25.js';
import { chunk } from '../utils/chunker.js';
import { callClaudeJson } from '../core/claudeClient.js';

const TOP_K = 5;

const SCHEMA = `{ "taskId": "string", "name": "string", "findings": ["string"], "verdict": "string", "notes": "string" }`;

export async function run({ paperText, task, onMeta }) {
  const chunks = chunk(paperText);
  const idx = new BM25Index();
  for (const c of chunks) idx.add(c.id, c.text);
  const hits = idx.search(task.focus, TOP_K);
  const ctxChunks = chunks.filter(ch => hits.some(h => h.id === ch.id));
  const contextText = ctxChunks
    .map(ch => `[${ch.id}${ch.section ? ' ' + ch.section : ''}${ch.page ? ' p.' + ch.page : ''}]\n${ch.text}`)
    .join('\n\n---\n\n');

  const prompt = `당신은 논문 감사 전문가입니다. 다음 한 가지 감사 작업을 수행하고 JSON으로만 응답하세요.

## 감사 작업
- name: ${task.name}
- focus: ${task.focus}

## 출력 JSON 스키마
{
  "taskId": "${task.id}",
  "name": "${task.name}",
  "findings": ["발견 사항 1~5개 (한국어 한 줄씩)"],
  "verdict": "종합 판정 한 문장",
  "notes": "추가 코멘트 또는 한계 (없으면 빈 문자열)"
}

## 원칙
- 논문에 명시되지 않은 내용 추측 금지
- 발견 사항은 구체적 근거 (섹션/페이지) 포함

## 관련 청크
${contextText}`;

  let meta;
  const raw = await callClaudeJson(prompt, SCHEMA, {
    timeoutMs: 300_000,
    onMeta: m => { meta = m; },
  });
  if (onMeta && meta) onMeta(meta);
  return {
    taskId: raw.taskId || task.id,
    name: raw.name || task.name,
    findings: Array.isArray(raw.findings) ? raw.findings : [],
    verdict: raw.verdict || '',
    notes: raw.notes || '',
  };
}
