import { mockSERPs } from './mockSerps.js';

export class SERPKeywordClusterer {

  serpSimilarity(urls1, urls2) {
    if (!urls1?.length || !urls2?.length) return 0;
    const a = new Set(urls1);
    const b = new Set(urls2);
    const intersection = [...a].filter(x => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    return intersection / union;
  }

  cosineSimilarity(v1, v2) {
    const dot = v1.reduce((s, a, i) => s + a * v2[i], 0);
    const mag1 = Math.sqrt(v1.reduce((s, a) => s + a * a, 0));
    const mag2 = Math.sqrt(v2.reduce((s, a) => s + a * a, 0));
    return dot / (mag1 * mag2 || 1);
  }

  getMockEmbeddings(keywords) {
    return keywords.map((_, i) =>
      Array(50).fill(0).map((_, j) => (i + j) % 10 / 10)
    );
  }

  inferIntent(keyword) {
    const kw = keyword.toLowerCase();
    if (kw.includes('how') || kw.includes('guide')) return 'Informational';
    if (kw.includes('buy') || kw.includes('price')) return 'Transactional';
    if (kw.includes('nike')) return 'Navigational';
    return 'Commercial';
  }

  async clusterKeywords(keywords, volumes = []) {
    volumes = volumes.length ? volumes : new Array(keywords.length).fill(100);

    const serpData = {};
    keywords.forEach(kw => serpData[kw] = mockSERPs[kw] || []);

    const embeddings = this.getMockEmbeddings(keywords);
    const clusters = {};

    keywords.forEach((kw, i) => {
      const clusterId = Math.floor(i / 2);
      clusters[clusterId] ??= [];
      clusters[clusterId].push(kw);
    });

    return Object.entries(clusters).map(([id, kws]) => ({
      cluster_id: Number(id),
      primary_keyword: kws[0],
      keywords: kws,
      total_volume: kws.reduce((s, k) => s + volumes[keywords.indexOf(k)], 0),
      intent: this.inferIntent(kws[0]),
      cluster_size: kws.length,
      shared_urls: serpData[kws[0]] || []
    }));
  }
}
