import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildCitationRefMap,
  citationRefsForText,
  extractCitationIds,
  stripInvalidCitationMarkers,
} from '../public/citationContract.js';

const app = readFileSync('public/app.js', 'utf8');
const server = readFileSync('server.js', 'utf8');
const pipeline = readFileSync('pipeline.js', 'utf8');
const writerPrompt = readFileSync('prompts/writer.md', 'utf8');
const contract = readFileSync('public/citationContract.js', 'utf8');

const claims = [
  { status: 'supported', claim: { id: 'c1', text: 'supported', sourcePage: 4 }, evidenceQuote: 'supported quote' },
  { status: 'partially_supported', claim: { id: 'c2', text: 'partial' }, evidenceQuote: 'partial quote' },
  { status: 'unsupported', claim: { id: 'c3', text: 'unsupported' }, evidenceQuote: 'unsupported quote' },
  { status: 'contradicted', claim: { id: 'c4', text: 'contradicted' }, evidenceQuote: 'contradicted quote' },
  { status: 'supported', claim: { id: 'c5', text: 'no quote' }, evidenceQuote: '' },
  { status: 'supported', claim: { text: 'no id' }, evidenceQuote: 'missing id quote' },
];

const refs = buildCitationRefMap(claims);
assert.deepEqual([...refs.keys()], ['c1', 'c2'], 'only supported/partial quote-backed claims are citable');
assert.equal(refs.get('c1').sourcePage, 4);

const answer = 'A [[cite:c1]] B [[cite:c2]] C [[cite:c3]] D [[cite:c4]] E [[cite:c5]] F [[cite:missing]]';
assert.deepEqual(extractCitationIds(answer), ['c1', 'c2', 'c3', 'c4', 'c5', 'missing']);
assert.deepEqual(citationRefsForText(claims, answer).map(r => r.id), ['c1', 'c2']);
assert.equal(
  stripInvalidCitationMarkers(answer, claims),
  'A [[cite:c1]] B [[cite:c2]] C  D  E  F ',
  'invalid markers are stripped before save/response/render fallback'
);
assert.equal(
  stripInvalidCitationMarkers('bad [[cite: c1]] empty [[cite:]] slash [[cite:c1/extra]] good [[cite:c1]]', claims),
  'bad  empty  slash  good [[cite:c1]]',
  'malformed internal cite syntax is stripped from canonical text'
);
assert.equal(stripInvalidCitationMarkers('legacy plain markdown', claims), 'legacy plain markdown');

assert.match(contract, /CITE_MARKER_PATTERN/);
assert.match(app, /from '\/citationContract\.js'/);
assert.match(app, /function renderMarkdownWithEvidence/);
assert.match(app, /function enhanceEvidenceRefs/);
assert.match(app, /className = 'evidence-ref-inline'/);
assert.match(app, /currentVerifiedClaims: \[\]/);
assert.match(app, /msg\.citations \|\| state\.currentVerifiedClaims/);
assert.match(app, /function evidenceLookupOpts/);
assert.match(app, /sourcePage: ref\?\.sourcePage \?\? ref\?\.claim\?\.sourcePage/);
assert.match(app, /pdfViewer\.canHighlightQuote/);
assert.match(app, /if \(ref && isEvidenceHighlightable\(ref\)\)/);
assert.doesNotMatch(app, /document\.createTextNode\(marker\)/, 'unknown markers must not leak as raw internal syntax');
assert.match(app, /root\.innerHTML = renderMarkdown\(src\)/, 'plain markdown still goes through existing safe renderer');

assert.match(server, /from '\.\/public\/citationContract\.js'/);
assert.match(server, /'\/citationContract\.js'/);
assert.match(server, /function buildGroundedChatInstructions/);
assert.match(server, /stripInvalidCitationMarkers\(rawAnswer/);
assert.match(server, /citationRefsForText/);
assert.match(server, /verifiedClaims,/);
assert.match(server, /jsonResponse\(res, 200, \{ answer, citations, chats/);
assert.match(server, /res\.end\(JSON\.stringify\(\{ answer, citations \}\)\)/);
assert.match(pipeline, /stripInvalidCitationMarkers\(rawReport, verifiedClaims\)/);

assert.match(writerPrompt, /\[\[cite:<claimId>\]\]/);
assert.doesNotMatch(writerPrompt, /각 주요 주장 끝에 출처 표기: `\(Section X, p\.Y\)`/);
assert.match(writerPrompt, /괄호형 출처.*사용 금지/s);

console.log('evidence-link verification passed');
