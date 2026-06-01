// Shared citation-marker contract for browser UI, server prompts, and tests.
// Keep this dependency-free so it can be imported by both Node and the browser.

export const CITE_MARKER_PATTERN = String.raw`\[\[cite:([A-Za-z0-9_.:-]+)\]\]`;
export const INTERNAL_CITE_MARKER_PATTERN = String.raw`\[\[cite:[^\]\n]*\]\]`;
export const CITABLE_STATUSES = new Set(['supported', 'partially_supported']);

export function createCitationMarkerRegex() {
  return new RegExp(CITE_MARKER_PATTERN, 'g');
}

export function claimIdOf(v) {
  return v?.claim?.id ?? v?.claimId ?? v?.id ?? '';
}

export function normalizeCitationRef(v) {
  const id = claimIdOf(v);
  const quote = v?.evidenceQuote ?? v?.quote ?? '';
  if (!id || !quote || !CITABLE_STATUSES.has(v?.status)) return null;
  return {
    id,
    text: v?.claim?.text ?? v?.text ?? '',
    status: v.status,
    quote,
    sourcePage: v?.claim?.sourcePage ?? v?.sourcePage ?? null,
    sourceSection: v?.evidenceSection ?? v?.claim?.sourceSection ?? v?.sourceSection ?? '',
  };
}

export function buildCitationRefMap(verifiedClaims) {
  const refs = new Map();
  for (const v of verifiedClaims || []) {
    const ref = normalizeCitationRef(v);
    if (ref && !refs.has(ref.id)) refs.set(ref.id, ref);
  }
  return refs;
}

export function extractCitationIds(text) {
  const ids = [];
  const seen = new Set();
  const markerRe = createCitationMarkerRegex();
  let match;
  while ((match = markerRe.exec(text || '')) !== null) {
    const id = match[1];
    if (!seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }
  return ids;
}

export function citationRefsForText(verifiedClaims, text) {
  const refs = buildCitationRefMap(verifiedClaims);
  return extractCitationIds(text).map(id => refs.get(id)).filter(Boolean);
}

export function stripInvalidCitationMarkers(text, verifiedClaims) {
  if (typeof text !== 'string' || !text.includes('[[cite:')) return text ?? '';
  const refs = buildCitationRefMap(verifiedClaims);
  const strictMarkerRe = new RegExp(`^${CITE_MARKER_PATTERN}$`);
  const internalMarkerRe = new RegExp(INTERNAL_CITE_MARKER_PATTERN, 'g');
  return text.replace(internalMarkerRe, (marker) => {
    const strict = marker.match(strictMarkerRe);
    return strict && refs.has(strict[1]) ? marker : '';
  });
}
