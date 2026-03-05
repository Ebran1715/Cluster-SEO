import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';

/* =====================
   BASIC SETUP
===================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static('public'));

/* =====================
   FILE UPLOAD (MULTER)
===================== */
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExt = ['.csv', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowedExt.includes(ext)
      ? cb(null, true)
      : cb(new Error('Only CSV or TXT files allowed'));
  }
});

/* =====================
   SIMPLE INTENT DETECTION
===================== */
function detectIntent(keyword) {
  const kw = keyword.toLowerCase().trim();
  if (kw.includes('best') || kw.includes('review') || kw.includes(' vs ') || kw.includes('top ') || kw.includes('compare')) return 'Commercial';
  if (kw.includes('buy') || kw.includes('price') || kw.includes('purchase') || kw.includes('order') || kw.includes('shop') || kw.includes('cost') || kw.includes('cheap') || kw.includes('discount') || kw.includes('deal')) return 'Transactional';
  if (kw.includes('login') || kw.includes('website') || kw.includes('site') || kw.includes('official') || kw.includes('app') || kw.includes('web') || kw.includes('sign in')) return 'Navigational';
  return 'Informational';
}

/* =====================
   ROUTES
===================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* =====================
   API: PROCESS KEYWORDS
===================== */
app.post('/api/process-keywords', async (req, res) => {
  try {
    const { keywords = [], volumes = [] } = req.body;

    if (!keywords.length) {
      return res.status(400).json({ success: false, error: 'No keywords provided' });
    }

    const parsedVolumes =
      volumes.length === keywords.length
        ? volumes.map(v => Number(v) || 0)
        : new Array(keywords.length).fill(0);

    const keywordObjects = keywords.map((keyword, index) => ({
      keyword,
      volume: parsedVolumes[index],
      intent: detectIntent(keyword)
    }));

    const keywordsByIntent = {
      Informational: [],
      Transactional: [],
      Commercial: [],
      Navigational: []
    };

    keywordObjects.forEach(item => {
      keywordsByIntent[item.intent].push(item);
    });

    const stats = {
      totalKeywords: keywords.length,
      totalClusters: keywords.length,
      totalVolume: parsedVolumes.reduce((a, b) => a + b, 0),
      intentDistribution: {
        Informational: keywordsByIntent.Informational.length,
        Transactional: keywordsByIntent.Transactional.length,
        Commercial: keywordsByIntent.Commercial.length,
        Navigational: keywordsByIntent.Navigational.length
      }
    };

    res.json({ success: true, keywordsByIntent, stats, allKeywords: keywordObjects });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================
   API: PROCESS CSV
===================== */
app.post('/api/process-csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const lines = fs
      .readFileSync(req.file.path, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    fs.unlinkSync(req.file.path);

    const keywords = [];
    const volumes  = [];

    lines.forEach((line, index) => {
      if (index === 0 && /keyword/i.test(line)) return;
      const parts = line.split(',').map(p => p.trim());
      if (parts[0] && isNaN(parts[0])) {
        keywords.push(parts[0]);
        volumes.push(parseInt(parts[1]) || 0);
      }
    });

    const keywordObjects = keywords.map((keyword, i) => ({
      keyword,
      volume: volumes[i],
      intent: detectIntent(keyword)
    }));

    const keywordsByIntent = {
      Informational: [],
      Transactional: [],
      Commercial: [],
      Navigational: []
    };

    keywordObjects.forEach(k => keywordsByIntent[k.intent].push(k));

    const stats = {
      totalKeywords: keywords.length,
      totalClusters: keywords.length,
      totalVolume: volumes.reduce((a, b) => a + b, 0),
      intentDistribution: {
        Informational: keywordsByIntent.Informational.length,
        Transactional: keywordsByIntent.Transactional.length,
        Commercial: keywordsByIntent.Commercial.length,
        Navigational: keywordsByIntent.Navigational.length
      }
    };

    res.json({ success: true, keywordsByIntent, stats, allKeywords: keywordObjects });

  } catch (err) {
    console.error('CSV error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================
   API: KEYWORD SUGGESTIONS
===================== */
const COUNTRY_PARAMS = {
  us: { gl: 'us', hl: 'en' },
  gb: { gl: 'gb', hl: 'en' },
  au: { gl: 'au', hl: 'en' },
  ca: { gl: 'ca', hl: 'en' },
  in: { gl: 'in', hl: 'en' },
  np: { gl: 'np', hl: 'ne' },
  global: { gl: '',   hl: 'en' },
};

async function fetchGoogleSuggest(query, gl = '', hl = 'en') {
  const params = new URLSearchParams({ client: 'firefox', q: query });
  if (gl)  params.set('gl',  gl);
  if (hl)  params.set('hl',  hl);
  const url = `https://suggestqueries.google.com/complete/search?${params.toString()}`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ClusterSEOBot/1.0)'
      }
    });

    const text = await response.text();
    let suggestions = [];

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
        suggestions = parsed[1];
      }
    } catch {
      const match = text.match(/\[.*?\[([^\]]+)\]/);
      if (match) {
        suggestions = match[1]
          .split(',')
          .map(s => s.trim().replace(/^"|"$/g, ''))
          .filter(s => s.length > 0);
      }
    }

    return suggestions.filter(s => typeof s === 'string' && s.trim().length > 0);

  } catch (err) {
    console.error(`Suggest fetch failed for "${query}":`, err.message);
    return [];
  }
}

app.get('/api/suggest', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || !query.trim()) {
      return res.status(400).json({ success: false, error: 'No query provided' });
    }

    const q       = query.trim();
    const country = (req.query.country || 'global').toLowerCase();
    const { gl, hl } = COUNTRY_PARAMS[country] || COUNTRY_PARAMS['global'];

    const variants = [
      q, 'best ' + q, 'how to choose ' + q, 'buy ' + q,
      q + ' review', q + ' vs', q + ' for beginners', q + ' price',
    ];

    const results = await Promise.allSettled(
      variants.map(v => fetchGoogleSuggest(v, gl, hl).then(sugs => ({ variant: v, suggestions: sugs })))
    );

    const seen = new Set();
    const keywords = [];

    results.forEach(r => {
      if (r.status === 'fulfilled') {
        const { variant, suggestions } = r.value;
        suggestions.forEach(kw => {
          const key = kw.toLowerCase().trim();
          if (!seen.has(key) && key.length > 3) {
            seen.add(key);
            keywords.push({ keyword: kw.trim(), source: variant });
          }
        });
      }
    });

    res.json({ success: true, keywords, total: keywords.length });

  } catch (err) {
    console.error('Suggest route error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================
   OPTIONAL: ADDITIONAL ENDPOINTS (for future use)
   These are placeholders - your HTML files work without them
===================== */

// SEO Audit endpoint (optional - your seo-audit.html works client-side)
app.post('/api/seo-audit', async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) {
      return res.status(400).json({ success: false, error: 'No HTML provided' });
    }
    // Your client-side already does this - this is just a placeholder
    res.json({ success: true, message: 'SEO audit endpoint ready' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Competitor analysis endpoint (optional)
app.post('/api/competitor-analysis', async (req, res) => {
  try {
    const { yourKeywords, competitorKeywords } = req.body;
    res.json({ success: true, message: 'Competitor analysis endpoint ready' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Keyword gap endpoint (optional)
app.post('/api/keyword-gap', async (req, res) => {
  try {
    const { yourKeywords, competitorKeywords } = req.body;
    res.json({ success: true, message: 'Keyword gap endpoint ready' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Wikipedia entity endpoint (optional - your wikipedia-entity.html calls Wikipedia directly)
app.get('/api/wikipedia-entity', async (req, res) => {
  try {
    const { topic } = req.query;
    if (!topic) {
      return res.status(400).json({ success: false, error: 'No topic provided' });
    }
    // Your client-side already calls Wikipedia directly - this is a proxy option
    const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`);
    const data = await response.json();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Backlinks endpoint (optional - your backlinks.html is strategy-only)
app.post('/api/backlinks', async (req, res) => {
  try {
    const { domain } = req.body;
    res.json({ success: true, message: 'Backlinks endpoint ready' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================
   ERROR HANDLING
===================== */
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

/* =====================
   START SERVER
===================== */
const PORT = process.env.PORT || 8007;

['uploads', 'public'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log('\n📝 Available Endpoints:');
  console.log('   ✅ POST /api/process-keywords');
  console.log('   ✅ POST /api/process-csv');
  console.log('   ✅ GET  /api/suggest');
  console.log('   ⚠️  All other endpoints are optional placeholders');
  console.log('\n✅ Your HTML tools work client-side:');
  console.log('   • backlinks.html - strategy guide (no API)');
  console.log('   • competitor.html - client-side analysis');
  console.log('   • entity-finder.html - client-side extraction');
  console.log('   • keyword-gap.html - client-side gap analysis');
  console.log('   • keyword-tracking.html - localStorage');
  console.log('   • seo-audit.html - client-side HTML parsing');
  console.log('   • wikipedia-entity.html - direct Wikipedia API');
});