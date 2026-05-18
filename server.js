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
import { runPipeline } from './pipeline.js';
import { callClaude } from './core/claudeClient.js';
import { getCurrent as getPrompts, setCurrent as setPrompts, loadDefaults as loadDefaultPrompts } from './core/promptStore.js';

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

async function runAndStream(pdfPath, res, emphasis) {
  try {
    const { report, parsed, sessionId, paperText, analyst, verifiedClaims, metrics, directive, auditResults } =
      await runPipeline(pdfPath, p => sseWrite(res, p), { emphasis });
    gcSessions();
    sessions.set(sessionId, {
      createdAt: new Date(),
      paperTitle: parsed.title,
      paperText,
      report,
      chatStarted: false,
    });
    sseWrite(res, { stage: 'done', message: '완료', report, sessionId, analyst, verifiedClaims, metrics, directive, auditResults });
  } catch (err) {
    sseWrite(res, { stage: 'error', message: `실패: ${err.message}` });
  }
}

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

  const { sessionId, question, persona } = payload;
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

  const personaInstruction = persona === 'adversarial'
    ? `당신은 학회 리뷰어입니다. 답변할 때 다음 원칙을 따르세요:
1. 사용자의 질문에 사실에 입각해 답하세요.
2. 답변 끝에 항상 회의적인 시각으로 도전 질문 1개를 추가하세요 ("그런데 X 가정이 깨지면?", "이 결론은 Y 조건에서도 성립하는가?" 등).
3. 논문이 명시하지 않은 부분에 추측을 더할 때는 명확히 "추측: ..."이라고 표시하세요.`
    : '';

  let promptText;
  let callOpts;
  if (!sess.chatStarted) {
    promptText = `다음 영어 논문과 한국어 분석 리포트를 참고해 사용자 질문에 답하세요.

## 논문 원문 (요약본)
${sess.paperText ?? ''}

## 한국어 분석 리포트
${sess.report ?? ''}

--- 위는 컨텍스트 ---

${personaInstruction}

사용자 질문: ${question}`;
    callOpts = { sessionId, timeoutMs: 600_000 };
  } else {
    promptText = personaInstruction
      ? `${personaInstruction}\n사용자 질문: ${question}`
      : question;
    callOpts = { resume: sessionId, timeoutMs: 600_000 };
  }

  try {
    const answer = await callClaude(promptText, callOpts);
    sess.chatStarted = true;
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
  await runAndStream(pdfPath, res, emphasis);
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
  startSse(res);

  const filename = safeUploadName(req);
  const emphasis = readEmphasisHeader(req);
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
    await runAndStream(tempPath, res, emphasis);
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

async function handleStatic(req, res) {
  const entry = STATIC[req.url];
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

function createAppServer() {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/analyze') {
      handleAnalyze(req, res);
    } else if (req.method === 'POST' && req.url === '/chat') {
      handleChat(req, res);
    } else if (req.method === 'GET' && req.url === '/api/prompts') {
      handlePromptsGet(req, res);
    } else if (req.method === 'GET' && req.url === '/api/prompts/defaults') {
      handlePromptsDefaultsGet(req, res);
    } else if (req.method === 'PUT' && req.url === '/api/prompts') {
      handlePromptsPut(req, res);
    } else if (req.method === 'GET') {
      handleStatic(req, res);
    } else {
      res.writeHead(405);
      res.end();
    }
  });
}

// Electron(또는 다른 호스트)에서 import해서 호출. port=0 이면 OS가 빈 포트 할당.
export function startServer({ host = HOST, port = PORT } = {}) {
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
    console.log(`▶ http://${host}:${port} 에서 열어주세요`);
  }).catch(err => {
    console.error('서버 시작 실패:', err.message);
    process.exit(1);
  });
}
