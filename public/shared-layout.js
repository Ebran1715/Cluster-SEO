/* shared-layout.js — injects navbar + footer on every page */
(function() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    function isActive(page) { return currentPage === page ? 'active' : ''; }
    const year = new Date().getFullYear();
  
    const navbar = `
    <nav class="topbar">
      <div class="topbar-inner">
        <a href="index.html" class="logo">
          <div class="logo-icon"><i class="fas fa-project-diagram"></i></div>
          <div class="logo-text">ClusterSEO<span>PRO</span></div>
        </a>
        <ul class="nav-links">
          <li><a href="index.html"        class="${isActive('index.html')}">Home</a></li>
          <li><a href="tool.html"         class="${isActive('tool.html')}">Tool</a></li>
          <li><a href="features.html"     class="${isActive('features.html')}">Features</a></li>
          <li><a href="how-it-works.html" class="${isActive('how-it-works.html')}">How It Works</a></li>
          <li><a href="blog.html"         class="${isActive('blog.html')}">Blog</a></li>
          <li><a href="contact.html"      class="${isActive('contact.html')}">Contact</a></li>
          <li><a href="tool.html" class="nav-cta">Start Clustering →</a></li>
        </ul>
        <button class="hamburger" onclick="document.getElementById('mobileMenu').classList.toggle('open')" aria-label="Menu">
          <span></span><span></span><span></span>
        </button>
      </div>
    </nav>
    <div class="mobile-menu" id="mobileMenu">
      <a href="index.html">Home</a>
      <a href="tool.html">Tool</a>
      <a href="features.html">Features</a>
      <a href="how-it-works.html">How It Works</a>
      <a href="blog.html">Blog</a>
      <a href="contact.html">Contact</a>
    </div>`;
  
    const footer = `
    <footer>
      <div class="footer-inner">
        <div class="footer-top">
          <div class="footer-brand">
            <div class="footer-brand-logo">
              <div class="footer-brand-icon"><i class="fas fa-project-diagram"></i></div>
              <div class="footer-brand-name">ClusterSEO Pro</div>
            </div>
            <p>The free keyword clustering tool built for modern SEO professionals. Group, classify, and rank smarter with intent-based analysis.</p>
            <div class="social-links">
              <a href="https://twitter.com/clusterseopro"            target="_blank" rel="noopener" class="social-link twitter"   title="Follow on X / Twitter"><i class="fab fa-x-twitter"></i></a>
              <a href="https://facebook.com/clusterseopro"           target="_blank" rel="noopener" class="social-link facebook"  title="Follow on Facebook"><i class="fab fa-facebook-f"></i></a>
              <a href="https://linkedin.com/company/clusterseopro"   target="_blank" rel="noopener" class="social-link linkedin"  title="Follow on LinkedIn"><i class="fab fa-linkedin-in"></i></a>
              <a href="https://youtube.com/@clusterseopro"           target="_blank" rel="noopener" class="social-link youtube"   title="Subscribe on YouTube"><i class="fab fa-youtube"></i></a>
              <a href="https://instagram.com/clusterseopro"          target="_blank" rel="noopener" class="social-link instagram" title="Follow on Instagram"><i class="fab fa-instagram"></i></a>
              <a href="https://github.com/clusterseopro"             target="_blank" rel="noopener" class="social-link github"    title="View on GitHub"><i class="fab fa-github"></i></a>
            </div>
          </div>
          <div class="footer-col">
            <h4>Product</h4>
            <ul>
              <li><a href="tool.html">Keyword Clusterer</a></li>
              <li><a href="tool.html">Upload CSV</a></li>
              <li><a href="tool.html">Manual Input</a></li>
              <li><a href="tool.html">Export Results</a></li>
              <li><a href="features.html">All Features</a></li>
            </ul>
          </div>
          <div class="footer-col">
            <h4>Learn</h4>
            <ul>
              <li><a href="blog.html">Blog</a></li>
              <li><a href="how-it-works.html">How It Works</a></li>
              <li><a href="features.html">Features</a></li>
              <li><a href="blog.html">Keyword Clustering</a></li>
              <li><a href="blog.html">Search Intent Guide</a></li>
            </ul>
          </div>
          <div class="footer-col">
            <h4>Company</h4>
            <ul>
              <li><a href="contact.html">Contact Us</a></li>
              <li><a href="privacy.html">Privacy Policy</a></li>
              <li><a href="terms.html">Terms of Use</a></li>
              <li><a href="blog.html">Blog</a></li>
            </ul>
          </div>
        </div>
        <div class="footer-bottom">
          <p>© ${year} ClusterSEO Pro. All rights reserved. Built for SEO professionals worldwide.</p>
          <div class="footer-badges">
            <span class="f-badge">Free Tool</span>
            <span class="f-badge">No Signup</span>
            <span class="f-badge">v4.0</span>
          </div>
        </div>
      </div>
    </footer>`;
  
    document.body.insertAdjacentHTML('afterbegin', navbar);
    document.body.insertAdjacentHTML('beforeend', footer);
  })();