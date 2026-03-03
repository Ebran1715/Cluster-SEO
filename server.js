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

  if (kw.includes('best')) return 'Commercial';

  if (
    kw.includes('buy') ||
    kw.includes('price') ||
    kw.includes('purchase') ||
    kw.includes('order') ||
    kw.includes('shop') ||
    kw.includes('cost')
  ) return 'Transactional';

  if (
    kw.includes('login') ||
    kw.includes('website') ||
    kw.includes('site') ||
    kw.includes('official') ||
    kw.includes('app') ||
    kw.includes('web')
  ) return 'Navigational';

  // Default for anything else
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

    // Assign keywords to their intent categories
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

    res.json({
      success: true,
      keywordsByIntent,
      stats,
      allKeywords: keywordObjects
    });

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
    const volumes = [];

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
   ERROR HANDLING
===================== */
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

/* =====================
   START SERVER
===================== */
const PORT = process.env.PORT || 8000;

['uploads', 'public'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});