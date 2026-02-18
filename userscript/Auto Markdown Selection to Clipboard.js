// ==UserScript==
// @name         Auto Markdown Selection to Clipboard (Obsidian-style + MathMLToLaTeX + MediaWiki/Wikipedia + Universal Code/Math Fixes)
// @namespace    https://github.com/yourname/userscripts
// @version      2026.02.18.4
// @description  Convert selection to Obsidian-compatible Markdown with robust codeblock + math handling (KaTeX/MathJax/MathML/MediaWiki), list spacing fixes, display-math context expansion, and auto-copy toast.
// @author       you
// @license      MIT
// @match        *://*/*
// @grant        GM_setClipboard
// @require      https://unpkg.com/turndown/dist/turndown.js
// @require      https://unpkg.com/@guyplusplus/turndown-plugin-gfm/dist/turndown-plugin-gfm.js
// @require      https://unpkg.com/mathml-to-latex@1.5.0/dist/index.umd.js
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG = false;

  // ---------------- Turndown setup ----------------
  if (typeof TurndownService === 'undefined') {
    console.error('[AutoMarkdown] TurndownService not found. Check @require URLs.');
    return;
  }

  const turndownService = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx'
  });

  let gfmPlugin = null;
  if (typeof turndownPluginGfm !== 'undefined') {
    gfmPlugin = turndownPluginGfm;
  } else if (typeof TurndownPluginGfmService !== 'undefined') {
    gfmPlugin = TurndownPluginGfmService;
  }

  if (gfmPlugin && typeof gfmPlugin.gfm === 'function') {
    turndownService.use(gfmPlugin.gfm);
  } else {
    console.warn('[AutoMarkdown] GFM plugin not found. GFM features disabled.');
  }

  // ---------------- MathMLToLaTeX helper ----------------
  function getMathMLToLatex() {
    if (typeof MathMLToLaTeX !== 'undefined' && MathMLToLaTeX && typeof MathMLToLaTeX.convert === 'function') {
      return MathMLToLaTeX;
    }
    if (typeof window !== 'undefined' &&
      window.MathMLToLaTeX &&
      typeof window.MathMLToLaTeX.convert === 'function') {
      return window.MathMLToLaTeX;
    }
    return null;
  }

  // ---------------- Placeholders: Math ----------------
  function wrapLatex(latex, inline) {
    const txt = (latex || '').trim();
    if (!txt) return '';
    return inline ? `$${txt}$` : `$$\n${txt}\n$$`;
  }

  let MATH_SNIPPETS = [];
  function createMathPlaceholder(latex, inline) {
    const wrapped = wrapLatex(latex, inline);
    const idx = MATH_SNIPPETS.length;
    MATH_SNIPPETS.push(wrapped);
    return `@@MATH${idx}@@`;
  }
  function restoreMathPlaceholders(md) {
    return md.replace(/@@MATH(\d+)@@/g, (m, idxStr) => MATH_SNIPPETS[Number(idxStr)] || '');
  }

  // ---------------- Placeholders: Code ----------------
  let CODE_SNIPPETS = [];

  function sanitizeCodeText(codeText) {
    let t = codeText || '';
    t = t.replace(/^\s*(?:Code\s*kopieren|Copy\s*code)\s*/i, '');
    t = t.replace(/\n+$/g, '');
    return t;
  }

  function createCodePlaceholder(codeText, language) {
    const lang = (language || '').trim();
    const code = sanitizeCodeText(codeText);
    const fenced = lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``;
    const idx = CODE_SNIPPETS.length;
    CODE_SNIPPETS.push(fenced);
    return `@@CODE${idx}@@`;
  }

  function restoreCodePlaceholders(md) {
    return md.replace(/@@CODE(\d+)@@/g, (m, idxStr) => CODE_SNIPPETS[Number(idxStr)] || '');
  }

  // ---------------- MediaWiki/Wikipedia detection ----------------
  function isMediaWikiMathSite() {
    return /\.(wikipedia|wikibooks|wikiversity|wiktionary|wikinews|wikivoyage|wikidata|wikimedia)\.org$/i.test(location.hostname);
  }

  // Mirrors/wrappers: detect via DOM signatures instead of hostname
  function hasMediaWikiMathMarkup(root) {
    try {
      return !!(
        root.querySelector('.mwe-math-element') ||
        root.querySelector('img[src*="/media/math/render/"]') ||
        root.querySelector('img[src*="wikimedia.org/api/rest_v1/media/math/render"]') ||
        root.querySelector('img[src*="media/math/render/svg"]')
      );
    } catch {
      return false;
    }
  }

  function isWikimediaMathRenderImg(img) {
    const src = (img.getAttribute('src') || '');
    return (
      src.includes('/media/math/render/') ||
      src.includes('wikimedia.org/api/rest_v1/media/math/render') ||
      src.includes('media/math/render/svg')
    );
  }

  // ---------------- MediaWiki math conversion (robust, incl. mirrors) ----------------
  function convertMediaWikiMath(root) {
    if (!isMediaWikiMathSite() && !hasMediaWikiMathMarkup(root)) return;

    const mmlConverter = getMathMLToLatex();

    // 1) canonical: .mwe-math-element wrappers
    const wrappers = root.querySelectorAll('.mwe-math-element');
    wrappers.forEach(wrapper => {
      if (wrapper.__mwMathHandled) return;

      let latex = null;

      // Prefer render-image alt/aria-label (clean TeX)
      const img = wrapper.querySelector('img');
      if (img && isWikimediaMathRenderImg(img)) {
        latex = (img.getAttribute('alt') || img.getAttribute('aria-label') || '').trim();
      }

      // Optional: MathML -> LaTeX if available
      if (!latex) {
        const mathEl = wrapper.querySelector('math');
        if (mathEl && mmlConverter) {
          try {
            latex = (mmlConverter.convert(mathEl.outerHTML) || '').trim();
          } catch (e) {
            if (DEBUG) console.warn('[AutoMarkdown] MediaWiki MathML convert failed:', e);
          }
        }
      }

      // No textContent fallback (prevents {\displaystyle ...} garbage)
      if (!latex) return;

      // Inline/Display from math@display and/or fallback image classes
      let isInline = true;

      const mathEl = wrapper.querySelector('math');
      if (mathEl) {
        const displayAttr = (mathEl.getAttribute('display') || '').toLowerCase();
        if (displayAttr === 'block') isInline = false;
      }
      if (wrapper.querySelector('.mwe-math-fallback-image-display')) isInline = false;
      if (wrapper.querySelector('.mwe-math-fallback-image-inline')) isInline = true;

      const placeholder = createMathPlaceholder(latex, isInline);
      wrapper.__mwMathHandled = true;
      wrapper.replaceWith(root.ownerDocument.createTextNode(placeholder));
    });

    // 2) mirrors: standalone render images with TeX in alt
    const mwImgs = root.querySelectorAll('img');
    mwImgs.forEach(img => {
      if (!isWikimediaMathRenderImg(img)) return;

      // already handled if wrapper got replaced
      if (img.closest('.mwe-math-element')) return;

      const latex = (img.getAttribute('alt') || img.getAttribute('aria-label') || '').trim();
      if (!latex) return;

      const isDisplay = img.classList.contains('mwe-math-fallback-image-display');
      const placeholder = createMathPlaceholder(latex, !isDisplay);
      img.replaceWith(root.ownerDocument.createTextNode(placeholder));
    });

    // 3) hard guarantee: remove any leftover render images so Turndown never emits ![](...)
    const leftovers = root.querySelectorAll('img');
    leftovers.forEach(img => {
      if (isWikimediaMathRenderImg(img)) img.remove();
    });
  }

  // ---------------- General math pipeline ----------------
  function convertMathInContainer(root) {
    const mmlConverter = getMathMLToLatex();

    // KaTeX
    const katexSpans = root.querySelectorAll('span.katex');
    katexSpans.forEach(span => {
      try {
        const ann = span.querySelector(
          '.katex-mathml annotation[encoding="application/x-tex"],' +
          '.katex-mathml annotation[encoding="TeX"]'
        );
        if (!ann) return;

        const latex = (ann.textContent || '').trim();
        if (!latex) return;

        const hasDisplayWrapper = span.closest('.katex-display') !== null;
        const hasBlockMath = span.querySelector('math[display="block"], math[display="true"]') !== null;
        const isDisplay = hasDisplayWrapper || hasBlockMath;

        const placeholder = createMathPlaceholder(latex, !isDisplay);
        span.replaceWith(root.ownerDocument.createTextNode(placeholder));
      } catch (e) {
        console.warn('[AutoMarkdown] KaTeX conversion failed:', e);
      }
    });

    // MathJax v3
    const mjxContainers = root.querySelectorAll('mjx-container');
    mjxContainers.forEach(mjx => {
      try {
        let latex = null;

        const ann = mjx.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
        if (ann && ann.textContent) latex = ann.textContent.trim();

        if (!latex) {
          const mathEl =
            mjx.querySelector('mjx-assistive-mml > math') ||
            mjx.querySelector('math');
          if (mathEl) {
            if (mmlConverter) latex = (mmlConverter.convert(mathEl.outerHTML) || '').trim();
            else latex = (mathEl.textContent || '').trim();
          }
        }

        if (!latex) return;

        const displayAttr = (mjx.getAttribute('display') || '').toLowerCase();
        const isDisplay =
          displayAttr === 'true' ||
          displayAttr === 'block' ||
          mjx.closest('[data-display="block"]') !== null;

        const placeholder = createMathPlaceholder(latex, !isDisplay);
        mjx.replaceWith(root.ownerDocument.createTextNode(placeholder));
      } catch (e) {
        console.warn('[AutoMarkdown] MathJax conversion failed:', e);
      }
    });

    // bare <math>
    const mathEls = root.querySelectorAll('math');
    mathEls.forEach(mathEl => {
      if (mathEl.closest('mjx-container,.katex-mathml,.katex,.mwe-math-element')) return;

      try {
        let latex = null;
        if (mmlConverter) latex = (mmlConverter.convert(mathEl.outerHTML) || '').trim();
        else latex = (mathEl.textContent || '').trim();
        if (!latex) return;

        const displayAttr = (mathEl.getAttribute('display') || '').toLowerCase();
        const isDisplay = displayAttr === 'block' || displayAttr === 'true';

        const placeholder = createMathPlaceholder(latex, !isDisplay);
        mathEl.replaceWith(root.ownerDocument.createTextNode(placeholder));
      } catch (e) {
        console.warn('[AutoMarkdown] bare MathML conversion failed:', e);
      }
    });

    // script type="math/tex"
    const texScripts = root.querySelectorAll('script[type^="math/tex"]');
    texScripts.forEach(script => {
      if (script.closest('mjx-container,.katex-mathml,.katex,.mwe-math-element')) return;

      try {
        const typeAttr = script.getAttribute('type') || '';
        const isDisplay = /mode\s*=\s*display/i.test(typeAttr);

        const latex = (script.textContent || '').trim();
        if (!latex) return;

        const placeholder = createMathPlaceholder(latex, !isDisplay);
        script.replaceWith(root.ownerDocument.createTextNode(placeholder));
      } catch (e) {
        console.warn('[AutoMarkdown] <script math/tex> conversion failed:', e);
      }
    });
  }

  // ---------------- Raw TeX markers in text nodes ----------------
  function convertInlineTeXTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;

    while ((node = walker.nextNode())) {
      if (!node.nodeValue) continue;
      const val = node.nodeValue;
      if (val.includes('\\(') || val.includes('\\[') || val.includes('$$')) {
        textNodes.push(node);
      }
    }

    const texRegex = /\\\((.+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$/g;

    textNodes.forEach(textNode => {
      const text = textNode.nodeValue;
      const parent = textNode.parentNode;
      if (!parent) return;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      let m;

      while ((m = texRegex.exec(text)) !== null) {
        const index = m.index;
        if (index > lastIndex) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex, index)));
        }

        const inlineContent = m[1];
        const displayContentBracket = m[2];
        const displayContentDollar = m[3];

        if (inlineContent != null) {
          const latex = inlineContent.trim();
          frag.appendChild(document.createTextNode(createMathPlaceholder(latex, true)));
        } else if (displayContentBracket != null) {
          const latex = displayContentBracket.trim();
          frag.appendChild(document.createTextNode(createMathPlaceholder(latex, false)));
        } else if (displayContentDollar != null) {
          const latex = displayContentDollar.trim();
          frag.appendChild(document.createTextNode(createMathPlaceholder(latex, false)));
        }

        lastIndex = texRegex.lastIndex;
      }

      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      parent.replaceChild(frag, textNode);
    });
  }

  // ---------------- Skip editables ----------------
  function isInEditable(node) {
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  // ---------------- Universal code block conversion ----------------
  function convertCodeBlocks(root) {
    const pres = root.querySelectorAll('pre');
    pres.forEach(pre => {
      if (pre.__codeHandled) return;

      let codeEl = pre.querySelector('code');
      let lang = '';

      function extractLangFrom(el) {
        const classes = Array.from((el && el.classList) || []);
        for (const cls of classes) {
          const match = cls.match(/^(?:language-|lang-|language_)([a-zA-Z0-9+-]+)/);
          if (match) return match[1];
        }
        const dataLang = el && (el.getAttribute('data-language') || el.getAttribute('data-lang'));
        return dataLang || '';
      }

      if (codeEl) lang = extractLangFrom(codeEl);
      else {
        const ancestorCode = pre.closest('code');
        if (ancestorCode) lang = extractLangFrom(ancestorCode);
      }
      if (!lang) lang = extractLangFrom(pre);

      const codeText = pre.textContent || '';
      if (!codeText.trim()) return;

      const placeholder = createCodePlaceholder(codeText, lang);
      pre.__codeHandled = true;
      pre.replaceWith(root.ownerDocument.createTextNode(placeholder));
    });
  }

  // ---------------- Postprocessing: list spacing ----------------
  function collapseListSpacing(md) {
    return md.replace(/\n\s*\n(?=\s*(?:[-*+]\s|\d+\.\s))/g, '\n');
  }

  // ---------------- Postprocessing: remove extra padding around fences ($$ and ```) ----------------
  function collapseFencePadding(md) {
    let out = md.replace(/\r\n/g, '\n');

    out = out.replace(/([^\n])\n{2,}```/g, '$1\n```');
    out = out.replace(/```\n{2,}([^\n])/g, '```\n$1');

    out = out.replace(/([^\n])\n{2,}\$\$/g, '$1\n$$');
    out = out.replace(/\$\$\n{2,}([^\n])/g, '$$\n$1');

    out = out.replace(/\n{3,}/g, '\n\n');
    return out;
  }

  // ---------------- Selection -> Markdown (with math context expansion) ----------------
  function selectionToMarkdown() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    let range = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    if (isInEditable(ancestor)) return null;

    // Expand range edges if inside math containers. Prefer display wrappers.
    try {
      const pickMathContainer = (el) => {
        if (!el || !el.closest) return null;
        return el.closest(
          'span.katex-display,' +
          'mjx-container[display="true"],mjx-container[display="block"],mjx-container[display],' +
          'math[display="block"],math[display="true"],' +
          '.mwe-math-element,' +
          'span.katex,mjx-container,math'
        );
      };

      const startEl = (range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer);
      const endEl = (range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.parentElement : range.endContainer);

      const startMath = pickMathContainer(startEl);
      const endMath = pickMathContainer(endEl);

      if (startMath) range.setStartBefore(startMath);
      if (endMath) range.setEndAfter(endMath);
    } catch { /* ignore */ }

    const fragment = range.cloneContents();
    const container = document.createElement('div');
    container.appendChild(fragment);

    MATH_SNIPPETS = [];
    CODE_SNIPPETS = [];

    convertCodeBlocks(container);

    // IMPORTANT: MediaWiki conversion must run BEFORE general math conversion
    // to avoid MathML text + image duplicates.
    convertMediaWikiMath(container);

    convertMathInContainer(container);
    convertInlineTeXTextNodes(container);

    const html = container.innerHTML;
    if (!html.trim()) return null;

    let md = turndownService.turndown(html);
    md = restoreMathPlaceholders(md);
    md = restoreCodePlaceholders(md);
    md = collapseListSpacing(md);
    md = collapseFencePadding(md);
    md = md.trim();

    if (DEBUG) console.log('[AutoMarkdown] FINAL MD:\n', md);
    return md;
  }

  // ---------------- Copy toast ----------------
  function showCopyToast() {
    const div = document.createElement('div');
    div.textContent = '⧉';
    div.style.position = 'fixed';
    div.style.bottom = '20px';
    div.style.right = '20px';
    div.style.fontSize = '26px';
    div.style.opacity = '0';
    div.style.transition = 'opacity 0.25s';
    div.style.zIndex = '999999999';
    div.style.userSelect = 'none';
    div.style.pointerEvents = 'none';
    div.style.color = 'var(--text-normal, #dadada)';

    document.body.appendChild(div);
    requestAnimationFrame(() => { div.style.opacity = '1'; });

    setTimeout(() => {
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 250);
    }, 600);
  }

  // ---------------- Auto-copy logic ----------------
  let lastCopied = '';

  function handleSelectionEvent() {
    const md = selectionToMarkdown();
    if (!md) return;
    if (md === lastCopied) return;
    lastCopied = md;

    try {
      GM_setClipboard(md, { type: 'text/plain', mimetype: 'text/plain' });
      showCopyToast();
    } catch (err) {
      console.error('[AutoMarkdown] Failed to copy to clipboard:', err);
    }
  }

  document.addEventListener('mouseup', handleSelectionEvent);
  document.addEventListener('keyup', handleSelectionEvent);
})();
