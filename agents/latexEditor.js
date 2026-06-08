// agents/latexEditor.js
// LaTeX 편집 에이전트: 현재 파일 + 사용자 지시 → 수정된 전체 파일 + 한 줄 요약.
import { callLLM } from '../core/llm.js';

const MAX_CHARS = 60000;

// 가장 큰 코드펜스 블록 추출
function extractFenced(text) {
  const re = /```[a-zA-Z]*\n?([\s\S]*?)```/g;
  let m, best = null;
  while ((m = re.exec(text)) !== null) {
    if (best === null || m[1].length > best.length) best = m[1];
  }
  return best;
}

/**
 * @param {{ fileName:string, content:string, instruction:string, llm:object }} args
 * @returns {Promise<{content:string, note:string}>}
 */
export async function editLatex({ fileName, content, instruction, llm }) {
  if ((content || '').length > MAX_CHARS) {
    throw new Error(`파일이 너무 큽니다(${content.length}자). ${MAX_CHARS}자 이하만 편집 가능합니다.`);
  }
  const prompt = `당신은 LaTeX 편집 도우미입니다. 사용자의 지시에 따라 아래 LaTeX 파일을 수정하세요.

규칙:
- 수정된 **전체 파일 내용**을 반환합니다(일부만 반환 금지).
- 반드시 하나의 \`\`\`latex 코드블록 안에 전체 파일을 넣습니다.
- 코드블록 **앞에** 무엇을 바꿨는지 한국어 한 줄 요약을 적습니다.
- 컴파일 가능한 유효한 LaTeX를 유지하고, 지시와 무관한 부분은 그대로 둡니다.
- 패키지가 더 필요하면 프리앰블에 추가합니다.

## 파일: ${fileName}
\`\`\`latex
${content}
\`\`\`

## 사용자 지시
${instruction}`;

  const out = await callLLM(prompt, {
    backend: llm.backend,
    model: llm.model,
    reasoningEffort: llm.reasoningEffort,
    timeoutMs: 600_000,
  });

  const edited = extractFenced(out);
  if (edited === null) {
    throw new Error('AI 응답에서 수정된 파일(코드블록)을 찾지 못했습니다.');
  }
  const note = (out.split('```')[0] || '').trim() || '파일을 수정했습니다.';
  return { content: edited.replace(/\s*$/, '') + '\n', note };
}
