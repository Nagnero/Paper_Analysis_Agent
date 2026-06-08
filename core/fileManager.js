// core/fileManager.js
// userData 경로 + 논문/분석 파일 관리
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

// Electron 환경이 아닐 때(Node 단독 실행)도 동작하도록 폴백
export function userDataDir() {
  if (process.env.PAA_DATA_DIR) return process.env.PAA_DATA_DIR;
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'korean-paper-agent-console');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'korean-paper-agent-console');
  }
  return path.join(os.homedir(), '.config', 'korean-paper-agent-console');
}

export function libraryDbPath() {
  return path.join(userDataDir(), 'library.db');
}

export function libraryJsonPath() {
  return path.join(userDataDir(), 'library.json');
}

export function paperDir(paperId) {
  return path.join(userDataDir(), 'papers', String(paperId));
}

export function paperSourcePath(paperId) {
  return path.join(paperDir(paperId), 'source.pdf');
}

export function analysisDir(paperId, analysisId) {
  return path.join(paperDir(paperId), 'analyses', String(analysisId));
}

export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

/** PDF를 임시 경로에서 paper 디렉토리로 이동. 다른 볼륨이면 copy+unlink. */
export async function adoptPdf(tempPath, paperId) {
  const targetDir = paperDir(paperId);
  await ensureDir(targetDir);
  const target = paperSourcePath(paperId);
  try {
    await fs.rename(tempPath, target);
  } catch (e) {
    if (e.code === 'EXDEV') {
      await fs.copyFile(tempPath, target);
      await fs.unlink(tempPath).catch(() => {});
    } else throw e;
  }
  return target;
}

/** PDF를 임시 경로에서 paper 디렉토리로 복사 (원본 보존). CLI 모드에서 사용. */
export async function copyPdf(srcPath, paperId) {
  const targetDir = paperDir(paperId);
  await ensureDir(targetDir);
  const target = paperSourcePath(paperId);
  await fs.copyFile(srcPath, target);
  return target;
}

export async function writeAnalysisFiles(paperId, analysisId, { reportMd, claimsJson, metricsJson }) {
  const dir = analysisDir(paperId, analysisId);
  await ensureDir(dir);
  const reportPath = path.join(dir, 'report.md');
  const claimsPath = path.join(dir, 'claims.json');
  const metricsPath = path.join(dir, 'metrics.json');
  await Promise.all([
    fs.writeFile(reportPath, reportMd, 'utf8'),
    fs.writeFile(claimsPath, JSON.stringify(claimsJson, null, 2), 'utf8'),
    fs.writeFile(metricsPath, JSON.stringify(metricsJson, null, 2), 'utf8'),
  ]);
  return { report: reportPath, claims: claimsPath, metrics: metricsPath };
}

export async function readAnalysisFiles(paperId, analysisId) {
  const dir = analysisDir(paperId, analysisId);
  const [report, claims, metrics, coreInsights] = await Promise.all([
    fs.readFile(path.join(dir, 'report.md'), 'utf8').catch(() => ''),
    fs.readFile(path.join(dir, 'claims.json'), 'utf8').then(JSON.parse).catch(() => []),
    fs.readFile(path.join(dir, 'metrics.json'), 'utf8').then(JSON.parse).catch(() => ({})),
    fs.readFile(path.join(dir, 'core-insights.json'), 'utf8').then(JSON.parse).catch(() => null),
  ]);
  return { report, claims, metrics, coreInsights };
}

export async function writeCoreInsights(paperId, analysisId, coreInsightsJson) {
  const dir = analysisDir(paperId, analysisId);
  await ensureDir(dir);
  const coreInsightsPath = path.join(dir, 'core-insights.json');
  await fs.writeFile(coreInsightsPath, JSON.stringify(coreInsightsJson, null, 2), 'utf8');
  return coreInsightsPath;
}

export async function writePaperText(paperId, text) {
  const dir = paperDir(paperId);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, 'paper-text.txt'), text, 'utf8');
}

export async function readPaperText(paperId) {
  return await fs.readFile(path.join(paperDir(paperId), 'paper-text.txt'), 'utf8').catch(() => null);
}

export async function deletePaperDir(paperId) {
  await fs.rm(paperDir(paperId), { recursive: true, force: true }).catch(() => {});
}

export async function deleteAllPapers() {
  await fs.rm(path.join(userDataDir(), 'papers'), { recursive: true, force: true }).catch(() => {});
}

// ---------------- LaTeX 프로젝트 ----------------
// projects/{id}/src  : 편집 가능한 소스 트리 (zip 해제 결과)
// projects/{id}/out  : 컴파일 산출물 (main.pdf, *.log)

export function projectDir(projectId) {
  return path.join(userDataDir(), 'projects', String(projectId));
}

export function projectSrcDir(projectId) {
  return path.join(projectDir(projectId), 'src');
}

export function projectOutDir(projectId) {
  return path.join(projectDir(projectId), 'out');
}

// 컴파일은 src 안에서 in-place 로 수행한다(MiKTeX bibtex 의 `..`/절대경로 쓰기 제한 회피).
// mainFile(예: 'main.tex' 또는 'paper/main.tex')에 대응하는 산출 PDF/SyncTeX 경로.
export function projectMainPdf(projectId, mainFile) {
  const rel = String(mainFile || 'main.tex').replace(/\.tex$/i, '');
  return path.join(projectSrcDir(projectId), `${rel}.pdf`);
}

export function projectSyncTex(projectId, mainFile) {
  const rel = String(mainFile || 'main.tex').replace(/\.tex$/i, '');
  return path.join(projectSrcDir(projectId), `${rel}.synctex.gz`);
}

export async function deleteProjectDir(projectId) {
  await fs.rm(projectDir(projectId), { recursive: true, force: true }).catch(() => {});
}

export async function deleteAllProjects() {
  await fs.rm(path.join(userDataDir(), 'projects'), { recursive: true, force: true }).catch(() => {});
}
