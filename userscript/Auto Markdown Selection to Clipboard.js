// ==UserScript==
// @name         AutoCopy Markdown (Obsidian-like + MediaWiki Math display fixed)
// @namespace    mdclipper.autocopy
// @version      2.4.0
// @description  Selection -> sanitize (preserve MathML) -> turndown(GFM) with MediaWiki math rule -> postprocess -> clipboard + toast.
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM.setClipboard
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js
// @require      https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js
// @require      https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.3/dist/turndown-plugin-gfm.js
// @require      https://cdn.jsdelivr.net/npm/mathml-to-latex@1.5.0/dist/mathml-to-latex.min.js
// ==/UserScript==

(function () {
  'use strict';

  const Policies = Object.freeze({
    debug: false,
    debounceMs: 120,
    cooldownMs: 80,

    preferGMSetClipboardSync: true,

    tightLists: true,
    adjacentDisplayMathTight: true,
    blanklineMax: 1,

    sanitizeWithDOMPurify: true,

    // MediaWiki / Wikipedia math
    wikipediaPreferTexAnnotation: true,
    wikipediaRemoveResidualMathImagesAfterExtract: true,
  });

  const Log = {
    d: (...a) => Policies.debug && console.debug('[mdclip]', ...a),
    w: (...a) => console.warn('[mdclip]', ...a),
  };

  function normalizeInvisibleUnicode(s) {
    return (s || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function stableHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function isEditableTarget(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return false;
    return !!el.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
  }

  class ToastService {
    constructor() { this.el = null; this.timer = null; }
    show(msg, ok = true) {
      if (!this.el) this.el = this._create();
      this.el.textContent = msg;
      this.el.style.opacity = '1';
      this.el.style.transform = 'translateY(0px)';
      this.el.dataset.state = ok ? 'ok' : 'fail';
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.el.style.opacity = '0';
        this.el.style.transform = 'translateY(6px)';
      }, 900);
    }
    _create() {
      const n = document.createElement('div');
      n.id = '__mdclip_toast';
      n.style.cssText = [
        'position:fixed','right:16px','bottom:16px',
        'z-index:2147483647','pointer-events:none',
        'max-width:60vw','padding:10px 12px','border-radius:10px',
        'font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
        'box-shadow:0 6px 18px rgba(0,0,0,0.18)',
        'background:rgba(20,20,20,0.92)','color:white',
        'opacity:0','transform:translateY(6px)',
        'transition:opacity 160ms ease, transform 160ms ease',
        'white-space:pre-wrap'
      ].join(';');
      document.documentElement.appendChild(n);
      return n;
    }
  }
  const toast = new ToastService();

  class ClipboardService {
    writeNow(text) {
      if (Policies.preferGMSetClipboardSync) {
        try {
          if (typeof GM_setClipboard === 'function') {
            GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' });
            return { started: true, immediateOk: true };
          }
        } catch (e) { Log.d('GM_setClipboard failed', e); }
      }
      try {
        if (typeof GM !== 'undefined' && typeof GM.setClipboard === 'function') {
          const p = Promise.resolve(GM.setClipboard(text, { type: 'text', mimetype: 'text/plain' }))
            .then(() => true).catch(() => false);
          return { started: true, promise: p };
        }
      } catch (e) { Log.d('GM.setClipboard failed', e); }

      try {
        if (navigator.clipboard?.writeText) {
          const p = navigator.clipboard.writeText(text).then(() => true).catch(() => false);
          return { started: true, promise: p };
        }
      } catch (e) { Log.d('navigator.clipboard failed', e); }

      return { started: false };
    }
  }
  const clipboard = new ClipboardService();

  class SelectionCapture {
    getPrimaryRange() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

      try {
        if (typeof sel.getComposedRanges === 'function') {
          const ranges = sel.getComposedRanges();
          if (ranges && ranges.length) {
            const sr = ranges[0];
            const r = document.createRange();
            r.setStart(sr.startContainer, sr.startOffset);
            r.setEnd(sr.endContainer, sr.endOffset);
            return r;
          }
        }
      } catch {}

      try { return sel.getRangeAt(0); } catch { return null; }
    }

    cloneFragment(range) {
      const frag = range.cloneContents();
      const div = document.createElement('div');
      div.appendChild(frag);
      return div;
    }
  }
  const capture = new SelectionCapture();

  class DOMSanitizer {
    sanitize(container) {
      container.querySelectorAll('script, style, noscript, textarea').forEach(n => n.remove());

      if (Policies.sanitizeWithDOMPurify && window.DOMPurify) {
        // Preserve MathML/SVG/HTML; also keep MediaWiki-relevant attrs.
        // ADD_ATTR matters: some setups otherwise drop typeof/alttext/aria-label which are used for TeX extraction.
        const cleanFrag = window.DOMPurify.sanitize(container, {
          RETURN_DOM_FRAGMENT: true,
          USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true },
          ADD_ATTR: ['class', 'id', 'href', 'src', 'alt', 'aria-label', 'typeof', 'alttext', 'data-latex', 'display'],
          FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
          FORBID_ATTR: ['style', 'onload', 'onerror', 'onclick', 'onmouseover', 'onmouseenter', 'onmouseleave']
        });

        container.innerHTML = '';
        container.appendChild(cleanFrag);
      }

      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const n of nodes) n.nodeValue = normalizeInvisibleUnicode(n.nodeValue || '');

      return container;
    }
  }
  const sanitizer = new DOMSanitizer();

  function detectCodeLanguage(codeEl, preEl) {
    const cls = (codeEl.getAttribute('class') || '') + ' ' + (preEl?.getAttribute?.('class') || '');
    const m = cls.match(/(?:language|lang)-([a-z0-9_+-]+)/i);
    return m ? m[1].toLowerCase() : '';
  }

  function fenceCode(raw, lang) {
    const body = (raw || '').replace(/\s+$/g, '');
    return `\n\`\`\`${lang || ''}\n${body}\n\`\`\`\n`;
  }

  function stripOuterBalancedBracesOnce(s) {
    s = (s || '').trim();
    if (!(s.startsWith('{') && s.endsWith('}'))) return s;

    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth === 0 && i < s.length - 1) return s; // closes early -> not a wrapper
      if (depth < 0) return s;
    }
    if (depth !== 0) return s;
    return s.slice(1, -1);
  }

  // Your rule: remove \displaystyle + outer {...}; if displaystyle was present -> force display $$...$$.
  function normalizeWikiTex(texRaw) {
    let s = (texRaw || '').trim();
    if (!s) return { latex: '', forceDisplay: false };

    s = stripOuterBalancedBracesOnce(s).trim();

    let forceDisplay = false;
    for (let i = 0; i < 3; i++) {
      const before = s;
      s = stripOuterBalancedBracesOnce(s).trim();

      if (/^\\displaystyle\b/.test(s)) {
        forceDisplay = true;
        s = s.replace(/^\\displaystyle\b\s*/, '').trim();
        continue;
      }
      if (/^\{\s*\\displaystyle\b/.test(s) && s.endsWith('}')) {
        forceDisplay = true;
        s = s.replace(/^\{\s*\\displaystyle\b\s*/, '').replace(/\}\s*$/, '').trim();
        continue;
      }
      if (s === before) break;
    }

    if (/^\\textstyle\b/.test(s)) s = s.replace(/^\\textstyle\b\s*/, '').trim();

    return { latex: s.trim(), forceDisplay };
  }

  function getMathMLToLatexConverter() {
    // mathml-to-latex UMD can expose different globals depending on bundle
    const fn = (window.mathmlToLatex && window.mathmlToLatex.convert) ? window.mathmlToLatex.convert
      : (window.MathMLToLaTeX && typeof window.MathMLToLaTeX.convert === 'function') ? window.MathMLToLaTeX.convert
      : (typeof window.MathMLToLaTeX === 'function') ? window.MathMLToLaTeX
      : null;
    return fn;
  }

  function extractLatexFromElement(node) {
    if (!(node instanceof Element)) return '';

    // 1) <math data-latex|alttext>
    if (node.nodeName.toLowerCase() === 'math') {
      const dl = node.getAttribute('data-latex');
      const alttext = node.getAttribute('alttext');
      if (dl) return dl.trim();
      if (alttext) return alttext.trim();
    }

    // 2) nested <math alttext>
    const mathAlt = node.querySelector('math[alttext]');
    if (mathAlt) {
      const alttext = mathAlt.getAttribute('alttext');
      if (alttext) return alttext.trim();
    }

    // 3) TeX annotation (best on MediaWiki/KaTeX/MathJax assistive MML)
    if (Policies.wikipediaPreferTexAnnotation) {
      const ann = node.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
      const tex = ann?.textContent?.trim();
      if (tex) return tex;
    }

    // 4) MathML -> LaTeX
    const mathNode = node.nodeName.toLowerCase() === 'math' ? node : node.querySelector('math');
    if (mathNode) {
      const conv = getMathMLToLatexConverter();
      if (conv) {
        try { return String(conv(mathNode.outerHTML)).trim(); }
        catch (e) { Log.d('MathML->LaTeX failed', e); }
      }
    }

    // 5) MediaWiki fallback img alt/aria-label
    const img = node.nodeName.toLowerCase() === 'img' ? node : node.querySelector('img');
    if (img) {
      return (img.getAttribute('alt') || img.getAttribute('aria-label') || '').trim();
    }
    return '';
  }

  class MarkdownConverter {
    constructor() {
      if (typeof TurndownService !== 'function') throw new Error('Turndown missing');

      this.td = new TurndownService({
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
        bulletListMarker: '-',
        headingStyle: 'atx',
      });

      if (window.turndownPluginGfm?.gfm) this.td.use(window.turndownPluginGfm.gfm);

      // Code blocks: turn <pre> into fenced code
      this.td.addRule('preToFence', {
        filter: (node) => node.nodeName && node.nodeName.toLowerCase() === 'pre',
        replacement: (_content, node) => {
          const pre = node;
          const code = pre.querySelector('code') || pre;
          const raw = code.textContent || '';
          const lang = detectCodeLanguage(code, pre);
          return fenceCode(raw, lang);
        }
      });

      // MathJax v3: <mjx-container> has assistive MathML
      this.td.addRule('MathJax', {
        filter: (node) => node.nodeName && node.nodeName.toLowerCase() === 'mjx-container',
        replacement: (content, node) => {
          if (!(node instanceof HTMLElement)) return content;
          const assistive = node.querySelector('mjx-assistive-mml');
          const mathEl = assistive?.querySelector('math');
          if (!mathEl) return content;

          const conv = getMathMLToLatexConverter();
          if (!conv) return content;

          let latex = '';
          try { latex = String(conv(mathEl.outerHTML)).trim(); }
          catch { return content; }

          const norm = normalizeWikiTex(latex);
          const isBlock = norm.forceDisplay || mathEl.getAttribute('display') === 'block';
          return isBlock ? `\n$$\n${norm.latex}\n$$\n` : `$${norm.latex}$`;
        }
      });

      // MediaWiki/Wikipedia + generic <math> and fallback images (Obsidian-like rule)
      this.td.addRule('math', {
        filter: (node) => {
          if (!node || !(node instanceof Element)) return false;
          const nn = node.nodeName.toLowerCase();
          if (nn === 'math') return true;
          if (!node.classList) return false;
          return node.classList.contains('mwe-math-element') ||
            node.classList.contains('mwe-math-fallback-image-inline') ||
            node.classList.contains('mwe-math-fallback-image-display');
        },
        replacement: (content, node) => {
          if (!(node instanceof Element)) return content;

          let latexRaw = extractLatexFromElement(node);
          latexRaw = (latexRaw || '').trim();
          if (!latexRaw) return '';

          const norm = normalizeWikiTex(latexRaw);
          const latex = norm.latex;

          // table-safety like Obsidian: avoid block $$ inside tables
          const isInTable = node.closest('table') !== null;

          // Display if:
          // - forced by \displaystyle
          // - math@display=block
          // - fallback display class
          // - (Obsidian heuristic) parent is mwe-math-element and previous sibling is <p>
          const displayByDom =
            node.getAttribute('display') === 'block' ||
            node.classList.contains('mwe-math-fallback-image-display') ||
            (node.parentElement &&
              node.parentElement.classList.contains('mwe-math-element') &&
              node.parentElement.previousElementSibling &&
              node.parentElement.previousElementSibling.nodeName.toLowerCase() === 'p');

          const isDisplay = !isInTable && (norm.forceDisplay || displayByDom);

          if (isDisplay) return `\n$$\n${latex}\n$$\n`;

          // Inline spacing (Obsidian-like)
          const prevNode = node.previousSibling;
          const nextNode = node.nextSibling;
          const prevChar = prevNode?.textContent?.slice(-1) || '';
          const nextChar = nextNode?.textContent?.[0] || '';
          const isStartOfLine = !prevNode || (prevNode.nodeType === Node.TEXT_NODE && (prevNode.textContent || '').trim() === '');
          const isEndOfLine = !nextNode || (nextNode.nodeType === Node.TEXT_NODE && (nextNode.textContent || '').trim() === '');
          const leftSpace = (!isStartOfLine && prevChar && !/[\s$]/.test(prevChar)) ? ' ' : '';
          const rightSpace = (!isEndOfLine && nextChar && !/[\s$]/.test(nextChar)) ? ' ' : '';
          return `${leftSpace}$${latex}$${rightSpace}`;
        }
      });

      // Images default
      this.td.addRule('images', {
        filter: 'img',
        replacement: (_content, node) => {
          const img = node;
          // After math rule, we can optionally drop remaining MediaWiki math images
          const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
          if (Policies.wikipediaRemoveResidualMathImagesAfterExtract && /\/media\/math\/render\//.test(src)) return '';
          const alt = (img.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
          if (!src) return '';
          return `![${alt}](${src})`;
        }
      });
    }

    convert(container) {
      return this.td.turndown(container.innerHTML);
    }
  }

  function normalizeBlanklinesBlockSafe(md, maxBlank) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inFence = false;
    let inDisplayMath = false;
    let blankCount = 0;

    for (const line of lines) {
      if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); blankCount = 0; continue; }
      if (/^\s*\$\$\s*$/.test(line)) { inDisplayMath = !inDisplayMath; out.push(line); blankCount = 0; continue; }

      const isTableLine = /^\s*\|.*\|\s*$/.test(line) || /^\s*\|?[-: ]+\|[-|: ]*\s*$/.test(line);
      const isBlank = !line.trim();

      if (inFence || inDisplayMath || isTableLine) { out.push(line); blankCount = 0; continue; }

      if (isBlank) { blankCount++; if (blankCount <= maxBlank) out.push(''); }
      else { blankCount = 0; out.push(line); }
    }
    return out.join('\n');
  }

  function tightenAdjacentDisplayMathBlocks(md) {
    const lines = md.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^\s*\$\$\s*$/.test(lines[i])) {
        const a = lines[i + 1];
        const b = lines[i + 2];
        if (a !== undefined && b !== undefined && !a.trim() && /^\s*\$\$\s*$/.test(b)) i += 1;
      }
    }
    return out.join('\n');
  }

  function tightenListsBlockSafe(md) {
    const lines = md.split('\n');
    const out = [];
    const isBlank = (l) => !l.trim();
    const listMatch = (l) => l.match(/^(\s*)([-*+]|\d+\.)\s+/);
    const fence = (l) => /^\s*```/.test(l);
    const disp = (l) => /^\s*\$\$\s*$/.test(l);

    let inFence = false;
    let inDisplayMath = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (fence(line)) { inFence = !inFence; out.push(line); continue; }
      if (disp(line)) { inDisplayMath = !inDisplayMath; out.push(line); continue; }
      if (inFence || inDisplayMath) { out.push(line); continue; }

      if (isBlank(line)) {
        const prev = out.length ? out[out.length - 1] : '';
        const next = (i + 1 < lines.length) ? lines[i + 1] : '';
        const p = listMatch(prev);
        const n = listMatch(next);
        if (p && n && p[1].length === n[1].length) continue;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  function postProcess(md) {
    let out = md;
    out = normalizeBlanklinesBlockSafe(out, Policies.blanklineMax);
    if (Policies.tightLists) out = tightenListsBlockSafe(out);
    if (Policies.adjacentDisplayMathTight) out = tightenAdjacentDisplayMathBlocks(out);
    return out.trim() + '\n';
  }

  class Engine {
    constructor() {
      this.inFlight = false;
      this.queued = false;
      this.lastSig = null;
      this.cooldownUntil = 0;
    }

    handleTrigger() {
      const now = Date.now();
      if (now < this.cooldownUntil) return;
      this.cooldownUntil = now + Policies.cooldownMs;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      if (isEditableTarget(sel.anchorNode)) return;

      const range = capture.getPrimaryRange();
      if (!range) return;

      const tmp = capture.cloneFragment(range);
      const text = normalizeInvisibleUnicode(sel.toString() || '');
      if (!text.trim()) return;

      const htmlSig = stableHash((tmp.innerHTML || '').slice(0, 20000));
      const sig = stableHash(text + '|' + htmlSig);
      if (sig === this.lastSig) return;
      this.lastSig = sig;

      if (this.inFlight) { this.queued = true; return; }
      this.inFlight = true;

      try {
        const container = tmp;
        sanitizer.sanitize(container);

        let md;
        try { md = new MarkdownConverter().convert(container); }
        catch (e) { Log.w('Turndown missing; copying plain text', e); md = text.trim() + '\n'; }

        md = postProcess(md);

        const write = clipboard.writeNow(md);
        if (!write.started) toast.show('Copy failed (clipboard blocked)', false);
        else if (write.immediateOk) toast.show('Copied Markdown', true);
        else if (write.promise) write.promise.then(ok => toast.show(ok ? 'Copied Markdown' : 'Copy failed', ok));
        else toast.show('Copied Markdown', true);

      } catch (e) {
        Log.w('Pipeline failed', e);
        toast.show('Copy failed', false);
      } finally {
        this.inFlight = false;
        if (this.queued) { this.queued = false; setTimeout(() => this.handleTrigger(), 0); }
      }
    }
  }

  const engine = new Engine();

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => engine.handleTrigger(), Policies.debounceMs);
  }

  window.addEventListener('mouseup', schedule, true);
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    schedule();
  }, true);

})();
