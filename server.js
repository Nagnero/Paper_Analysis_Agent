// server.js
// Node 내장 모듈만으로 SSE 기반 분석 콘솔 서버.
// 실행: node server.js  →  http://localhost:8788
// Electron 에서는 startServer({ port: 0 }) 호출로 임의 포트에 부트.
import http from 'node:http';
import fs from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runPipeline } from './pipeline.js';
import { checkAuthStatus } from './core/claudeClient.js';
import { callLLM } from './core/llm.js';
import { getCurrent as getPrompts, setCurrent as setPrompts, loadDefaults as loadDefaultPrompts } from './core/promptStore.js';
import * as llmConfig from './core/llmConfig.js';
import * as authStatus from './core/authStatus.js';
import * as library from './core/library.js';
import * as fileManager from './core/fileManager.js';
import { parsePdf } from './utils/parsePdf.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000;
const sessions = new Map();

function gcSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt.getTime() > SESSION_TTL_MS) sessions.delete(id);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8788;
const HOST = '127.0.0.1';

const STATIC = {
  '/': { file: 'public/index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'public/app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'public/app.js', type: 'application/javascript; charset=utf-8' },
  '/pdfViewer.js': { file: 'public/pdfViewer.js', type: 'application/javascript; charset=utf-8' },
  '/setup': { file: 'public/setup.html', type: 'text/html; charset=utf-8' },
};

// /vendor/* 정적 서빙 (PDF.js 번들 등). 확장자별 MIME + 경로 탐색 차단.
const VENDOR_DIR = path.join(__dirname, 'public', 'vendor');
const VENDOR_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

async function runAndStream(pdfPath, res, emphasis, sourceFile, { copyPdfMode = false } = {}) {
  try {
    const auth = await authStatus.checkAll();
    llmConfig.applyAvailability(auth);
    const required = collectAnalysisBackends(emphasis);
    const missing = missingLoginBackend(auth, required);
    if (missing) {
      sseWrite(res, { stage: 'error', message: `분석 실패: ${missing}에 로그인이 필요합니다. 설정에서 다른 백엔드로 바꾸거나 로그인하세요.` });
      return;
    }
    const { report, parsed, sessionId, paperText, analyst, verifiedClaims, metrics, directive, auditResults, paperId, analysisId } =
      await runPipeline(pdfPath, p => sseWrite(res, p), { emphasis, sourceFile, copyPdfMode, llmConfigSnapshot: llmConfig.getConfig() });
    gcSessions();
    sessions.set(sessionId, {
      createdAt: new Date(),
      paperTitle: parsed.title,
      paperText,
      report,
      chatStartedByBackend: { claude: false, codex: false },
    });
    sseWrite(res, { stage: 'done', message: '완료', report, sessionId, analyst, verifiedClaims, metrics, directive, auditResults, paperId, analysisId });
  } catch (err) {
    sseWrite(res, { stage: 'error', message: `실패: ${err.message}` });
  }
}

// 분석 파이프라인이 실제 호출할 backend 집합을 반환.
// emphasis 가 비어있으면 orchestrator/audit 는 호출되지 않음(pipeline 동작과 일치).
function collectAnalysisBackends(emphasis) {
  const cfg = llmConfig.getConfig();
  const roles = ['analyst', 'verifier', 'writer'];
  if (emphasis && emphasis.trim()) {
    roles.unshift('orchestrator');
    roles.push('audit');
  }
  const backends = new Set();
  for (const r of roles) {
    const role = cfg[r];
    if (role && role.backend) backends.add(role.backend);
  }
  return [...backends];
}

function missingLoginBackend(authResult, backends) {
  for (const b of backends) {
    const entry = authResult[b];
    if (!entry || !entry.loggedIn) return b;
  }
  return null;
}

// === 라이브러리 API ===

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  return JSON.parse(body);
}

async function handleLibraryTree(req, res) {
  try {
    const tree = await library.getTree();
    jsonResponse(res, 200, tree);
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
}

async function handleLibraryCreateFolder(req, res) {
  try {
    const body = await readJsonBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonResponse(res, 400, { error: 'name required' });
    const row = await library.createFolder(name);
    jsonResponse(res, 200, row);
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
}

async function handleLibraryUpdateFolder(req, res, id) {
  try {
    const body = await readJsonBody(req);
    const fields = {};
    if (typeof body.name === 'string') fields.name = body.name.trim();
    if (typeof body.sort_order === 'number') fields.sort_order = body.sort_order;
    const row = await library.updateFolder(id, fields);
    if (!row) return jsonResponse(res, 404, { error: 'folder not found' });
    jsonResponse(res, 200, row);
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
}

async function handleLibraryDeleteFolder(req, res, id) {
  try {
    const ok = await library.deleteFolder(id);
    if (!ok) return jsonResponse(res, 404, { error: 'folder not found' });
    jsonResponse(res, 200, { ok: true });
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
}

async function handleLibraryGetPaper(req, res, id) {
  try {
    const paper = await library.getPaper(id);
    if (!paper) return jsonResponse(res, 404, { error: 'paper not found' });
    const latest = await library.getLatestAnalysis(paper.id);
    let analysis = null;
    let chats = [];
    if (latest) {
      const files = await fileManager.readAnalysisFiles(paper.id, latest.id);
      analysis = {
        id: latest.id,
        created_at: latest.created_at,
        duration_ms: latest.duration_ms,
        config_snapshot: latest.config_snapshot,
        report: files.report,
        claims: files.claims,
        metrics: files.metrics,
        directive: files.metrics?.directive ?? null,
        auditResults: files.metrics?.auditResults ?? [],
      };
      chats = await library.listChats(latest.id);
    }
    jsonResponse(res, 200, { paper, analysis, chats });
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
}

async function handleLibraryGetPaperPdf(req, res, id) {
  try {
    const paper = await library.getPaper(id);
    if (!paper) return jsonResponse(res, 404, { error: 'paper not found' });
    // 경로는 숫자 id에서만 파생되므로 경로 탐색(traversal) 위험이 없다.
    const pdfPath = fileManager.paperSourcePath(paper.id);
    let stat;
    try {
      stat = await fs.promises.stat(pdfPath);
    } catch {
      return jsonResponse(res, 404, { error: 'pdf not found' });
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="paper-${paper.id}.pdf"`,
      'Cache-Control': 'no-cache',
    });
    const stream = fs.createReadStream(pdfPath);
    stream.on('error', () => { if (!res.writableEnded) res.end(); });
    stream.pipe(res);
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
}

async function handleLibraryUpdatePaper(req, res, id) {
  try {
    const body = await readJsonBody(req);
    const fields = {};
    if (typeof body.title === 'string') fields.title = body.title.trim();
    if ('folderId' in body) {
      const f = body.folderId;
      fields.folderId = (f == null) ? null : Number(f);
    }
    const row = await library.updatePaper(id, fields);
    if (!row) return jsonResponse(res, 404, { error: 'paper not found' });
    jsonResponse(res, 200, row);
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
}

async function handleLibraryReset(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('confirm') !== 'yes') {
    return jsonResponse(res, 400, { error: '?confirm=yes 필요' });
  }
  try {
    await library.deleteAll();
    await fileManager.deleteAllPapers();
    jsonResponse(res, 200, { ok: true });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

async function handleLibraryDeletePaper(req, res, id) {
  try {
    const ok = await library.deletePaper(id);
    if (!ok) return jsonResponse(res, 404, { error: 'paper not found' });
    jsonResponse(res, 200, { ok: true });
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
}

async function handleLibraryPaperChat(req, res, paperId) {
  try {
    const body = await readJsonBody(req);
    const question = typeof body.question === 'string' ? body.question : '';
    if (!question.trim()) return jsonResponse(res, 400, { error: 'question required' });
    if (question.length > 8000) return jsonResponse(res, 413, { error: '질문이 너무 깁니다 (최대 8000자).' });

    const paper = await library.getPaper(paperId);
    if (!paper) return jsonResponse(res, 404, { error: 'paper not found' });
    const latest = await library.getLatestAnalysis(paper.id);
    if (!latest) return jsonResponse(res, 400, { error: '저장된 분석이 없습니다.' });

    // 인증 게이트
    const auth = await authStatus.checkAll();
    llmConfig.applyAvailability(auth);
    const chatCfg = llmConfig.getRole('chat');
    const chatEntry = auth[chatCfg.backend];
    if (!chatEntry || !chatEntry.loggedIn) {
      return jsonResponse(res, 401, { error: `${chatCfg.backend}에 로그인이 필요합니다. 설정에서 다른 백엔드로 바꾸거나 로그인하세요.` });
    }

    // paperText 캐시 우선, 없으면 PDF 재파싱 fallback
    let paperText = await fileManager.readPaperText(paper.id);
    if (!paperText) {
      const pdfPath = paper.pdf_path || fileManager.paperSourcePath(paper.id);
      const parsed = await parsePdf(pdfPath);
      paperText = parsed.fullText;
      await fileManager.writePaperText(paper.id, paperText).catch(() => {});
    }
    const files = await fileManager.readAnalysisFiles(paper.id, latest.id);

    const promptText = `다음 영어 논문과 한국어 분석 리포트를 참고해 사용자 질문에 답하세요.

## 논문 원문 (요약본)
${paperText ?? ''}

## 한국어 분석 리포트
${files.report ?? ''}

--- 위는 컨텍스트 ---

사용자 질문: ${question}`;

    const callOpts = {
      backend: chatCfg.backend,
      model: chatCfg.model,
      reasoningEffort: chatCfg.reasoningEffort,
      timeoutMs: 600_000,
    };
    const answer = await callLLM(promptText, callOpts);

    const modelTag = `${chatCfg.backend}${chatCfg.model ? '/' + chatCfg.model : ''}`;
    const { user: userRow, assistant: assistantRow } = await library.appendChatTurn(latest.id, question, answer, modelTag);
    jsonResponse(res, 200, { answer, chats: [userRow, assistantRow] });
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
}

// === /chat (deprecated v0.3 — 사이드바 UI로 이전 후 제거 예정) ===
async function handleChat(req, res) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const { sessionId, question } = payload;
  if (typeof sessionId !== 'string' || !sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'sessionId required' }));
    return;
  }
  if (typeof question !== 'string' || question.trim() === '') {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'question required' }));
    return;
  }
  if (question.length > 8000) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '질문이 너무 깁니다 (최대 8000자).' }));
    return;
  }

  gcSessions();
  const sess = sessions.get(sessionId);
  if (!sess) {
    res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '세션이 만료되었거나 존재하지 않습니다. 분석을 다시 실행하세요.' }));
    return;
  }

  const chatAuth = await authStatus.checkAll();
  llmConfig.applyAvailability(chatAuth);
  const chatCfg = llmConfig.getRole('chat');
  const chatEntry = chatAuth[chatCfg.backend];
  if (!chatEntry || !chatEntry.loggedIn) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `${chatCfg.backend}에 로그인이 필요합니다. 설정에서 다른 백엔드로 바꾸거나 로그인하세요.` }));
    return;
  }
  // codex 백엔드는 세션 미지원 → 매번 paperText+report 포함한 fresh 프롬프트 사용
  const useFreshPrompt = chatCfg.backend === 'codex' || !sess.chatStartedByBackend[chatCfg.backend];

  let promptText;
  let callOpts;
  if (useFreshPrompt) {
    promptText = `다음 영어 논문과 한국어 분석 리포트를 참고해 사용자 질문에 답하세요.

## 논문 원문 (요약본)
${sess.paperText ?? ''}

## 한국어 분석 리포트
${sess.report ?? ''}

--- 위는 컨텍스트 ---

사용자 질문: ${question}`;
    callOpts = {
      backend: chatCfg.backend,
      model: chatCfg.model,
      reasoningEffort: chatCfg.reasoningEffort,
      timeoutMs: 600_000,
    };
    if (chatCfg.backend !== 'codex') callOpts.sessionId = sessionId;
  } else {
    promptText = question;
    callOpts = {
      backend: chatCfg.backend,
      model: chatCfg.model,
      reasoningEffort: chatCfg.reasoningEffort,
      resume: sessionId,
      timeoutMs: 600_000,
    };
  }

  try {
    const answer = await callLLM(promptText, callOpts);
    if (chatCfg.backend !== 'codex') sess.chatStartedByBackend[chatCfg.backend] = true;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ answer }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleJsonAnalyze(req, res) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;

  let parsedBody;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }
  const pdfPath = parsedBody.pdfPath;
  const emphasis = typeof parsedBody.emphasis === 'string' ? parsedBody.emphasis : '';
  if (!pdfPath || typeof pdfPath !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'pdfPath required' }));
    return;
  }

  startSse(res);
  // JSON 모드: 사용자가 경로를 직접 지정 — 원본 보존을 위해 copy
  await runAndStream(pdfPath, res, emphasis, path.basename(pdfPath), { copyPdfMode: true });
  res.end();
}

function safeUploadName(req) {
  const raw = req.headers['x-filename'];
  if (!raw || typeof raw !== 'string') return 'upload.pdf';
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return 'upload.pdf';
  }
  const base = path.basename(decoded);
  if (!base || base === '.' || base === '..') return 'upload.pdf';
  return base;
}

async function receiveUpload(req, tempPath) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tempPath);
    let received = 0;
    let aborted = false;

    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      req.unpipe(ws);
      ws.destroy();
      req.destroy();
      reject(err);
    };

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        fail(new Error(`업로드 크기가 50MB를 초과했습니다.`));
      }
    });
    req.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => {
      if (!aborted) resolve();
    });

    req.pipe(ws);
  });
}

function readEmphasisHeader(req) {
  const raw = req.headers['x-emphasis'];
  if (!raw || typeof raw !== 'string') return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

async function handleRawAnalyze(req, res) {
  const filename = safeUploadName(req);
  const emphasis = readEmphasisHeader(req);

  // preflight: 업로드(최대 50MB) 받기 전에 인증 게이트 검사 → 헛수고 방지
  const preAuth = await authStatus.checkAll();
  llmConfig.applyAvailability(preAuth);
  const requiredBackends = collectAnalysisBackends(emphasis);
  const preMissing = missingLoginBackend(preAuth, requiredBackends);
  if (preMissing) {
    startSse(res);
    sseWrite(res, { stage: 'error', message: `분석 실패: ${preMissing}에 로그인이 필요합니다. 설정에서 다른 백엔드로 바꾸거나 터미널에서 ${preMissing} 로그인 후 다시 시도하세요.` });
    res.end();
    return;
  }

  startSse(res);

  let tempDir;
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kpac-'));
  } catch (err) {
    sseWrite(res, { stage: 'error', message: `임시 디렉토리 생성 실패: ${err.message}` });
    res.end();
    return;
  }
  const tempPath = path.join(tempDir, filename);

  try {
    try {
      await receiveUpload(req, tempPath);
    } catch (err) {
      sseWrite(res, { stage: 'error', message: err.message });
      return;
    }
    await runAndStream(tempPath, res, emphasis, filename);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    res.end();
  }
}

async function handlePromptsGet(req, res) {
  try {
    const prompts = await getPrompts();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(prompts));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handlePromptsDefaultsGet(req, res) {
  try {
    const prompts = await loadDefaultPrompts();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(prompts));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handlePromptsPut(req, res) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }
  if (!payload || typeof payload !== 'object') {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'JSON object required' }));
    return;
  }
  const current = await getPrompts();
  const next = { ...current };
  for (const k of ['analyst', 'verifier', 'writer', 'orchestrator']) {
    if (k in payload) {
      if (typeof payload[k] !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${k} must be string` }));
        return;
      }
      next[k] = payload[k];
    }
  }
  setPrompts(next);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(next));
}

async function handleLlmConfigGet(req, res) {
  const s = await authStatus.checkAll();
  llmConfig.applyAvailability(s);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(llmConfig.getConfig()));
}

async function handleLlmConfigDefaultsGet(req, res) {
  const s = await authStatus.checkAll();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(llmConfig.getDefaults(s)));
}

async function handleLlmConfigPut(req, res) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }
  if (!payload || typeof payload !== 'object') {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'JSON object required' }));
    return;
  }
  for (const role of llmConfig.ROLES) {
    if (role in payload) {
      const entry = payload[role];
      if (!entry || typeof entry !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${role} must be object` }));
        return;
      }
      if (entry.backend !== undefined && entry.backend !== 'claude' && entry.backend !== 'codex') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${role}.backend must be 'claude' or 'codex'` }));
        return;
      }
      if (entry.model !== undefined && typeof entry.model !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${role}.model must be string` }));
        return;
      }
      if (entry.reasoningEffort !== undefined && typeof entry.reasoningEffort !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${role}.reasoningEffort must be string` }));
        return;
      }
      if (entry.reasoningEffort !== undefined && entry.reasoningEffort !== '' && !llmConfig.isReasoningEffort(entry.reasoningEffort)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${role}.reasoningEffort must be one of ${llmConfig.REASONING_EFFORTS.join(', ')}` }));
        return;
      }
    }
  }
  const next = llmConfig.setConfig(payload);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(next));
}

async function handleAnalyze(req, res) {
  const ctype = (req.headers['content-type'] || '').toLowerCase();
  if (ctype.startsWith('application/pdf') || ctype.startsWith('application/octet-stream')) {
    await handleRawAnalyze(req, res);
    return;
  }
  if (ctype.startsWith('application/json')) {
    await handleJsonAnalyze(req, res);
    return;
  }
  res.writeHead(415, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unsupported content-type' }));
}

async function handleAuthStatusGet(req, res) {
  try {
    const s = await authStatus.checkAll();
    llmConfig.applyAvailability(s);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(s));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleAuthStatusRefresh(req, res) {
  try {
    authStatus.invalidateCache();
    const s = await authStatus.checkAll(true);
    llmConfig.applyAvailability(s);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(s));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleClaudeStatus(req, res) {
  try {
    const status = await checkAuthStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(status));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ binary: false, authenticated: false, errorMessage: err.message }));
  }
}

// 새 터미널 창을 띄워 `claude auth login` 실행 — 사용자가 그 안에서 OAuth 진행.
async function handleClaudeLogin(req, res) {
  try {
    if (process.platform === 'win32') {
      // 새 cmd 창 + claude auth login. /k 로 명령 끝난 후 창 유지.
      spawn('cmd', ['/c', 'start', '', 'cmd', '/k', 'claude auth login'], { detached: true, shell: false });
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', 'tell application "Terminal" to do script "claude auth login"'], { detached: true });
    } else {
      // Linux: 흔한 터미널 후보들 순차 시도
      const candidates = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];
      for (const term of candidates) {
        try {
          spawn(term, ['-e', 'claude auth login'], { detached: true });
          break;
        } catch { /* 다음 후보 */ }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

async function handleStatic(req, res) {
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    pathname = req.url || '/';
  }
  const entry = STATIC[pathname];
  if (!entry) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  try {
    const data = await readFile(path.join(__dirname, entry.file));
    res.writeHead(200, { 'Content-Type': entry.type });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end('Static read error');
  }
}

async function handleVendorStatic(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  const rel = decodeURIComponent(pathname.replace(/^\/vendor\//, ''));
  const filePath = path.join(VENDOR_DIR, rel);
  // 경로 탐색 차단: 해석된 경로가 VENDOR_DIR 하위인지 확인.
  if (!filePath.startsWith(VENDOR_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const type = VENDOR_TYPES[path.extname(filePath).toLowerCase()];
  if (!type) { res.writeHead(404); res.end('Not Found'); return; }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}

// /api/library/papers/:id, /:id/chat, /:id/pdf, /api/library/folders/:id 매칭
function matchLibraryRoute(method, url) {
  const m = url.match(/^\/api\/library\/(folders|papers)\/(\d+)(\/chat|\/pdf)?$/);
  if (!m) return null;
  return { kind: m[1], id: Number(m[2]), sub: m[3] || '', method };
}

function createAppServer() {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/analyze') {
      handleAnalyze(req, res);
    } else if (req.method === 'POST' && req.url === '/chat') {
      handleChat(req, res);
    } else if (req.method === 'GET' && req.url === '/api/library/tree') {
      handleLibraryTree(req, res);
    } else if (req.method === 'DELETE' && req.url && (req.url === '/api/library' || req.url.startsWith('/api/library?'))) {
      handleLibraryReset(req, res);
    } else if (req.method === 'POST' && req.url === '/api/library/folders') {
      handleLibraryCreateFolder(req, res);
    } else if (req.url && req.url.startsWith('/api/library/')) {
      const m = matchLibraryRoute(req.method, req.url);
      if (!m) { res.writeHead(404); res.end(); return; }
      if (m.kind === 'folders' && m.method === 'PATCH') return handleLibraryUpdateFolder(req, res, m.id);
      if (m.kind === 'folders' && m.method === 'DELETE') return handleLibraryDeleteFolder(req, res, m.id);
      if (m.kind === 'papers' && m.sub === '/chat' && m.method === 'POST') return handleLibraryPaperChat(req, res, m.id);
      if (m.kind === 'papers' && m.sub === '/pdf' && m.method === 'GET') return handleLibraryGetPaperPdf(req, res, m.id);
      if (m.kind === 'papers' && m.method === 'GET') return handleLibraryGetPaper(req, res, m.id);
      if (m.kind === 'papers' && m.method === 'PATCH') return handleLibraryUpdatePaper(req, res, m.id);
      if (m.kind === 'papers' && m.method === 'DELETE') return handleLibraryDeletePaper(req, res, m.id);
      res.writeHead(405); res.end();
    } else if (req.method === 'GET' && req.url === '/api/prompts') {
      handlePromptsGet(req, res);
    } else if (req.method === 'GET' && req.url === '/api/prompts/defaults') {
      handlePromptsDefaultsGet(req, res);
    } else if (req.method === 'PUT' && req.url === '/api/prompts') {
      handlePromptsPut(req, res);
    } else if (req.method === 'GET' && req.url === '/api/llm-config') {
      handleLlmConfigGet(req, res);
    } else if (req.method === 'GET' && req.url === '/api/llm-config/defaults') {
      handleLlmConfigDefaultsGet(req, res);
    } else if (req.method === 'PUT' && req.url === '/api/llm-config') {
      handleLlmConfigPut(req, res);
    } else if (req.method === 'GET' && req.url === '/api/auth-status') {
      handleAuthStatusGet(req, res);
    } else if (req.method === 'POST' && req.url === '/api/auth-status/refresh') {
      handleAuthStatusRefresh(req, res);
    } else if (req.method === 'GET' && req.url === '/api/claude-status') {
      handleClaudeStatus(req, res);
    } else if (req.method === 'POST' && req.url === '/api/claude-login') {
      handleClaudeLogin(req, res);
    } else if (req.method === 'GET' && req.url && req.url.startsWith('/vendor/')) {
      handleVendorStatic(req, res);
    } else if (req.method === 'GET') {
      handleStatic(req, res);
    } else {
      res.writeHead(405);
      res.end();
    }
  });
}

// Electron(또는 다른 호스트)에서 import해서 호출. port=0 이면 OS가 빈 포트 할당.
export async function startServer({ host = HOST, port = PORT } = {}) {
  await library.init();
  console.log(`[paa] library: ${library.getBackend()} (${fileManager.userDataDir()})`);
  return new Promise((resolve, reject) => {
    const server = createAppServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, host: addr.address, port: addr.port });
    });
  });
}

// 직접 실행 (node server.js) 시에만 자동 listen
const isMain = path.basename(process.argv[1] ?? '') === 'server.js';
if (isMain) {
  startServer().then(({ host, port }) => {
    console.log(`[paa] listening on http://${host}:${port}`);
  }).catch(err => {
    console.error('[paa] server start failed:', err.message);
    process.exit(1);
  });
}
