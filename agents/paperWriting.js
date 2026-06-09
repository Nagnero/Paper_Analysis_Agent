// agents/paperWriting.js
// 논문 작성팀: 오케스트레이터가 지시를 분류 → writing/figure/citation 모듈 실행
// → 컴파일 게이트(에러 시 writeCompile 수정 루프). STORM식 계획-우선 + self-reflection.
import { callLLM } from '../core/llm.js';
import * as llmConfig from '../core/llmConfig.js';
import { getCurrent as getPrompts, fillTemplate } from '../core/promptStore.js';
import * as latexProject from '../core/latexProject.js';
import { compileProject } from '../core/latexCompiler.js';
import { findEvidence } from './evidence.js';

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

// 프로젝트의 모든 .tex 내용을 합쳐 반환(근거 탐색용 문서 텍스트)
async function collectProjectText(projectId) {
  const files = (await latexProject.listFiles(projectId)).filter(f => /\.tex$/i.test(f.path));
  let txt = '';
  for (const f of files) {
    try {
      const body = await latexProject.readProjectFile(projectId, f.path);
      txt += `\n% ===== ${f.path} =====\n${body}\n`;
    } catch { /* ignore */ }
  }
  return txt.trim();
}

const MODULE_MAP = {
  writing: { prompt: 'writeBody', role: 'writeBody', type: '본문' },
  figure: { prompt: 'writeFigure', role: 'writeFigure', type: '그림/표' },
  citation: { prompt: 'writeCitation', role: 'writeCitation' },
};

// 작성팀 채팅 기록을 프롬프트용 텍스트로. 최근 8턴, 길면 자른다.
function formatHistory(history) {
  if (!Array.isArray(history) || !history.length) return '(이전 대화 없음)';
  return history.slice(-8).map((h) => {
    const who = (h.c || h.role) === 'user' ? '사용자' : 'AI';
    let t = String(h.text || '').replace(/^[\s🧑🤖🔎✗✓🧭🗺️✍️🔍🔧🎯📊📚]+/u, '').trim();
    if (t.length > 600) t = t.slice(0, 600) + '…';
    return `${who}: ${t}`;
  }).join('\n');
}

// 범위 지정: 지시가 국소적이면 수정할 줄 범위만 찾아 반환(토큰 절약).
// 짧은 파일/모호한 지시/실패 시 'whole' 로 폴백.
const SCOPE_MIN_LINES = 60;
async function locateScope(content, instruction, history = '(이전 대화 없음)') {
  const lines = content.split('\n');
  if (lines.length < SCOPE_MIN_LINES) return { scope: 'whole' };
  const prompts = await getPrompts();
  if (!prompts.scopeLocator) return { scope: 'whole' };
  const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
  const role = llmConfig.getRole('scopeLocator');
  try {
    const out = await callLLM(fillTemplate(prompts.scopeLocator, { numberedContent: numbered, instruction, history }), {
      backend: role.backend, model: role.model, reasoningEffort: role.reasoningEffort, timeoutMs: 120_000,
    });
    const j = JSON.parse(stripFence(out));
    if (j.scope === 'range') {
      const s = parseInt(j.startLine, 10);
      const e = parseInt(j.endLine, 10);
      if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s && e <= lines.length) {
        return { scope: 'range', startLine: s, endLine: e };
      }
    }
  } catch { /* 폴백 */ }
  return { scope: 'whole' };
}

// Planner: 텍스트 계획 반환(코드블록 없음)
async function planStep(moduleType, fileName, content, instruction, history = '(이전 대화 없음)') {
  const prompts = await getPrompts();
  const role = llmConfig.getRole('writePlan');
  const out = await callLLM(fillTemplate(prompts.writePlan, { moduleType, fileName, content, instruction, history }), {
    backend: role.backend, model: role.model, reasoningEffort: role.reasoningEffort, timeoutMs: 180_000,
  });
  return (out || '').trim();
}

// 본문/그림 모듈: 계획 → 작성 → 검토 (멀티에이전트, STORM식)
async function multiAgentEdit({ module, fileName, content, instruction, onStep, history = '(이전 대화 없음)' }) {
  const sel = MODULE_MAP[module];
  onStep({ stage: 'plan', label: '🗺️ 계획 수립 중…' });
  const plan = await planStep(sel.type, fileName, content, instruction, history);
  onStep({ stage: 'write', label: `✍️ ${sel.type} 작성 중…` });
  const draft = await runModule(sel.prompt, sel.role, { fileName, content, instruction, plan, history });
  onStep({ stage: 'review', label: '🔍 검토 중…' });
  const reviewed = await runModule('writeReview', 'writeReview', { fileName, content: draft.content, instruction, plan, history });
  return { content: reviewed.content, note: `[계획→작성→검토] ${reviewed.note}` };
}

/**
 * @param {{ projectId:number, file:string, mainFile:string, instruction:string }} args
 * @returns {Promise<{module:string, note:string, content:string, file:string, compiled:boolean, fixes:number, log:string}>}
 */
export async function runPaperWriting({ projectId, file, mainFile, instruction, history = [], onStep = () => {} }) {
  const content = await latexProject.readProjectFile(projectId, file);
  if (content.length > MAX_CHARS) throw new Error(`파일이 너무 큽니다(${content.length}자, 최대 ${MAX_CHARS}).`);
  const historyText = formatHistory(history);

  // 1) 오케스트레이터: 모듈 분류 + 지시 다듬기 (이전 대화 참고 — "그 부분", "알아서 수정" 해석)
  let module = 'writing';
  let refined = instruction;
  onStep({ stage: 'orchestrate', label: '🧭 지시 분석·모듈 분류 중…' });
  try {
    const prompts = await getPrompts();
    const orchRole = llmConfig.getRole('writeOrchestrator');
    const out = await callLLM(fillTemplate(prompts.writeOrchestrator, { fileName: file, instruction, history: historyText }), {
      backend: orchRole.backend, model: orchRole.model, reasoningEffort: orchRole.reasoningEffort, timeoutMs: 120_000,
    });
    const j = JSON.parse(stripFence(out));
    if (['writing', 'figure', 'citation', 'evidence'].includes(j.module)) module = j.module;
    if (typeof j.refinedInstruction === 'string' && j.refinedInstruction.trim()) refined = j.refinedInstruction.trim();
  } catch { /* 분류 실패 → writing + 원지시 */ }

  const moduleLabel = { writing: '✍️ 본문', figure: '📊 그림/표', citation: '📚 인용', evidence: '🔎 근거 탐색' }[module] || module;
  onStep({ stage: 'route', label: `🧭 ${moduleLabel} 모듈로 처리`, module });

  // 근거 탐색(읽기 전용): 파일 수정·컴파일 없이 프로젝트 .tex에서 답만 찾는다.
  if (module === 'evidence') {
    onStep({ stage: 'evidence', label: '🔎 논문에서 근거 찾는 중…' });
    const docText = await collectProjectText(projectId);
    const answer = await findEvidence({ documentText: docText, question: refined });
    return {
      module, readOnly: true, answer, note: answer, file,
      content, compiled: null, fixes: 0, log: '',
    };
  }

  // 2) 모듈 실행 — 본문/그림은 멀티에이전트(계획→작성→검토), 인용은 단일
  let edit;
  if (module === 'citation') {
    onStep({ stage: 'citation', label: '📚 인용 채우는 중…' });
    const bibKeys = (await collectBibKeys(projectId)).join(', ') || '(없음)';
    edit = await runModule('writeCitation', 'writeCitation', { fileName: file, content, instruction: refined, bibKeys });
  } else {
    // 범위 지정: 특정 부분만 수정하면 그 슬라이스만 보고 작성(토큰 절약)
    const sc = await locateScope(content, refined, historyText);
    if (sc.scope === 'range') {
      onStep({ stage: 'scope', label: `🎯 ${sc.startLine}–${sc.endLine}줄만 수정 (범위 한정)` });
      const lines = content.split('\n');
      const slice = lines.slice(sc.startLine - 1, sc.endLine).join('\n');
      const excerptNote =
        `아래 내용은 더 큰 .tex 파일의 ${sc.startLine}–${sc.endLine}줄 "발췌"입니다. ` +
        `이 발췌 범위만 수정해서 발췌 전체를(수정 반영해) 그대로 반환하세요. ` +
        `프리앰블·\\begin{document}·문서 구조를 새로 추가하지 말고, 발췌 밖은 건드리지 마세요.\n\n${refined}`;
      const ed = await multiAgentEdit({ module, fileName: file, content: slice, instruction: excerptNote, onStep, history: historyText });
      const editedLines = ed.content.replace(/\n+$/, '').split('\n');
      const newLines = [...lines.slice(0, sc.startLine - 1), ...editedLines, ...lines.slice(sc.endLine)];
      edit = { content: newLines.join('\n') + (content.endsWith('\n') ? '\n' : ''), note: `[${sc.startLine}–${sc.endLine}줄] ${ed.note}` };
    } else {
      edit = await multiAgentEdit({ module, fileName: file, content, instruction: refined, onStep, history: historyText });
    }
  }
  await latexProject.writeProjectFile(projectId, file, edit.content);

  // 3) 컴파일 게이트 + 에러 수정 루프
  onStep({ stage: 'compile', label: '🔧 컴파일 중…' });
  let compile = await compileProject(projectId, mainFile, { timeoutMs: 180_000 });
  let fixes = 0;
  let finalContent = edit.content;
  while (!compile.hasPdf && fixes < MAX_COMPILE_FIXES) {
    fixes++;
    onStep({ stage: 'fix', label: `🔧 컴파일 오류 수정 중… (${fixes}회)` });
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
