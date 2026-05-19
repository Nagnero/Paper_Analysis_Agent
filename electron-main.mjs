// Electron 메인 프로세스 진입점.
// HTTP 서버를 무조건 먼저 띄우고, BrowserWindow 가 로드할 URL 을
// claude CLI 의 binary/인증 상태에 따라 분기:
//   - binary 없음        → /setup?reason=missing  (CLI 설치 안내)
//   - binary 있고 미로그인 → /setup?reason=login   (로그인 안내 + 자동 폴링)
//   - 둘 다 OK           → / (메인 채팅 UI)
import { app, BrowserWindow, shell } from 'electron';
import { startServer } from './server.js';

// Authentication routing is handled in public/app.js via /api/auth-status.
let mainWindow = null;
let serverHandle = null;

function startupErrorPage(message) {
  const safe = String(message).replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>PAA — 시작 실패</title>
<style>
  body { margin:0; padding:48px; background:#0e0f13; color:#e6e6e6;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  .card { max-width:640px; margin:0 auto; background:#1a1c22; border:1px solid #ff6b6b;
    border-radius:12px; padding:28px 32px; }
  h1 { margin:0 0 12px; font-size:18px; color:#ff6b6b; }
  pre { background:#11131a; border:1px solid #2a2d35; border-radius:6px; padding:12px;
    font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12.5px;
    color:#b5bac4; white-space:pre-wrap; word-break:break-word; }
</style></head><body>
<div class="card"><h1>앱 시작 실패</h1><pre>${safe}</pre></div></body></html>`;
  return 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64');
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'PAA',
    backgroundColor: '#0e0f13',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 외부 링크는 기본 브라우저로
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('data:')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  try {
    // 서버는 claude 상태와 무관하게 항상 먼저 부트. setup 페이지의 폴링 라우트가 필요.
    if (!serverHandle) {
      serverHandle = await startServer({ host: '127.0.0.1', port: 0 });
    }
    await mainWindow.loadURL(`http://127.0.0.1:${serverHandle.port}/`);
  } catch (err) {
    await mainWindow.loadURL(startupErrorPage(err?.stack || err?.message || String(err)));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
