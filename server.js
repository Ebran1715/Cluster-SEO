import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static('public'));

/* ============================================================
   FILE UPLOAD (MULTER)
============================================================ */
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.csv', '.txt'].includes(ext) ? cb(null, true) : cb(new Error('Only CSV or TXT files allowed'));
  }
});

/* ============================================================
   SHARED HELPERS
============================================================ */

// ── Intent classifier ───────────────────────────────────────
function detectIntent(keyword) {
  const k = keyword.toLowerCase().trim();
  if (/\b(best|top|review|reviews|compare|comparison|vs|versus|rated|recommended|ranking)\b/.test(k)) return 'Commercial';
  if (/\b(buy|purchase|order|shop|price|cost|cheap|discount|deal|coupon|promo|sale|pricing|affordable)\b/.test(k)) return 'Transactional';
  if (/\b(login|sign in|sign up|register|account|download|app|website|official|portal|access|contact)\b/.test(k)) return 'Navigational';
  return 'Informational';
}

// ── Difficulty estimator ────────────────────────────────────
function estimateDifficulty(keyword) {
  const words = keyword.trim().split(/\s+/).length;
  if (words === 1) return 'Hard';
  if (words === 2) return 'Medium';
  return 'Easy';
}

// ── Shared stopwords ────────────────────────────────────────
const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','were','be','been','have','has','had','do','does','did',
  'will','would','could','should','may','might','that','this','these','those',
  'it','its','we','our','you','your','they','their','he','she','his','her',
  'i','me','my','us','him','them','who','which','what','when','where','how',
  'why','not','also','more','most','some','any','all','each','other','into',
  'than','then','there','here','so','if','about','after','before','just',
  'only','very','can','no','new','one','two','three','first','last','same','such',
  'company','companies','include','includes','including','american','british',
  'french','chinese','german','global','international','national','headquartered',
  'incorporated','multinational','products','product','founded','launched','made',
  'make','sold','sells','develop','developed','designs','began','became','become',
  'over','recent','major','currently','quickly','highly','alongside','making',
  'inc','ltd','llc','corp','corporation'
]);

/* ============================================================
   ROUTES
============================================================ */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/test', (req, res) => res.json({ success: true, message: 'API is working!', version: '4.0' }));

/* ============================================================
   API 1 — PROCESS KEYWORDS (Keyword Clustering)
============================================================ */
app.post('/api/process-keywords', (req, res) => {
  try {
    const { keywords = [], volumes = [] } = req.body;
    if (!keywords.length) return res.status(400).json({ success: false, error: 'No keywords provided' });

    const parsedVolumes = volumes.length === keywords.length
      ? volumes.map(v => Number(v) || 0)
      : new Array(keywords.length).fill(0);

    const keywordObjects = keywords.map((keyword, i) => ({
      keyword, volume: parsedVolumes[i], intent: detectIntent(keyword)
    }));

    const keywordsByIntent = { Informational:[], Transactional:[], Commercial:[], Navigational:[] };
    keywordObjects.forEach(item => keywordsByIntent[item.intent].push(item));

    const stats = {
      totalKeywords: keywords.length,
      totalClusters: keywords.length,
      totalVolume: parsedVolumes.reduce((a, b) => a + b, 0),
      intentDistribution: {
        Informational: keywordsByIntent.Informational.length,
        Transactional: keywordsByIntent.Transactional.length,
        Commercial:    keywordsByIntent.Commercial.length,
        Navigational:  keywordsByIntent.Navigational.length
      }
    };

    res.json({ success: true, keywordsByIntent, stats, allKeywords: keywordObjects });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   API 2 — PROCESS CSV (Keyword Clustering via file)
============================================================ */
app.post('/api/process-csv', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const lines = fs.readFileSync(req.file.path, 'utf8')
      .split('\n').map(l => l.trim()).filter(Boolean);
    fs.unlinkSync(req.file.path);

    const keywords = [], volumes = [];
    lines.forEach((line, index) => {
      if (index === 0 && /keyword/i.test(line)) return;
      const parts = line.split(',').map(p => p.trim());
      if (parts[0] && isNaN(parts[0])) {
        keywords.push(parts[0]);
        volumes.push(parseInt(parts[1]) || 0);
      }
    });

    const keywordObjects = keywords.map((keyword, i) => ({
      keyword, volume: volumes[i], intent: detectIntent(keyword)
    }));
    const keywordsByIntent = { Informational:[], Transactional:[], Commercial:[], Navigational:[] };
    keywordObjects.forEach(k => keywordsByIntent[k.intent].push(k));

    res.json({
      success: true, keywordsByIntent, allKeywords: keywordObjects,
      stats: {
        totalKeywords: keywords.length, totalClusters: keywords.length,
        totalVolume: volumes.reduce((a,b) => a+b, 0),
        intentDistribution: {
          Informational: keywordsByIntent.Informational.length,
          Transactional: keywordsByIntent.Transactional.length,
          Commercial:    keywordsByIntent.Commercial.length,
          Navigational:  keywordsByIntent.Navigational.length
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   API 3 — KEYWORD SUGGESTIONS (Keyword Research)
============================================================ */
const COUNTRY_PARAMS = {
  us: { gl:'us', hl:'en' }, gb: { gl:'gb', hl:'en' }, au: { gl:'au', hl:'en' },
  ca: { gl:'ca', hl:'en' }, in: { gl:'in', hl:'en' }, np: { gl:'np', hl:'ne' },
  global: { gl:'', hl:'en' }
};

async function fetchGoogleSuggest(query, gl = '', hl = 'en') {
  const params = new URLSearchParams({ client: 'firefox', q: query });
  if (gl) params.set('gl', gl);
  if (hl) params.set('hl', hl);
  const url = `https://suggestqueries.google.com/complete/search?${params}`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClusterSEOBot/1.0)' }
    });
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && Array.isArray(parsed[1])) return parsed[1];
    } catch {
      const match = text.match(/\[.*?\[([^\]]+)\]/);
      if (match) return match[1].split(',').map(s => s.trim().replace(/^"|"$/g,'')).filter(Boolean);
    }
    return [];
  } catch (err) {
    console.error(`Suggest failed for "${query}":`, err.message);
    return [];
  }
}

app.get('/api/suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ success: false, error: 'No query provided' });

    const { gl, hl } = COUNTRY_PARAMS[(req.query.country || 'global').toLowerCase()] || COUNTRY_PARAMS.global;
    const variants = [
      q, 'best ' + q, 'how to choose ' + q, 'buy ' + q,
      q + ' review', q + ' vs', q + ' for beginners', q + ' price'
    ];

    const results = await Promise.allSettled(
      variants.map(v => fetchGoogleSuggest(v, gl, hl).then(suggestions => ({ variant: v, suggestions })))
    );

    const seen = new Set(), keywords = [];
    results.forEach(r => {
      if (r.status === 'fulfilled') {
        r.value.suggestions.forEach(kw => {
          const key = kw.toLowerCase().trim();
          if (!seen.has(key) && key.length > 3) { seen.add(key); keywords.push({ keyword: kw.trim(), source: r.value.variant }); }
        });
      }
    });

    res.json({ success: true, keywords, total: keywords.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   API 4 — ENTITY EXTRACTION (UPDATED - REAL WORLD READY)
============================================================ */
app.post('/api/extract-entities', (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ success: false, error: 'No text provided' });

    const entities = { 
      people: [], 
      organizations: [], 
      places: [], 
      brands: [], 
      concepts: [] 
    };
    
    const fullText = text;

    /* ===== 1. PEOPLE DETECTION ===== */
    const personTitles = [
      'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'President', 'Vice President', 'VP',
      'Director', 'Manager', 'Founder', 'Co-founder', 'Chairman', 'Chairwoman',
      'Senator', 'Governor', 'Minister', 'Prime Minister', 'General', 'Captain',
      'Professor', 'Dr', 'Doctor', 'Prof', 'Mr', 'Mrs', 'Ms', 'Miss', 'Sir', 'Lord', 'Lady',
      'Ambassador', 'Judge', 'Justice', 'Chief', 'Executive', 'Officer', 'Head of'
    ];
    
    const titleNamePattern = new RegExp(
      `\\b(?:${personTitles.join('|')})\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})`, 
      'g'
    );
    
    const nameTitlePattern = /([A-Z][a-z]+\s+[A-Z][a-z]+),\s+(?:the\s+)?(?:CEO|CTO|CFO|President|Founder|Director)/g;
    const fullNamePattern = /\b([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)\b/g;
    const verbNamePattern = /\b(said|announced|stated|confirmed|added|replied|mentioned|declared)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/g;
    const suffixNamePattern = /\b([A-Z][a-z]+\s+[A-Z][a-z]+)\s+(?:Jr\.?|Sr\.?|III|IV|II)\b/g;
    
    const allPeople = new Set();
    
    [titleNamePattern, nameTitlePattern, fullNamePattern, verbNamePattern, suffixNamePattern].forEach(pattern => {
      let match;
      while ((match = pattern.exec(fullText)) !== null) {
        const name = (match[1] || match[2] || match[0]).trim();
        if (name.split(' ').length >= 2 && name.length > 4 && /^[A-Z][a-z]/.test(name) &&
            !name.includes('http') && !name.includes('www')) {
          allPeople.add(name);
        }
      }
    });
    
    const knownPeople = [
      'Tim Cook', 'Steve Jobs', 'Steve Wozniak', 'Elon Musk', 'Jeff Bezos',
      'Bill Gates', 'Satya Nadella', 'Sundar Pichai', 'Mark Zuckerberg',
      'Larry Page', 'Sergey Brin', 'Warren Buffett', 'Richard Branson',
      'Jack Dorsey', 'Evan Spiegel', 'Kevin Systrom', 'Brian Chesky'
    ];
    
    knownPeople.forEach(person => {
      if (fullText.includes(person)) allPeople.add(person);
    });
    
    entities.people = Array.from(allPeople).slice(0, 20);

    /* ===== 2. ORGANIZATION DETECTION ===== */
    const orgSuffixes = [
      'Inc', 'Inc.', 'Ltd', 'Ltd.', 'LLC', 'Corp', 'Corp.', 'Corporation',
      'Company', 'Co', 'Co.', 'Group', 'Holdings', 'Technologies', 'Tech',
      'Solutions', 'Services', 'Systems', 'Software', 'Networks', 'Media',
      'Entertainment', 'Industries', 'International', 'Global', 'Partners',
      'Associates', 'Agency', 'Bureau', 'Council', 'Association', 'Foundation',
      'Institute', 'University', 'College', 'School', 'Hospital', 'Clinic',
      'Bank', 'Financial', 'Insurance', 'Pharmaceutical', 'Airlines', 'Airways',
      'Transportation', 'Logistics', 'Retail', 'Stores'
    ];
    
    const orgPattern = new RegExp(
      `\\b([A-Z][A-Za-z0-9&.'\\-\\s]{1,40}(?:\\s+(?:${orgSuffixes.join('|')})))`, 
      'g'
    );
    
    const abbrPattern = /\b([A-Z]{2,8})\b/g;
    
    const knownCompanies = [
      'Google', 'Microsoft', 'Apple', 'Amazon', 'Meta', 'Netflix', 'Tesla',
      'SpaceX', 'Twitter', 'X', 'Snap', 'Uber', 'Lyft', 'Airbnb', 'Spotify',
      'Zoom', 'Salesforce', 'Oracle', 'IBM', 'Intel', 'AMD', 'NVIDIA',
      'Adobe', 'PayPal', 'Square', 'Stripe', 'Shopify', 'WordPress',
      'Samsung', 'Sony', 'LG', 'Panasonic', 'Philips', 'Xiaomi', 'Huawei',
      'Toyota', 'Honda', 'Ford', 'GM', 'BMW', 'Mercedes', 'Audi', 'Volkswagen',
      'Nike', 'Adidas', 'Puma', 'Zara', 'H&M', 'Uniqlo', 'Coca-Cola', 'Pepsi',
      'McDonald\'s', 'Starbucks', 'KFC', 'Burger King', 'Subway', 'Domino\'s'
    ];
    
    const sourcePattern = /\b(according to|reported by|announced by|released by|published by|from)\s+([A-Z][A-Za-z0-9\s]{2,30})(?:\s+[A-Z]|\.|,)/g;
    
    const allOrgs = new Set();
    const skipOrgs = new Set(['THE', 'AND', 'FOR', 'WITH', 'THIS', 'THAT', 'FROM', 'YOUR', 'OUR']);
    
    let match;
    while ((match = orgPattern.exec(fullText)) !== null) {
      const org = match[1].trim();
      if (org.length > 3 && org.length < 60) allOrgs.add(org);
    }
    
    while ((match = abbrPattern.exec(fullText)) !== null) {
      if (!skipOrgs.has(match[1]) && match[1].length > 1) allOrgs.add(match[1]);
    }
    
    while ((match = sourcePattern.exec(fullText)) !== null) {
      const org = match[2].trim();
      if (org.length > 2 && !org.includes(' ')) allOrgs.add(org);
    }
    
    knownCompanies.forEach(company => {
      if (fullText.includes(company)) allOrgs.add(company);
    });
    
    entities.organizations = Array.from(allOrgs)
      .filter(org => {
        const lower = org.toLowerCase();
        return !['the', 'and', 'for', 'this', 'that', 'with', 'from', 'have', 'has', 'was', 'were'].includes(lower) &&
               org.length > 2;
      })
      .slice(0, 25);

    /* ===== 3. PLACE DETECTION ===== */
    const countriesAndCities = [
      'United States', 'USA', 'US', 'United Kingdom', 'UK', 'England', 'Scotland', 'Wales',
      'Germany', 'France', 'Japan', 'China', 'India', 'Australia', 'Canada', 'Brazil',
      'Russia', 'Italy', 'Spain', 'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Finland',
      'Switzerland', 'Austria', 'Belgium', 'Ireland', 'Portugal', 'Greece', 'Turkey',
      'Israel', 'UAE', 'Saudi Arabia', 'Singapore', 'Malaysia', 'Thailand', 'Vietnam',
      'South Korea', 'North Korea', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'Peru',
      'Egypt', 'South Africa', 'Nigeria', 'Kenya', 'Morocco',
      'California', 'Texas', 'Florida', 'New York', 'Illinois', 'Pennsylvania', 'Ohio',
      'Georgia', 'North Carolina', 'Michigan', 'New Jersey', 'Virginia', 'Washington',
      'Arizona', 'Massachusetts', 'Tennessee', 'Indiana', 'Missouri', 'Maryland', 'Wisconsin',
      'Colorado', 'Minnesota', 'South Carolina', 'Alabama', 'Louisiana', 'Kentucky',
      'Oregon', 'Oklahoma', 'Connecticut', 'Iowa', 'Mississippi', 'Arkansas', 'Utah',
      'Nevada', 'New Mexico', 'West Virginia', 'Nebraska', 'Idaho', 'Hawaii', 'Maine',
      'New Hampshire', 'Rhode Island', 'Montana', 'Delaware', 'South Dakota', 'North Dakota',
      'Alaska', 'Vermont', 'Wyoming',
      'New York City', 'NYC', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia',
      'San Antonio', 'San Diego', 'Dallas', 'San Jose', 'Austin', 'Jacksonville', 'Fort Worth',
      'Columbus', 'Charlotte', 'San Francisco', 'Indianapolis', 'Seattle', 'Denver', 'Washington DC',
      'Boston', 'El Paso', 'Nashville', 'Detroit', 'Oklahoma City', 'Portland', 'Las Vegas',
      'Memphis', 'Louisville', 'Baltimore', 'Milwaukee', 'Albuquerque', 'Tucson', 'Fresno',
      'Sacramento', 'Kansas City', 'Mesa', 'Atlanta', 'Omaha', 'Colorado Springs', 'Raleigh',
      'Miami', 'Virginia Beach', 'Oakland', 'Minneapolis', 'Tulsa', 'Wichita', 'New Orleans',
      'Arlington', 'Cleveland', 'Tampa', 'Bakersfield', 'Aurora', 'Honolulu', 'Anaheim',
      'Santa Ana', 'Riverside', 'Corpus Christi', 'Lexington', 'Stockton', 'St. Louis',
      'St Paul', 'Henderson', 'Pittsburgh', 'Cincinnati', 'Anchorage', 'Huntsville',
      'London', 'Paris', 'Tokyo', 'Beijing', 'Shanghai', 'Moscow', 'Berlin', 'Madrid',
      'Rome', 'Amsterdam', 'Vienna', 'Prague', 'Budapest', 'Warsaw', 'Brussels', 'Dublin',
      'Lisbon', 'Copenhagen', 'Stockholm', 'Oslo', 'Helsinki', 'Zurich', 'Geneva',
      'Milan', 'Barcelona', 'Munich', 'Hamburg', 'Frankfurt', 'Istanbul', 'Dubai',
      'Abu Dhabi', 'Doha', 'Kuwait City', 'Riyadh', 'Tel Aviv', 'Jerusalem', 'Cairo',
      'Cape Town', 'Johannesburg', 'Nairobi', 'Lagos', 'Casablanca', 'Tunis',
      'Mexico City', 'Toronto', 'Vancouver', 'Montreal', 'Ottawa', 'Calgary', 'Edmonton',
      'Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Auckland', 'Wellington',
      'Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Kolkata', 'Hyderabad', 'Pune',
      'Singapore', 'Hong Kong', 'Taipei', 'Seoul', 'Busan', 'Osaka', 'Kyoto', 'Nagoya',
      'Bangkok', 'Phuket', 'Chiang Mai', 'Ho Chi Minh City', 'Hanoi', 'Jakarta', 'Bali',
      'Manila', 'Kuala Lumpur', 'Penang'
    ];
    
    const allPlaces = new Set();
    
    countriesAndCities.forEach(place => {
      if (fullText.includes(place)) allPlaces.add(place);
    });
    
    const placePrepositionPattern = /\b(in|at|from|to|near|outside|inside|around|throughout|across)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
    
    while ((match = placePrepositionPattern.exec(fullText)) !== null) {
      const place = match[2].trim();
      if (place.length > 3 && 
          !entities.people.includes(place) && 
          !entities.organizations.includes(place)) {
        allPlaces.add(place);
      }
    }
    
    const cityStatePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),\s*([A-Z]{2})\b/g;
    while ((match = cityStatePattern.exec(fullText)) !== null) {
      allPlaces.add(match[1].trim());
      allPlaces.add(match[2].trim());
    }
    
    const cityCountryPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
    while ((match = cityCountryPattern.exec(fullText)) !== null) {
      allPlaces.add(match[1].trim());
      allPlaces.add(match[2].trim());
    }
    
    entities.places = Array.from(allPlaces)
      .filter(p => p.length > 2 && p.length < 50)
      .slice(0, 20);

    /* ===== 4. BRAND & PRODUCT DETECTION ===== */
    const allBrands = new Set();
    
    const camelCasePattern = /\b([A-Z][a-z]+[A-Z][A-Za-z0-9]+)\b/g;
    while ((match = camelCasePattern.exec(fullText)) !== null) {
      allBrands.add(match[1]);
    }
    
    const trademarkPattern = /\b([A-Z][A-Za-z0-9\s-]{2,30})[™®©]/g;
    while ((match = trademarkPattern.exec(fullText)) !== null) {
      allBrands.add(match[1].trim());
    }
    
    const productNumberPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?[\s-]*\d+(?:\.\d+)?)\b/g;
    while ((match = productNumberPattern.exec(fullText)) !== null) {
      allBrands.add(match[1]);
    }
    
    const knownProducts = [
      'iPhone', 'iPad', 'MacBook', 'AirPods', 'Apple Watch', 'iPod', 'iMac',
      'Mac Pro', 'Mac Mini', 'Apple TV', 'HomePod', 'Vision Pro',
      'Windows', 'Office', 'Teams', 'Xbox', 'Surface', 'Azure', 'AWS',
      'Android', 'Pixel', 'Chromebook', 'Fire TV', 'Kindle', 'Echo', 'Alexa',
      'PlayStation', 'PS5', 'PS4', 'Nintendo', 'Switch', 'Xbox Series X',
      'Galaxy', 'Note', 'Fold', 'Watch', 'Buds', 'Gear', 'S Pen',
      'Photoshop', 'Lightroom', 'Premiere', 'After Effects', 'Illustrator',
      'Salesforce', 'Slack', 'Zoom', 'Teams', 'Webex', 'Hangouts', 'Meet',
      'Gmail', 'Google Docs', 'Sheets', 'Slides', 'Drive', 'Calendar',
      'Spotify', 'Netflix', 'Disney+', 'Hulu', 'Prime Video', 'Apple Music',
      'Coca-Cola', 'Pepsi', 'Sprite', 'Fanta', 'Dr Pepper', 'Red Bull',
      'Nike Air', 'Air Jordan', 'Adidas Ultraboost', 'Reebok', 'Puma'
    ];
    
    knownProducts.forEach(product => {
      if (fullText.includes(product)) allBrands.add(product);
    });
    
    entities.brands = Array.from(allBrands)
      .filter(brand => 
        !entities.people.includes(brand) && 
        !entities.organizations.includes(brand) &&
        brand.length > 2
      )
      .slice(0, 20);

    /* ===== 5. CONCEPT DETECTION ===== */
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      'from', 'as', 'is', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did',
      'will', 'would', 'could', 'should', 'may', 'might', 'that', 'this', 'these', 'those',
      'it', 'its', 'we', 'our', 'you', 'your', 'they', 'their', 'he', 'him', 'his', 'she', 'her',
      'i', 'me', 'my', 'us', 'our', 'them', 'who', 'which', 'what', 'when', 'where', 'why', 'how',
      'not', 'also', 'more', 'most', 'some', 'any', 'all', 'each', 'other', 'into', 'than',
      'then', 'there', 'here', 'so', 'if', 'about', 'after', 'before', 'just', 'only', 'very',
      'can', 'no', 'new', 'one', 'two', 'three', 'first', 'last', 'same', 'such', 'many', 'much'
    ]);
    
    const entityWords = new Set();
    [...entities.people, ...entities.organizations, ...entities.places, ...entities.brands].forEach(entity => {
      entityWords.add(entity.toLowerCase());
      entity.split(/\s+/).forEach(word => {
        if (word.length > 3) entityWords.add(word.toLowerCase());
      });
    });
    
    const wordFreq = {};
    const words = fullText.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => 
        word.length > 4 && 
        !stopWords.has(word) && 
        !entityWords.has(word) &&
        !/^\d+$/.test(word)
      );
    
    words.forEach(word => {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    });
    
    entities.concepts = Object.entries(wordFreq)
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([word, count]) => 
        word.charAt(0).toUpperCase() + word.slice(1) + ' (' + count + 'x)'
      );

    /* ===== 6. FINAL CLEANUP ===== */
    Object.keys(entities).forEach(key => {
      entities[key] = [...new Set(entities[key])]
        .filter(e => e && e.length > 1)
        .sort();
    });

    const stats = {
      totalEntities: Object.values(entities).reduce((sum, arr) => sum + arr.length, 0)
    };

    console.log('Entity extraction successful:', stats);
    res.json({ success: true, entities, stats });

  } catch (err) {
    console.error('Entity extraction error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   API 5 — SEO AUDIT (Full 16-check)
============================================================ */
app.post('/api/seo-audit', (req, res) => {
  try {
    const { html, keyword = '' } = req.body;
    if (!html) return res.status(400).json({ success: false, error: 'No HTML provided' });

    const kw = keyword.toLowerCase().trim();
    const checks = [];
    let totalPoints = 0, maxPoints = 0;

    function check(id, title, pass, warn, points, maxPts, detail, tip) {
      const status = pass ? 'pass' : warn ? 'warn' : 'fail';
      const scored = pass ? maxPts : warn ? Math.round(maxPts * 0.5) : 0;
      totalPoints += scored; maxPoints += maxPts;
      checks.push({ id, title, status, points: scored, maxPoints: maxPts, detail, tip });
    }

    // 1. Title tag
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g,'').trim() : '';
    const titleLen = title.length;
    check('title', 'Title Tag', titleLen >= 50 && titleLen <= 60, titleLen > 0 && (titleLen < 50 || titleLen > 60), 10, 10,
      title ? `"${title}" (${titleLen} chars)` : 'No title tag found',
      titleLen === 0 ? 'Add a <title> tag' : titleLen < 50 ? 'Title too short — aim for 50–60 characters' : titleLen > 60 ? 'Title too long — Google truncates at ~60 characters' : 'Title length is perfect');

    // 2. Keyword in title
    const kwInTitle = kw && title.toLowerCase().includes(kw);
    const kwInTitleFirst = kw && title.toLowerCase().indexOf(kw) < 20;
    check('kw-title', 'Keyword in Title', kwInTitleFirst, kwInTitle && !kwInTitleFirst, 8, 8,
      kw ? (kwInTitle ? `"${kw}" found in title${kwInTitleFirst ? ' (near start ✓)' : ' (not near start)'}` : `"${kw}" not found in title`) : 'No focus keyword set',
      kwInTitle ? (kwInTitleFirst ? 'Great — keyword appears early in title' : 'Move keyword to start of title for more impact') : 'Add your focus keyword to the title tag');

    // 3. Meta description
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
    const metaDesc = metaMatch ? metaMatch[1].trim() : '';
    const metaLen  = metaDesc.length;
    check('meta-desc', 'Meta Description', metaLen >= 140 && metaLen <= 160, metaLen > 0 && (metaLen < 140 || metaLen > 160), 8, 8,
      metaDesc ? `${metaLen} characters` : 'No meta description found',
      metaLen === 0 ? 'Add a meta description (140–160 chars)' : metaLen < 140 ? 'Too short — expand to 140–160 chars' : metaLen > 160 ? 'Too long — Google will truncate it' : 'Perfect length');

    // 4. Keyword in meta description
    const kwInMeta = kw && metaDesc.toLowerCase().includes(kw);
    check('kw-meta', 'Keyword in Meta Description', kwInMeta, !kw, 5, 5,
      kw ? (kwInMeta ? `"${kw}" found in meta description` : `"${kw}" missing from meta description`) : 'No focus keyword set',
      kw ? (kwInMeta ? 'Good — Google bolds matching keywords in search results' : 'Add your keyword to the meta description') : 'Set a focus keyword to check');

    // 5. H1 tag
    const h1Matches = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi) || [];
    const h1Texts   = h1Matches.map(h => h.replace(/<[^>]+>/g,'').trim());
    check('h1', 'H1 Tag', h1Texts.length === 1, h1Texts.length > 1, 8, 8,
      h1Texts.length === 0 ? 'No H1 found' : h1Texts.length === 1 ? `H1: "${h1Texts[0]}"` : `${h1Texts.length} H1 tags found — should be exactly 1`,
      h1Texts.length === 0 ? 'Add one H1 tag as the main page heading' : h1Texts.length > 1 ? 'Remove duplicate H1s — use only one per page' : 'Good — one H1 present');

    // 6. Keyword in H1
    const kwInH1 = kw && h1Texts.some(h => h.toLowerCase().includes(kw));
    check('kw-h1', 'Keyword in H1', kwInH1, !kw || h1Texts.length === 0, 6, 6,
      kw ? (kwInH1 ? `"${kw}" found in H1` : `"${kw}" not found in H1`) : 'No focus keyword set',
      kw ? (kwInH1 ? 'Good — H1 contains focus keyword' : 'Add your focus keyword to the H1') : 'Set a focus keyword');

    // 7. Heading structure (H2/H3)
    const h2Count = (html.match(/<h2[^>]*>/gi) || []).length;
    const h3Count = (html.match(/<h3[^>]*>/gi) || []).length;
    check('headings', 'Heading Structure (H2/H3)', h2Count >= 2, h2Count === 1, 5, 5,
      `H2: ${h2Count}, H3: ${h3Count}`,
      h2Count === 0 ? 'Add H2 subheadings to structure your content' : h2Count === 1 ? 'Add more H2s to break up content sections' : 'Good heading structure');

    // 8. Word count
    const bodyText  = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    const wordCount = bodyText.split(/\s+/).filter(w => w.length > 1).length;
    check('word-count', 'Word Count', wordCount >= 1000, wordCount >= 600, 8, 8,
      `${wordCount.toLocaleString()} words`,
      wordCount < 300 ? 'Very thin content — aim for at least 600 words' : wordCount < 600 ? 'Short content — expand to 600+ words for better rankings' : wordCount < 1000 ? 'Decent length — aim for 1000+ for competitive topics' : 'Good word count for topical depth');

    // 9. Keyword density
    const kwDensity = kw && wordCount > 0
      ? ((bodyText.toLowerCase().split(kw).length - 1) / wordCount * 100)
      : 0;
    const densityPass = kw ? kwDensity >= 1 && kwDensity <= 2.5 : false;
    const densityWarn = kw ? kwDensity > 0 && (kwDensity < 1 || (kwDensity > 2.5 && kwDensity <= 4)) : false;
    check('kw-density', 'Keyword Density', densityPass, densityWarn || !kw, 6, 6,
      kw ? `${kwDensity.toFixed(2)}% (${bodyText.toLowerCase().split(kw).length - 1} occurrences)` : 'No focus keyword set',
      kw ? (kwDensity === 0 ? 'Keyword not found in body — use it naturally in content' : kwDensity < 1 ? 'Low density — use keyword more naturally in text' : kwDensity > 3 ? 'Keyword stuffing risk — reduce usage, write naturally' : 'Good density — keyword is used naturally') : 'Set a focus keyword');

    // 10. Images & alt text
    const imgMatches = html.match(/<img[^>]+>/gi) || [];
    const imgsWithAlt  = imgMatches.filter(img => /alt=["'][^"']+["']/i.test(img)).length;
    const imgsWithoutAlt = imgMatches.length - imgsWithAlt;
    check('images', 'Image Alt Text', imgMatches.length > 0 && imgsWithoutAlt === 0, imgMatches.length > 0 && imgsWithoutAlt > 0, 6, 6,
      imgMatches.length === 0 ? 'No images found' : `${imgsWithAlt}/${imgMatches.length} images have alt text`,
      imgMatches.length === 0 ? 'Add relevant images with descriptive alt text' : imgsWithoutAlt > 0 ? `Add alt text to ${imgsWithoutAlt} image(s) — improves accessibility and image SEO` : 'All images have alt text');

    // 11. Canonical tag
    const hasCanonical = /<link[^>]+rel=["']canonical["'][^>]*>/i.test(html);
    check('canonical', 'Canonical Tag', hasCanonical, false, 5, 5,
      hasCanonical ? 'Canonical tag present' : 'No canonical tag found',
      hasCanonical ? 'Good — canonical prevents duplicate content issues' : 'Add <link rel="canonical" href="..."> to prevent duplicate content');

    // 12. Open Graph tags
    const ogTitle = /<meta[^>]+property=["']og:title["'][^>]*>/i.test(html);
    const ogDesc  = /<meta[^>]+property=["']og:description["'][^>]*>/i.test(html);
    const ogImage = /<meta[^>]+property=["']og:image["'][^>]*>/i.test(html);
    const ogCount = [ogTitle, ogDesc, ogImage].filter(Boolean).length;
    check('og-tags', 'Open Graph Tags', ogCount === 3, ogCount > 0 && ogCount < 3, 5, 5,
      `${ogCount}/3 OG tags (title, description, image)`,
      ogCount === 0 ? 'Add og:title, og:description, og:image for social sharing' : `Add missing OG tags: ${[!ogTitle&&'og:title',!ogDesc&&'og:description',!ogImage&&'og:image'].filter(Boolean).join(', ')}`);

    // 13. Internal links
    const internalLinks = (html.match(/<a[^>]+href=["'][^"'#][^"']*["'][^>]*>/gi) || [])
      .filter(a => !/<a[^>]+href=["']https?:/i.test(a));
    const linkCount = internalLinks.length;
    check('internal-links', 'Internal Links', linkCount >= 3 && linkCount <= 100, linkCount > 0 && (linkCount < 3 || linkCount > 100), 5, 5,
      `${linkCount} internal links`,
      linkCount === 0 ? 'Add internal links to related pages — helps PageRank flow' : linkCount < 3 ? 'Add more internal links (aim for 3–8 per page)' : linkCount > 100 ? 'Too many links — Google recommends keeping to a reasonable number' : 'Good internal linking');

    // 14. Mobile viewport
    const hasViewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(html);
    check('mobile', 'Mobile Viewport', hasViewport, false, 6, 6,
      hasViewport ? 'Viewport meta tag present' : 'No viewport meta tag',
      hasViewport ? 'Good — mobile-first indexing requires viewport tag' : 'Add <meta name="viewport" content="width=device-width, initial-scale=1">');

    // 15. Structured data (JSON-LD)
    const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    let schemaTypes = [];
    jsonLdMatch.forEach(s => {
      try {
        const d = JSON.parse(s.replace(/<[^>]+>/g,''));
        if (d['@type']) schemaTypes.push(d['@type']);
      } catch {}
    });
    check('schema', 'Structured Data (JSON-LD)', schemaTypes.length > 0, false, 6, 6,
      schemaTypes.length > 0 ? `Schema types: ${schemaTypes.join(', ')}` : 'No JSON-LD structured data found',
      schemaTypes.length > 0 ? 'Good — structured data enables rich results in Google' : 'Add JSON-LD schema (Article, Product, FAQ etc.) for rich results');

    // 16. Page speed hints (render-blocking CSS)
    const renderBlockingCSS = (html.match(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi) || []).length;
    check('speed', 'Page Speed Hints', renderBlockingCSS <= 2, renderBlockingCSS <= 5 && renderBlockingCSS > 2, 3, 3,
      `${renderBlockingCSS} render-blocking stylesheet(s)`,
      renderBlockingCSS === 0 ? 'No render-blocking CSS detected' : renderBlockingCSS <= 2 ? 'Acceptable — consider lazy-loading non-critical CSS' : 'Reduce render-blocking CSS — inline critical styles or defer non-critical sheets');

    // Sort: fails first, warnings, passes
    checks.sort((a, b) => {
      const order = { fail:0, warn:1, pass:2 };
      return order[a.status] - order[b.status];
    });

    const score = maxPoints > 0 ? Math.round((totalPoints / maxPoints) * 100) : 0;
    const grade = score >= 80 ? 'Good' : score >= 60 ? 'Needs Work' : 'Poor';

    res.json({
      success: true,
      score, grade, totalPoints, maxPoints,
      checks,
      summary: {
        pass:  checks.filter(c => c.status === 'pass').length,
        warn:  checks.filter(c => c.status === 'warn').length,
        fail:  checks.filter(c => c.status === 'fail').length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   API 6 — COMPETITOR ANALYSIS
============================================================ */
app.post('/api/competitor-analysis', (req, res) => {
  try {
    const { yourKeywords = [], competitorKeywords = [] } = req.body;

    function parseList(input) {
      return input.map(item => {
        if (typeof item === 'object') return item;
        const parts = String(item).split(',').map(s => s.trim());
        return { keyword: parts[0], volume: parseInt(parts[1]) || 0 };
      }).filter(k => k.keyword && k.keyword.length > 1);
    }

    const yours = parseList(yourKeywords);
    const comps  = parseList(competitorKeywords);

    if (!yours.length || !comps.length)
      return res.status(400).json({ success: false, error: 'Both keyword lists are required' });

    const yourSet = new Set(yours.map(k => k.keyword.toLowerCase()));
    const compSet = new Set(comps.map(k => k.keyword.toLowerCase()));

    const shared    = yours.filter(k => compSet.has(k.keyword.toLowerCase()));
    const onlyYours = yours.filter(k => !compSet.has(k.keyword.toLowerCase()));
    const onlyComp  = comps.filter(k => !yourSet.has(k.keyword.toLowerCase()));

    const union      = new Set([...yourSet, ...compSet]);
    const overlapPct = Math.round((shared.length / union.size) * 100);

    function buildIntentDist(kws) {
      const d = { Informational:[], Transactional:[], Commercial:[], Navigational:[] };
      kws.forEach(k => d[detectIntent(k.keyword)].push(k));
      return d;
    }

    const yourDist = buildIntentDist(yours);
    const compDist = buildIntentDist(comps);
    const intentComparison = ['Transactional','Commercial','Informational','Navigational'].map(intent => {
      const y  = yourDist[intent].length;
      const c  = compDist[intent].length;
      const yP = Math.round((y / Math.max(yours.length, 1)) * 100);
      const cP = Math.round((c / Math.max(comps.length, 1)) * 100);
      return { intent, yourCount:y, compCount:c, yourPct:yP, compPct:cP, diff: yP - cP };
    });

    const opportunities = onlyComp
      .map(k => ({ ...k, intent: detectIntent(k.keyword), difficulty: estimateDifficulty(k.keyword) }))
      .sort((a, b) => (b.volume || 0) - (a.volume || 0));

    const quickWins = opportunities.filter(k => k.difficulty === 'Easy').slice(0, 10);

    const yourOnly  = yours.length - shared.length;
    const compOnly  = comps.length - shared.length;
    const total     = yourOnly + shared.length + compOnly;

    res.json({
      success: true,
      stats: {
        yourKeywords:   yours.length,
        compKeywords:   comps.length,
        shared:         shared.length,
        yourAdvantage:  onlyYours.length,
        missing:        onlyComp.length,
        overlapPct
      },
      overlap: {
        yourPct:    Math.round((yourOnly / total) * 100),
        sharedPct:  Math.round((shared.length / total) * 100),
        compPct:    Math.round((compOnly / total) * 100)
      },
      shared:        shared,
      onlyYours:     onlyYours.map(k => ({ ...k, intent: detectIntent(k.keyword), difficulty: estimateDifficulty(k.keyword) })),
      onlyComp:      opportunities,
      quickWins,
      intentComparison
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   API 7 — KEYWORD GAP
============================================================ */
app.post('/api/keyword-gap', (req, res) => {
  try {
    const { yourKeywords = [], competitorKeywords = [] } = req.body;

    function parseList(input) {
      return input.map(item => {
        if (typeof item === 'object') return item;
        const parts = String(item).split(',').map(s => s.trim());
        return { keyword: parts[0], volume: parseInt(parts[1]) || 0 };
      }).filter(k => k.keyword && k.keyword.length > 1);
    }

    const yours = parseList(yourKeywords);
    const comps  = parseList(competitorKeywords);

    if (!yours.length || !comps.length)
      return res.status(400).json({ success: false, error: 'Both keyword lists are required' });

    const yourSet = new Set(yours.map(k => k.keyword.toLowerCase()));

    const gaps   = comps.filter(k => !yourSet.has(k.keyword.toLowerCase()))
      .map(k => ({ ...k, intent: detectIntent(k.keyword), difficulty: estimateDifficulty(k.keyword) }));

    const shared = comps.filter(k => yourSet.has(k.keyword.toLowerCase()))
      .map(k => ({ ...k, intent: detectIntent(k.keyword), difficulty: estimateDifficulty(k.keyword) }));

    const intentActions = {
      Transactional:  'Create a product or landing page',
      Commercial:     'Write a comparison or review post',
      Informational:  'Write a blog post or guide',
      Navigational:   'Optimise your brand or about page'
    };

    const gapsByIntent = {};
    gaps.forEach(k => {
      const intent = k.intent;
      if (!gapsByIntent[intent]) gapsByIntent[intent] = [];
      gapsByIntent[intent].push({ ...k, recommendedAction: intentActions[intent] });
    });

    const intentOrder = ['Transactional','Commercial','Informational','Navigational'];

    const quickWins = gaps.filter(k => k.difficulty === 'Easy')
      .sort((a, b) => (b.volume || 0) - (a.volume || 0))
      .slice(0, 15);

    const coverageRate = Math.round((shared.length / Math.max(comps.length, 1)) * 100);
    const gapRate      = Math.round((gaps.length   / Math.max(comps.length, 1)) * 100);

    res.json({
      success: true,
      stats: {
        yourKeywords:  yours.length,
        compKeywords:  comps.length,
        gaps:          gaps.length,
        shared:        shared.length,
        coverageRate,
        gapRate
      },
      gaps,
      shared,
      quickWins,
      gapsByIntent,
      intentOrder
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   API 8 — WIKIPEDIA ENTITY
============================================================ */
app.get('/api/wikipedia-entity', async (req, res) => {
  try {
    const topic = (req.query.topic || req.query.q || '').trim();
    if (!topic) return res.status(400).json({ success: false, error: 'No topic provided' });

    const encoded = encodeURIComponent(topic);
    const baseURL  = 'https://en.wikipedia.org';

    const [summaryRes, linksRes, catsRes] = await Promise.allSettled([
      fetch(`${baseURL}/api/rest_v1/page/summary/${encoded}`).then(r => r.json()),
      fetch(`${baseURL}/w/api.php?action=query&titles=${encoded}&prop=links&pllimit=50&format=json&origin=*`).then(r => r.json()),
      fetch(`${baseURL}/w/api.php?action=query&titles=${encoded}&prop=categories&cllimit=30&format=json&origin=*`).then(r => r.json())
    ]);

    const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : {};
    if (!summary.title) return res.status(404).json({ success: false, error: 'Topic not found on Wikipedia' });

    let relatedLinks = [];
    if (linksRes.status === 'fulfilled') {
      const pages = linksRes.value?.query?.pages || {};
      const page  = Object.values(pages)[0];
      relatedLinks = (page?.links || []).map(l => l.title).filter(t => !t.includes(':'));
    }

    let categories = [];
    if (catsRes.status === 'fulfilled') {
      const pages = catsRes.value?.query?.pages || {};
      const page  = Object.values(pages)[0];
      categories = (page?.categories || [])
        .map(c => c.title.replace('Category:',''))
        .filter(c => !c.startsWith('Articles') && !c.startsWith('Pages') && !c.startsWith('CS1') && !c.startsWith('Webarchive'));
    }

    const text = summary.extract || '';
    const entities = { people:[], organizations:[], places:[], dates:[], numbers:[] };

    const personPat = /(?:President|CEO|Director|Founder|Minister|General|Dr\.?|Prof\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g;
    let m;
    while ((m = personPat.exec(text)) !== null) {
      if (!entities.people.includes(m[1])) entities.people.push(m[1]);
    }

    const placeCountries = ['United States','United Kingdom','Germany','France','Japan','China','Australia','India'];
    placeCountries.forEach(c => { if (text.includes(c)) entities.places.push(c); });
    const inPat = /\bin\s+([A-Z][a-z]+(?:,\s*[A-Z][a-z]+)?)\b/g;
    while ((m = inPat.exec(text)) !== null) {
      const p = m[1].trim();
      if (p.length > 3 && !entities.places.includes(p)) entities.places.push(p);
    }

    const datePat = /\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\b\d{4}\b)/g;
    while ((m = datePat.exec(text)) !== null) {
      if (!entities.dates.includes(m[0])) entities.dates.push(m[0]);
    }

    const numPat = /\b(\d+(?:\.\d+)?(?:\s*(?:million|billion|trillion|thousand|percent|%|km|mi|kg|lb)))\b/gi;
    while ((m = numPat.exec(text)) !== null) {
      if (!entities.numbers.includes(m[0])) entities.numbers.push(m[0]);
    }

    const sentences = text.match(/[^.!?]+[.!?]/g) || [];
    const keyFacts  = sentences.filter(s => /\d/.test(s)).slice(0, 6).map(s => s.trim());

    res.json({
      success: true,
      topic:        summary.title,
      description:  summary.description,
      extract:      summary.extract,
      thumbnail:    summary.thumbnail?.source || null,
      url:          summary.content_urls?.desktop?.page || null,
      entities,
      relatedLinks: relatedLinks.slice(0, 40),
      categories:   categories.slice(0, 20),
      keyFacts
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   API 9 — BACKLINKS OVERVIEW
============================================================ */
app.post('/api/backlinks', (req, res) => {
  try {
    const { domain: rawDomain } = req.body;
    if (!rawDomain) return res.status(400).json({ success: false, error: 'No domain provided' });

    const domain = rawDomain.replace(/https?:\/\//,'').replace(/\/.*/,'').toLowerCase().replace(/^www\./,'');
    const parts = domain.split('.');
    const domainName = parts[0];
    const tld = parts.slice(1).join('.');

    function hasKw(keywords) {
      return keywords.some(kw =>
        domainName === kw || domainName.startsWith(kw) || domainName.endsWith(kw) ||
        domainName.includes('-' + kw) || domainName.includes(kw + '-')
      );
    }

    const isEdu        = tld === 'edu' || tld === 'ac.uk';
    const isNonProfit  = tld === 'org' || tld === 'ngo';
    const isLocal      = hasKw(['local','city','town','near','plumber','dentist','salon','restaurant','clinic','garage','bakery']);
    const isCommercial = hasKw(['shop','store','buy','deals','mart','market','price','cheap','sale','cart','boutique']);
    const isInfo       = hasKw(['blog','news','info','guide','learn','wiki','review','tips','times','post','journal','magazine','press','media','daily']);
    const isSaas       = hasKw(['app','tool','tools','soft','tech','digital','cloud','suite','platform','desk','base','stack','hub','api','dev','labs']) || tld === 'io';

    const domainType = isEdu ? 'Educational'
      : isNonProfit  ? 'Non-profit / Organisation'
      : isLocal      ? 'Local Business'
      : isCommercial ? 'E-commerce'
      : isInfo       ? 'Blog / Media'
      : isSaas       ? 'SaaS / Tech'
      : 'Business Website';

    const freeTools = [
      { name:'Google Search Console', url:`https://search.google.com/search-console`, badge:'Official', desc:'Official Google data — most accurate source for your own site.' },
      { name:'Ahrefs Free Backlink Checker', url:`https://ahrefs.com/backlink-checker?input=${encodeURIComponent(domain)}`, badge:'Free Tier', desc:'Top 100 backlinks for any domain. Shows DR score and anchor text.' },
      { name:'Moz Link Explorer', url:`https://moz.com/link-explorer?site=${encodeURIComponent(domain)}`, badge:'10 Free', desc:'10 free queries/month. Shows Domain Authority and linking domains.' },
      { name:'Semrush Backlink Analytics', url:`https://www.semrush.com/analytics/backlinks/?target=${encodeURIComponent(domain)}`, badge:'10/day', desc:'10 free requests/day. Toxicity scores and full backlink database.' },
      { name:'Majestic Free Tools', url:`https://majestic.com/reports/site-explorer?q=${encodeURIComponent(domain)}`, badge:'Free', desc:'Shows Trust Flow, Citation Flow and top backlinks.' },
      { name:'OpenLinkProfiler', url:`https://www.openlinkprofiler.org/r/${encodeURIComponent(domain)}`, badge:'100% Free', desc:'Completely free backlink checker for quick overviews.' }
    ];

    const anchorGuide = [
      { type:`Branded (${domainName})`, pct:40, note:'Most natural — your brand name as anchor text.' },
      { type:`Naked URL (${domain})`,   pct:20, note:'Plain URL as the clickable text.' },
      { type:'Generic (click here, read more)', pct:15, note:'Natural variation — not manipulative.' },
      { type:'Partial match keyword',   pct:15, note:'Contains keyword but not exact phrase.' },
      { type:'Exact match keyword',     pct:10, note:'Too many exact-match anchors triggers Google Penguin.' }
    ];

    const baseStrategies = [
      { icon:'fa-newspaper', priority:'High',   title:'Create Linkable Assets', desc:'Original research, data studies, free tools, infographics — content people naturally want to reference and link to.' },
      { icon:'fa-handshake', priority:'High',   title:'Guest Posting', desc:`Write expert articles for authoritative sites in your niche. Target DR 40+ sites. Include 1–2 contextual links back to relevant pages.` },
      { icon:'fa-bell',      priority:'Medium', title:'Brand Mention Monitoring', desc:`Set up Google Alerts for "${domainName}". When people mention you without linking, request the link.` },
      { icon:'fa-link',      priority:'Medium', title:'Broken Link Building', desc:'Find broken links on authority sites. Offer your content as a replacement. High acceptance rate.' },
      { icon:'fa-comments',  priority:'Medium', title:'HARO / Expert Quotes', desc:'Sign up at helpareporter.com. Respond to journalist queries in your niche for high-authority press links.' }
    ];

    const typeStrategies = {
      'E-commerce':              [{ icon:'fa-tag',      priority:'High',   title:'Product Review Outreach',         desc:'Send products to bloggers and YouTubers in your niche for honest reviews.' },
                                  { icon:'fa-list',     priority:'High',   title:'Get Listed on Comparison Sites',   desc:'Ensure you appear on G2, Capterra, Trustpilot, Product Hunt and industry directories.' }],
      'SaaS / Tech':             [{ icon:'fa-code',     priority:'High',   title:'Developer & Integration Partners', desc:'Build integrations with popular tools. Get listed in their marketplace or directory.' },
                                  { icon:'fa-trophy',   priority:'Medium', title:'Product Hunt Launch',              desc:'A successful launch earns tech blog coverage and a strong producthunt.com link.' }],
      'Blog / Media':            [{ icon:'fa-chart-bar',priority:'High',   title:'Original Data & Research',         desc:'Publish annual industry reports. Journalists and bloggers constantly link to primary data.' },
                                  { icon:'fa-users',    priority:'Medium', title:'Expert Roundups',                  desc:'Host roundup posts with industry expert quotes. They share and link back.' }],
      'Local Business':          [{ icon:'fa-map-pin',  priority:'High',   title:'Local Directory Citations',        desc:'Ensure consistent NAP across all local directories — Google Business, Yelp, Yell.com.' },
                                  { icon:'fa-building', priority:'High',   title:'Chamber of Commerce & Associations',desc:'Join your local chamber and industry associations for high-authority .org links.' }],
      'Educational':             [{ icon:'fa-graduation-cap', priority:'High', title:'.EDU Resource Pages',          desc:'Get listed on .edu resource pages by creating genuinely useful academic content.' }],
      'Non-profit / Organisation':[{ icon:'fa-heart',   priority:'High',   title:'Charity & Directory Listings',     desc:'List on charity directories and partner with related non-profits for cross-links.' }]
    };

    const strategies = [...(typeStrategies[domainType] || []), ...baseStrategies].slice(0, 7);

    res.json({
      success: true,
      domain,
      domainName,
      tld,
      domainType,
      freeTools,
      anchorGuide,
      strategies,
      analysisAreas: [
        { icon:'fa-star',             title:'Domain Rating / Authority', color:'#0ea5e9', what:'Score 0–100 showing backlink profile strength.',     good:'DR 50+ is strong. Under 20 needs significant link building.',  howToCheck:'Ahrefs Free Checker or Moz Link Explorer.' },
        { icon:'fa-sitemap',          title:'Referring Domains',         color:'#7c3aed', what:'Number of unique websites linking to you.',          good:'Quality matters more than quantity. 50 domains from 50 sites beats 500 from 1.', howToCheck:'Google Search Console > Links > Top linking sites.' },
        { icon:'fa-tag',              title:'Anchor Text Distribution',  color:'#f59e0b', what:'The clickable text used in links pointing to you.',  good:'Healthy mix: 40% branded, 20% naked URL, 15% generic, 15% partial, 10% exact.', howToCheck:'Ahrefs, Semrush or Majestic all show anchor breakdown.' },
        { icon:'fa-skull-crossbones', title:'Toxic / Spammy Links',      color:'#ef4444', what:'Links from low-quality sites that can hurt rankings.',good:'Use Google Disavow Tool if you have a manual penalty.',         howToCheck:'Semrush Backlink Audit (free trial available).' },
        { icon:'fa-chart-line',       title:'Link Velocity',             color:'#10b981', what:'The rate you gain or lose backlinks over time.',     good:'Steady organic growth is ideal. Sudden spikes look unnatural.', howToCheck:'Ahrefs "New & Lost" backlinks chart.' },
        { icon:'fa-file-alt',         title:'Linked Pages',              color:'#64748b', what:'Which of your pages receive the most backlinks.',   good:'Deep content pages with backlinks signal topical authority.',   howToCheck:'Google Search Console > Links > Top linked pages.' }
      ]
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   API 10 — KEYWORD TRACKING
============================================================ */
const TRACKING_FILE = path.join(__dirname, 'data', 'keyword-tracking.json');

function loadTrackingData() {
  try {
    const dir = path.dirname(TRACKING_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(TRACKING_FILE)) return {};
    return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
  } catch { return {}; }
}

function saveTrackingFile(data) {
  const dir = path.dirname(TRACKING_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/keyword-tracking', (req, res) => {
  try {
    res.json({ success: true, data: loadTrackingData() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/keyword-tracking', (req, res) => {
  try {
    const { keyword, position, url = '', date } = req.body;
    if (!keyword || !keyword.trim())
      return res.status(400).json({ success: false, error: 'No keyword provided' });
    const pos = parseInt(position);
    if (!pos || pos < 1 || pos > 200)
      return res.status(400).json({ success: false, error: 'Position must be 1–200' });
    const dt   = date || new Date().toISOString().split('T')[0];
    const data = loadTrackingData();
    const kw   = keyword.trim();
    if (!data[kw]) data[kw] = { url: '', entries: [] };
    if (url) data[kw].url = url.trim();
    data[kw].entries = data[kw].entries.filter(e => e.date !== dt);
    data[kw].entries.push({ date: dt, pos });
    data[kw].entries.sort((a, b) => a.date.localeCompare(b.date));
    saveTrackingFile(data);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/keyword-tracking/:keyword', (req, res) => {
  try {
    const kw   = decodeURIComponent(req.params.keyword);
    const data = loadTrackingData();
    if (!data[kw]) return res.status(404).json({ success: false, error: 'Keyword not found' });
    delete data[kw];
    saveTrackingFile(data);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/keyword-tracking', (req, res) => {
  try {
    saveTrackingFile({});
    res.json({ success: true, data: {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   ERROR HANDLING
============================================================ */
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found' }));

/* ============================================================
   START SERVER
============================================================ */
const PORT = process.env.PORT || 8001;
['uploads','public','data'].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

app.listen(PORT, () => {
  console.log(`\n🚀 ClusterSEO Pro API v4.0 — http://localhost:${PORT}`);
  console.log('─'.repeat(50));
  console.log('✅ POST /api/process-keywords    — Keyword Clustering');
  console.log('✅ POST /api/process-csv         — Keyword Clustering (file)');
  console.log('✅ GET  /api/suggest             — Keyword Research');
  console.log('✅ POST /api/extract-entities    — Entity Finder (FULLY UPDATED)');
  console.log('✅ POST /api/seo-audit           — SEO Audit (16 checks)');
  console.log('✅ POST /api/competitor-analysis — Competitor Analysis');
  console.log('✅ POST /api/keyword-gap         — Keyword Gap');
  console.log('✅ GET  /api/wikipedia-entity    — Wikipedia Entities');
  console.log('✅ POST /api/backlinks           — Backlinks Overview');
  console.log('✅ GET  /api/keyword-tracking    — Load Tracking Data');
  console.log('✅ POST /api/keyword-tracking    — Save Tracking Data');
  console.log('✅ DELETE /api/keyword-tracking  — Clear All Tracking');
  console.log('✅ GET  /api/test                — Health check');
  console.log('─'.repeat(50));
  console.log(`📁 Static files from /public`);
  console.log(`📁 Tracking data saved to /data/keyword-tracking.json\n`);
});