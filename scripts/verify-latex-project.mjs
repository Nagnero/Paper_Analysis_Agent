import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

// 격리된 임시 데이터 폴더 (라이브러리/프로젝트 디스크 쓰기용)
process.env.PAA_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'paa-verify-latex-'));

const read = (f) => readFileSync(f, 'utf8');

// ---------- 1. 기능: ZIP 해제 + 경로 가드 + main 감지 ----------
const latexProject = await import('../core/latexProject.js');
const library = await import('../core/library.js');

const project = await library.createProject({ name: 'verify', mainFile: 'main.tex', sourceZip: 'verify.zip' });
const zip = zipSync({
  'wrapper/main.tex': strToU8('\\documentclass{article}\n\\begin{document}Hi\\end{document}\n'),
  'wrapper/sections/intro.tex': strToU8('intro\n'),
  'wrapper/refs.bib': strToU8('@article{a,title={t}}\n'),
  'wrapper/figure.png': strToU8('PNGDATA'),
  'wrapper/__MACOSX/._main.tex': strToU8('junk'),
  '../evil.tex': strToU8('should be rejected'),
});
const { fileCount, mainGuess } = await latexProject.extractZip(zip, project.id);

assert.equal(mainGuess, 'main.tex', 'main.tex should be detected via \\documentclass');
const files = (await latexProject.listFiles(project.id)).map(f => f.path);
assert.ok(files.includes('main.tex'), 'top-level wrapper folder should be stripped');
assert.ok(files.includes('sections/intro.tex'), 'nested files should be kept');
assert.ok(!files.some(f => f.includes('__MACOSX') || f.includes('evil')), 'junk/traversal entries must be skipped');
assert.equal(fileCount, files.length, 'fileCount should match listed files');

// 읽기/쓰기 + 경로 탐색 차단
const content = await latexProject.readProjectFile(project.id, 'main.tex');
assert.match(content, /documentclass/, 'readProjectFile should return file content');
await latexProject.writeProjectFile(project.id, 'main.tex', '\\documentclass{article}\\begin{document}edited\\end{document}');
assert.match(await latexProject.readProjectFile(project.id, 'main.tex'), /edited/, 'writeProjectFile should persist');
await assert.rejects(() => latexProject.readProjectFile(project.id, '../../../server.js'), /잘못된 파일 경로/, 'path traversal must be blocked');
await assert.rejects(() => latexProject.writeProjectFile(project.id, 'figure.png', 'x'), /편집할 수 없는/, 'binary files must be read-only');

// 엔진 감지는 환경 의존이므로 호출만 검증(throw 없이 null|object)
const { detectEngine } = await import('../core/latexCompiler.js');
const engine = await detectEngine();
assert.ok(engine === null || typeof engine.engine === 'string', 'detectEngine should return null or {engine}');

await library.deleteProject(project.id);

// ---------- 2. 계약: 서버 라우트 / 프론트 UI ----------
const server = read('server.js');
assert.match(server, /\/api\/latex-status/, 'server must expose latex-status');
assert.match(server, /function handleProjectsDispatch/, 'server must dispatch project routes');
assert.match(server, /handleProjectCompile/, 'server must expose compile handler');
assert.match(server, /handleProjectPdf/, 'server must serve compiled pdf');
assert.match(server, /'\/latexEditor\.js'/, 'latexEditor.js must be a static route');
assert.match(server, /'\.ttf'/, 'vendor types must include ttf for Monaco fonts');

const fileManager = read('core/fileManager.js');
assert.match(fileManager, /function projectSrcDir/, 'fileManager must expose projectSrcDir');
assert.match(fileManager, /function projectMainPdf/, 'fileManager must expose projectMainPdf');

const lib = read('core/library.js');
assert.match(lib, /CREATE TABLE IF NOT EXISTS projects/, 'library must define projects table');
assert.match(lib, /export async function createProject/, 'library must expose createProject');

const index = read('public/index.html');
assert.match(index, /id="latexPane"/, 'index must include the LaTeX pane');
assert.match(index, /id="latexCompileBtn"/, 'index must include a compile button');
assert.match(index, /id="latexTree"/, 'index must include the sidebar LaTeX section');
assert.match(index, /vendor\/monaco\/vs\/loader\.js/, 'index must load the Monaco AMD loader');

const app = read('public/app.js');
assert.match(app, /function openLatexProject/, 'app must open LaTeX projects');
assert.match(app, /function compileLatex/, 'app must trigger compile');
assert.match(app, /function uploadLatexZip/, 'app must upload zip projects');
assert.match(app, /function isZip/, 'app must detect zip files for drag-drop routing');
assert.match(app, /createLatexEditor/, 'app must use the Monaco wrapper');

const editor = read('public/latexEditor.js');
assert.match(editor, /getWorkerUrl/, 'Monaco worker env must be configured');
assert.match(editor, /vs\/editor\/editor\.main/, 'editor must load Monaco main module');

console.log('latex-project verification passed');
