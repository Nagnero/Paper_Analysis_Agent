// core/promptStore.js
// 4-agent 파이프라인 프롬프트 로드 및 in-process 메모리 관리.
// prompts/ 디렉토리는 프로젝트 최상위에 있다 (core/ 의 부모).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

const KEYS = [
  'analyst', 'verifier', 'writer', 'orchestrator', 'coreInsight',
  // 분석팀 공용 — 근거 탐색(작성팀에서도 사용)
  'evidence',
  // 논문 작성팀 (본문/그림은 계획→작성→검토 멀티에이전트)
  'writeOrchestrator', 'writePlan', 'writeBody', 'writeFigure', 'writeReview', 'writeCitation', 'writeCompile',
];

/** 디스크에서 기본 프롬프트 읽기 */
export async function loadDefaults() {
  const out = {};
  for (const k of KEYS) {
    out[k] = await readFile(path.join(PROMPTS_DIR, `${k}.md`), 'utf8');
  }
  return out;
}

// 메모리에 현재 프롬프트 보관 (서버 단위 in-process)
let current = null;

export async function getCurrent() {
  if (!current) current = await loadDefaults();
  return { ...current };
}

export function setCurrent(prompts) {
  current = { ...prompts };
}

export async function resetToDefaults() {
  current = await loadDefaults();
  return { ...current };
}

/** 단순 mustache-lite 치환: {{key}} -> value */
export function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    return vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`;
  });
}

/** userEmphasis_block 헬퍼 — emphasis가 있으면 강조 블록, 없으면 빈 문자열 */
export function buildEmphasisBlock(emphasis) {
  if (!emphasis || !emphasis.trim()) return '';
  return `## 사용자가 특별히 강조한 부분\n${emphasis.trim()}\n\n위 강조 사항을 분석에서 우선 다루세요.\n`;
}
