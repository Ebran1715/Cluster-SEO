/* shared-layout.js — injects navbar + footer on every page */
(function () {

  /* ── Page detection ──────────────────────────────────────────── */
  var currentPage = window.location.pathname.split('/').pop() || 'index.html';

  /* FIX #1: isToolPage used properly to keep "Tools" active on ALL tool pages */
  var toolPages = [
    'tool.html', 'research.html', 'tools.html',
    'entity-finder.html', 'seo-audit.html', 'backlinks.html',
    'keyword-tracking.html', 'competitor.html',
    'keyword-gap.html', 'wikipedia-entity.html'
  ];
  var isToolPage = toolPages.includes(currentPage);
  var year = new Date().getFullYear();

  /* ── FIX #2: Inject CSS into <head>, NOT inside <body> ───────── */
  /* Prevents invalid HTML and eliminates flash of unstyled content  */
  var style = document.createElement('style');
  style.textContent = `
    .topbar {
      background: var(--navy, #0f172a);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 12px 28px;
      position: sticky;
      top: 0;
      z-index: 1000;
      backdrop-filter: blur(8px);
    }
    .topbar-inner {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
    }
    .logo-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, #0ea5e9, #2563eb);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 14px;
    }
    .logo-text {
      font-weight: 800;
      font-size: 1.1rem;
      color: #ffffff;
      letter-spacing: -0.02em;
    }
    .logo-text span { color: #0ea5e9; margin-left: 2px; }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 24px;
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .nav-links li { margin: 0; padding: 0; }
    .nav-links a {
      color: rgba(255,255,255,0.7);
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      transition: color 0.2s;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 0;
    }
    .nav-links a:hover { color: white; }
    .nav-links a.active {
      color: white;
      border-bottom: 2px solid #0ea5e9;
    }
    .nav-links a i { color: #0ea5e9; font-size: 13px; }
    .nav-cta {
      background: linear-gradient(135deg, #0ea5e9, #2563eb);
      color: white !important;
      padding: 8px 18px !important;
      border-radius: 30px;
      font-weight: 700;
      margin-left: 8px;
      border: none;
    }
    .nav-cta:hover { opacity: 0.9; color: white !important; border-bottom: none !important; }
    .hamburger {
      display: none;
      flex-direction: column;
      gap: 4px;
      background: none;
      border: none;
      cursor: pointer;
      padding: 5px;
    }
    .hamburger span {
      width: 22px;
      height: 2px;
      background: white;
      border-radius: 2px;
      transition: all 0.2s;
    }
    .mobile-menu {
      display: none;
      background: #1e293b;
      padding: 16px 20px;
      flex-direction: column;
      gap: 12px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .mobile-menu.open { display: flex; }
    .mobile-menu a {
      color: rgba(255,255,255,0.7);
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .mobile-menu a i { color: #0ea5e9; width: 20px; }
    .mobile-menu a.active { color: white; }
    @media (max-width: 800px) {
      .nav-links { display: none; }
      .hamburger { display: flex; }
    }
    footer {
      background: #0f172a;
      border-top: 1px solid rgba(255,255,255,0.06);
      padding: 48px 28px 24px;
      color: rgba(255,255,255,0.6);
      margin-top: auto;
    }
    .footer-inner { max-width: 1200px; margin: 0 auto; }
    .footer-top {
      display: grid;
      grid-template-columns: 2fr repeat(3, 1fr);
      gap: 40px;
      margin-bottom: 48px;
    }
    @media (max-width: 800px) { .footer-top { grid-template-columns: 1fr 1fr; gap: 30px; } }
    @media (max-width: 500px) { .footer-top { grid-template-columns: 1fr; } }
    .footer-brand-logo { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
    .footer-brand-icon {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, #0ea5e9, #2563eb);
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      color: white; font-size: 14px;
    }
    .footer-brand-name { font-weight: 800; font-size: 1.1rem; color: white; }
    .footer-brand p { font-size: 13px; line-height: 1.7; color: rgba(255,255,255,0.5); max-width: 260px; margin-bottom: 20px; }
    .social-links { display: flex; gap: 12px; flex-wrap: wrap; }
    .social-link {
      width: 34px; height: 34px; border-radius: 50%;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      display: flex; align-items: center; justify-content: center;
      color: rgba(255,255,255,0.5); text-decoration: none; transition: all 0.2s;
    }
    .social-link:hover { background: #0ea5e9; border-color: #0ea5e9; color: white; }
    .footer-col h4 { font-size: 13px; font-weight: 700; color: white; margin-bottom: 20px; letter-spacing: 0.05em; text-transform: uppercase; }
    .footer-col ul { list-style: none; margin: 0; padding: 0; }
    .footer-col li { margin-bottom: 12px; }
    .footer-col a { color: rgba(255,255,255,0.5); text-decoration: none; font-size: 13px; transition: color 0.2s; display: inline-flex; align-items: center; gap: 6px; }
    .footer-col a:hover { color: white; }
    .footer-col a i { font-size: 10px; color: #0ea5e9; opacity: 0.5; }
    .footer-bottom {
      padding-top: 24px;
      border-top: 1px solid rgba(255,255,255,0.06);
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 16px;
      font-size: 12px; color: rgba(255,255,255,0.4);
    }
    .footer-badges { display: flex; gap: 12px; }
    .f-badge {
      padding: 3px 9px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 100px;
      font-size: 10px; font-weight: 600;
    }
  `;
  document.head.appendChild(style);

  /* ── Navbar HTML ─────────────────────────────────────────────── */
  /* FIX #1: NO class="${isActive()}" in template — active set by JS below */
  var navbar = `
  <nav class="topbar">
    <div class="topbar-inner">
      <a href="index.html" class="logo">
        <div class="logo-icon"><i class="fas fa-project-diagram"></i></div>
        <div class="logo-text">ClusterSEO<span>PRO</span></div>
      </a>
      <ul class="nav-links">
        <li><a href="index.html">Home</a></li>
        <li><a href="tools.html"><i class="fas fa-tools"></i> Tools</a></li>
        <li><a href="features.html">Features</a></li>
        <li><a href="how-it-works.html">How It Works</a></li>
        <li><a href="blog.html">Blog</a></li>
        <li><a href="contact.html">Contact</a></li>
        <li><a href="tool.html" class="nav-cta">Start Free →</a></li>
      </ul>
      <button class="hamburger" onclick="document.getElementById('mobileMenu').classList.toggle('open')" aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
    </div>
  </nav>
  <div class="mobile-menu" id="mobileMenu">
    <a href="index.html"><i class="fas fa-home"></i> Home</a>
    <a href="tools.html"><i class="fas fa-th-large"></i> All Tools</a>
    <a href="tool.html"><i class="fas fa-layer-group"></i> Keyword Clustering</a>
    <a href="research.html"><i class="fas fa-search"></i> Keyword Research</a>
    <a href="entity-finder.html"><i class="fas fa-tags"></i> Entity Finder</a>
    <a href="seo-audit.html"><i class="fas fa-stethoscope"></i> SEO Audit</a>
    <a href="keyword-tracking.html"><i class="fas fa-chart-line"></i> Keyword Tracking</a>
    <a href="competitor.html"><i class="fas fa-chess"></i> Competitor Analysis</a>
    <a href="keyword-gap.html"><i class="fas fa-not-equal"></i> Keyword Gap</a>
    <a href="wikipedia-entity.html"><i class="fab fa-wikipedia-w"></i> Wikipedia Entities</a>
    <a href="backlinks.html"><i class="fas fa-link"></i> Backlinks Overview</a>
    <a href="features.html"><i class="fas fa-star"></i> Features</a>
    <a href="how-it-works.html"><i class="fas fa-question-circle"></i> How It Works</a>
    <a href="blog.html"><i class="fas fa-blog"></i> Blog</a>
    <a href="contact.html"><i class="fas fa-envelope"></i> Contact</a>
  </div>`;

  /* ── Footer HTML ─────────────────────────────────────────────── */
  var footer = `
  <footer>
    <div class="footer-inner">
      <div class="footer-top">
        <div class="footer-brand">
          <div class="footer-brand-logo">
            <div class="footer-brand-icon"><i class="fas fa-project-diagram"></i></div>
            <div class="footer-brand-name">ClusterSEO Pro</div>
          </div>
          <p>The free SEO toolkit built for modern professionals. Cluster, research, audit and track — no signup, no cost, no limits.</p>
          <div class="social-links">
            <a href="https://twitter.com/clusterseopro" target="_blank" rel="noopener" class="social-link" title="X / Twitter"><i class="fab fa-x-twitter"></i></a>
            <a href="https://facebook.com/clusterseopro" target="_blank" rel="noopener" class="social-link" title="Facebook"><i class="fab fa-facebook-f"></i></a>
            <a href="https://linkedin.com/company/clusterseopro" target="_blank" rel="noopener" class="social-link" title="LinkedIn"><i class="fab fa-linkedin-in"></i></a>
            <a href="https://youtube.com/@clusterseopro" target="_blank" rel="noopener" class="social-link" title="YouTube"><i class="fab fa-youtube"></i></a>
            <a href="https://instagram.com/clusterseopro" target="_blank" rel="noopener" class="social-link" title="Instagram"><i class="fab fa-instagram"></i></a>
            <a href="https://github.com/clusterseopro" target="_blank" rel="noopener" class="social-link" title="GitHub"><i class="fab fa-github"></i></a>
          </div>
        </div>
        <div class="footer-col">
          <h4>Tools</h4>
          <ul>
            <li><a href="tools.html"><i class="fas fa-chevron-right"></i> All Tools</a></li>
            <li><a href="tool.html"><i class="fas fa-chevron-right"></i> Keyword Clustering</a></li>
            <li><a href="research.html"><i class="fas fa-chevron-right"></i> Keyword Research</a></li>
            <li><a href="entity-finder.html"><i class="fas fa-chevron-right"></i> Entity Finder</a></li>
            <li><a href="seo-audit.html"><i class="fas fa-chevron-right"></i> SEO Audit</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h4>More Tools</h4>
          <ul>
            <li><a href="keyword-tracking.html"><i class="fas fa-chevron-right"></i> Keyword Tracking</a></li>
            <li><a href="competitor.html"><i class="fas fa-chevron-right"></i> Competitor Analysis</a></li>
            <li><a href="keyword-gap.html"><i class="fas fa-chevron-right"></i> Keyword Gap</a></li>
            <li><a href="wikipedia-entity.html"><i class="fas fa-chevron-right"></i> Wikipedia Entity</a></li>
            <li><a href="backlinks.html"><i class="fas fa-chevron-right"></i> Backlinks Overview</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h4>Resources</h4>
          <ul>
            <li><a href="blog.html"><i class="fas fa-chevron-right"></i> Blog</a></li>
            <li><a href="how-it-works.html"><i class="fas fa-chevron-right"></i> How It Works</a></li>
            <li><a href="features.html"><i class="fas fa-chevron-right"></i> Features</a></li>
            <li><a href="privacy.html"><i class="fas fa-chevron-right"></i> Privacy</a></li>
            <li><a href="terms.html"><i class="fas fa-chevron-right"></i> Terms</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <p>© ${year} ClusterSEO Pro. Free forever — no signup required.</p>
        <div class="footer-badges">
          <span class="f-badge">✨ 9 Free Tools</span>
          <span class="f-badge">🚀 No Signup</span>
          <span class="f-badge">⚡ v4.0</span>
        </div>
      </div>
    </div>
  </footer>`;

  /* ── Inject into DOM ─────────────────────────────────────────── */
  document.body.insertAdjacentHTML('afterbegin', navbar);
  document.body.insertAdjacentHTML('beforeend', footer);

  /* ── FIX #3 + #4: Single active-state handler, runs immediately ─ */
  /* No DOMContentLoaded needed — script runs after body is parsed   */
  /* isToolPage correctly highlights "Tools" on ALL 9 tool pages     */
  function applyActiveStates() {
    /* Desktop nav */
    document.querySelectorAll('.nav-links a').forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href || link.classList.contains('nav-cta')) return;
      /* Exact page match */
      if (href === currentPage) link.classList.add('active');
      /* "Tools" stays active on any tool page */
      if (href === 'tools.html' && isToolPage) link.classList.add('active');
    });

    /* Mobile menu */
    document.querySelectorAll('.mobile-menu a').forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href) return;
      if (href === currentPage) link.classList.add('active');
      /* Close menu on tap */
      link.addEventListener('click', function () {
        var menu = document.getElementById('mobileMenu');
        if (menu) menu.classList.remove('open');
      });
    });
  }

  /* FIX #4: Guard against DOMContentLoaded already having fired */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyActiveStates);
  } else {
    applyActiveStates();
  }

})();