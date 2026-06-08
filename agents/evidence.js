// agents/evidence.js
// 근거 탐색 에이전트 (싱글). 주어진 문서에서 질문에 해당하는 부분을 찾아 근거와 함께 답한다.
// 분석팀(분석한 논문 텍스트) / 작성팀(프로젝트 .tex) 양쪽에서 공용으로 사용한다.
import { callLLM } from '../core/llm.js';
import * as llmConfig from '../core/llmConfig.js';
import { getCurrent as getPrompts, fillTemplate } from '../core/promptStore.js';

const MAX_DOC_CHARS = 120000;

/**
 * 문서에서 질문에 대한 근거를 찾아 한국어 답변을 반환.
 * @param {{ documentText:string, question:string, role?:object }} args
 * @returns {Promise<string>} 근거 포함 답변(한국어)
 */
export async function findEvidence({ documentText, question, role }) {
  const prompts = await getPrompts();
  const tpl = prompts.evidence;
  if (!tpl) throw new Error('프롬프트 없음: evidence');
  const r = role || llmConfig.getRole('evidence');

  let doc = documentText || '';
  let truncated = false;
  if (doc.length > MAX_DOC_CHARS) { doc = doc.slice(0, MAX_DOC_CHARS); truncated = true; }
  if (truncated) doc += '\n\n…(문서가 길어 일부만 표시됨)';

  const out = await callLLM(fillTemplate(tpl, { document: doc, question }), {
    backend: r.backend, model: r.model, reasoningEffort: r.reasoningEffort, timeoutMs: 300_000,
  });
  return (out || '').trim();
}
