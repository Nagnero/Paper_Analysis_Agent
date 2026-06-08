// agents/paperWriting.js
// 논문 작성팀: 오케스트레이터가 지시를 분류 → writing/figure/citation 모듈 실행
// → 컴파일 게이트(에러 시 writeCompile 수정 루프). STORM식 계획-우선 + self-reflection.
import { callLLM } from '../core/llm.js';
import * as llmConfig from '../core/llmConfig.js';
import { getCurrent as getPrompts, fillTemplate } from '../core/promptStore.js';
import * as latexProject from '../core/latexProject.js';
import { compileProject } from '../core/latexCompiler.js';

const MAX_CHARS = 80000;
const MAX_COMPILE_FIXES = 2;

// 가장 큰 코드펜스 블록 추출(수정된 전체 파일)
function extractFenced(text) {
  const re = /```[a-zA-Z]*\n?([\s\S]*?)```/g;
  let m, best = null;
  while ((m = re.exec(text)) !== null) {
    if (best === null || m[1].length > best.length) best = m[1];
  }
  return best;
}

function stripFence(text) {
  const f = extractFenced(text);
  return f !== null ? f : text;
}

// 모듈 1회 실행: 프롬프트 채우고 LLM 호출 → {content, note}
async function runModule(promptKey, roleName, vars) {
  const prompts = await getPrompts();
  const tpl = prompts[promptKey];
  if (!tpl) throw new Error(`프롬프트 없음: ${promptKey}`);
  const role = llmConfig.getRole(roleName);
  const out = await callLLM(fillTemplate(tpl, vars), {
    backend: role.backend, model: role.model, reasoningEffort: role.reasoningEffort, timeoutMs: 600_000,
  });
  const edited = extractFenced(out);
  if (edited === null) throw new Error('AI 응답에서 코드블록(수정된 파일)을 찾지 못했습니다.');
  const note = (out.split('```')[0] || '').trim() || '수정 완료';
  return { content: edited.replace(/\s*$/, '') + '\n', note };
}

// src 내 .bib 파일들에서 인용 키 수집
async function collectBibKeys(projectId) {
  const files = (await latexProject.listFiles(projectId)).filter(f => /\.bib$/i.test(f.path));
  const keys = [];
  for (const f of files) {
    try {
      const txt = await latexProject.readProjectFile(projectId, f.path);
      for (const m of txt.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)) keys.push(m[1]);
    } catch { /* ignore */ }
  }
  return [...new Set(keys)];
}

const MODULE_MAP = {
  writing: { prompt: 'writeBody', role: 'writeBody' },
  figure: { prompt: 'writeFigure', role: 'writeFigure' },
  citation: { prompt: 'writeCitation', role: 'writeCitation' },
};

/**
 * @param {{ projectId:number, file:string, mainFile:string, instruction:string }} args
 * @returns {Promise<{module:string, note:string, content:string, file:string, compiled:boolean, fixes:number, log:string}>}
 */
export async function runPaperWriting({ projectId, file, mainFile, instruction }) {
  const content = await latexProject.readProjectFile(projectId, file);
  if (content.length > MAX_CHARS) throw new Error(`파일이 너무 큽니다(${content.length}자, 최대 ${MAX_CHARS}).`);

  // 1) 오케스트레이터: 모듈 분류 + 지시 다듬기
  let module = 'writing';
  let refined = instruction;
  try {
    const prompts = await getPrompts();
    const orchRole = llmConfig.getRole('writeOrchestrator');
    const out = await callLLM(fillTemplate(prompts.writeOrchestrator, { fileName: file, instruction }), {
      backend: orchRole.backend, model: orchRole.model, reasoningEffort: orchRole.reasoningEffort, timeoutMs: 120_000,
    });
    const j = JSON.parse(stripFence(out));
    if (['writing', 'figure', 'citation'].includes(j.module)) module = j.module;
    if (typeof j.refinedInstruction === 'string' && j.refinedInstruction.trim()) refined = j.refinedInstruction.trim();
  } catch { /* 분류 실패 → writing + 원지시 */ }

  // 2) 모듈 실행
  const sel = MODULE_MAP[module] || MODULE_MAP.writing;
  const vars = { fileName: file, content, instruction: refined };
  if (module === 'citation') vars.bibKeys = (await collectBibKeys(projectId)).join(', ') || '(없음)';
  const edit = await runModule(sel.prompt, sel.role, vars);
  await latexProject.writeProjectFile(projectId, file, edit.content);

  // 3) 컴파일 게이트 + 에러 수정 루프
  let compile = await compileProject(projectId, mainFile, { timeoutMs: 180_000 });
  let fixes = 0;
  let finalContent = edit.content;
  while (!compile.hasPdf && fixes < MAX_COMPILE_FIXES) {
    fixes++;
    const cur = await latexProject.readProjectFile(projectId, file);
    const logTail = (compile.log || '').split('\n').slice(-60).join('\n');
    let fix;
    try {
      fix = await runModule('writeCompile', 'writeCompile', { fileName: file, content: cur, log: logTail });
    } catch { break; }
    await latexProject.writeProjectFile(projectId, file, fix.content);
    finalContent = fix.content;
    compile = await compileProject(projectId, mainFile, { timeoutMs: 180_000 });
  }

  let note = edit.note;
  if (fixes > 0) note += compile.hasPdf ? ` (컴파일 오류 ${fixes}회 자동 수정)` : ` (컴파일 오류 자동 수정 ${fixes}회 시도했으나 실패 — 로그 확인)`;

  return {
    module,
    note,
    content: finalContent,
    file,
    compiled: compile.hasPdf,
    fixes,
    log: (compile.log || '').slice(-8000),
  };
}
