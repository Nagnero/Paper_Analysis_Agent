// Electron 메인 프로세스 진입점.
// 백그라운드로 HTTP 서버를 띄우고 BrowserWindow 가 그 localhost 페이지를 로드.
// 시작 시 claude CLI 가용성 체크 — 없으면 안내 화면 표시.
import { app, BrowserWindow, shell } from 'electron';
import { spawn } from 'node:child_process';
import { startServer } from './server.js';

let mainWindow = null;
let serverHandle = null;

function probeClaude() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, info) => {
      if (settled) return;
      settled = true;
      resolve({ ok, info });
    };
    try {
      // shell:true + args[] 조합은 DEP0190 경고. 명령 전체를 단일 문자열로 전달.
      const proc = spawn('claude --version', [], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout?.on('data', d => { out += d.toString(); });
      proc.on('error', () => done(false, ''));
      proc.on('close', code => done(code === 0, out.trim()));
      setTimeout(() => { try { proc.kill(); } catch {} ; done(false, 'probe timeout'); }, 5000);
    } catch {
      done(false, '');
    }
  });
}

function claudeMissingPage() {
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Veridict — 설정 필요</title>
<style>
  body { margin:0; padding:48px; background:#0e0f13; color:#e6e6e6;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; line-height:1.6; }
  .card { max-width:640px; margin:0 auto; background:#1a1c22; border:1px solid #2a2d35;
    border-radius:12px; padding:28px 32px; }
  h1 { margin:0 0 8px; font-size:20px; }
  p { color:#b5bac4; margin:8px 0; }
  ol { padding-left:20px; color:#b5bac4; }
  ol li { margin:8px 0; }
  code { background:#11131a; border:1px solid #2a2d35; border-radius:4px;
    padding:2px 6px; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12.5px; }
  a { color:#4f9eff; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .muted { color:#7d8693; font-size:12px; margin-top:20px; }
  button { margin-top:16px; background:#4f9eff; color:white; border:none;
    padding:8px 16px; border-radius:6px; cursor:pointer; font-size:13px; }
</style></head><body>
<div class="card">
  <h1>Claude Code CLI 가 필요합니다</h1>
  <p>Veridict 는 사용자의 Claude Pro/Max 구독으로 동작하는 <code>claude</code> CLI 를 호출합니다.
  PC 에서 <code>claude</code> 를 찾을 수 없어요.</p>
  <ol>
    <li>Claude Code CLI 설치: <a href="https://claude.com/code" target="_blank" rel="noopener">claude.com/code</a></li>
    <li>터미널에서 <code>claude</code> 를 한 번 실행하여 로그인</li>
    <li>이 앱을 다시 시작</li>
  </ol>
  <button onclick="location.reload()">다시 시도</button>
  <p class="muted">앱 자체엔 API 키나 로그인 정보가 저장되지 않습니다. 인증은 전적으로 claude CLI 가 관리합니다.</p>
</div></body></html>`;
  return 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64');
}

function startupErrorPage(message) {
  const safe = String(message).replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Veridict — 시작 실패</title>
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
    title: 'Veridict',
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

  const probe = await probeClaude();
  if (!probe.ok) {
    await mainWindow.loadURL(claudeMissingPage());
    return;
  }

  try {
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
