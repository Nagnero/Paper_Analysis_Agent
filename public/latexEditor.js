// public/latexEditor.js
// Monaco 에디터 래퍼 (LaTeX). index.html 의 /vendor/monaco/vs/loader.js (AMD)를 통해 로드.
const MONACO_BASE = '/vendor/monaco/';
const VS_PATH = MONACO_BASE + 'vs';

let _monacoPromise = null;

function setupWorkerEnv() {
  if (window.MonacoEnvironment) return;
  const origin = location.origin;
  window.MonacoEnvironment = {
    getWorkerUrl() {
      // blob 워커: 절대 URL 로 vendored workerMain 을 importScripts
      const code =
        `self.MonacoEnvironment = { baseUrl: '${origin}${MONACO_BASE}' };\n` +
        `importScripts('${origin}${VS_PATH}/base/worker/workerMain.js');`;
      return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    },
  };
}

function registerLatex(monaco) {
  if (monaco.languages.getLanguages().some(l => l.id === 'latex')) return;
  monaco.languages.register({ id: 'latex', extensions: ['.tex', '.cls', '.sty', '.ltx', '.def', '.bib'] });
  monaco.languages.setMonarchTokensProvider('latex', {
    defaultToken: '',
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/\\(begin|end)\b/, 'keyword.control'],
        [/\\[a-zA-Z@]+/, 'keyword'],
        [/\\[^a-zA-Z]/, 'keyword'],
        [/\$[^$]*\$/, 'string'],
        [/[{}]/, 'delimiter.bracket'],
        [/[[\]]/, 'delimiter.square'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '$', close: '$' },
    ],
  });
}

function ensureMonaco() {
  if (_monacoPromise) return _monacoPromise;
  _monacoPromise = new Promise((resolve, reject) => {
    if (window.monaco) return resolve(window.monaco);
    const req = window.require;
    if (typeof req !== 'function') {
      return reject(new Error('Monaco 로더가 로드되지 않았습니다 (loader.js).'));
    }
    setupWorkerEnv();
    try {
      req.config({ paths: { vs: VS_PATH } });
      req(['vs/editor/editor.main'], () => {
        try { registerLatex(window.monaco); resolve(window.monaco); }
        catch (e) { reject(e); }
      }, reject);
    } catch (e) { reject(e); }
  });
  return _monacoPromise;
}

function langForPath(p) {
  return /\.(tex|cls|sty|ltx|def|bib)$/i.test(p || '') ? 'latex' : 'plaintext';
}

/**
 * 에디터 인스턴스 생성. @returns {Promise<controller>}
 */
export async function createLatexEditor(container) {
  const monaco = await ensureMonaco();
  const editor = monaco.editor.create(container, {
    value: '',
    language: 'latex',
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: false },
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    renderWhitespace: 'none',
    tabSize: 2,
  });

  let changeCb = null;
  let suppress = false;
  editor.onDidChangeModelContent(() => { if (!suppress && changeCb) changeCb(editor.getValue()); });

  // Ctrl/Cmd+S 저장 훅
  let saveCb = null;
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { if (saveCb) saveCb(); });

  // 수정 전/후 비교용 diff 에디터 (지연 생성)
  let diffEditor = null;
  function disposeDiffModels() {
    if (!diffEditor) return;
    const prev = diffEditor.getModel();
    diffEditor.setModel(null);
    if (prev) { prev.original?.dispose?.(); prev.modified?.dispose?.(); }
  }

  return {
    setContent(path, content) {
      suppress = true;
      monaco.editor.setModelLanguage(editor.getModel(), langForPath(path));
      editor.setValue(content || '');
      suppress = false;
    },
    getValue() { return editor.getValue(); },
    onChange(cb) { changeCb = cb; },
    onSave(cb) { saveCb = cb; },
    gotoLine(line) {
      const total = editor.getModel()?.getLineCount() || 1;
      const ln = Math.max(1, Math.min(total, Number(line) | 0 || 1));
      editor.revealLineInCenter(ln);
      editor.setPosition({ lineNumber: ln, column: 1 });
      editor.focus();
      const ids = editor.deltaDecorations([], [{
        range: new monaco.Range(ln, 1, ln, 1),
        options: { isWholeLine: true, className: 'latex-jump-line' },
      }]);
      setTimeout(() => { try { editor.deltaDecorations(ids, []); } catch { /* ignore */ } }, 1600);
    },
    layout() { editor.layout(); },
    focus() { editor.focus(); },
    setReadOnly(ro) { editor.updateOptions({ readOnly: !!ro }); },
    // 수정 전(original) ↔ 후(modified) 나란히 비교. diffContainer 는 보이는 상태여야 함.
    showDiff(diffContainer, path, original, modified) {
      if (!diffEditor) {
        diffEditor = monaco.editor.createDiffEditor(diffContainer, {
          theme: 'vs-dark', automaticLayout: true, readOnly: true, originalEditable: false,
          fontSize: 13, renderSideBySide: true, minimap: { enabled: false },
          wordWrap: 'on', scrollBeyondLastLine: false, ignoreTrimWhitespace: false,
        });
      }
      const lang = langForPath(path);
      disposeDiffModels();
      diffEditor.setModel({
        original: monaco.editor.createModel(original || '', lang),
        modified: monaco.editor.createModel(modified || '', lang),
      });
      diffEditor.layout();
    },
    closeDiff() { disposeDiffModels(); },
    layoutDiff() { if (diffEditor) diffEditor.layout(); },
    dispose() { disposeDiffModels(); if (diffEditor) diffEditor.dispose(); editor.dispose(); },
  };
}
