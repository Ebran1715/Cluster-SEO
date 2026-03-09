import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';
// Add this near the top with your other imports and configs
const PSI_CACHE = new Map();
const PSI_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours cache

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static('public'));

const storage = multer.diskStorage({ destination:'uploads/', filename:(req,file,cb)=>cb(null,`${Date.now()}-${file.originalname}`) });
const upload  = multer({ storage, limits:{ fileSize:50*1024*1024 }, fileFilter:(req,file,cb)=>{ const ext=path.extname(file.originalname).toLowerCase(); ['.csv','.txt'].includes(ext)?cb(null,true):cb(new Error('Only CSV/TXT')); } });


/* ================================================================
   GOOGLE SEARCH CONSOLE — OAuth 2.0 Config
================================================================ */
const GSC_CLIENT_ID     = process.env.GSC_CLIENT_ID     || '986583218091-6j8gvs5uirg3vla290ip0douh4oqu752.apps.googleusercontent.com';
const GSC_CLIENT_SECRET = process.env.GSC_CLIENT_SECRET || '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';
const GSC_REDIRECT_URI  = process.env.GSC_REDIRECT_URI  || 'http://localhost:8003/auth/callback';
const GSC_TOKEN_FILE    = path.join(__dirname, 'data', 'gsc_token.json');
const GSC_SCOPES        = 'https://www.googleapis.com/auth/webmasters.readonly';

function loadGSCToken() {
  try { return fs.existsSync(GSC_TOKEN_FILE) ? JSON.parse(fs.readFileSync(GSC_TOKEN_FILE,'utf8')) : null; }
  catch{ return null; }
}
function saveGSCToken(token) {
  if(!fs.existsSync('data')) fs.mkdirSync('data',{recursive:true});
  fs.writeFileSync(GSC_TOKEN_FILE, JSON.stringify(token,null,2));
}

async function getValidAccessToken() {
  let token = loadGSCToken();
  if (!token) throw new Error('NOT_CONNECTED');
  // Refresh if expired (expires_at is ms timestamp)
  if (token.expires_at && Date.now() > token.expires_at - 60000) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        client_id:     GSC_CLIENT_ID,
        client_secret: GSC_CLIENT_SECRET,
        refresh_token: token.refresh_token,
        grant_type:    'refresh_token'
      })
    });
    const data = await r.json();
    if (data.error) throw new Error('Token refresh failed: ' + data.error);
    token.access_token = data.access_token;
    token.expires_at   = Date.now() + (data.expires_in||3600)*1000;
    saveGSCToken(token);
  }
  return token.access_token;
}

/* ── Auth Routes ── */

// Step 1: redirect user to Google login
app.get('/auth/google', (req,res)=>{
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id:     GSC_CLIENT_ID,
    redirect_uri:  GSC_REDIRECT_URI,
    response_type: 'code',
    scope:         GSC_SCOPES,
    access_type:   'offline',
    prompt:        'consent'
  });
  res.redirect(url);
});

// Step 2: Google redirects back here with ?code=
app.get('/auth/callback', async (req,res)=>{
  const { code, error } = req.query;
  if (error) return res.send(`<script>window.opener&&window.opener.postMessage({gsc:'error',msg:'${error}'},'*');window.close();</script>`);
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        code, client_id:GSC_CLIENT_ID, client_secret:GSC_CLIENT_SECRET,
        redirect_uri:GSC_REDIRECT_URI, grant_type:'authorization_code'
      })
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    saveGSCToken({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + (data.expires_in||3600)*1000
    });
    res.send(`<script>window.opener&&window.opener.postMessage({gsc:'success'},'*');window.close();</script>`);
  } catch(e){
    res.send(`<script>window.opener&&window.opener.postMessage({gsc:'error',msg:'${e.message}'},'*');window.close();</script>`);
  }
});

// Step 3: check connection status
app.get('/auth/status', (req,res)=>{
  const token = loadGSCToken();
  res.json({ connected: !!token });
});

// Step 4: disconnect
app.post('/auth/disconnect', (req,res)=>{
  try { if(fs.existsSync(GSC_TOKEN_FILE)) fs.unlinkSync(GSC_TOKEN_FILE); } catch{}
  res.json({ success:true });
});

/* ── GSC Data APIs ── */

// List all verified sites
app.get('/api/gsc/sites', async (req,res)=>{
  try {
    const token = await getValidAccessToken();
    const r = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    res.json({ success:true, sites: (data.siteEntry||[]).map(s=>s.siteUrl) });
  } catch(e){
    if(e.message==='NOT_CONNECTED') return res.json({success:false,error:'NOT_CONNECTED'});
    res.status(500).json({success:false,error:e.message});
  }
});

// Get top keywords for a site
app.get('/api/gsc/keywords', async (req,res)=>{
  try {
    const { site, days=90, limit=100 } = req.query;
    if (!site) return res.status(400).json({success:false,error:'site required'});
    const token = await getValidAccessToken();
    const endDate   = new Date(); endDate.setDate(endDate.getDate()-2); // GSC lags 2 days
    const startDate = new Date(); startDate.setDate(startDate.getDate()-parseInt(days)-2);
    const fmt = d => d.toISOString().split('T')[0];
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        startDate: fmt(startDate), endDate: fmt(endDate),
        dimensions: ['query'],
        rowLimit: parseInt(limit),
        orderBy: [{ field:'impressions', sortOrder:'DESCENDING' }]
      })
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const keywords = (data.rows||[]).map(row=>({
      keyword:    row.keys[0],
      clicks:     row.clicks,
      impressions:row.impressions,
      ctr:        parseFloat((row.ctr*100).toFixed(1)),
      position:   parseFloat(row.position.toFixed(1))
    }));
    res.json({ success:true, keywords, site, dateRange:`${fmt(startDate)} → ${fmt(endDate)}` });
  } catch(e){
    if(e.message==='NOT_CONNECTED') return res.json({success:false,error:'NOT_CONNECTED'});
    res.status(500).json({success:false,error:e.message});
  }
});

// Get top pages for a site
app.get('/api/gsc/pages', async (req,res)=>{
  try {
    const { site, days=90 } = req.query;
    if (!site) return res.status(400).json({success:false,error:'site required'});
    const token = await getValidAccessToken();
    const endDate   = new Date(); endDate.setDate(endDate.getDate()-2);
    const startDate = new Date(); startDate.setDate(startDate.getDate()-parseInt(days)-2);
    const fmt = d => d.toISOString().split('T')[0];
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        startDate: fmt(startDate), endDate: fmt(endDate),
        dimensions: ['page'],
        rowLimit: 50,
        orderBy: [{ field:'clicks', sortOrder:'DESCENDING' }]
      })
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const pages = (data.rows||[]).map(row=>({
      page:       row.keys[0],
      clicks:     row.clicks,
      impressions:row.impressions,
      ctr:        parseFloat((row.ctr*100).toFixed(1)),
      position:   parseFloat(row.position.toFixed(1))
    }));
    res.json({ success:true, pages });
  } catch(e){
    if(e.message==='NOT_CONNECTED') return res.json({success:false,error:'NOT_CONNECTED'});
    res.status(500).json({success:false,error:e.message});
  }
});

// Performance over time (for charts)
app.get('/api/gsc/performance', async (req,res)=>{
  try {
    const { site, days=90 } = req.query;
    if (!site) return res.status(400).json({success:false,error:'site required'});
    const token = await getValidAccessToken();
    const endDate   = new Date(); endDate.setDate(endDate.getDate()-2);
    const startDate = new Date(); startDate.setDate(startDate.getDate()-parseInt(days)-2);
    const fmt = d => d.toISOString().split('T')[0];
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        startDate: fmt(startDate), endDate: fmt(endDate),
        dimensions: ['date'],
        rowLimit: 90
      })
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const rows = (data.rows||[]).map(row=>({
      date:        row.keys[0],
      clicks:      row.clicks,
      impressions: row.impressions,
      ctr:         parseFloat((row.ctr*100).toFixed(1)),
      position:    parseFloat(row.position.toFixed(1))
    }));
    res.json({ success:true, rows });
  } catch(e){
    if(e.message==='NOT_CONNECTED') return res.json({success:false,error:'NOT_CONNECTED'});
    res.status(500).json({success:false,error:e.message});
  }
});

/* ================================================================
   SHARED NLP HELPERS
================================================================ */
const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from',
  'as','is','was','were','be','been','have','has','had','do','does','did','will',
  'would','could','should','may','might','that','this','these','those','it','its',
  'we','our','you','your','they','their','he','she','his','her','i','my','me','us',
  'him','them','who','which','what','when','where','how','why','not','also','more',
  'most','some','any','all','each','other','into','than','then','there','here','so',
  'if','about','after','before','just','only','very','can','no','new','one','two',
  'three','first','last','same','such','company','companies','include','includes',
  'including','american','british','french','chinese','german','global','international',
  'national','headquartered','incorporated','multinational','products','product',
  'founded','launched','made','make','sold','sells','develop','developed','designs',
  'began','became','become','over','recent','major','currently','quickly','highly',
  'alongside','making','inc','ltd','llc','corp','corporation','per','being','both',
  'between','through','during','against','across','without','within','along',
  'following','behind','beyond','plus','except','around','down','above','below',
  'since','used','using','use','well','way','part','often','many','even','still',
  'back','however','therefore','thus','although','though','while','because','like',
  'year','years','time','times','said','says','say','told','according','now',
  'already','always','never','often','usually','recently','currently','today',
  'early','late','shortly','soon','finally','meanwhile','another','several'
]);

function detectIntent(kw) {
  const k = kw.toLowerCase().trim();
  if (/\b(buy|purchase|order|shop|price|cost|cheap|discount|deal|coupon|promo|sale|pricing|affordable|checkout|cart|hire|subscribe|download|free trial|sign up|register|get quote|near me|book|booking|rent|rental|apply|enroll|join now|get started|try free|demo|install|shipping|delivery|for sale)\b/.test(k)) return 'Transactional';
  if (/\b(best|top|review|reviews|compare|comparison|vs|versus|rated|recommended|ranking|alternative|alternatives|pros and cons|worth it|should i|which is better|cheapest|leading|premium|budget|difference between|guide to choosing|best value|top rated|highly rated|most popular)\b/.test(k)) return 'Commercial';
  // Navigational: only if the ENTIRE query is clearly a brand/site lookup, not a tutorial/guide
  if (/\b(login|log in|sign in|account|official site|official website|app|portal|dashboard|customer service|phone number|address|location|hours|directions|home page)\b/.test(k)) return 'Navigational';
  // Brand-only queries (single brand name with no action words)
  if (/^(facebook|twitter|instagram|linkedin|youtube|reddit|wikipedia|amazon|apple|microsoft|netflix|spotify|gmail|google|tiktok|snapchat|pinterest)$/.test(k)) return 'Navigational';
  return 'Informational';
}

function estimateDifficulty(kw) {
  const words = kw.trim().split(/\s+/).length;
  const hasCommercial = /\b(best|buy|review|top|cheap|vs|compare|price)\b/i.test(kw);
  if (words === 1 || hasCommercial)  return { label:'Hard',   color:'#ef4444', score:85 };
  if (words === 2)                   return { label:'Medium', color:'#f59e0b', score:55 };
  if (words === 3)                   return { label:'Low',    color:'#10b981', score:30 };
  return                                    { label:'Easy',   color:'#059669', score:15 };
}

function recommendPageType(kw, intent) {
  const k = kw.toLowerCase();
  if (intent === 'Transactional') return /\b(service|hire|agency|consult|coaching)\b/.test(k) ? 'Service Page' : 'Product / Landing Page';
  if (intent === 'Commercial')    return 'Comparison / Review Article';
  if (intent === 'Navigational')  return 'Brand / About Page';
  if (/\b(how|steps|ways|tips|guide|tutorial|learn|setup|configure|install|create|make|build|write|start)\b/.test(k)) return 'How-to / Guide';
  if (/\b(list|best|top|ideas|examples|tools|resources|options|types)\b/.test(k)) return 'Listicle / Roundup';
  if (/\b(what is|what are|definition|meaning|explained|overview|introduction|beginners)\b/.test(k)) return 'Informational / Pillar Page';
  return 'Blog Post / Article';
}

function funnelStage(intent) {
  return { Transactional:'Decision', Commercial:'Consideration', Navigational:'Decision', Informational:'Awareness' }[intent] || 'Awareness';
}

function clusterKey(kw) {
  return kw.toLowerCase()
    .replace(/^(best|top|cheap|buy|how to|what is|what are|how do i|review of|guide to|tips for|list of|\d+ )/g, '')
    .replace(/( reviews?| prices?| costs?| guide| tips| tutorial| vs\.?.*| for (beginners?|dummies|kids|professionals?|business)| near me| online| free| download| examples?| tools?| software| app)$/g, '')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s{2,}/g, ' ').trim()
    .split(/\s+/).slice(0, 3).join(' ');
}

function buildClusters(kwObjs) {
  const map = {};
  kwObjs.forEach(kw => {
    const key = clusterKey(kw.keyword);
    if (!map[key]) map[key] = { clusterName: key.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' '), keywords:[], totalVolume:0 };
    map[key].keywords.push(kw);
    map[key].totalVolume += kw.volume||0;
  });
  return Object.values(map).map(c => {
    const intents = {};
    c.keywords.forEach(k => { intents[k.intent]=(intents[k.intent]||0)+1; });
    const dom    = Object.entries(intents).sort((a,b)=>b[1]-a[1])[0][0];
    const pillar = [...c.keywords].sort((a,b)=>(b.volume||0)-(a.volume||0))[0];
    const hasMedium = c.keywords.some(k=>k.difficulty.label==='Easy'||k.difficulty.label==='Low');
    return { clusterName:c.clusterName, pillarKeyword:pillar.keyword, keywords:c.keywords, totalVolume:c.totalVolume, keywordCount:c.keywords.length, dominantIntent:dom, opportunity: hasMedium&&c.totalVolume>100?'High':c.keywords.length>2?'Medium':'Low', pageType:recommendPageType(pillar.keyword,dom) };
  }).sort((a,b)=>b.totalVolume-a.totalVolume||b.keywordCount-a.keywordCount);
}

/* ================================================================
   ROUTES
================================================================ */
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/api/test',(req,res)=>res.json({success:true,message:'ClusterSEO Pro API v6.0',version:'6.0'}));

/* API 1 — KEYWORD CLUSTERING */
app.post('/api/process-keywords', (req,res)=>{
  try {
    const { keywords=[], volumes=[] } = req.body;
    if (!keywords.length) return res.status(400).json({success:false,error:'No keywords provided'});
    const vols = volumes.length===keywords.length ? volumes.map(v=>Number(v)||0) : new Array(keywords.length).fill(0);
    const kwObjs = keywords.map((kw,i)=>{ const intent=detectIntent(kw); return { keyword:kw.trim(), volume:vols[i], intent, difficulty:estimateDifficulty(kw), pageType:recommendPageType(kw,intent) }; });
    const byIntent = { Informational:[], Transactional:[], Commercial:[], Navigational:[] };
    kwObjs.forEach(k=>byIntent[k.intent].push(k));
    const clusters = buildClusters(kwObjs);
    const totalVol = vols.reduce((a,b)=>a+b,0);
    res.json({ success:true, keywordsByIntent:byIntent, clusters, allKeywords:kwObjs, stats:{ totalKeywords:keywords.length, totalClusters:clusters.length, totalVolume:totalVol, topOpportunity:clusters.filter(c=>c.opportunity==='High').length, intentDistribution:{ Informational:byIntent.Informational.length, Transactional:byIntent.Transactional.length, Commercial:byIntent.Commercial.length, Navigational:byIntent.Navigational.length } } });
  } catch(err){ res.status(500).json({success:false,error:err.message}); }
});

/* API 2 — PROCESS CSV */
app.post('/api/process-csv', upload.single('file'), (req,res)=>{
  try {
    if (!req.file) return res.status(400).json({success:false,error:'No file uploaded'});
    const lines = fs.readFileSync(req.file.path,'utf8').split('\n').map(l=>l.trim()).filter(Boolean);
    fs.unlinkSync(req.file.path);
    const keywords=[], volumes=[];
    lines.forEach((line,i)=>{ if(i===0&&/keyword/i.test(line))return; const parts=line.split(',').map(p=>p.replace(/^["']|["']$/g,'').trim()); if(parts[0]&&isNaN(parts[0])){ keywords.push(parts[0]); volumes.push(parseInt(parts[1])||0); } });
    const kwObjs = keywords.map((kw,i)=>{ const intent=detectIntent(kw); return {keyword:kw,volume:volumes[i],intent,difficulty:estimateDifficulty(kw),pageType:recommendPageType(kw,intent)}; });
    const byIntent={Informational:[],Transactional:[],Commercial:[],Navigational:[]};
    kwObjs.forEach(k=>byIntent[k.intent].push(k));
    const clusters=buildClusters(kwObjs);
    const totalVol=volumes.reduce((a,b)=>a+b,0);
    res.json({success:true,keywordsByIntent:byIntent,clusters,allKeywords:kwObjs,stats:{totalKeywords:keywords.length,totalClusters:clusters.length,totalVolume:totalVol,topOpportunity:clusters.filter(c=>c.opportunity==='High').length,intentDistribution:{Informational:byIntent.Informational.length,Transactional:byIntent.Transactional.length,Commercial:byIntent.Commercial.length,Navigational:byIntent.Navigational.length}}});
  } catch(err){ res.status(500).json({success:false,error:err.message}); }
});

/* API 3 — KEYWORD RESEARCH */
const COUNTRY_PARAMS = { us:{gl:'us',hl:'en'}, gb:{gl:'gb',hl:'en'}, au:{gl:'au',hl:'en'}, ca:{gl:'ca',hl:'en'}, in:{gl:'in',hl:'en'}, np:{gl:'np',hl:'ne'}, global:{gl:'',hl:'en'} };

async function fetchSuggest(query, gl='', hl='en') {
  try {
    const params = new URLSearchParams({client:'firefox',q:query});
    if(gl) params.set('gl',gl); if(hl) params.set('hl',hl);
    const r = await fetch(`https://suggestqueries.google.com/complete/search?${params}`,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(4000)});
    const p = JSON.parse(await r.text());
    return Array.isArray(p)&&Array.isArray(p[1])?p[1]:[];
  } catch { return []; }
}

app.get('/api/suggest', async (req,res)=>{
  try {
    const q = (req.query.q||'').trim();
    if (!q) return res.status(400).json({success:false,error:'No query provided'});
    const {gl,hl} = COUNTRY_PARAMS[(req.query.country||'global').toLowerCase()]||COUNTRY_PARAMS.global;
    const yr = new Date().getFullYear();
    const variants = [q,`what is ${q}`,`how to ${q}`,`why ${q}`,`how does ${q} work`,`what are the best ${q}`,`how much does ${q} cost`,`when to use ${q}`,`where to find ${q}`,`who uses ${q}`,`which ${q}`,`can you ${q}`,`should i ${q}`,`is ${q} worth it`,`does ${q} work`,`best ${q}`,`${q} review`,`${q} vs`,`${q} alternatives`,`top ${q}`,`${q} comparison`,`cheapest ${q}`,`${q} pricing`,`${q} pros and cons`,`buy ${q}`,`${q} price`,`${q} for sale`,`${q} discount`,`${q} near me`,`book ${q}`,`hire ${q}`,`best ${q} ${yr}`,`${q} ${yr}`,`${q} for beginners`,`${q} for small business`,`${q} for free`,`${q} without`,`${q} tips`,`${q} guide`,`${q} tutorial`,`${q} examples`,`${q} tools`,`${q} software`,...'abcdefghijklmnopqrstuvwxyz'.split('').map(l=>`${q} ${l}`)];
    const results = await Promise.allSettled(variants.map(v=>fetchSuggest(v,gl,hl).then(s=>({variant:v,suggestions:s}))));
    const seen = new Set(), keywords = [];
    const qStarters = new Set(['what','how','why','when','where','who','which','can','does','is','are','do','should','will','would']);
    results.forEach(r=>{ if(r.status!=='fulfilled') return; r.value.suggestions.forEach(kw=>{ const key=kw.toLowerCase().trim(); if(!seen.has(key)&&key.length>2&&key!==q.toLowerCase()){ seen.add(key); const intent=detectIntent(kw); const diff=estimateDifficulty(kw); const fw=key.split(' ')[0]; const type=qStarters.has(fw)?'Question':intent==='Transactional'?'Transactional':intent==='Commercial'?'Commercial':'Informational'; keywords.push({keyword:kw.trim(),source:r.value.variant,intent,difficulty:diff.label,type,pageType:recommendPageType(kw,intent)}); } }); });
    const grouped = { Question:keywords.filter(k=>k.type==='Question'), Commercial:keywords.filter(k=>k.type==='Commercial'), Transactional:keywords.filter(k=>k.type==='Transactional'), Informational:keywords.filter(k=>k.type==='Informational') };
    res.json({success:true,keywords,grouped,total:keywords.length});
  } catch(err){ res.status(500).json({success:false,error:err.message}); }
});

/* ================================================================
   API 4 — ENTITY EXTRACTION  v6 — Hugging Face NLP + Regex Fallback
   Primary  : Hugging Face dslim/bert-base-NER (free, no API key needed)
   Secondary: Wink NLP (lightweight, runs on your server)
   Fallback  : Enhanced regex (always works, no internet needed)
   Set HF_API_KEY in your .env for higher rate limits (optional)
================================================================ */
app.post('/api/extract-entities', async (req,res)=>{
  try {
    const { text: rawText } = req.body;
    if (!rawText||!rawText.trim()) return res.status(400).json({success:false,error:'No text provided'});

    /* ── Shared helpers ── */
    const wordCount = rawText.split(/\s+/).filter(w=>w.length>0).length;

    /* ══════════════════════════════════════════════════════════
       STRATEGY 1 — Hugging Face FREE Inference API
       Model: dslim/bert-base-NER  (best free NER model)
       Rate limit: ~1000 req/day free without key, unlimited with key
    ══════════════════════════════════════════════════════════ */
    const HF_KEY   = process.env.HF_API_KEY || '';
    const HF_MODEL = 'dslim/bert-base-NER';
    const HF_URL   = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

    async function tryHuggingFace(text) {
      // HF has 512 token limit — split long text into chunks
      const CHUNK = 400; // words per chunk
      const words = text.split(/\s+/);
      const chunks = [];
      for(let i=0;i<words.length;i+=CHUNK) chunks.push(words.slice(i,i+CHUNK).join(' '));

      const headers = { 'Content-Type':'application/json' };
      if(HF_KEY) headers['Authorization'] = `Bearer ${HF_KEY}`;

      const allEnts = [];
      for(const chunk of chunks){
        const resp = await fetch(HF_URL,{
          method:'POST',
          headers,
          body: JSON.stringify({ inputs: chunk, options:{ wait_for_model:true } }),
          signal: AbortSignal.timeout(15000)
        });
        if(!resp.ok){
          const err = await resp.text();
          throw new Error(`HF API error ${resp.status}: ${err.slice(0,200)}`);
        }
        const data = await resp.json();
        if(!Array.isArray(data)) throw new Error('HF returned non-array: '+JSON.stringify(data).slice(0,200));
        allEnts.push(...data);
      }
      return allEnts;
    }

    /* ── Merge consecutive tokens from BERT (##word → full word) ── */
    function mergeHFEntities(rawEnts) {
      const merged = [];
      let current = null;
      for(const ent of rawEnts){
        const word   = (ent.word||'').replace(/^##/,'');
        const tag    = (ent.entity||'').replace(/^[BI]-/,'');
        const isNext = ent.entity?.startsWith('I-') && current && (ent.entity||'').replace(/^I-/,'')===tag;
        if(isNext){
          // continuation token — append to current word
          current.word = current.word + (ent.word?.startsWith('##') ? '' : ' ') + word;
        } else {
          if(current) merged.push(current);
          current = { word, tag, score: ent.score||0 };
        }
      }
      if(current) merged.push(current);
      return merged.filter(e=>e.word.trim().length>1 && e.score>0.7);
    }

    /* ── Map HF NER tags to our categories ── */
    function mapHFToCategories(mergedEnts, rawText) {
      const entities = { people:[], organizations:[], places:[], brands:[], concepts:[] };
      const freq = {};
      const countF = n => { const k=n.toLowerCase(); freq[k]=Math.max(freq[k]||0, rawText.toLowerCase().split(k).length-1); };
      const seen = { people:new Set(), organizations:new Set(), places:new Set(), brands:new Set() };
      const addE = (cat, val) => {
        val = val?.trim().replace(/^['"]+|['".,;:!?]+$/g,'').trim();
        if(!val||val.length<2) return;
        const key = val.toLowerCase();
        if(seen[cat]?.has(key)) return;
        seen[cat]?.add(key);
        entities[cat].push(val);
        countF(val);
      };

      // Known brand names that HF may tag as ORG or MISC
      const BRAND_NAMES = new Set(['iPhone','iPad','MacBook','iMac','Apple Watch','AirPods','iCloud','Apple Music','Android','Pixel','Chrome','Gmail','Windows','Surface','Xbox','Teams','Office','Kindle','Alexa','Echo','AWS','Instagram','Twitter','WhatsApp','Threads','Starship','Falcon 9','Dragon','Starlink','Galaxy','Galaxy S','PlayStation','PS5','ChatGPT','GPT-4','Gemini','Copilot','Claude','H100','A100','Cybertruck','Model Y','Model 3','Model S','Model X','iOS','macOS','watchOS','visionOS','Siri','Cortana','Bixby']);

      for(const ent of mergedEnts){
        const w = ent.word.trim();
        if(!w||w.length<2) continue;
        // Clean up HF artifacts
        const clean = w.replace(/\s+/g,' ').replace(/^[^A-Za-z]+/,'').trim();
        if(!clean) continue;

        if(ent.tag==='PER'){
          addE('people', clean);
        } else if(ent.tag==='LOC'){
          addE('places', clean);
        } else if(ent.tag==='ORG'){
          if(BRAND_NAMES.has(clean)) addE('brands', clean);
          else addE('organizations', clean);
        } else if(ent.tag==='MISC'){
          // MISC = products, languages, events
          if(BRAND_NAMES.has(clean)) addE('brands', clean);
          else if(/^[A-Z]/.test(clean)) addE('brands', clean);
        }
      }

      // Also scan for known brands that HF may miss
      const KNOWN_BRANDS = ['iPhone','iPad','MacBook','iMac','Mac Pro','Apple Watch','AirPods','AirPods Pro','Apple TV','HomePod','iTunes','iCloud','Apple Music','Apple TV+','App Store','FaceTime','Siri','Android','Pixel','Chrome','Gmail','Google Maps','Google Drive','Windows','Surface','Xbox','Teams','Office','Kindle','Alexa','Echo','AWS','Instagram','Twitter','WhatsApp','Messenger','Threads','Model S','Model 3','Model X','Model Y','Cybertruck','Powerwall','Starship','Falcon 9','Starlink','Galaxy','Galaxy S','Galaxy S23','Galaxy S24','PlayStation','PS5','PS4','Xbox Series X','Nintendo Switch','ChatGPT','GPT-4','GPT-3','DALL-E','Gemini','Copilot','Claude','Midjourney','Stable Diffusion','H100','A100','RTX 4090','iOS','macOS','watchOS','visionOS'];
      KNOWN_BRANDS.forEach(b=>{ if(rawText.includes(b)&&!entities.brands.some(e=>e.toLowerCase()===b.toLowerCase())) addE('brands',b); });

      // Compute concepts from text
      const STOPWORDS=new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','that','this','these','those','it','its','we','our','you','your','they','their','he','she','his','her','i','my','me','us','him','them','who','which','what','when','where','how','why','not','also','more','most','some','any','all','each','other','into','than','then','there','here','so','if','about','after','before','just','only','very','can','no','new','one','two','three','first','last','same','such','over','per','both','through','during','against','since','without','within','along','following','across','behind','beyond','plus','except','up','down','out','off','above','below','between','under','again','further','once','said','says','say','told','according','now','already','always','never','often','usually','recently','today','early','late','another','several']);
      const CS=new Set(['prime','minister','president','announced','according','confirmed','meeting','signed','joined','posted','scored','playing','career','historic','launched','unveiled','arrived','worked','started','called','calling','using','making','asked','added','stated','celebrated','invested','working','including','developed','running','powered','planned','named','based','taken','given','shown','built','found','used','held','made','went','came','became','happened','spent','brought','praised','during','series','century','defeated','visionary','leader','expressed','condolences','attending','saying','telling','noting','confirming','expressing','producing','investing','operating','opening','closing','winning','losing']);
      const allWords=new Set();
      [...entities.people,...entities.organizations,...entities.places,...entities.brands].forEach(e=>{allWords.add(e.toLowerCase());e.toLowerCase().split(/\s+/).forEach(w=>{if(w.length>2)allWords.add(w);});});
      const wf={};
      rawText.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w=>w.length>4&&!STOPWORDS.has(w)&&!allWords.has(w)&&!/^\d+$/.test(w)&&!CS.has(w)).forEach(w=>{wf[w]=(wf[w]||0)+1;});
      entities.concepts=Object.entries(wf).filter(([,c])=>c>=2).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([w,c])=>w.charAt(0).toUpperCase()+w.slice(1)+' ('+c+'x)');

      // Sort by frequency
      Object.keys(entities).forEach(k=>{
        if(k==='concepts') return;
        entities[k]=entities[k].sort((a,b)=>(freq[b.toLowerCase()]||0)-(freq[a.toLowerCase()]||0)||a.localeCompare(b)).slice(0,30);
      });

      return { entities, freq };
    }

    /* ══════════════════════════════════════════════════════════
       STRATEGY 2 — Enhanced Regex Fallback
       Used when HF API is unavailable or rate-limited
    ══════════════════════════════════════════════════════════ */
    function regexFallback(rawText) {
      const text = rawText.replace(/\r?\n+/g,' ').replace(/\s{2,}/g,' ').trim();
      const MONTHS=new Set(['January','February','March','April','May','June','July','August','September','October','November','December']);
      const DAYS=new Set(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']);
      const TITLE_ABB=new Set(['CEO','COO','CFO','CTO','CMO','EVP','SVP','VP','HR','PR','US','UK','EU','UN','NATO','WHO','IMF','FBI','CIA','NASA','NFL','NBA','NHL','MLB','UFC','IPL','ICC','ODI','T20','GDP','G7','G20','BRICS','GPU','CPU','RAM','USB','HTML','CSS','API','SEO','AI','ML','UI','UX','VR','AR','IP','DO','BC','AD','CO','OR','IF','AS','AT','BY','IN','OF','ON','TO','AN','BE','IT','IS','NO','SO','UP','WE','HE','VS','ST','RD','ND','TH']);
      const SKIP_WORD=new Set(['The','This','That','These','Those','A','An','He','She','It','We','They','Their','Its','Our','His','Her','My','Your','Some','Any','Each','All','Both','Few','Many','More','Most','Other','Such','Same','Only','Also','Just','Very','Even','New','Old','Big','Small','Great','Good','High','Low','Long','Short','Next','Last','First','Second','Third','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','While','After','Before','During','Since','Until','Although','Because','However','Therefore','Moreover','Furthermore','Meanwhile']);
      const SKIP_OF=new Set([...SKIP_WORD,...MONTHS,...DAYS]);
      const ORG_WORDS=new Set(['Council','Committee','Board','Association','Organization','Organisation','Federation','Union','Institute','Foundation','Commission','Corporation','Department','Ministry','Agency','Bureau','Authority','Office','Court','Parliament','Senate','Congress','Assembly','Coalition','Alliance','Group','Holdings','Industries','Enterprises','Services','Solutions','Systems','Technologies','University','College','Hospital','Bank','Exchange','Press','Media','Trust','Consortium','Ventures','Capital','Partners','Labs','Studios']);
      const STOPWORDS=new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','that','this','these','those','it','its','we','our','you','your','they','their','he','she','his','her','i','my','me','us','him','them','who','which','what','when','where','how','why','not','also','more','most','some','any','all','each','other','into','than','then','there','here','so','if','about','after','before','just','only','very','can','no','new','one','two','three','first','last','same','such','over','per','both','through','during','against','since','without','within','along','following','across','said','says','told','according','now','already','always','never','often','recently','today','early','late','another','several']);
      const KP=['Africa','Asia','Europe','Middle East','North America','South America','Latin America','Oceania','United States of America','United States','United Kingdom','Germany','France','Japan','China','Australia','Canada','India','Brazil','Russia','Italy','Spain','Netherlands','Sweden','Norway','Denmark','Finland','Switzerland','Belgium','Austria','Ireland','Portugal','Greece','Turkey','Poland','Ukraine','Czech Republic','Hungary','Romania','Singapore','New Zealand','South Africa','Mexico','Argentina','Colombia','Chile','Peru','South Korea','North Korea','Indonesia','Philippines','Thailand','Vietnam','Malaysia','Bangladesh','Pakistan','Saudi Arabia','UAE','United Arab Emirates','Kuwait','Qatar','Bahrain','Oman','Jordan','Lebanon','Israel','Egypt','Libya','Morocco','Tunisia','Algeria','Nigeria','Kenya','Ethiopia','Ghana','Tanzania','Uganda','Rwanda','Zimbabwe','California','New York','Texas','Washington','Florida','Georgia','Colorado','Illinois','Massachusetts','Pennsylvania','Ohio','Michigan','Arizona','Tennessee','North Carolina','Virginia','Maryland','New Jersey','Minnesota','Wisconsin','Nevada','Oregon','Connecticut','Iowa','Utah','Missouri','Indiana','Kentucky','Louisiana','New Mexico','Hawaii','Alaska','London','Tokyo','Paris','Berlin','Sydney','Shanghai','Beijing','Toronto','Vancouver','Dubai','Mumbai','Delhi','Seoul','Amsterdam','Stockholm','Zurich','Vienna','Dublin','Madrid','Rome','Prague','Warsaw','Budapest','Lisbon','Athens','Helsinki','Oslo','Copenhagen','Hong Kong','Bangkok','Jakarta','Manila','Kuala Lumpur','Houston','Austin','Seattle','Boston','Chicago','Los Angeles','San Francisco','Miami','Atlanta','Denver','Phoenix','Portland','Las Vegas','Nashville','San Diego','Dallas','Minneapolis','Detroit','New York City','Washington D.C.','Silicon Valley','Wall Street','Palo Alto','Mountain View','Cupertino','San Jose','Redmond','Bangalore','Chennai','Kolkata','Pune','Hyderabad','Karachi','Lahore','Islamabad','Dhaka','Cairo','Lagos','Nairobi','Cape Town','Johannesburg','Casablanca','Buenos Aires','Santiago','Bogota','Lima','Osaka','Taipei','Munich','Hamburg','Frankfurt','Barcelona','Lyon','Milan','Edinburgh','Manchester','Birmingham','Liverpool','Glasgow','Brussels','Geneva','Porto','Naples','Kyiv','Minsk','Riga','Tallinn','Vilnius','Reykjavik','Doha','Abu Dhabi','Riyadh','Jeddah','Muscat','Amman','Beirut','Tel Aviv','Jerusalem','Tehran','Baghdad','Kabul','Colombo','Kathmandu','Yangon','Hanoi','Ho Chi Minh City','Monterrey','Boca Chica'];
      const KNOWN_PEOPLE=['Ratan Tata','Tim Cook','Sundar Pichai','Satya Nadella','Jeff Bezos','Elon Musk','Steve Jobs','Bill Gates','Mark Zuckerberg','Larry Page','Sergey Brin','Jensen Huang','Sam Altman','Reed Hastings','Jack Dorsey','Andy Jassy','Pat Gelsinger','Lisa Su','Mary Barra','Barack Obama','Joe Biden','Donald Trump','Vladimir Putin','Xi Jinping','Narendra Modi','Boris Johnson','Emmanuel Macron','Angela Merkel','Justin Trudeau','Jacinda Ardern','Rishi Sunak','Warren Buffett','Jamie Dimon','Oprah Winfrey','Cristiano Ronaldo','Lionel Messi','LeBron James','Serena Williams','Roger Federer','Tiger Woods','Michael Jordan','Usain Bolt','Virat Kohli','Sachin Tendulkar','MS Dhoni','Stephen Hawking','Albert Einstein','Isaac Newton','Marie Curie','Nikola Tesla','Thomas Edison','Alan Turing'];
      const KNOWN_ORGS=['Apple','Google','Microsoft','Amazon','Meta','Tesla','Netflix','Uber','Airbnb','SpaceX','NVIDIA','Intel','AMD','IBM','Oracle','Salesforce','Adobe','Shopify','Stripe','PayPal','Square','Zoom','Slack','Dropbox','Spotify','TikTok','Snapchat','Pinterest','LinkedIn','YouTube','Reddit','Wikipedia','OpenAI','Anthropic','DeepMind','Samsung','Sony','LG','Huawei','Xiaomi','Alibaba','Tencent','Baidu','ByteDance','Toyota','BMW','Mercedes','Volkswagen','Ford','General Motors','Boeing','Airbus','Pfizer','Moderna','Goldman Sachs','JPMorgan','Berkshire Hathaway','Walmart','Nike','Adidas','Coca-Cola','Disney','CNN','BBC','Reuters','Associated Press','New York Times','Washington Post','Forbes','Bloomberg','Wall Street Journal','Harvard University','MIT','Stanford University','Oxford University','Cambridge University','United Nations','World Health Organization','International Monetary Fund','World Bank','European Union','NATO','OPEC','Tata Group','Tata Motors','Tata Steel','Tata Consultancy Services','Jaguar Land Rover','Infosys','Wipro','HCL Technologies','Reliance Industries','HDFC Bank','State Bank of India','Adani Group','Mahindra','Maruti Suzuki','Board of Control for Cricket in India','International Cricket Council','Al Nassr','Al Hilal','Real Madrid','Barcelona','Manchester United','Manchester City','Liverpool','Chelsea','Arsenal','Bayern Munich','Paris Saint-Germain','Los Angeles Lakers','Golden State Warriors','Miami Heat','Inter Miami','White House','Pentagon','Federal Reserve','FIFA','UEFA','NBA','NFL','MLB','NHL','ICC','BCCI'];
      const KNOWN_BRANDS=['iPhone','iPad','MacBook','iMac','Mac Pro','Apple Watch','AirPods','AirPods Pro','Apple TV','HomePod','iTunes','iCloud','Apple Music','Apple TV+','App Store','FaceTime','Siri','Android','Pixel','Chrome','Gmail','Google Maps','Google Drive','Windows','Surface','Xbox','Teams','Office','Kindle','Alexa','Echo','AWS','Instagram','Twitter','WhatsApp','Messenger','Threads','Model S','Model 3','Model X','Model Y','Cybertruck','Powerwall','Starship','Falcon 9','Starlink','Galaxy','Galaxy S','Galaxy S24','PlayStation','PS5','Xbox Series X','Nintendo Switch','ChatGPT','GPT-4','DALL-E','Gemini','Copilot','Claude','Midjourney','H100','A100','iOS','macOS','watchOS','visionOS'];
      const MAJOR_CITIES=new Set(['London','Paris','Tokyo','Berlin','Sydney','Dubai','Mumbai','Delhi','Seoul','Amsterdam','Madrid','Rome','Beijing','Shanghai','Singapore','Los Angeles','San Francisco','New York','Chicago','Miami','Houston','Boston','Seattle','Atlanta','Denver','Toronto','Vancouver','Melbourne','Barcelona','Milan','Munich','Cairo','Lagos','Nairobi','Johannesburg','Buenos Aires','Santiago','Lima','Bogota','Monterrey','Bangalore']);

      const entities={people:[],organizations:[],places:[],brands:[],concepts:[]};
      const freq={};
      const countF=n=>{const k=n.toLowerCase();freq[k]=Math.max(freq[k]||0,rawText.toLowerCase().split(k).length-1);};
      const addE=(cat,val)=>{val=val?.trim().replace(/[.,;:!?]$/,'');if(val&&val.length>1&&!entities[cat].some(e=>e.toLowerCase()===val.toLowerCase())){entities[cat].push(val);countF(val);}};
      let m;

      KNOWN_PEOPLE.forEach(p=>{if(text.includes(p))addE('people',p);});
      KNOWN_ORGS.forEach(o=>{if(text.includes(o))addE('organizations',o);});
      KNOWN_BRANDS.forEach(b=>{if(text.includes(b))addE('brands',b);});

      const PT='CEO|CTO|CFO|COO|CRO|CMO|President|Vice President|VP|Director|Managing Director|Executive Director|Founder|Co-Founder|Co-founder|Administrator|Chairman|Chairwoman|Chairperson|Manager|Governor|Senator|Prime Minister|Deputy Prime Minister|General|Lieutenant General|Professor|Chancellor|Secretary|Commissioner|Ambassador|Chief|Head|Spokesperson|Mayor|Trustee|Minister|Officer|Scientist|Researcher|Engineer';
      [new RegExp(`([A-Z][a-z]+(?:\\s+(?:[A-Z][a-z]+|de|van|von|el|al|bin)){1,3}),\\s*(?:the\\s+)?(?:${PT})`,"g"),new RegExp(`\\b(?:${PT})\\s+([A-Z][a-z]+\\s+[A-Z][a-z]+)`,"gi"),/\b(?:co-founder|cofounder|founder|chairman|chairwoman|director|president|governor|senator|ambassador|commissioner|chancellor|secretary|professor|minister|scientist|researcher)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/gi,new RegExp(`([A-Z][a-z]+\\s+[A-Z][a-z]+)\\s+(?:is|was|becomes?|became|serves?\\s+as|served\\s+as|appointed\\s+as|named\\s+as)\\s+(?:the\\s+)?(?:current\\s+|new\\s+|former\\s+)?(?:${PT})`,"g"),/(?<![a-z])([A-Z][a-z]+\s+[A-Z][a-z]+)\s+(?:said|told|added|confirmed|stated|announced|noted|wrote|explained|warned|argued|revealed|claimed|denied|praised|declared|tweeted|posted|reported|scored|won|attended|defeated|expressed)/g,/\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sir|Lord|Lady|Sheikh|Rabbi|Bishop|Cardinal)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g,/\b(?:founded|created|established|started|co-founded|invented|discovered)\b[^.]{0,80}?\bby\s+((?:[A-Z][a-z]+\s+[A-Z][a-z]+(?:,\s+(?:and\s+)?)?){1,6})/g].forEach(pat=>{while((m=pat.exec(text))!==null){const raw=(m[1]||"").trim();const names=raw.split(/,\s*(?:and\s+)?/).map(n=>n.replace(/\band\b/gi,"").trim()).filter(n=>/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(n));(names.length>1?names:[raw]).forEach(n=>{const clean=(n.match(/[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|de|van|von|bin|al-)){1,3}/)||[])[0]||"";const lastWord=clean.split(" ").pop();if(clean.length>3&&!SKIP_WORD.has(clean.split(" ")[0])&&!MONTHS.has(clean.split(" ")[0])&&!ORG_WORDS.has(lastWord))addE("people",clean);});}});

      const OS='Inc\\.|Incorporated|Ltd\\.|Limited|LLC|Corp\\.|Corporation|PLC|GmbH|AG|Group|Holdings|Technologies|Technology|Systems|Solutions|Software|Ventures|Capital|Partners|Consulting|University|College|Foundation|Trust|Association|Organization|Organisation|Council|Agency|Bureau|Bank|Exchange|Hospital|Labs|Ministry|Department|Office|Network|Media|Studios|Press|Authority|Commission|Federation|Union|Alliance|Services|International|Global|Enterprises|Industries|Motors|Steel|Consultancy|Pharma|Biotech';
      const orgRE=new RegExp(`([A-Z][A-Za-z0-9&'\\-]{1,35}(?:\\s+[A-Z][A-Za-z0-9&'\\-]{1,25}){0,4})\\s+(${OS})`,"g");
      text.split(/(?<=[.!?])\s+(?=[A-Z"])/).forEach(sent=>{while((m=orgRE.exec(sent))!==null){const org=(m[1].trim()+" "+m[2]).replace(/\s+/g," ").trim();const orgWords=org.split(/\s+/).filter(w=>w.length>2);if(org.length>3&&org.length<80&&!KP.includes(org)&&orgWords.length>=2&&!["The","A","An"].includes(org.split(" ")[0]))addE("organizations",org);}});
      const ofRE=/\b(?:at|joins?|joined|left|leads?|runs?|CEO\s+of|head\s+of|director\s+of|president\s+of|founder\s+of|acquired\s+by|owned\s+by|backed\s+by|invested\s+in)\s+([A-Z][A-Za-z0-9]{2,25}(?:\s+[A-Z][A-Za-z0-9]{2,25}){0,3})(?=[\s,.])/g;
      while((m=ofRE.exec(text))!==null){const o=m[1].trim();if(!SKIP_OF.has(o)&&o.length>2&&!entities.people.some(p=>p===o)&&!KP.includes(o))addE("organizations",o);}
      const acRE=/\b([A-Z]{2,6})\b/g;
      while((m=acRE.exec(text))!==null){if(!TITLE_ABB.has(m[1]))addE("organizations",m[1]);}

      KP.forEach(p=>{if(text.includes(p))addE("places",p);});
      [/\b(?:in|at|near|to|visiting|located\s+in|based\s+in|headquartered\s+in|born\s+in|raised\s+in|held\s+in|arrived\s+in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?=\s*[,.]|\s+[a-z]|\s+and\b)/g,/\b(?:headquartered|based|located|founded|established)\s+in\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g].forEach(pat=>{while((m=pat.exec(text))!==null){const p=m[1].trim().replace(/[.,;]$/,"");if(p.length>2&&!MONTHS.has(p)&&!DAYS.has(p)&&!SKIP_WORD.has(p)&&!entities.people.some(pe=>pe.includes(p))&&!entities.organizations.some(o=>o===p)&&!KP.includes(p))addE("places",p);}});

      const camelRE=/\b([A-Z][a-z]{1,18}[A-Z][A-Za-z0-9]{1,18})\b/g;
      while((m=camelRE.exec(text))!==null){if(m[1].length>3&&!entities.people.some(p=>p.includes(m[1])))addE("brands",m[1]);}
      const techRE=/\b(i(?:Phone|Pad|Mac|Pod|Cloud|Watch)|m(?:acOS|iOS)|watchOS|tvOS|visionOS|android)(?:\s+(?!and\b|or\b)[A-Za-z0-9]{1,20}){0,2}\b/gi;
      while((m=techRE.exec(text))!==null)addE("brands",m[0].trim());
      const prodRE=/\b([A-Z][a-z]{1,20}(?:\s+(?!and\b|or\b)(?:[A-Z][a-z]{0,15}|\d+)){1,3})\b/g;
      while((m=prodRE.exec(text))!==null){const p=m[1].trim();if(/\d/.test(p)&&!MONTHS.has(p.split(" ")[0])&&!SKIP_WORD.has(p.split(" ")[0])&&p.length>3&&!entities.people.some(pe=>pe.includes(p)))addE("brands",p);}
      const hyphenRE=/\b([A-Z][A-Za-z0-9]{1,15}-[A-Za-z0-9]{1,15})\b/g;
      while((m=hyphenRE.exec(text))!==null){if(m[1].length>3)addE("brands",m[1]);}

      entities.places=entities.places.filter(place=>{if(MAJOR_CITIES.has(place))return true;return !entities.organizations.some(org=>org!==place&&org.toLowerCase().includes(place.toLowerCase()));});
      entities.organizations=entities.organizations.filter(org=>!KP.includes(org));

      const allWords=new Set();
      [...entities.people,...entities.organizations,...entities.places,...entities.brands].forEach(e=>{allWords.add(e.toLowerCase());e.toLowerCase().split(/\s+/).forEach(w=>{if(w.length>2)allWords.add(w);});});
      const CS=new Set(['prime','minister','president','announced','according','confirmed','meeting','signed','joined','posted','scored','playing','career','historic','launched','unveiled','arrived','worked','started','called','calling','using','making','asked','added','stated','celebrated','invested','working','including','developed','running','powered','planned','named','based','taken','given','shown','built','found','used','held','made','went','came','became','happened','spent','brought','praised','during','series','century','defeated','visionary','leader','expressed','condolences','attending','confirming','operating','investing','producing','opening','winning','losing']);
      const wf={};
      text.toLowerCase().replace(/[^\w\s]/g," ").split(/\s+/).filter(w=>w.length>4&&!STOPWORDS.has(w)&&!allWords.has(w)&&!/^\d+$/.test(w)&&!CS.has(w)).forEach(w=>{wf[w]=(wf[w]||0)+1;});
      entities.concepts=Object.entries(wf).filter(([,c])=>c>=2).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([w,c])=>w.charAt(0).toUpperCase()+w.slice(1)+' ('+c+'x)');

      Object.keys(entities).forEach(k=>{const seen=new Set();entities[k]=entities[k].filter(e=>{const key=e.toLowerCase().replace(/[^a-z0-9\s]/g,"").trim();if(!key||key.length<2||seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>{if(k==="concepts")return 0;return(freq[b.toLowerCase()]||0)-(freq[a.toLowerCase()]||0)||a.localeCompare(b);}).slice(0,30);});
      return {entities,freq};
    }

    /* ══════════════════════════════════════════════════════════
       MAIN: try HF first, fall back to regex if it fails
    ══════════════════════════════════════════════════════════ */
    let entities, freq, usedMethod;

    try {
      console.log('Trying Hugging Face NER...');
      const hfRaw    = await tryHuggingFace(rawText);
      const merged   = mergeHFEntities(hfRaw);
      const result   = mapHFToCategories(merged, rawText);
      entities       = result.entities;
      freq           = result.freq;
      usedMethod     = 'huggingface';
      console.log(`HF NER success: ${Object.values(entities).reduce((s,a)=>s+a.length,0)} entities`);
    } catch(hfErr) {
      console.log('HF API failed, using regex fallback:', hfErr.message);
      const result   = regexFallback(rawText);
      entities       = result.entities;
      freq           = result.freq;
      usedMethod     = 'regex-fallback';
    }

    const withFreq = list => list.map(e=>({ name:e, mentions:freq[e.toLowerCase()]||1 }));
    const total    = Object.values(entities).reduce((s,a)=>s+a.length,0);

    /* ══════════════════════════════════════════════════════════
       ATTRIBUTE EXTRACTION — Role, Relationship, Location, Sentiment
    ══════════════════════════════════════════════════════════ */
    function extractAttributes(rawText, entities) {
      const text = rawText.replace(/\r?\n+/g,' ').replace(/\s{2,}/g,' ');
      const attrs = {};

      // ── Sentiment word lists (expanded) ──
      const POS_WORDS = new Set(['best','top','leading','innovative','successful','praised','awarded','celebrated','excellent','outstanding','remarkable','revolutionary','pioneering','thriving','dominant','record','growth','profit','milestone','breakthrough','historic','iconic','trusted','powerful','advanced','valuable','popular','loved','renowned','respected','admired','first','largest','biggest','greatest','famous','major','significant','important','key','strong','rich','wealthy','influential','most','world','global','trillion','billion','leading','premier','number','one']);
      const NEG_WORDS = new Set(['worst','failed','struggling','criticized','accused','scandal','controversy','declined','dropped','loss','lawsuit','fraud','bankrupt','fired','resigned','arrested','charged','fined','banned','blocked','hacked','breach','crisis','problem','issue','concern','warning','threat','risk','fallen','poor','weak','slow','bad','terrible','horrible','awful','negative','down','closed','shutdown','layoff','cut','reduced','limited']);

      function getSentiment(entityName) {
        const nameLow = entityName.toLowerCase();
        if (!rawText.toLowerCase().includes(nameLow)) return { label:'Neutral', color:'#64748b' };
        // Score full article for overall tone
        const fullWords = rawText.toLowerCase().replace(/[^a-z\s]/g,' ').split(/\s+/);
        let pos=0, neg=0;
        fullWords.forEach(w=>{ if(POS_WORDS.has(w))pos++; if(NEG_WORDS.has(w))neg++; });
        // Also score entity-specific sentences for more precise tone
        const entSents = rawText.split(/[.!?\n]+/).filter(s=>s.toLowerCase().includes(nameLow));
        let ePos=0, eNeg=0;
        entSents.forEach(s=>s.toLowerCase().replace(/[^a-z\s]/g,' ').split(/\s+/).forEach(w=>{
          if(POS_WORDS.has(w))ePos++; if(NEG_WORDS.has(w))eNeg++;
        }));
        // Prefer entity-level score; fall back to article-level
        const fPos = ePos||pos, fNeg = eNeg||neg;
        if(fPos>fNeg)  return { label:'Positive', color:'#10b981' };
        if(fNeg>fPos)  return { label:'Negative', color:'#ef4444' };
        if(fPos>0&&fNeg>0) return { label:'Mixed', color:'#f59e0b' };
        return { label:'Neutral', color:'#64748b' };
      }

      // ── Relationship patterns ──
      const REL_PATTERNS = [
        { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:joined|joins)\s+([A-Z][A-Za-z\s&.]{2,35})/g, rel:'joined' },
        { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:founded|co-founded|created|established|started)\s+([A-Z][A-Za-z\s&.]{2,35})/g, rel:'founded' },
        { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:left|resigned from|quit|departed)\s+([A-Z][A-Za-z\s&.]{2,35})/g, rel:'left' },
        { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:acquired|bought|purchased|took over)\s+([A-Z][A-Za-z\s&.]{2,35})/g, rel:'acquired' },
        { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:leads?|runs?|heads?|chairs?|manages?)\s+([A-Z][A-Za-z\s&.]{2,35})/g, rel:'leads' },
        { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:works?\s+(?:at|for)|employed\s+(?:at|by))\s+([A-Z][A-Za-z\s&.]{2,35})/g, rel:'works at' },
        { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}),\s+(?:the\s+)?(?:CEO|CFO|CTO|COO|President|Director|Founder|Co-Founder|Chairman|Manager|Head|Chief|Officer)\s+(?:of\s+)?([A-Z][A-Za-z\s&.]{2,35})/g, rel:'executive at' },
        { re: /([A-Z][A-Za-z\s&.]{2,35})\s+(?:was\s+)?(?:acquired|bought|purchased)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g, rel:'acquired by' },
        { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:succeeded|replaced|took over from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g, rel:'succeeded' },
        { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}),\s+(?:the\s+)?(?:company's\s+)?co-founder/g, rel:'co-founded' },
      ];

      // ── Location patterns ──
      const LOC_PATTERNS = [
        /([A-Z][A-Za-z\s&.]{2,35})\s+(?:is\s+)?(?:headquartered|based|located)\s+in\s+([A-Z][a-z]+(?:[,\s]+[A-Z][a-z]+)?)/g,
        /([A-Z][A-Za-z\s&.]{2,35})\s+(?:has\s+)?(?:its\s+)?(?:offices?|headquarters?|HQ)\s+in\s+([A-Z][a-z]+(?:[,\s]+[A-Z][a-z]+)?)/g,
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:is from|born in|grew up in|lives?\s+in|based\s+in)\s+([A-Z][a-z]+(?:[,\s]+[A-Z][a-z]+)?)/g,
        /([A-Z][A-Za-z\s&.]{2,35})\s+in\s+([A-Z][a-z]+(?:,\s*[A-Z][a-z]+)?),?\s+(?:California|New York|Texas|London|Tokyo|Shanghai|Berlin|Paris|Mumbai|Sydney)/g,
      ];

      // ── Role extraction helper ──
      function extractRole(name) {
        const n = escRe(name);
        const patterns = [
          // "Name is/was the [current/new/former] Title [of/at Org]"
          new RegExp(n + '\\s+(?:is|was|serves?\\s+as|served\\s+as|became|appointed\\s+as)\\s+(?:the\\s+)?(?:current\\s+|new\\s+|former\\s+)?([A-Za-z][A-Za-z\\s\\-]{2,45}?)(?=\\s*(?:,|\\.|of\\s|at\\s|for\\s|in\\s|and\\s|$))', 'i'),
          // "Title, Name" or "Title Name" — e.g. "CEO Tim Cook"
          new RegExp('\\b(CEO|CFO|CTO|COO|President|Vice[\\s\\-]President|Director|Founder|Co\\-Founder|Chairman|Governor|Senator|Prime\\s+Minister|Chancellor|Secretary|Professor|Ambassador|Manager|Head|Chief\\s+\\w+|Officer|Engineer|Coach|Captain|Author|Editor)\\s+(?:of\\s+[A-Z][\\w\\s]+,\\s*)?' + n, 'i'),
          // "Name, [the] Title"
          new RegExp(n + ',\\s*(?:the\\s+)?([A-Za-z][A-Za-z\\s\\-]{2,45}?)(?=\\s*(?:of\\s|at\\s|,|\\.|$))', 'i'),
          // "Name's role as Title"
          new RegExp(n + "\\'s\\s+(?:role|position|job)\\s+as\\s+([A-Za-z][A-Za-z\\s\\-]{2,40}?)(?=\\s*(?:,|\\.|$))", 'i'),
          // "succeeding Name" → predecessor role
          new RegExp('(?:succeeding|replacing|succeeded\\s+by)\\s+(?:the\\s+company[^s]*s\\s+)?(?:co-)?(?:founder\\s+)?(' + n + ')', 'i'),
        ];
        for (const re of patterns) {
          const m = text.match(re);
          if (m) {
            // Pattern 2 returns the title in m[1]
            const raw = (m[2]||m[1]||'').trim().replace(/[,.]$/, '').trim();
            if (raw.length > 2 && raw.length < 60 && !/^(the|a|an|and|or|but|in|on|at)$/i.test(raw)) {
              return raw;
            }
          }
        }
        return null;
      }

      // Collect all entities
      const allEntities = [
        ...entities.people.map(e=>({name:e,type:'person'})),
        ...entities.organizations.map(e=>({name:e,type:'org'})),
        ...entities.brands.map(e=>({name:e,type:'brand'})),
      ];

      allEntities.forEach(({name, type}) => {
        if (!name || name.length < 2) return;
        const attr = { role: null, relationships: [], location: null, sentiment: getSentiment(name) };

        // Role
        attr.role = extractRole(name);

        // Relationships
        REL_PATTERNS.forEach(({re, rel}) => {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text)) !== null) {
            const a = (m[1]||'').trim();
            const b = (m[2]||'').trim().replace(/[.,;]$/,'');
            // "founded by X" pattern — X is in m[1], no m[2]
            if (!m[2] && a.toLowerCase() === name.toLowerCase()) {
              // single-capture: entity IS the subject  
              if (!attr.relationships.find(r=>r.rel===rel))
                attr.relationships.push({ rel, target: '(this org)' });
            }
            if (b && a.toLowerCase() === name.toLowerCase() && b.length > 1 && b.length < 60) {
              if (!attr.relationships.find(r=>r.target===b))
                attr.relationships.push({ rel, target: b });
            }
            // Reverse match — entity is the target
            if (b && b.toLowerCase() === name.toLowerCase() && a.length > 1 && a.length < 60) {
              const inv = rel==='acquired by'?'acquired': rel==='founded'?'was founded by': rel==='succeeded'?'was succeeded by': null;
              if (inv && !attr.relationships.find(r=>r.target===a))
                attr.relationships.push({ rel: inv, target: a });
            }
          }
        });

        // Special: "co-founder" pattern — "Steve Jobs, the company's co-founder"
        if (type==='person') {
          const coRe = new RegExp(escRe(name) + "[',]?\\s+(?:the\\s+)?(?:company's\\s+)?co-founder", 'i');
          if (coRe.test(text) && !attr.role) attr.role = 'Co-Founder';
          const succRe = new RegExp('succeeding\\s+(?:the\\s+company[^s]*s\\s+)?co-founder\\s+' + escRe(name), 'i');
          if (succRe.test(text) && !attr.role) attr.role = 'Co-Founder (predecessor)';
        }

        // Location — search for "Name ... headquartered/based in City" within 150 chars
        if (!attr.location) {
          const locKeywords = ['headquartered','based','located','offices','headquarters'];
          locKeywords.forEach(kw => {
            if (attr.location) return;
            const idx = text.toLowerCase().indexOf(kw);
            if (idx === -1) return;
            // Find the nearest "in City" after the keyword
            const after = text.slice(idx, idx+80);
            const cityM = after.match(/in\s+([A-Z][a-z]+(?:[,\s]+[A-Z][a-z]+)?)/);
            if (!cityM) return;
            // Check if entity name appears within 120 chars before the keyword
            const before = text.slice(Math.max(0, idx-120), idx);
            const nameWords = name.toLowerCase().split(/\s+/).filter(w=>w.length>2);
            if (nameWords.some(w=>before.toLowerCase().includes(w))) {
              attr.location = cityM[1].trim().replace(/[.,;]$/,'');
            }
          });
        }
        // Fallback: broader LOC_PATTERNS
        if (!attr.location) {
          LOC_PATTERNS.forEach(re => {
            if (attr.location) return;
            re.lastIndex = 0; let m;
            while ((m = re.exec(text)) !== null) {
              const subject = (m[1]||'').trim().toLowerCase();
              const loc = (m[2]||'').trim().replace(/[.,;]$/,'');
              if (loc.length > 2) {
                const nameWords = name.toLowerCase().split(/\s+/).filter(w=>w.length>2);
                if (nameWords.some(w=>subject.includes(w))) { attr.location = loc; break; }
              }
            }
          });
        }

        // Always save — every entity gets at minimum a sentiment
        attrs[name] = attr;
      });

      return attrs;
    }

    function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

    const attributes = extractAttributes(rawText, entities);

    res.json({
      success:true, entities,
      attributes,
      entityDetails:{
        people:       withFreq(entities.people),
        organizations:withFreq(entities.organizations),
        places:       withFreq(entities.places),
        brands:       withFreq(entities.brands),
        concepts:     entities.concepts.map(c=>({name:c}))
      },
      stats:{
        totalEntities: total,
        wordCount,
        charCount:     rawText.length,
        method:        usedMethod
      }
    });
  } catch(err){ console.error('Entity error:',err); res.status(500).json({success:false,error:err.message}); }
});

/* ================================================================
   API 4b — FETCH URL HTML (for SEO Audit URL mode)
================================================================ */
app.get('/api/fetch-html', async (req,res)=>{
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({success:false,error:'No URL provided'});
    const target = url.startsWith('http') ? url : 'https://'+url;
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), 15000);
    const response = await fetch(target, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ClusterSEOBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });
    clearTimeout(timeout);
    if (!response.ok) return res.status(response.status).json({success:false,error:`HTTP ${response.status}: ${response.statusText}`});
    const html = await response.text();
    const finalUrl = response.url || target;
    res.json({ success:true, html, finalUrl });
  } catch(err) {
    if (err.name==='AbortError') return res.status(408).json({success:false,error:'Request timed out (15s). The site may be blocking bots.'});
    res.status(500).json({success:false,error:err.message});
  }
});

/* ================================================================
   API 4c — GOOGLE PAGESPEED INSIGHTS (CACHED for 24h)
================================================================ */
app.get('/api/pagespeed', async (req,res)=>{
  try {
    const { url, strategy='mobile' } = req.query;
    if (!url) return res.status(400).json({success:false,error:'No URL provided'});
    const target = url.startsWith('http') ? url : 'https://'+url;
    
    // Create cache key
    const cacheKey = `${target}_${strategy}`;
    const cached = PSI_CACHE.get(cacheKey);
    
    // Return cached result if fresh
    if (cached && (Date.now() - cached.timestamp) < PSI_CACHE_TTL) {
      console.log(`✅ Returning cached PSI for ${cacheKey}`);
      return res.json(cached.data);
    }
    
    const PSI_KEY = process.env.PAGESPEED_API_KEY || '';
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(target)}&strategy=${strategy}&category=performance&category=seo&category=accessibility&category=best-practices${PSI_KEY?'&key='+PSI_KEY:''}`;

    const r = await fetch(apiUrl, { signal: AbortSignal.timeout(55000) });
    if (!r.ok) {
      const err = await r.json().catch(()=>({}));
      throw new Error(err?.error?.message || `PageSpeed API error ${r.status}`);
    }
    const psi = await r.json();

    // ── Extract Lighthouse categories ──
    const cats = psi.lighthouseResult?.categories || {};
    const perf    = Math.round((cats.performance?.score||0)*100);
    const seo     = Math.round((cats.seo?.score||0)*100);
    const access  = Math.round((cats.accessibility?.score||0)*100);
    const bp      = Math.round((cats['best-practices']?.score||0)*100);

    // ── Core Web Vitals ──
    const audits = psi.lighthouseResult?.audits || {};
    const getAudit = id => audits[id] || {};

    const lcp   = getAudit('largest-contentful-paint');
    const fid   = getAudit('total-blocking-time');       // TBT as FID proxy
    const cls   = getAudit('cumulative-layout-shift');
    const fcp   = getAudit('first-contentful-paint');
    const si    = getAudit('speed-index');
    const tti   = getAudit('interactive');
    const tbt   = getAudit('total-blocking-time');
    const server_rt = getAudit('server-response-time');

    // ── Field Data (real user data from CrUX) ──
    const loadingExp = psi.loadingExperience || {};
    const fieldData = {
      hasCrux: loadingExp.overall_category ? true : false,
      overall:  loadingExp.overall_category || null,
      lcp:  loadingExp.metrics?.LARGEST_CONTENTFUL_PAINT_MS   || null,
      fid:  loadingExp.metrics?.FIRST_INPUT_DELAY_MS           || null,
      cls:  loadingExp.metrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE  || null,
      fcp:  loadingExp.metrics?.FIRST_CONTENTFUL_PAINT_MS      || null,
      inp:  loadingExp.metrics?.INTERACTION_TO_NEXT_PAINT      || null,
      ttfb: loadingExp.metrics?.EXPERIMENTAL_TIME_TO_FIRST_BYTE|| null,
    };

    // ── Opportunities (what to fix) ──
    const opportunities = Object.values(audits)
      .filter(a => a.details?.type === 'opportunity' && a.score !== null && a.score < 0.9)
      .map(a => ({
        id:          a.id,
        title:       a.title,
        description: a.description,
        score:       Math.round((a.score||0)*100),
        savings:     a.details?.overallSavingsMs ? Math.round(a.details.overallSavingsMs) + 'ms' : null,
        displayValue:a.displayValue || null
      }))
      .sort((a,b) => a.score - b.score)
      .slice(0, 8);

    // ── Diagnostics ──
    const diagnostics = Object.values(audits)
      .filter(a => a.details?.type === 'table' && a.score !== null && a.score < 0.9 && !opportunities.find(o=>o.id===a.id))
      .map(a => ({
        id:    a.id,
        title: a.title,
        score: Math.round((a.score||0)*100),
        displayValue: a.displayValue || null,
        description: a.description || null,
        items: (a.details?.items||[]).slice(0,5).map(item=>({
          url: item.url||item.source||item.label||'',
          wastedBytes: item.wastedBytes||null,
          wastedMs: item.wastedMs||null,
          totalBytes: item.totalBytes||null,
        }))
      }))
      .sort((a,b) => a.score - b.score)
      .slice(0, 10);

    // ── Passed Audits ──
    const passedAudits = Object.values(audits)
      .filter(a => a.score !== null && a.score >= 0.9)
      .map(a => ({ id:a.id, title:a.title }))
      .slice(0,20);

    // ── Failed Audits (score 0-0.49) ──
    const failedAudits = Object.values(audits)
      .filter(a => a.score !== null && a.score < 0.5)
      .map(a => ({ id:a.id, title:a.title, description:a.description||null, displayValue:a.displayValue||null }))
      .slice(0,15);

    // ── 3rd Party Summary ──
    const thirdPartySummary = audits['third-party-summary'];
    const thirdParties = thirdPartySummary?.details?.items
      ? thirdPartySummary.details.items.slice(0,8).map(i=>({
          entity: i.entity||'Unknown',
          transferSize: i.transferSize||0,
          blockingTime: i.blockingTime||0,
          mainThreadTime: i.mainThreadTime||0
        }))
      : [];

    // ── JS Libraries ──
    const jsLibs = audits['js-libraries']?.details?.items
      ? audits['js-libraries'].details.items.map(i=>({ name:i.name||'', version:i.version||'' }))
      : [];

    // ── Render Blocking ──
    const renderBlocking = audits['render-blocking-resources'];
    const renderBlockingItems = renderBlocking?.details?.items
      ? renderBlocking.details.items.slice(0,6).map(i=>({
          url: i.url||'',
          totalBytes: i.totalBytes||0,
          wastedMs: i.wastedMs||0
        }))
      : [];

    // ── Unused CSS/JS ──
    const unusedCSS = audits['unused-css-rules'];
    const unusedJS  = audits['unused-javascript'];
    const unusedCSSItems = unusedCSS?.details?.items?.slice(0,5).map(i=>({ url:i.url||'', wastedBytes:i.wastedBytes||0 }))||[];
    const unusedJSItems  = unusedJS?.details?.items?.slice(0,5).map(i=>({ url:i.url||'', wastedBytes:i.wastedBytes||0 }))||[];

    // ── Image Issues ──
    const imgSizing = audits['uses-responsive-images'];
    const imgItems = imgSizing?.details?.items?.slice(0,5).map(i=>({ url:i.url||'', wastedBytes:i.wastedBytes||0 }))||[];

    // ── Score colour helper ──
    const scoreCol = s => s>=90?'#059669':s>=50?'#f59e0b':'#ef4444';
    const scoreLabel = s => s>=90?'Good':s>=50?'Needs Improvement':'Poor';

    const response = {
      success:  true,
      url:      target,
      strategy,
      scores: {
        performance: { score:perf,  color:scoreCol(perf),  label:scoreLabel(perf)  },
        seo:         { score:seo,   color:scoreCol(seo),   label:scoreLabel(seo)   },
        accessibility:{ score:access,color:scoreCol(access),label:scoreLabel(access)},
        bestPractices:{ score:bp,   color:scoreCol(bp),    label:scoreLabel(bp)    }
      },
      vitals: {
        lcp:  { value:lcp.displayValue||null,  score:lcp.score!==null?Math.round((lcp.score||0)*100):null,  label:'Largest Contentful Paint',  good:'≤ 2.5s' },
        tbt:  { value:tbt.displayValue||null,  score:tbt.score!==null?Math.round((tbt.score||0)*100):null,  label:'Total Blocking Time',        good:'≤ 200ms' },
        cls:  { value:cls.displayValue||null,  score:cls.score!==null?Math.round((cls.score||0)*100):null,  label:'Cumulative Layout Shift',    good:'≤ 0.1' },
        fcp:  { value:fcp.displayValue||null,  score:fcp.score!==null?Math.round((fcp.score||0)*100):null,  label:'First Contentful Paint',     good:'≤ 1.8s' },
        si:   { value:si.displayValue||null,   score:si.score!==null?Math.round((si.score||0)*100):null,    label:'Speed Index',                good:'≤ 3.4s' },
        tti:  { value:tti.displayValue||null,  score:tti.score!==null?Math.round((tti.score||0)*100):null,  label:'Time to Interactive',        good:'≤ 3.8s' },
      },
      fieldData,
      opportunities,
      diagnostics,
      passedAudits,
      failedAudits,
      thirdParties,
      jsLibs,
      renderBlockingItems,
      unusedCSSItems,
      unusedJSItems,
      imgItems,
      fetchTime: new Date().toISOString()
    };
    
    // Cache the result
    PSI_CACHE.set(cacheKey, {
      timestamp: Date.now(),
      data: response
    });
    
    res.json(response);
    
  } catch(err){
    res.status(500).json({success:false, error:err.message});
  }
});

/* ================================================================
   API 5 — SEO AUDIT — 22 checks
================================================================ */
app.post('/api/seo-audit', (req,res)=>{
  try {
    const { html, keyword='', url='' } = req.body;
    if (!html) return res.status(400).json({success:false,error:'No HTML provided'});
    const kw = keyword.toLowerCase().trim();
    const strip = s=>s.replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();
    const bodyText = strip(html.replace(/<(script|style|noscript|svg|canvas)[^>]*>[\s\S]*?<\/\1>/gi,''));
    const wordCount = bodyText.split(/\s+/).filter(w=>w.length>1).length;
    const checks=[], pts={total:0,max:0};

    function addCheck(id,title,status,maxPts,detail,tip){
      const scored=status==='pass'?maxPts:status==='warn'?Math.round(maxPts*0.5):0;
      pts.total+=scored; pts.max+=maxPts;
      checks.push({id,title,status,points:scored,maxPoints:maxPts,detail,tip});
    }

    // 1. Title tag
    const titleM=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title=titleM?strip(titleM[1]):''; const tL=title.length;
    addCheck('title','Title Tag',tL>=50&&tL<=60?'pass':tL>0?'warn':'fail',10,title?`"${title.slice(0,70)}${tL>70?'…':''}" (${tL} chars)`:'Missing title tag',tL===0?'Add a <title> tag — the single most important on-page SEO element. Format: Primary Keyword | Brand Name':tL<30?`Very short (${tL} chars). Target 50–60 characters.`:tL<50?`Short (${tL} chars). Expand to 50–60 chars.`:tL>70?`Too long (${tL} chars). Google truncates at ~60 chars.`:tL>60?`Slightly long (${tL} chars). Trim a few words.`:'Perfect title length ✓');

    // 2. Keyword in title
    const kwIT=kw&&title.toLowerCase().includes(kw); const kwITF=kw&&title.toLowerCase().indexOf(kw)<=20;
    addCheck('kw-title','Keyword in Title',kwITF?'pass':kwIT?'warn':kw?'fail':'warn',8,!kw?'No focus keyword set':kwIT?`"${kw}" found${kwITF?' near start ✓':' (not near start)'}`:`"${kw}" not in title`,!kw?'Enter a focus keyword above to enable all keyword checks.':kwITF?'Excellent — keyword appears within the first 20 characters.':kwIT?'Keyword present but not near the start. Move it to the beginning.': `Add "${kw}" to your title. Ideal: "${kw} | Your Brand Name".`);

    // 3. Meta description
    const metaM=html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i)||html.match(/<meta[^>]+content=["']([^"']*["'][^>]*name=["']description)/i);
    const meta=metaM?metaM[1].trim():''; const mL=meta.length;
    addCheck('meta-desc','Meta Description',mL>=140&&mL<=160?'pass':mL>0?'warn':'fail',8,meta?`${mL} chars: "${meta.slice(0,80)}${mL>80?'…':''}"`:'No meta description found',mL===0?'Missing! Write 140–160 chars that sell the click — it shows in Google results.':mL<100?`Too short (${mL} chars). Expand to 140–160.`:mL<140?`Short (${mL} chars). Add one more sentence.`:mL>170?`Too long (${mL} chars). Google cuts off at ~160.`:'Perfect meta description length ✓');

    // 4. Keyword in meta description
    const kwIM=kw&&meta.toLowerCase().includes(kw);
    addCheck('kw-meta','Keyword in Meta',kwIM?'pass':!kw||!meta?'warn':'fail',5,!kw?'No focus keyword set':kwIM?`"${kw}" found — Google bolds it in SERPs ✓`:`"${kw}" missing from meta description`,!kw?'Set a focus keyword.':kwIM?'Google bolds matching words in SERPs, increasing CTR.': `Add "${kw}" to your meta description.`);

    // 5. H1 tag
    const h1s=(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)||[]).map(h=>strip(h));
    addCheck('h1','H1 Heading',h1s.length===1?'pass':h1s.length>1?'warn':'fail',10,h1s.length===0?'No H1 tag found':h1s.length===1?`"${h1s[0].slice(0,80)}"`:`${h1s.length} H1 tags found`,h1s.length===0?'Add exactly one H1 — Google\'s strongest on-page signal after the title.':h1s.length>1?`Only 1 H1 allowed. You have ${h1s.length}. Demote extras to H2.`:'Good — exactly one H1 ✓');

    // 6. Keyword in H1
    const kwIH=kw&&h1s.some(h=>h.toLowerCase().includes(kw));
    addCheck('kw-h1','Keyword in H1',kwIH?'pass':!kw||h1s.length===0?'warn':'fail',8,!kw?'No focus keyword set':kwIH?`"${kw}" in H1 ✓`:`"${kw}" missing from H1`,!kw?'Set a focus keyword.':kwIH?'Great — H1 contains the focus keyword.': `Add "${kw}" to your H1.`);

    // 7. Heading hierarchy
    const h2n=(html.match(/<h2[^>]*>/gi)||[]).length, h3n=(html.match(/<h3[^>]*>/gi)||[]).length;
    addCheck('headings','Heading Hierarchy',h2n>=2?'pass':h2n===1?'warn':'fail',6,`H2: ${h2n}  H3: ${h3n}`,h2n===0?'No H2 subheadings. Add 2+ H2s to structure content and signal topic coverage.':h2n===1?'Only 1 H2. Add more — one per major section.':`Good structure (${h2n} H2s${h3n>0?', '+h3n+' H3s':''}) ✓`);

    // 8. Word count
    addCheck('word-count','Word Count',wordCount>=1200?'pass':wordCount>=600?'warn':'fail',8,`${wordCount.toLocaleString()} words`,wordCount<300?'Extremely thin — Google may not index this page.':wordCount<600?`Short (${wordCount} words). Top-ranking pages need 800+ words.`:wordCount<1000?`Decent (${wordCount} words). For competitive topics, aim for 1,200+.`:wordCount<2000?`Good (${wordCount} words).`:`Excellent (${wordCount} words). Comprehensive content ✓`);

    // 9. Keyword density
    const kwCount=kw?(bodyText.toLowerCase().split(kw).length-1):0;
    const kwDens=kw&&wordCount>0?(kwCount/wordCount*100):0;
    addCheck('kw-density','Keyword Density',kw&&kwDens>=0.8&&kwDens<=2.5?'pass':kw&&kwDens>0?'warn':!kw?'warn':'fail',6,!kw?'No focus keyword set':`${kwDens.toFixed(2)}% — "${kw}" appears ${kwCount}× in ${wordCount} words`,!kw?'Set a focus keyword.':kwDens===0?`"${kw}" not in body. Include it in intro, headings, and body.`:kwDens<0.5?`Very low (${kwDens.toFixed(2)}%). Aim for 0.8–2.5%.`:kwDens>4?`Keyword stuffing (${kwDens.toFixed(2)}%). Google penalises this.`:kwDens>2.5?`Slightly high (${kwDens.toFixed(2)}%). Replace some with synonyms.`:'Ideal keyword density ✓');

    // 10. Image alt text
    const imgs=(html.match(/<img[^>]+>/gi)||[]);
    const withAlt=imgs.filter(i=>/alt=["'][^"']+["']/i.test(i)).length;
    addCheck('images','Image Alt Text',imgs.length>0&&imgs.length===withAlt?'pass':imgs.length>0?'warn':'warn',6,imgs.length===0?'No images found':`${withAlt}/${imgs.length} images have alt text`,imgs.length===0?'Add relevant images with descriptive alt text.':imgs.length>withAlt?`${imgs.length-withAlt} image(s) missing alt text.`:'All images have alt text ✓');

    // 11. Canonical tag
    const hasCan=/<link[^>]+rel=["']canonical["'][^>]*>/i.test(html);
    addCheck('canonical','Canonical Tag',hasCan?'pass':'warn',5,hasCan?'Canonical tag present ✓':'No canonical tag found',hasCan?'Prevents duplicate content penalties from URL variations.':'Add <link rel="canonical" href="https://yourdomain.com/this-page/"> to <head>.');

    // 12. Open Graph
    const ogT=/<meta[^>]+property=["']og:title["'][^>]*>/i.test(html),ogD=/<meta[^>]+property=["']og:description["'][^>]*>/i.test(html),ogI=/<meta[^>]+property=["']og:image["'][^>]*>/i.test(html);
    const ogN=[ogT,ogD,ogI].filter(Boolean).length;
    addCheck('og-tags','Open Graph Tags',ogN===3?'pass':ogN>0?'warn':'fail',5,`${ogN}/3 tags (og:title, og:description, og:image)`,ogN===0?'No OG tags. Add them to control appearance when shared on Facebook, LinkedIn, WhatsApp.':ogN<3?`Missing: ${[!ogT&&'og:title',!ogD&&'og:description',!ogI&&'og:image'].filter(Boolean).join(', ')}.`:'All OG tags present ✓');

    // 13. Keyword in URL
    const kwInURL=kw&&url&&url.toLowerCase().includes(kw.replace(/\s+/g,'-'));
    addCheck('url-keyword','Keyword in URL',kwInURL?'pass':kw&&url?'warn':'warn',6,url?`${url.replace(/https?:\/\/[^/]+/,'').slice(0,70)}`:'No URL provided',!url?'Enter your page URL above.':!kw?'Set a focus keyword.':kwInURL?`"${kw.replace(/\s+/g,'-')}" found in URL ✓`:`Add keyword to URL: /your-${kw.replace(/\s+/g,'-')}/`);

    // 14. URL structure
    const urlSlug=url.replace(/https?:\/\/[^/]+/,'');
    const urlBad=url&&(/_/.test(urlSlug)||urlSlug.length>80);
    addCheck('url-structure','URL Structure',url&&!urlBad?'pass':url?'warn':'warn',5,url?urlSlug.slice(0,80)||'/':'No URL provided',!url?'Enter your page URL above.':/_/.test(urlSlug)?'Replace underscores with hyphens. Google treats hyphens as word separators.':urlSlug.length>80?'Long URL. Keep slugs short and focused on target keyword.':'URL structure looks clean ✓');

    // 15. Internal links
    const intLinks=(html.match(/<a[^>]+href=["'][^"']+["'][^>]*>/gi)||[]).filter(a=>!/<a[^>]+href=["']https?:/i.test(a)&&!/<a[^>]+href=["']#/i.test(a)&&!/<a[^>]+href=["']mailto:/i.test(a));
    const extLinks=(html.match(/<a[^>]+href=["']https?:\/\/[^"']+["'][^>]*>/gi)||[]).length;
    addCheck('internal-links','Internal Links',intLinks.length>=3&&intLinks.length<=100?'pass':intLinks.length>0?'warn':'fail',6,`${intLinks.length} internal | ${extLinks} external`,intLinks.length===0?'No internal links. Add 3–8 links to related pages — improves crawlability and PageRank distribution.':intLinks.length<3?`Only ${intLinks.length} internal link(s). Add more to related content.`:intLinks.length>100?'Too many links — keep to a reasonable number.':`Good internal linking (${intLinks.length}) ✓`);

    // 16. Mobile viewport
    const hasVP=/<meta[^>]+name=["']viewport["'][^>]*>/i.test(html);
    addCheck('mobile','Mobile Viewport',hasVP?'pass':'fail',8,hasVP?'Viewport meta tag present ✓':'No viewport meta tag — CRITICAL',hasVP?'Required for Google\'s mobile-first indexing ✓':'CRITICAL: Add <meta name="viewport" content="width=device-width, initial-scale=1"> immediately.');

    // 17. Structured data
    const jsonLDs=html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)||[];
    const schemaTypes=[];
    jsonLDs.forEach(s=>{ try{ const d=JSON.parse(s.replace(/<\/?script[^>]*>/gi,'').trim()); if(d['@type'])schemaTypes.push(d['@type']); if(d['@graph'])d['@graph'].forEach(n=>n['@type']&&schemaTypes.push(n['@type'])); }catch{} });
    addCheck('schema','Structured Data (JSON-LD)',schemaTypes.length>0?'pass':'warn',6,schemaTypes.length>0?`Schema types: ${schemaTypes.join(', ')}`:'No JSON-LD structured data',schemaTypes.length>0?`Rich results enabled for: ${schemaTypes.join(', ')}. Consider adding FAQ or HowTo schema too.`:'Add JSON-LD schema. Start with Article or FAQ. Rich results improve CTR by up to 30%.');

    // 18. Readability (Flesch-Kincaid)
    const sentCount=(bodyText.match(/[.!?]+\s+[A-Z]/g)||[]).length+1;
    const avgWPS=wordCount/Math.max(sentCount,1);
    const syllCount=bodyText.replace(/[^a-zA-Z]/g,' ').split(/\s+/).reduce((acc,w)=>{ const s=w.toLowerCase().replace(/[^a-z]/g,''); if(!s)return acc; const sy=Math.max(1,(s.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/,'').match(/[aeiouy]{1,2}/g)||[]).length); return acc+sy; },0);
    const avgSPW=wordCount>0?(syllCount/wordCount):1.5;
    const flesch=Math.max(0,Math.min(100,206.835-(1.015*avgWPS)-(84.6*avgSPW)));
    const readLabel=flesch>=70?'Easy':flesch>=60?'Standard':flesch>=50?'Fairly Difficult':flesch>=30?'Difficult':'Very Difficult';
    addCheck('readability','Readability Score',flesch>=60?'pass':flesch>=40?'warn':'fail',6,`${flesch.toFixed(0)}/100 — ${readLabel} | avg ${avgWPS.toFixed(1)} words/sentence`,flesch>=70?'Excellent readability.':flesch>=60?'Good readability for a general audience.':flesch>=50?`Standard difficulty (${flesch.toFixed(0)}). Simplify sentences — aim for under 20 words each.`:flesch>=30?`Difficult (${flesch.toFixed(0)}). Break up long sentences. Use simpler words.`:`Very difficult (${flesch.toFixed(0)}). Rewrite with shorter sentences and simpler vocabulary.`);

    // 19. Render-blocking resources
    const cssN=(html.match(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)||[]).length;
    const syncS=(html.match(/<script(?![^>]*(?:async|defer|type=["']module["']))[^>]*src=["'][^"']+["'][^>]*>/gi)||[]).length;
    addCheck('speed','Render-Blocking Resources',cssN+syncS<=2?'pass':cssN+syncS<=5?'warn':'fail',5,`${cssN} CSS file(s) | ${syncS} sync JS file(s)`,cssN+syncS===0?'No render-blocking resources ✓':cssN+syncS<=2?'Few render-blocking resources. Add defer to scripts.': `${cssN+syncS} render-blocking resources. Add defer/async to scripts. Inline critical CSS.`);

    // 20. Twitter Card
    const tC=/<meta[^>]+name=["']twitter:card["'][^>]*>/i.test(html),tT=/<meta[^>]+name=["']twitter:title["'][^>]*>/i.test(html);
    addCheck('twitter','Twitter / X Card',tC&&tT?'pass':tC||tT?'warn':'warn',3,[tC&&'twitter:card',tT&&'twitter:title'].filter(Boolean).join(', ')||'No Twitter Card tags',tC&&tT?'Twitter Card tags present ✓':'Add twitter:card and twitter:title for better X/Twitter sharing.');

    // 21. HTTPS
    const hasHttps=!url||url.startsWith('https://');
    addCheck('https','HTTPS / SSL',hasHttps?'pass':'fail',6,hasHttps?url?'URL uses HTTPS ✓':'No URL (assumed HTTPS)':'URL uses HTTP — not secure!',hasHttps?'HTTPS confirmed. Google uses it as a ranking signal.':'CRITICAL: Migrate to HTTPS immediately. Google penalises HTTP sites.');

    // 22. Date markup
    const hasDate=/<time[^>]*datetime/i.test(html)||/published[_-]?time|article[_-]?date|modified[_-]?date/i.test(html);
    const hasUpdated=/(updated|last modified|reviewed)/i.test(bodyText.slice(0,500));
    addCheck('freshness','Publication Date',hasDate||hasUpdated?'pass':'warn',3,hasDate?'Date markup found':hasUpdated?'Date mentioned in content':'No date markup detected',hasDate?'Good — date markup helps Google assess content freshness.':hasUpdated?'Date found in content. Add <time datetime="YYYY-MM-DD"> for proper markup.':'Add a publication/update date. Google favours fresh content for time-sensitive topics.');

    checks.sort((a,b)=>({fail:0,warn:1,pass:2}[a.status]-{fail:0,warn:1,pass:2}[b.status]));
    const score=pts.max>0?Math.round((pts.total/pts.max)*100):0;
    const grade=score>=85?'A':score>=70?'B':score>=55?'C':score>=40?'D':'F';
    const gradeLabel=score>=85?'Excellent':score>=70?'Good':score>=55?'Needs Work':score>=40?'Poor':'Critical';
    const gradeColor=score>=85?'#059669':score>=70?'#10b981':score>=55?'#f59e0b':score>=40?'#f97316':'#ef4444';
    res.json({ success:true, score, grade, gradeLabel, gradeColor, totalPoints:pts.total, maxPoints:pts.max, checks, summary:{ pass:checks.filter(c=>c.status==='pass').length, warn:checks.filter(c=>c.status==='warn').length, fail:checks.filter(c=>c.status==='fail').length }, meta:{ wordCount, sentences:sentCount, avgWordsPerSentence:parseFloat(avgWPS.toFixed(1)), readabilityScore:parseFloat(flesch.toFixed(0)), readability:readLabel } });
  } catch(err){ console.error('SEO audit error:',err); res.status(500).json({success:false,error:err.message}); }
});

/* ================================================================
   API 6 — COMPETITOR ANALYSIS
================================================================ */
app.post('/api/competitor-analysis', (req,res)=>{
  try {
    const { yourKeywords=[], competitorKeywords=[] } = req.body;
    const parseL = input=>input.map(item=>{ if(typeof item==='object'&&item)return item; const p=String(item).split(',').map(s=>s.trim()); return {keyword:p[0],volume:parseInt(p[1])||0}; }).filter(k=>k.keyword&&k.keyword.length>1);
    const yours=parseL(yourKeywords), comps=parseL(competitorKeywords);
    if(!yours.length||!comps.length) return res.status(400).json({success:false,error:'Both keyword lists required'});
    const yourSet=new Set(yours.map(k=>k.keyword.toLowerCase()));
    const compSet=new Set(comps.map(k=>k.keyword.toLowerCase()));
    const enrichKw=(k,extra={})=>{ const intent=detectIntent(k.keyword); const diff=estimateDifficulty(k.keyword); return {...k,intent,difficulty:diff.label,difficultyColor:diff.color,pageType:recommendPageType(k.keyword,intent),funnelStage:funnelStage(intent),opportunityScore:(({Easy:4,Low:3,Medium:2,Hard:1}[diff.label]||1))*((k.volume||0)>10000?5:(k.volume||0)>1000?3:(k.volume||0)>100?2:1),...extra}; };
    const shared=yours.filter(k=>compSet.has(k.keyword.toLowerCase())).map(k=>enrichKw(k));
    const onlyYours=yours.filter(k=>!compSet.has(k.keyword.toLowerCase())).map(k=>enrichKw(k));
    const onlyComp=comps.filter(k=>!yourSet.has(k.keyword.toLowerCase())).map(k=>enrichKw(k)).sort((a,b)=>b.opportunityScore-a.opportunityScore||(b.volume||0)-(a.volume||0));
    const union=new Set([...yourSet,...compSet]);
    const overlapPct=Math.round((shared.length/Math.max(union.size,1))*100);
    const buildD=kws=>{ const d={Informational:[],Transactional:[],Commercial:[],Navigational:[]}; kws.forEach(k=>d[detectIntent(k.keyword)].push(k)); return d; };
    const yD=buildD(yours), cD=buildD(comps);
    const intentComparison=['Transactional','Commercial','Informational','Navigational'].map(intent=>({ intent, yourCount:yD[intent].length, compCount:cD[intent].length, yourPct:Math.round((yD[intent].length/Math.max(yours.length,1))*100), compPct:Math.round((cD[intent].length/Math.max(comps.length,1))*100), diff:Math.round(((yD[intent].length/Math.max(yours.length,1))-(cD[intent].length/Math.max(comps.length,1)))*100) }));
    const yourClusters=new Set(yours.map(k=>clusterKey(k.keyword)));
    const clusterGaps={};
    comps.forEach(k=>{ const ck=clusterKey(k.keyword); if(!yourClusters.has(ck)){ if(!clusterGaps[ck])clusterGaps[ck]={clusterName:ck.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' '),keywords:[],totalVolume:0}; clusterGaps[ck].keywords.push(k); clusterGaps[ck].totalVolume+=k.volume||0; } });
    const topicGaps=Object.values(clusterGaps).sort((a,b)=>b.totalVolume-a.totalVolume||b.keywords.length-a.keywords.length).slice(0,20).map(c=>({...c,intent:detectIntent(c.keywords[0].keyword),pageType:recommendPageType(c.keywords[0].keyword,detectIntent(c.keywords[0].keyword))}));
    const quickWins=onlyComp.filter(k=>k.difficulty==='Easy'||k.difficulty==='Low').slice(0,15);
    const highValue=onlyComp.filter(k=>(k.volume||0)>1000).slice(0,10);
    const yO=yours.length-shared.length, cO=comps.length-shared.length, tot=yO+shared.length+cO;
    res.json({ success:true, stats:{yourKeywords:yours.length,compKeywords:comps.length,shared:shared.length,yourAdvantage:onlyYours.length,missing:onlyComp.length,overlapPct}, overlap:{yourPct:Math.round((yO/Math.max(tot,1))*100),sharedPct:Math.round((shared.length/Math.max(tot,1))*100),compPct:Math.round((cO/Math.max(tot,1))*100)}, shared, onlyYours, onlyComp, quickWins, highValue, topicGaps, intentComparison });
  } catch(err){ res.status(500).json({success:false,error:err.message}); }
});

/* ================================================================
   API 7 — KEYWORD GAP
================================================================ */
app.post('/api/keyword-gap', (req,res)=>{
  try {
    const { yourKeywords=[], competitorKeywords=[] } = req.body;
    const parseL=input=>input.map(item=>{ if(typeof item==='object'&&item)return item; const p=String(item).split(',').map(s=>s.trim()); return {keyword:p[0],volume:parseInt(p[1])||0}; }).filter(k=>k.keyword&&k.keyword.length>1);
    const yours=parseL(yourKeywords), comps=parseL(competitorKeywords);
    if(!yours.length||!comps.length) return res.status(400).json({success:false,error:'Both lists required'});
    const yourSet=new Set(yours.map(k=>k.keyword.toLowerCase()));
    const BRIEFS={ Transactional:'Build a product or landing page. Include CTA, pricing, testimonials, and trust signals (reviews, guarantees, security badges).', Commercial:'Write a detailed comparison or review post. Cover features, pros/cons, pricing. Include a clear verdict. Aim for 1,500+ words.', Informational:'Create a comprehensive guide or pillar article. Cover the topic fully with subheadings, FAQs, examples, and visuals.', Navigational:'Optimise your brand or about page, or create a dedicated landing page for this brand query.' };
    const ACTIONS={ Transactional:'Create product or landing page', Commercial:'Write comparison or review article', Informational:'Write blog post or guide', Navigational:'Optimise brand / about page' };
    const gaps=comps.filter(k=>!yourSet.has(k.keyword.toLowerCase())).map(k=>{ const intent=detectIntent(k.keyword); const diff=estimateDifficulty(k.keyword); const opp=((({Easy:4,Low:3,Medium:2,Hard:1}[diff.label]||1))*((k.volume||0)>10000?5:(k.volume||0)>1000?3:(k.volume||0)>100?2:1)); return {...k,intent,difficulty:diff.label,difficultyColor:diff.color,funnelStage:funnelStage(intent),pageType:recommendPageType(k.keyword,intent),opportunityScore:opp,contentBrief:BRIEFS[intent],recommendedAction:ACTIONS[intent]}; }).sort((a,b)=>b.opportunityScore-a.opportunityScore||(b.volume||0)-(a.volume||0));
    const shared=comps.filter(k=>yourSet.has(k.keyword.toLowerCase())).map(k=>{ const intent=detectIntent(k.keyword); const diff=estimateDifficulty(k.keyword); return {...k,intent,difficulty:diff.label}; });
    const gapsByIntent={};
    gaps.forEach(k=>{ if(!gapsByIntent[k.intent])gapsByIntent[k.intent]=[]; gapsByIntent[k.intent].push(k); });
    const gapsByFunnel={Awareness:[],Consideration:[],Decision:[]};
    gaps.forEach(k=>{ if(gapsByFunnel[k.funnelStage])gapsByFunnel[k.funnelStage].push(k); });
    const clusterMap={};
    gaps.forEach(k=>{ const ck=clusterKey(k.keyword); if(!clusterMap[ck])clusterMap[ck]={clusterName:ck.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' '),keywords:[],totalVolume:0}; clusterMap[ck].keywords.push(k); clusterMap[ck].totalVolume+=k.volume||0; });
    const topClusters=Object.values(clusterMap).sort((a,b)=>b.totalVolume-a.totalVolume||b.keywords.length-a.keywords.length).slice(0,15);
    const quickWins=gaps.filter(k=>k.difficulty==='Easy'||k.difficulty==='Low').slice(0,20);
    const coverageRate=Math.round((shared.length/Math.max(comps.length,1))*100);
    const gapRate=Math.round((gaps.length/Math.max(comps.length,1))*100);
    res.json({success:true,stats:{yourKeywords:yours.length,compKeywords:comps.length,gaps:gaps.length,shared:shared.length,coverageRate,gapRate},gaps,shared,quickWins,gapsByIntent,gapsByFunnel,topClusters,intentOrder:['Transactional','Commercial','Informational','Navigational']});
  } catch(err){ res.status(500).json({success:false,error:err.message}); }
});

/* ================================================================
   API 8 — WIKIPEDIA ENTITY
================================================================ */
app.get('/api/wikipedia-entity', async (req,res)=>{
  try {
    const topic=(req.query.topic||req.query.q||'').trim();
    if(!topic) return res.status(400).json({success:false,error:'No topic provided'});
    const enc=encodeURIComponent(topic), BASE='https://en.wikipedia.org';
    const [sumR,lnkR,catR,introR]=await Promise.allSettled([
      fetch(`${BASE}/api/rest_v1/page/summary/${enc}`).then(r=>r.json()),
      fetch(`${BASE}/w/api.php?action=query&titles=${enc}&prop=links&pllimit=100&format=json&origin=*`).then(r=>r.json()),
      fetch(`${BASE}/w/api.php?action=query&titles=${enc}&prop=categories&cllimit=50&format=json&origin=*&clshow=!hidden`).then(r=>r.json()),
      fetch(`${BASE}/w/api.php?action=query&titles=${enc}&prop=extracts&exlimit=1&explaintext=true&exsectionformat=plain&format=json&origin=*`).then(r=>r.json())
    ]);
    const sum=sumR.status==='fulfilled'?sumR.value:{};
    if(!sum.title||sum.type?.includes('not_found')) return res.status(404).json({success:false,error:`No Wikipedia article found for "${topic}".`});
    let relatedLinks=[];
    if(lnkR.status==='fulfilled'){ const pg=Object.values(lnkR.value?.query?.pages||{})[0]; relatedLinks=(pg?.links||[]).map(l=>l.title).filter(t=>!t.includes(':')&&!t.includes('(disambiguation)')); }
    let categories=[];
    if(catR.status==='fulfilled'){ const pg=Object.values(catR.value?.query?.pages||{})[0]; categories=(pg?.categories||[]).map(c=>c.title.replace('Category:','')).filter(c=>!c.match(/^(Articles|Wikipedia|Pages|CS1|Webarchive|All |Use |Coordinates|Short description|Good article|Featured|Cleanup)/)); }
    // Use full intro text for better entity/fact extraction
    let fullIntro='';
    if(introR.status==='fulfilled'){ const pg=Object.values(introR.value?.query?.pages||{})[0]; fullIntro=pg?.extract||''; }
    const text=fullIntro||sum.extract||''; const entities={people:[],organizations:[],places:[],dates:[],numbers:[]};
    let m;
    // People: broad name pattern (First [Middle] Last where each part starts uppercase)
    // Matches: John McCarthy, Alan Turing, Yann LeCun, Geoffrey Hinton, Marvin Minsky etc.
    const namePat=/\b([A-Z][A-Za-z]{1,14}(?:\s+[A-Z][A-Za-z]{1,14}){1,2})\b/g;
    const stopWords=new Set(['The','In','It','At','On','An','By','As','To','Of','Or','And','But','For','With','From','This','That','These','Those','They','Their','There','Then','When','Where','While','Which','Who','What','How','Also','Both','Each','Such','More','Most','Many','Some','Other','After','Before','During','Since','Although','However','Therefore','Moreover','Furthermore','Additionally','Nevertheless','Meanwhile','Artificial','Intelligence','United','States','Kingdom','January','February','March','April','June','July','August','September','October','November','December']);
    const personSignal=/\b(born|died|proposed|coined|won|wrote|founded|invented|developed|said|known|named|called|organized|created|introduced|described|argued|published|received|awarded|professor|scientist|researcher|engineer|pioneer|author|philosopher|mathematician|CEO|president|director|founder|minister)\b/i;
    const nonPerson=/^(Turing Test|Turing Award|Modern AI|Deep Learning|Machine Learning|Natural Language|Neural Network|Dartmouth Conference|United States|United Kingdom|New York|Los Angeles|San Francisco|Hong Kong|North America|South America|West Africa|East Asia|Middle East|Nobel Prize|World War|Cold War|Real World|Computer Science|Search Engine|Social Media|Open Source|Real Time)$/i;
    // Collect all name candidates with their match positions
    const nameCandidates=new Map();
    while((m=namePat.exec(text))!==null){
      const n=m[1].trim(); const parts=n.split(' ');
      if(parts.length>=2&&parts.length<=3&&!stopWords.has(parts[0])&&!stopWords.has(parts[parts.length-1])&&!/^[A-Z]{2,}$/.test(n)&&n.length<40&&!nonPerson.test(n)){
        if(!nameCandidates.has(n)) nameCandidates.set(n,[]);
        nameCandidates.get(n).push(m.index);
      }
    }
    // Check ALL occurrences of each candidate for person context
    nameCandidates.forEach((positions,n)=>{
      const hasContext=positions.some(pos=>{
        const ctx=text.slice(Math.max(0,pos-80),pos+n.length+80);
        return personSignal.test(ctx)||/,\s*(?:and\s+)?[A-Z][a-z]+\s+[A-Z]/.test(ctx);
      });
      if(hasContext&&!entities.people.includes(n)) entities.people.push(n);
    });
    // Orgs: formal names + "companies like X, Y" + known orgs
    [
      /\b([A-Z][A-Za-z0-9]{1,20}(?:\s+[A-Z][A-Za-z0-9]{1,20}){0,3})\s+(?:Inc\.|Corp\.|Ltd\.|LLC|PLC|Group|Corporation|Company|University|Institute|Foundation|Lab|Labs)/g,
    ].forEach(pat=>{ while((m=pat.exec(text))!==null){ const o=(m[1]||'').trim(); if(o.length>1&&!new Set(['THE','AND','OR','FOR','OF','IN','ON','AT','TO','BY','AN','IS','IT','AS','BE','A']).has(o)&&!entities.organizations.includes(o))entities.organizations.push(o); } });
    // "companies/organisations like X, Y, Z"
    const orgListPat=/(?:companies|organisations|organizations|firms|labs|researchers at)\s+(?:like|such as|including)\s+((?:[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)?,?\s*(?:and\s+)?){1,8})/g;
    while((m=orgListPat.exec(text))!==null){ m[1].split(/,\s*|\s+and\s+/).forEach(o=>{ o=o.trim(); if(o.length>1&&/^[A-Z]/.test(o)&&!entities.organizations.includes(o))entities.organizations.push(o); }); }
    ['United States','United Kingdom','Germany','France','Japan','China','India','Russia','Italy','Spain','Australia','Canada','Brazil'].forEach(p=>{ if(text.includes(p)&&!entities.places.includes(p))entities.places.push(p); });
    const inP=/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?=\s*[,.]|\s+[a-z])/g;
    while((m=inP.exec(text))!==null){ const p=m[1].trim(); if(p.length>3&&!['January','February','March','April','May','June','July','August','September','October','November','December'].includes(p)&&!entities.places.includes(p))entities.places.push(p); }
    const dp=/\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\b\d{4}\b)/g;
    while((m=dp.exec(text))!==null){ if(!entities.dates.includes(m[0]))entities.dates.push(m[0]); }
    const np=/\b(\d+(?:[,.]\d+)?(?:\s*(?:million|billion|trillion|thousand|percent|%|km|mi|kg|lb|metres?|feet|acres?)))\b/gi;
    while((m=np.exec(text))!==null){ if(!entities.numbers.includes(m[0]))entities.numbers.push(m[0]); }
    // Key facts: sentences with numbers OR important signal words
    const keyFacts=(text.match(/[^.!?]+[.!?]/g)||[])
      .filter(s=>/\d/.test(s)||/\b(founded|created|developed|invented|established|introduced|launched|released|discovered|first|largest|most|known as|defined as|refers to|is a|are a)\b/i.test(s))
      .slice(0,10).map(s=>s.trim());
    // Semantic keywords: context-aware based on topic type
    const topicLower=topic.toLowerCase();
    const yr=new Date().getFullYear();
    const isPerson=entities.people.some(p=>p.toLowerCase().includes(topicLower.split(' ')[0].toLowerCase()))||(sum.description||'').toLowerCase().includes('born')||(sum.description||'').toLowerCase().match(/businessman|entrepreneur|politician|scientist|author|actor|musician|athlete|ceo|founder|president/);
    const isPlace=(sum.description||'').toLowerCase().match(/city|country|town|village|region|state|nation|continent|island|river|mountain/)||entities.places.includes(topic);
    const isOrg=(sum.description||'').toLowerCase().match(/company|corporation|organisation|organization|university|institute|foundation|agency|department/);
    let semanticKeywords=[];
    if(isPerson){
      semanticKeywords=[topicLower,`${topicLower} net worth`,`${topicLower} age`,`${topicLower} biography`,`${topicLower} education`,`${topicLower} career`,`${topicLower} achievements`,`${topicLower} companies`,`${topicLower} early life`,`${topicLower} ${yr}`,`${topicLower} news`,`${topicLower} wife`,`${topicLower} children`];
    } else if(isPlace){
      semanticKeywords=[topicLower,`${topicLower} history`,`${topicLower} population`,`${topicLower} capital`,`${topicLower} culture`,`${topicLower} economy`,`things to do in ${topicLower}`,`best places in ${topicLower}`,`${topicLower} travel guide`,`${topicLower} ${yr}`,`visit ${topicLower}`,`${topicLower} facts`];
    } else if(isOrg){
      semanticKeywords=[topicLower,`${topicLower} history`,`${topicLower} products`,`${topicLower} services`,`${topicLower} revenue`,`${topicLower} ceo`,`${topicLower} headquarters`,`${topicLower} founded`,`${topicLower} employees`,`${topicLower} ${yr}`,`${topicLower} stock`,`${topicLower} review`];
    } else {
      semanticKeywords=[topicLower,`what is ${topicLower}`,`${topicLower} definition`,`${topicLower} history`,`${topicLower} explained`,`how does ${topicLower} work`,`${topicLower} examples`,`${topicLower} benefits`,`${topicLower} vs`,`${topicLower} types`,`${topicLower} ${yr}`,`best ${topicLower}`,`${topicLower} for beginners`];
    }
    // Add category-based keywords
    semanticKeywords=[...semanticKeywords,...categories.slice(0,4).map(cat=>cat.toLowerCase().replace(/,.*$/,'').trim())].filter((v,i,a)=>v&&v.length>2&&a.indexOf(v)===i);
    // Cap entities per category to avoid noise
    Object.keys(entities).forEach(k=>{ entities[k]=entities[k].slice(0,25); });
    res.json({success:true,topic:sum.title,description:sum.description,extract:sum.extract,thumbnail:sum.thumbnail?.source||null,url:sum.content_urls?.desktop?.page||null,entities,relatedLinks:relatedLinks.slice(0,50),categories:categories.slice(0,25),keyFacts,semanticKeywords});
  } catch(err){ res.status(500).json({success:false,error:err.message}); }
});

/* ================================================================
   API 9 — BACKLINKS
================================================================ */
app.post('/api/backlinks', async (req,res)=>{
  try {
    const { domain:raw } = req.body;
    if(!raw) return res.status(400).json({success:false,error:'No domain provided'});
    const domain=raw.replace(/https?:\/\//g,'').replace(/\/.*/g,'').toLowerCase().replace(/^www\./,'');
    const parts=domain.split('.'), domainName=parts[0], tld=parts.slice(1).join('.');
    const hasKw=kws=>kws.some(kw=>domainName===kw||domainName.startsWith(kw)||domainName.endsWith(kw)||domainName.includes('-'+kw)||domainName.includes(kw+'-'));
    const isEdu=tld==='edu'||tld==='ac.uk'||tld==='edu.au', isNP=tld==='org'||tld==='ngo'||tld==='charity';
    const isLocal=hasKw(['local','city','town','near','plumber','dentist','salon','restaurant','clinic','garage','bakery','solicitor','lawyer','accountant','electrician','builder','roofer','landscaper','cleaner','painter','locksmith','florist','optician','physio','vet','barber','hairdresser']);
    const isComm=hasKw(['shop','store','buy','deals','mart','market','price','cheap','sale','cart','boutique','outlet','wholesale','ecommerce','retail','goods','products']);
    const isInfo=hasKw(['blog','news','info','guide','learn','wiki','review','tips','times','post','journal','magazine','press','media','daily','weekly','report','hub','digest','central','insider']);
    const isSaas=hasKw(['app','tool','tools','soft','tech','digital','cloud','suite','platform','desk','base','stack','hub','api','dev','labs','io','saas','crm','erp','cms','hq','ai'])||tld==='io'||tld==='ai';
    const domainType=isEdu?'Educational':isNP?'Non-profit / Organisation':isLocal?'Local Business':isComm?'E-commerce':isInfo?'Blog / Media':isSaas?'SaaS / Tech':'Business Website';
    // Open PageRank — free domain authority score (requires free key from openpagerank.com)
    let pageRankData=null;
    const OPR_KEY=process.env.OPR_API_KEY||'';
    if(OPR_KEY){
      try {
        const prR=await fetch(`https://openpagerank.com/api/v1.0/getPageRank?domains[]=${encodeURIComponent(domain)}`,{
          headers:{'API-OPR':OPR_KEY},
          signal:AbortSignal.timeout(5000)
        });
        if(prR.ok){
          const prJson=await prR.json();
          const entry=(prJson.response||[])[0];
          if(entry){ pageRankData={pageRank:entry.page_rank_integer,domainRank:entry.rank,status:entry.status_code}; }
        }
      } catch {}
    } else {
      pageRankData={noKey:true};
    }
    // Common Crawl CDX — find pages ON this domain (crawl coverage indicator)
    let cdxLinks=null;
    try {
      const cdxR=await fetch(`https://index.commoncrawl.org/CC-MAIN-2024-10-index?url=*.${domain}&output=json&limit=100&fl=url,timestamp`,{signal:AbortSignal.timeout(8000)});
      if(cdxR.ok){
        const rows=(await cdxR.text()).trim().split('\n').filter(Boolean);
        const all=rows.map(r=>{try{return JSON.parse(r);}catch{return null;}}).filter(Boolean);
        const seen=new Set();
        cdxLinks=all.filter(r=>{
          try{ const path=new URL(r.url).pathname; if(seen.has(path))return false; seen.add(path); return true; }catch{return false;}
        }).slice(0,15);
      }
    } catch {}
    const freeTools=[{name:'Google Search Console',url:'https://search.google.com/search-console',badge:'Official',desc:'Your definitive backlink source. Shows every link Google has found to your site.'},{name:'Ahrefs Free Checker',url:`https://ahrefs.com/backlink-checker?input=${encodeURIComponent(domain)}`,badge:'Free Tier',desc:'Top 100 backlinks + Domain Rating. No account needed.'},{name:'Moz Link Explorer',url:`https://moz.com/link-explorer?site=${encodeURIComponent(domain)}`,badge:'10/month',desc:'Domain Authority + linking domains. 10 free queries per month.'},{name:'Semrush Backlink Analytics',url:`https://www.semrush.com/analytics/backlinks/?target=${encodeURIComponent(domain)}`,badge:'10/day',desc:'Full backlink database with toxicity scoring.'},{name:'Majestic Site Explorer',url:`https://majestic.com/reports/site-explorer?q=${encodeURIComponent(domain)}`,badge:'Free',desc:'Trust Flow & Citation Flow metrics.'},{name:'OpenLinkProfiler',url:`https://www.openlinkprofiler.org/r/${encodeURIComponent(domain)}`,badge:'100% Free',desc:'Completely free. No account required.'}];
    const anchorGuide=[{type:`Branded (${domainName})`,pct:40,note:'Safest and most natural.'},{type:`Naked URL (${domain})`,pct:20,note:'The plain URL as clickable text.'},{type:'Generic (click here, read more)',pct:15,note:'Adds natural variation.'},{type:'Partial match keyword',pct:15,note:'Contains the keyword but not exact.'},{type:'Exact match keyword',pct:10,note:'Too many can trigger Google Penguin filter.'}];
    const typeStrats={'E-commerce':[{icon:'fa-tag',priority:'High',title:'Product Review Outreach',desc:'Send products to bloggers, YouTubers, and influencers for genuine reviews. A DR 40+ blog review drives both links and sales.'},{icon:'fa-list',priority:'High',title:'Shopping Directory Listings',desc:'Submit to Google Shopping, PriceRunner, Kelkoo, and niche comparison sites.'},{icon:'fa-star',priority:'Medium',title:'"Best of" Roundup Mentions',desc:'Reach out to "best [product type]" roundup articles and ask to be featured.'}],'SaaS / Tech':[{icon:'fa-code',priority:'High',title:'Integration & Marketplace Listings',desc:'Build integrations with Zapier, Make, HubSpot. Each marketplace listing is a permanent high-authority backlink.'},{icon:'fa-trophy',priority:'High',title:'Product Hunt & G2/Capterra',desc:'A strong Product Hunt launch earns tech blog coverage. G2 and Capterra listings provide ongoing link equity.'},{icon:'fa-book',priority:'Medium',title:'Developer Docs & API Tutorials',desc:'Publish comprehensive API docs and tutorials. Developer community links are highly trusted.'}],'Blog / Media':[{icon:'fa-chart-bar',priority:'High',title:'Original Data & Industry Research',desc:'Publish annual surveys or original studies. Journalists cite primary data constantly — one study earns hundreds of links.'},{icon:'fa-users',priority:'High',title:'Expert Quote Roundups',desc:'Publish roundups featuring 15+ industry experts. They almost always share and link back.'},{icon:'fa-newspaper',priority:'Medium',title:'Newsjacking & Trend Commentary',desc:'Publish expert commentary on breaking industry news. Journalists link to the best early analysis.'}],'Local Business':[{icon:'fa-map-pin',priority:'High',title:'Local Directory Citations',desc:'Consistent NAP across Google Business Profile, Yelp, Yell.com, Checkatrade, Trustpilot. Essential for local ranking.'},{icon:'fa-building',priority:'High',title:'Chamber & Trade Body Membership',desc:'Join your local chamber of commerce and trade associations. Their directories provide permanent trusted backlinks.'},{icon:'fa-heart',priority:'Medium',title:'Local Sponsorships & Events',desc:'Sponsor local events, charities, or sports teams. Organisers almost always link to sponsors.'}]};
    const baseStrats=[{icon:'fa-newspaper',priority:'High',title:'Create Linkable Assets',desc:'Original research, free tools, infographics, ultimate guides — content others want to cite. One great asset earns hundreds of natural links.'},{icon:'fa-handshake',priority:'High',title:'Guest Posting on Authority Sites',desc:`Write expert articles for DR 40+ sites in your niche. Include 1–2 contextual links to ${domain}.`},{icon:'fa-bell',priority:'Medium',title:'Brand Mention Monitoring',desc:`Set Google Alerts for "${domainName}". When mentioned without a link, send a brief friendly link request.`},{icon:'fa-link',priority:'Medium',title:'Broken Link Building',desc:'Find broken outbound links on authority sites in your niche. Offer your content as a replacement.'},{icon:'fa-comments',priority:'Medium',title:'HARO & Qwoted',desc:'Respond to journalist queries at helpareporter.com and qwoted.com to earn high-authority press coverage.'}];
    const strategies=[...(typeStrats[domainType]||[]),...baseStrats].slice(0,8);
    const analysisAreas=[{icon:'fa-star',title:'Domain Rating / Authority',color:'#0ea5e9',what:'A 0–100 score measuring overall backlink profile strength.',good:'DR 50+ is strong in most niches.',howToCheck:'Ahrefs Free Backlink Checker.'},{icon:'fa-sitemap',title:'Referring Domains',color:'#7c3aed',what:'Number of unique websites linking to your domain.',good:'1 link from 100 sites beats 100 links from 1 site.',howToCheck:'Google Search Console → Links → Top linking sites.'},{icon:'fa-tag',title:'Anchor Text Distribution',color:'#f59e0b',what:'The clickable text used in links to your site.',good:'~40% branded, 20% naked URL, 15% generic, 15% partial, 10% exact.',howToCheck:'Ahrefs, Semrush, or Majestic.'},{icon:'fa-skull-crossbones',title:'Toxic / Spammy Links',color:'#ef4444',what:'Links from low-quality or penalised sites.',good:'Disavow truly harmful links. Don\'t over-disavow — most spam is ignored.',howToCheck:'Semrush Backlink Audit with toxicity scoring.'},{icon:'fa-chart-line',title:'Link Velocity & Trends',color:'#10b981',what:'Rate at which you gain or lose backlinks over time.',good:'Steady organic growth looks natural.',howToCheck:'Ahrefs "New & Lost" chart.'},{icon:'fa-file-alt',title:'Top Linked Pages',color:'#64748b',what:'Which of your pages receive the most inbound links.',good:'Deep content pages with backlinks signal topical authority.',howToCheck:'Google Search Console → Links → Top linked pages.'}];
    res.json({success:true,domain,domainName,tld,domainType,pageRankData,cdxLinks,freeTools,anchorGuide,strategies,analysisAreas});
  } catch(err){ res.status(500).json({success:false,error:err.message}); }
});

/* ================================================================
   API 10 — KEYWORD TRACKING
================================================================ */
const TF=path.join(__dirname,'data','keyword-tracking.json');
const ensureDir=f=>{ const d=path.dirname(f); if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true}); };
const loadT=()=>{ try{ ensureDir(TF); return fs.existsSync(TF)?JSON.parse(fs.readFileSync(TF,'utf8')):{};} catch{return{};} };
const saveT=d=>{ ensureDir(TF); fs.writeFileSync(TF,JSON.stringify(d,null,2)); };

app.get('/api/keyword-tracking',(req,res)=>{ try{ res.json({success:true,data:loadT()}); }catch(e){ res.status(500).json({success:false,error:e.message}); } });
app.post('/api/keyword-tracking',(req,res)=>{
  try {
    const {keyword,position,url='',date,target,notes=''} = req.body;
    if(!keyword?.trim()) return res.status(400).json({success:false,error:'No keyword provided'});
    const pos=parseInt(position); if(!pos||pos<1||pos>200) return res.status(400).json({success:false,error:'Position must be 1–200'});
    const dt=date||new Date().toISOString().split('T')[0];
    const data=loadT(), kw=keyword.trim();
    if(!data[kw])data[kw]={url:'',target:null,notes:'',entries:[]};
    if(url)data[kw].url=url.trim(); if(target)data[kw].target=parseInt(target)||null; if(notes)data[kw].notes=notes.trim();
    data[kw].entries=data[kw].entries.filter(e=>e.date!==dt); data[kw].entries.push({date:dt,pos}); data[kw].entries.sort((a,b)=>a.date.localeCompare(b.date));
    saveT(data); res.json({success:true,data});
  } catch(e){ res.status(500).json({success:false,error:e.message}); }
});
app.post('/api/keyword-tracking/bulk',(req,res)=>{
  try {
    const {entries=[]}=req.body; if(!entries.length) return res.status(400).json({success:false,error:'No entries'});
    const data=loadT(); let added=0;
    entries.forEach(e=>{ const kw=(e.keyword||'').trim(); const pos=parseInt(e.position||e.pos); if(!kw||!pos||pos<1||pos>200)return; const dt=e.date||new Date().toISOString().split('T')[0]; if(!data[kw])data[kw]={url:e.url||'',target:null,notes:'',entries:[]}; data[kw].entries=data[kw].entries.filter(en=>en.date!==dt); data[kw].entries.push({date:dt,pos}); data[kw].entries.sort((a,b)=>a.date.localeCompare(b.date)); added++; });
    saveT(data); res.json({success:true,added,data});
  } catch(e){ res.status(500).json({success:false,error:e.message}); }
});
app.delete('/api/keyword-tracking/:keyword',(req,res)=>{ try{ const kw=decodeURIComponent(req.params.keyword); const data=loadT(); if(!data[kw])return res.status(404).json({success:false,error:'Not found'}); delete data[kw]; saveT(data); res.json({success:true,data}); }catch(e){ res.status(500).json({success:false,error:e.message}); } });
app.delete('/api/keyword-tracking',(req,res)=>{ try{ saveT({}); res.json({success:true,data:{}}); }catch(e){ res.status(500).json({success:false,error:e.message}); } });

/* ================================================================
   ERROR HANDLER + SERVER START
================================================================ */
app.use((req,res)=>res.status(404).json({success:false,error:'Endpoint not found'}));
const PORT=process.env.PORT||8003;
['uploads','public','data'].forEach(d=>{ if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true}); });
app.listen(PORT,()=>{
  console.log(`\n🚀 ClusterSEO Pro API v6.0 — http://localhost:${PORT}`);
  console.log('─'.repeat(60));
  ['GET  /auth/google           → GSC OAuth Login','GET  /auth/callback          → GSC OAuth Callback','GET  /auth/status            → GSC Connection Status','GET  /api/gsc/sites          → List GSC Sites','GET  /api/gsc/keywords       → GSC Top Keywords','GET  /api/gsc/pages          → GSC Top Pages','GET  /api/gsc/performance    → GSC Performance Chart','POST /api/process-keywords  → Keyword Clustering','POST /api/process-csv        → Clustering via CSV','GET  /api/suggest             → Keyword Research (+A-Z)','POST /api/extract-entities   → Entity Finder v4 (NLP)','GET  /api/pagespeed          → PageSpeed Insights (free)','POST /api/seo-audit          → SEO Audit (22 checks)','POST /api/competitor-analysis→ Competitor Analysis','POST /api/keyword-gap        → Keyword Gap + briefs','GET  /api/wikipedia-entity   → Wikipedia + Semantic KW','POST /api/backlinks          → Backlinks + CDX + Strategy','GET  /api/keyword-tracking   → Tracking (read)','POST /api/keyword-tracking   → Tracking (add/update)','POST /api/keyword-tracking/bulk → Tracking (bulk)','DEL  /api/keyword-tracking/:kw → Delete one keyword','DEL  /api/keyword-tracking   → Clear all tracking'].forEach(l=>console.log('✅ '+l));
  console.log('─'.repeat(60));
});