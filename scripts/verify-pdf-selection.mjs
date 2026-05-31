import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(file, 'utf8');

const index = read('public/index.html');
const css = read('public/app.css');
const app = read('public/app.js');
const pdfViewer = read('public/pdfViewer.js');
const server = read('server.js');
const llm = read('core/llm.js');
const codex = read('core/codexCli.js');
const claude = read('core/claudeClient.js');

// UI contract: one explicit range-selection control and one composer chip.
assert.match(index, /id="pdfSelectBtn"/, 'PDF header must expose a selection-mode button');
assert.match(index, /id="selectionChip"/, 'composer must expose a single pending-selection chip');
assert.match(css, /\.pdf-selection-layer/, 'viewer must style an overlay layer above PDF pages');
assert.match(css, /\.pdf-selection-layer\.active/, 'selection overlay must only capture pointer events in active mode');
assert.match(css, /\.selection-chip/, 'composer chip must be styled separately from plain text input');

// Frontend contract: one pending selection is captured, shown, sent, retried, and cleared.
assert.match(app, /pendingPdfSelection: null/, 'app state must keep exactly one pending selection');
assert.match(app, /function selectionRequestPayload/, 'selection payload must be normalized before POST');
assert.match(app, /pdfViewer\.onRegionSelected/, 'PDF viewer selection callback must feed the composer chip');
assert.match(app, /if \(selectionPayload\) body\.selection = selectionPayload/, 'chat requests must include optional selection payloads');
assert.match(app, /catch \(err\)[\s\S]*setPdfSelection\(selection\)/, 'failed sends must restore the pending selection for retry');
assert.match(app, /try[\s\S]*clearPdfSelection\(\)[\s\S]*catch \(err\)/, 'successful sends must clear the pending selection');

// Viewer contract: drag rectangle yields text plus a PNG crop without touching citation highlights.
assert.match(pdfViewer, /className = 'pdf-selection-layer'/, 'each rendered page must receive a selection overlay');
assert.match(pdfViewer, /pageDiv\.querySelectorAll\('\.textLayer span'\)/, 'selection must extract overlapping text-layer spans');
assert.match(pdfViewer, /crop\.toDataURL\('image\/png'\)/, 'selection must capture a PNG crop for figure/image questions');
assert.match(pdfViewer, /function setSelectionMode\(enabled\)/, 'viewer must expose selection-mode toggling');
assert.match(pdfViewer, /function onRegionSelected\(callback\)/, 'viewer must expose a region-selected callback');
assert.match(pdfViewer, /function clearSelection\(\)/, 'viewer must expose selection cleanup');
assert.doesNotMatch(pdfViewer, /activeHighlight[^]*pdf-selection-layer/, 'selection overlay must not be implemented by reusing citation highlight nodes');

// Backend contract: bounded JSON/image payload, metadata-only persistence, and temp cleanup.
assert.match(server, /MAX_CHAT_JSON_BODY_BYTES = 6 \* 1024 \* 1024/, 'chat JSON body must have a bounded cap for inline PNG data URLs');
assert.match(server, /MAX_SELECTION_IMAGE_BYTES = 3 \* 1024 \* 1024/, 'decoded selection PNG must have a bounded cap');
assert.match(server, /selection\.type must be pdf-region/, 'server must reject unknown selection types');
assert.match(server, /data:image\/png;base64,/, 'server must only accept PNG data URLs for selection images');
assert.match(server, /function isPng\(bytes\)/, 'server must verify decoded selection image bytes');
assert.match(server, /selection\.image is not a PNG file/, 'server must reject non-PNG bytes even with a PNG data URL prefix');
assert.match(server, /mkdtemp\(path\.join\(os\.tmpdir\(\), 'paa-selection-'\)\)/, 'selection image must be materialized in an OS temp directory');
assert.match(server, /await cleanupPdfSelection\(preparedSelection\)/, 'selection temp directories must be removed in finally blocks');
assert.match(server, /selectedRegionContext\(preparedSelection\)/, 'LLM prompt must receive selected-region context');
assert.match(server, /callOpts\.imagePaths = \[preparedSelection\.imagePath\]/, 'LLM calls must receive the temp image path when present');
assert.match(server, /questionWithSelectionMetadata\(question, preparedSelection\)/, 'library history must store selection metadata rather than image data');
assert.doesNotMatch(server, /appendChatTurn\([^)]*body\.selection/s, 'chat persistence must not store raw selection payloads');
assert.match(server, /return `p\.\$\{selection\.page\} · 선택 영역/, 'persisted selection label must be metadata-only');
assert.doesNotMatch(server, /selectionLabel\(selection\) \{[\s\S]*clampText\(selection\.text/, 'persisted selection label must not store selected text preview');

// LLM adapter contract: image paths are explicit argv values, not shell-interpolated strings.
assert.match(llm, /imagePaths\?: string\[\]/, 'unified LLM wrapper must document imagePaths passthrough');
assert.match(codex, /safeImagePaths/, 'Codex adapter must validate image paths');
assert.match(codex, /args\.push\('--image', imagePath\)/, 'Codex adapter must pass images via argv --image');
assert.match(codex, /shell: process\.platform === 'win32'/, 'Codex adapter must preserve Windows CLI wrapper compatibility without shelling on Unix');
assert.match(claude, /safeImagePaths/, 'Claude adapter must validate image paths');
assert.match(claude, /args\.push\('--add-dir', dir\)/, 'Claude adapter must add only image parent directories');
assert.match(claude, /args\.push\('--allowedTools', 'Read'\)/, 'Claude adapter must allow Read only when images are present');
assert.match(claude, /shell: process\.platform === 'win32'/, 'Claude adapter must preserve Windows CLI wrapper compatibility without shelling on Unix');

console.log('pdf-selection verification passed');
