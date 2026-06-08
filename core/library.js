// core/library.js
// 영구 라이브러리: SQLite(better-sqlite3) 기본, 실패 시 JSON 폴백.
// 두 백엔드 모두 같은 비동기 인터페이스 export.
import fs from 'node:fs/promises';
import { libraryDbPath, libraryJsonPath, userDataDir, ensureDir, deletePaperDir, deleteProjectDir, deleteAllProjects } from './fileManager.js';

let backend = null;  // 'sqlite' | 'json'
let db = null;       // sqlite instance OR { data, save() }
let initPromise = null;

async function initSqlite() {
  const { default: Database } = await import('better-sqlite3');
  await ensureDir(userDataDir());
  db = new Database(libraryDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      authors TEXT,
      year INTEGER,
      source_file TEXT NOT NULL,
      pdf_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      duration_ms INTEGER,
      config_snapshot TEXT,
      report_path TEXT NOT NULL,
      metrics_path TEXT NOT NULL,
      claims_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model_used TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      main_file TEXT NOT NULL,
      source_zip TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_papers_folder ON papers(folder_id);
    CREATE INDEX IF NOT EXISTS idx_analyses_paper ON analyses(paper_id);
    CREATE INDEX IF NOT EXISTS idx_chats_analysis ON chats(analysis_id);
    CREATE INDEX IF NOT EXISTS idx_projects_folder ON projects(folder_id);
  `);
  backend = 'sqlite';
}

async function initJson() {
  await ensureDir(userDataDir());
  const file = libraryJsonPath();
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    data = { folders: [], papers: [], analyses: [], chats: [], projects: [], counter: { folders: 0, papers: 0, analyses: 0, chats: 0, projects: 0 } };
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  }
  data.counter = data.counter || { folders: 0, papers: 0, analyses: 0, chats: 0, projects: 0 };
  for (const k of ['folders','papers','analyses','chats','projects']) {
    data[k] = data[k] || [];
    const maxId = data[k].reduce((m, x) => Math.max(m, x.id || 0), 0);
    data.counter[k] = Math.max(data.counter[k] || 0, maxId);
  }
  const save = async () => {
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  };
  db = { data, save };
  backend = 'json';
}

export async function init() {
  if (backend) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await initSqlite();
    } catch (e) {
      // native bindings 로드 실패만 폴백 — SQL 에러 등은 그대로 throw
      const msg = (e.message || '').toLowerCase();
      const code = e.code || '';
      const isBindingError = code === 'MODULE_NOT_FOUND'
        || code === 'ERR_DLOPEN_FAILED'
        || msg.includes('could not locate the bindings')
        || msg.includes('node_module_version')
        || msg.includes('was compiled against a different node.js version');
      if (!isBindingError) throw e;
      console.warn('[library] SQLite native bindings failed to load -> JSON fallback:', e.message);
      await initJson();
    }
  })().finally(() => { initPromise = null; });
  return initPromise;
}

export function getBackend() {
  return backend;
}

// ===== 폴더 =====

export async function createFolder(name) {
  await init();
  const now = new Date().toISOString();
  if (backend === 'sqlite') {
    const info = db.prepare('INSERT INTO folders (name, sort_order, created_at) VALUES (?, 0, ?)').run(name, now);
    return { id: info.lastInsertRowid, name, sort_order: 0, created_at: now };
  } else {
    const id = ++db.data.counter.folders;
    const row = { id, name, sort_order: 0, created_at: now };
    db.data.folders.push(row);
    await db.save();
    return row;
  }
}

export async function listFolders() {
  await init();
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM folders ORDER BY sort_order ASC, created_at DESC').all();
  } else {
    return [...db.data.folders].sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  }
}

export async function renameFolder(id, name) {
  await init();
  if (backend === 'sqlite') {
    const info = db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id);
    if (info.changes === 0) return null;
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  } else {
    const row = db.data.folders.find(f => f.id === Number(id));
    if (!row) return null;
    row.name = name;
    await db.save();
    return row;
  }
}

export async function updateFolder(id, fields) {
  await init();
  const sets = [];
  const vals = [];
  if (typeof fields.name === 'string') { sets.push('name = ?'); vals.push(fields.name); }
  if (typeof fields.sort_order === 'number') { sets.push('sort_order = ?'); vals.push(fields.sort_order); }
  if (sets.length === 0) {
    return await getFolder(id);
  }
  if (backend === 'sqlite') {
    vals.push(Number(id));
    const info = db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (info.changes === 0) return null;
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  } else {
    const row = db.data.folders.find(f => f.id === Number(id));
    if (!row) return null;
    if (typeof fields.name === 'string') row.name = fields.name;
    if (typeof fields.sort_order === 'number') row.sort_order = fields.sort_order;
    await db.save();
    return row;
  }
}

async function getFolder(id) {
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id) || null;
  } else {
    return db.data.folders.find(f => f.id === Number(id)) || null;
  }
}

export async function deleteFolder(id) {
  await init();
  if (backend === 'sqlite') {
    // ON DELETE SET NULL 이 papers.folder_id 자동 처리
    const info = db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    return info.changes > 0;
  } else {
    const idx = db.data.folders.findIndex(f => f.id === Number(id));
    if (idx === -1) return false;
    db.data.folders.splice(idx, 1);
    for (const p of db.data.papers) {
      if (p.folder_id === Number(id)) p.folder_id = null;
    }
    await db.save();
    return true;
  }
}

// ===== 논문 =====

export async function createPaper({ title, authors = null, year = null, sourceFile, folderId = null }) {
  await init();
  const now = new Date().toISOString();
  if (backend === 'sqlite') {
    const info = db.prepare(
      'INSERT INTO papers (folder_id, title, authors, year, source_file, pdf_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(folderId ?? null, title, authors, year, sourceFile, '', now, now);
    const id = info.lastInsertRowid;
    return db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
  } else {
    const id = ++db.data.counter.papers;
    const row = {
      id,
      folder_id: folderId ?? null,
      title,
      authors,
      year,
      source_file: sourceFile,
      pdf_path: '',
      created_at: now,
      updated_at: now,
    };
    db.data.papers.push(row);
    await db.save();
    return row;
  }
}

export async function updatePaperPdfPath(id, pdfPath) {
  await init();
  const now = new Date().toISOString();
  if (backend === 'sqlite') {
    db.prepare('UPDATE papers SET pdf_path = ?, updated_at = ? WHERE id = ?').run(pdfPath, now, id);
  } else {
    const row = db.data.papers.find(p => p.id === Number(id));
    if (row) {
      row.pdf_path = pdfPath;
      row.updated_at = now;
      await db.save();
    }
  }
}

export async function getPaper(id) {
  await init();
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM papers WHERE id = ?').get(id) || null;
  } else {
    return db.data.papers.find(p => p.id === Number(id)) || null;
  }
}

export async function updatePaper(id, fields) {
  await init();
  const sets = [];
  const vals = [];
  if (typeof fields.title === 'string') { sets.push('title = ?'); vals.push(fields.title); }
  if ('folderId' in fields) { sets.push('folder_id = ?'); vals.push(fields.folderId ?? null); }
  if (sets.length === 0) return await getPaper(id);
  const now = new Date().toISOString();
  sets.push('updated_at = ?'); vals.push(now);
  if (backend === 'sqlite') {
    vals.push(Number(id));
    const info = db.prepare(`UPDATE papers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (info.changes === 0) return null;
    return db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
  } else {
    const row = db.data.papers.find(p => p.id === Number(id));
    if (!row) return null;
    if (typeof fields.title === 'string') row.title = fields.title;
    if ('folderId' in fields) row.folder_id = fields.folderId ?? null;
    row.updated_at = now;
    await db.save();
    return row;
  }
}

export async function deletePaper(id) {
  await init();
  const pid = Number(id);
  let ok = false;
  if (backend === 'sqlite') {
    // CASCADE 가 analyses → chats 정리
    const info = db.prepare('DELETE FROM papers WHERE id = ?').run(pid);
    ok = info.changes > 0;
  } else {
    const idx = db.data.papers.findIndex(p => p.id === pid);
    if (idx !== -1) {
      db.data.papers.splice(idx, 1);
      const analysisIds = db.data.analyses.filter(a => a.paper_id === pid).map(a => a.id);
      db.data.analyses = db.data.analyses.filter(a => a.paper_id !== pid);
      db.data.chats = db.data.chats.filter(c => !analysisIds.includes(c.analysis_id));
      await db.save();
      ok = true;
    }
  }
  // 디스크 파일도 정리
  await deletePaperDir(pid);
  return ok;
}

export async function listPapersWithoutFolder() {
  await init();
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM papers WHERE folder_id IS NULL ORDER BY created_at DESC').all();
  } else {
    return db.data.papers
      .filter(p => p.folder_id == null)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }
}

export async function listPapersInFolder(folderId) {
  await init();
  const fid = Number(folderId);
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM papers WHERE folder_id = ? ORDER BY created_at DESC').all(fid);
  } else {
    return db.data.papers
      .filter(p => p.folder_id === fid)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }
}

export async function getTree() {
  await init();
  const folders = await listFolders();
  const tree = [];
  for (const f of folders) {
    const papers = await listPapersInFolder(f.id);
    tree.push({ ...f, papers });
  }
  const unfoldered = await listPapersWithoutFolder();
  return { folders: tree, unfoldered };
}

// ===== LaTeX 프로젝트 =====

export async function createProject({ name, mainFile, sourceZip = null, folderId = null }) {
  await init();
  const now = new Date().toISOString();
  if (backend === 'sqlite') {
    const info = db.prepare(
      'INSERT INTO projects (folder_id, name, main_file, source_zip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(folderId ?? null, name, mainFile, sourceZip, now, now);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
  } else {
    const id = ++db.data.counter.projects;
    const row = { id, folder_id: folderId ?? null, name, main_file: mainFile, source_zip: sourceZip, created_at: now, updated_at: now };
    db.data.projects.push(row);
    await db.save();
    return row;
  }
}

export async function getProject(id) {
  await init();
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id)) || null;
  } else {
    return db.data.projects.find(p => p.id === Number(id)) || null;
  }
}

export async function listProjects() {
  await init();
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC').all();
  } else {
    return [...db.data.projects].sort((a, b) =>
      (b.updated_at || '').localeCompare(a.updated_at || '') || b.id - a.id);
  }
}

export async function updateProject(id, fields) {
  await init();
  const sets = [];
  const vals = [];
  if (typeof fields.name === 'string') { sets.push('name = ?'); vals.push(fields.name); }
  if (typeof fields.mainFile === 'string') { sets.push('main_file = ?'); vals.push(fields.mainFile); }
  if ('folderId' in fields) { sets.push('folder_id = ?'); vals.push(fields.folderId ?? null); }
  if (sets.length === 0) return await getProject(id);
  const now = new Date().toISOString();
  sets.push('updated_at = ?'); vals.push(now);
  if (backend === 'sqlite') {
    vals.push(Number(id));
    const info = db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (info.changes === 0) return null;
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  } else {
    const row = db.data.projects.find(p => p.id === Number(id));
    if (!row) return null;
    if (typeof fields.name === 'string') row.name = fields.name;
    if (typeof fields.mainFile === 'string') row.main_file = fields.mainFile;
    if ('folderId' in fields) row.folder_id = fields.folderId ?? null;
    row.updated_at = now;
    await db.save();
    return row;
  }
}

// 컴파일/저장 시 updated_at 만 갱신
export async function touchProject(id) {
  await init();
  const now = new Date().toISOString();
  if (backend === 'sqlite') {
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, Number(id));
  } else {
    const row = db.data.projects.find(p => p.id === Number(id));
    if (row) { row.updated_at = now; await db.save(); }
  }
}

export async function deleteProject(id) {
  await init();
  const pid = Number(id);
  let ok = false;
  if (backend === 'sqlite') {
    ok = db.prepare('DELETE FROM projects WHERE id = ?').run(pid).changes > 0;
  } else {
    const idx = db.data.projects.findIndex(p => p.id === pid);
    if (idx !== -1) { db.data.projects.splice(idx, 1); await db.save(); ok = true; }
  }
  await deleteProjectDir(pid);
  return ok;
}

// ===== 분석 =====

export async function createAnalysis({ paperId, durationMs = 0, configSnapshot = '', reportPath, metricsPath, claimsPath }) {
  await init();
  const now = new Date().toISOString();
  if (backend === 'sqlite') {
    const info = db.prepare(
      'INSERT INTO analyses (paper_id, created_at, duration_ms, config_snapshot, report_path, metrics_path, claims_path) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(Number(paperId), now, durationMs, configSnapshot, reportPath, metricsPath, claimsPath);
    const id = info.lastInsertRowid;
    return db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
  } else {
    const id = ++db.data.counter.analyses;
    const row = {
      id,
      paper_id: Number(paperId),
      created_at: now,
      duration_ms: durationMs,
      config_snapshot: configSnapshot,
      report_path: reportPath,
      metrics_path: metricsPath,
      claims_path: claimsPath,
    };
    db.data.analyses.push(row);
    await db.save();
    return row;
  }
}

export async function updateAnalysisPaths(id, { report, metrics, claims }) {
  await init();
  if (backend === 'sqlite') {
    db.prepare('UPDATE analyses SET report_path = ?, metrics_path = ?, claims_path = ? WHERE id = ?')
      .run(report, metrics, claims, Number(id));
  } else {
    const row = db.data.analyses.find(a => a.id === Number(id));
    if (row) {
      row.report_path = report;
      row.metrics_path = metrics;
      row.claims_path = claims;
      await db.save();
    }
  }
}

export async function getLatestAnalysis(paperId) {
  await init();
  const pid = Number(paperId);
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM analyses WHERE paper_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(pid) || null;
  } else {
    const list = db.data.analyses
      .filter(a => a.paper_id === pid)
      .sort((a, b) => {
        const t = (b.created_at || '').localeCompare(a.created_at || '');
        if (t !== 0) return t;
        return b.id - a.id;
      });
    return list[0] || null;
  }
}

export async function deleteAnalysis(id) {
  await init();
  const aid = Number(id);
  if (backend === 'sqlite') {
    // CASCADE 가 chats 정리
    const info = db.prepare('DELETE FROM analyses WHERE id = ?').run(aid);
    return info.changes > 0;
  } else {
    const idx = db.data.analyses.findIndex(a => a.id === aid);
    if (idx === -1) return false;
    db.data.analyses.splice(idx, 1);
    db.data.chats = db.data.chats.filter(c => c.analysis_id !== aid);
    await db.save();
    return true;
  }
}

export async function getAnalysis(id) {
  await init();
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM analyses WHERE id = ?').get(Number(id)) || null;
  } else {
    return db.data.analyses.find(a => a.id === Number(id)) || null;
  }
}

// ===== 채팅 =====

export async function appendChat(analysisId, role, content, modelUsed = null) {
  await init();
  const now = new Date().toISOString();
  if (backend === 'sqlite') {
    const info = db.prepare(
      'INSERT INTO chats (analysis_id, role, content, model_used, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(Number(analysisId), role, content, modelUsed, now);
    const id = info.lastInsertRowid;
    return db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  } else {
    const id = ++db.data.counter.chats;
    const row = {
      id,
      analysis_id: Number(analysisId),
      role,
      content,
      model_used: modelUsed,
      created_at: now,
    };
    db.data.chats.push(row);
    await db.save();
    return row;
  }
}

export async function appendChatTurn(analysisId, userContent, assistantContent, modelUsed = null) {
  await init();
  const aid = Number(analysisId);
  const now = new Date().toISOString();
  if (backend === 'sqlite') {
    const tx = db.transaction(() => {
      const stmt = db.prepare('INSERT INTO chats (analysis_id, role, content, model_used, created_at) VALUES (?, ?, ?, ?, ?)');
      const r1 = stmt.run(aid, 'user', userContent, modelUsed, now);
      const r2 = stmt.run(aid, 'assistant', assistantContent, modelUsed, now);
      return [r1.lastInsertRowid, r2.lastInsertRowid];
    });
    const [userId, assistantId] = tx();
    return {
      user: { id: userId, analysis_id: aid, role: 'user', content: userContent, model_used: modelUsed, created_at: now },
      assistant: { id: assistantId, analysis_id: aid, role: 'assistant', content: assistantContent, model_used: modelUsed, created_at: now },
    };
  } else {
    const userRow = { id: ++db.data.counter.chats, analysis_id: aid, role: 'user', content: userContent, model_used: modelUsed, created_at: now };
    const assistantRow = { id: ++db.data.counter.chats, analysis_id: aid, role: 'assistant', content: assistantContent, model_used: modelUsed, created_at: now };
    db.data.chats.push(userRow, assistantRow);
    await db.save();
    return { user: userRow, assistant: assistantRow };
  }
}

export async function deleteAll() {
  await init();
  if (backend === 'sqlite') {
    db.exec('DELETE FROM chats; DELETE FROM analyses; DELETE FROM papers; DELETE FROM projects; DELETE FROM folders;');
  } else {
    db.data.folders = [];
    db.data.papers = [];
    db.data.analyses = [];
    db.data.chats = [];
    db.data.projects = [];
    db.data.counter = { folders: 0, papers: 0, analyses: 0, chats: 0, projects: 0 };
    await db.save();
  }
  await deleteAllProjects();
}

export async function listChats(analysisId) {
  await init();
  const aid = Number(analysisId);
  if (backend === 'sqlite') {
    return db.prepare('SELECT * FROM chats WHERE analysis_id = ? ORDER BY created_at ASC, id ASC').all(aid);
  } else {
    return db.data.chats
      .filter(c => c.analysis_id === aid)
      .sort((a, b) => {
        const t = (a.created_at || '').localeCompare(b.created_at || '');
        if (t !== 0) return t;
        return a.id - b.id;
      });
  }
}
