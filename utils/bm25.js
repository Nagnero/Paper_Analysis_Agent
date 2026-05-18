// utils/bm25.js
// 메모리 기반 BM25 인덱스. 외부 의존성 없음.

const STOPWORDS = new Set(
  'the a an of in on to and or for is are was were be by with'.split(' ')
);

function tokenize(s) {
  const out = [];
  const re = /[a-z0-9가-힣]+/g;
  const low = s.toLowerCase();
  let m;
  while ((m = re.exec(low)) !== null) {
    const t = m[0];
    if (!STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

export class BM25Index {
  constructor() {
    this.docs = []; // [{id, tokens, len}]
    this.df = new Map(); // term -> doc count
    this.avgLen = 0;
    this.k1 = 1.5;
    this.b = 0.75;
  }

  add(id, text) {
    const tokens = tokenize(text);
    const seen = new Set(tokens);
    for (const t of seen) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.docs.push({ id, tokens, len: tokens.length });
    const total = this.docs.reduce((s, d) => s + d.len, 0);
    this.avgLen = total / this.docs.length;
  }

  search(query, topK = 3) {
    const qTokens = tokenize(query);
    const N = this.docs.length;
    const scored = this.docs.map(d => {
      const tf = new Map();
      for (const t of d.tokens) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const q of qTokens) {
        const f = tf.get(q) || 0;
        if (f === 0) continue;
        const df = this.df.get(q) || 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const norm = 1 - this.b + this.b * (d.len / (this.avgLen || 1));
        score += idf * (f * (this.k1 + 1)) / (f + this.k1 * norm);
      }
      return { id: d.id, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(s => s.score > 0);
  }
}
