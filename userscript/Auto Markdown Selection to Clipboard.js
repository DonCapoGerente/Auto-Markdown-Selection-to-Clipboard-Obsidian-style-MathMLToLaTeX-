// ==UserScript==
// @name         Auto Markdown Selection to Clipboard (Obsidian-style + MathMLToLaTeX + MediaWiki/Wikipedia)
// @namespace    https://github.com/yourname/userscripts
// @version      2025.03.20.7
// @description  Convert selected content to Markdown with proper inline/display LaTeX math, and auto-copy to clipboard (similar to Obsidian Web Clipper behavior). Includes special handling for Wikipedia/MediaWiki math.
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

    // ---------------------------------------------------------------------
    // Turndown setup (HTML -> Markdown) + GFM
    // ---------------------------------------------------------------------
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

    // ---------------------------------------------------------------------
    // Helper: MathMLToLaTeX
    // ---------------------------------------------------------------------
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

    // ---------------------------------------------------------------------
    // LaTeX-Wrapping + Platzhalter
    // ---------------------------------------------------------------------
    function wrapLatex(latex, inline) {
        const txt = (latex || '').trim();
        if (!txt) return '';
        return inline ? `$${txt}$` : `$$\n${txt}\n$$`;
    }

    /** @type {string[]} */
    let MATH_SNIPPETS = [];

    function createMathPlaceholder(latex, inline) {
        const wrapped = wrapLatex(latex, inline);
        const idx = MATH_SNIPPETS.length;
        MATH_SNIPPETS.push(wrapped);
        return `@@MATH${idx}@@`;
    }

    function restoreMathPlaceholders(md) {
        return md.replace(/@@MATH(\d+)@@/g, (m, idxStr) => {
            const idx = Number(idxStr);
            return MATH_SNIPPETS[idx] || '';
        });
    }

    // ---------------------------------------------------------------------
    // MediaWiki/Wikipedia-Erkennung
    // ---------------------------------------------------------------------
    function isMediaWikiMathSite() {
        return /\.(wikipedia|wikibooks|wikiversity|wiktionary|wikinews|wikivoyage|wikidata|wikimedia)\.org$/.test(location.hostname);
    }

    // ---------------------------------------------------------------------
    // MediaWiki/Wikipedia-Math: .mwe-math-element -> Platzhalter
    //  - Holt TeX bevorzugt aus img.alt / aria-label
    //  - Optional MathML->LaTeX, aber kein textContent-Fallback
    //  - Inline vs Display sauber anhand von math@display / Klassen
    // ---------------------------------------------------------------------
    function convertMediaWikiMath(root) {
        if (!isMediaWikiMathSite()) return;

        const mmlConverter = getMathMLToLatex();
        const wrappers = root.querySelectorAll('.mwe-math-element');

        wrappers.forEach(wrapper => {
            if (wrapper.__mwMathHandled) return;

            let latex = null;

            // 1) bevorzugt: Bild-Alt / aria-label (enthält sauberes TeX)
            const img = wrapper.querySelector('img[src*="/media/math/render/"]');
            if (img) {
                latex = (img.getAttribute('alt') ||
                         img.getAttribute('aria-label') ||
                         '').trim();
            }

            // 2) optional: MathML -> LaTeX (nur mit Converter)
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

            // kein textContent-Fallback – lieber gar nichts verändern,
            // als zerhackte {\displaystyle ...}-Strings zu erzeugen
            if (!latex) return;

            // Inline/Display bestimmen
            let isInline = true;

            const mathEl = wrapper.querySelector('math');
            if (mathEl) {
                const displayAttr = (mathEl.getAttribute('display') || '').toLowerCase();
                if (displayAttr === 'block') {
                    isInline = false;
                }
            }

            // Klassen der Fallback-Bilder beachten
            if (wrapper.querySelector('.mwe-math-fallback-image-display')) {
                isInline = false;
            }
            if (wrapper.querySelector('.mwe-math-fallback-image-inline')) {
                isInline = true;
            }

            if (DEBUG) console.log('[AutoMarkdown] MediaWiki latex:', latex, 'inline:', isInline);

            const placeholder = createMathPlaceholder(latex, isInline);
            const textNode = root.ownerDocument.createTextNode(
                isInline ? placeholder : '\n' + placeholder + '\n'
            );

            wrapper.__mwMathHandled = true;
            wrapper.replaceWith(textNode);
        });

        // Stray-Bild-Math entfernen, damit Turndown keine Markdown-Bilder daraus macht
        const strayImgs = root.querySelectorAll('img[src*="/media/math/render/"]');
        strayImgs.forEach(img => {
            if (!img.closest('.mwe-math-element')) {
                img.remove();
            }
        });
    }

    // ---------------------------------------------------------------------
    // Standard-Math (KaTeX, MathJax, bare <math>, script type="math/tex")
    // ---------------------------------------------------------------------
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

                const isDisplay = span.closest('.katex-display') !== null;

                if (DEBUG) console.log('[AutoMarkdown] KaTeX latex:', latex, 'display:', isDisplay);

                const placeholder = createMathPlaceholder(latex, !isDisplay);
                const textNode = root.ownerDocument.createTextNode(
                    isDisplay ? '\n' + placeholder + '\n' : placeholder
                );
                span.replaceWith(textNode);
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
                if (ann && ann.textContent) {
                    latex = ann.textContent.trim();
                }

                if (!latex) {
                    const mathEl =
                        mjx.querySelector('mjx-assistive-mml > math') ||
                        mjx.querySelector('math');
                    if (mathEl) {
                        if (mmlConverter) {
                            latex = (mmlConverter.convert(mathEl.outerHTML) || '').trim();
                        } else {
                            latex = (mathEl.textContent || '').trim();
                        }
                    }
                }

                if (!latex) return;

                const displayAttr = mjx.getAttribute('display') || '';
                const isDisplay =
                    displayAttr === 'true' ||
                    displayAttr === 'block' ||
                    mjx.closest('[data-display="block"]') !== null;

                if (DEBUG) console.log('[AutoMarkdown] MJX latex:', latex, 'display:', isDisplay);

                const placeholder = createMathPlaceholder(latex, !isDisplay);
                const textNode = root.ownerDocument.createTextNode(
                    isDisplay ? '\n' + placeholder + '\n' : placeholder
                );
                mjx.replaceWith(textNode);
            } catch (e) {
                console.warn('[AutoMarkdown] MathJax conversion failed:', e);
            }
        });

        // bare <math> (nicht in KaTeX/MathJax)
        const mathEls = root.querySelectorAll('math');
        mathEls.forEach(mathEl => {
            if (mathEl.closest('mjx-container,.katex-mathml,.katex')) return;

            try {
                let latex = null;
                if (mmlConverter) {
                    latex = (mmlConverter.convert(mathEl.outerHTML) || '').trim();
                } else {
                    latex = (mathEl.textContent || '').trim();
                }
                if (!latex) return;

                const displayAttr = (mathEl.getAttribute('display') || '').toLowerCase();
                const isDisplay = displayAttr === 'block' || displayAttr === 'true';

                if (DEBUG) console.log('[AutoMarkdown] bare MathML latex:', latex, 'display:', isDisplay);

                const placeholder = createMathPlaceholder(latex, !isDisplay);
                const textNode = root.ownerDocument.createTextNode(
                    isDisplay ? '\n' + placeholder + '\n' : placeholder
                );
                mathEl.replaceWith(textNode);
            } catch (e) {
                console.warn('[AutoMarkdown] bare MathML conversion failed:', e);
            }
        });

        // script type="math/tex"
        const texScripts = root.querySelectorAll('script[type^="math/tex"]');
        texScripts.forEach(script => {
            if (script.closest('mjx-container,.katex-mathml,.katex')) return;

            try {
                const typeAttr = script.getAttribute('type') || '';
                const isDisplay = /mode\s*=\s*display/i.test(typeAttr);

                const latex = (script.textContent || '').trim();
                if (!latex) return;

                if (DEBUG) console.log('[AutoMarkdown] <script math/tex> latex:', latex, 'display:', isDisplay);

                const placeholder = createMathPlaceholder(latex, !isDisplay);
                const textNode = root.ownerDocument.createTextNode(
                    isDisplay ? '\n' + placeholder + '\n' : placeholder
                );
                script.replaceWith(textNode);
            } catch (e) {
                console.warn('[AutoMarkdown] <script math/tex> conversion failed:', e);
            }
        });
    }

    // ---------------------------------------------------------------------
    // rohe \(...\) / \[...\] in Text -> Platzhalter
    // ---------------------------------------------------------------------
    function convertInlineTeXTextNodes(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) {
            if (!node.nodeValue) continue;
            if (!node.nodeValue.includes('\\(') && !node.nodeValue.includes('\\[')) continue;
            textNodes.push(node);
        }

        textNodes.forEach(textNode => {
            const text = textNode.nodeValue;
            const parent = textNode.parentNode;
            if (!parent) return;

            const frag = document.createDocumentFragment();
            const regex = /\\\((.+?)\\\)|\\\[([\s\S]+?)\\\]/g;
            let lastIndex = 0;
            let m;

            while ((m = regex.exec(text)) !== null) {
                const index = m.index;
                if (index > lastIndex) {
                    frag.appendChild(document.createTextNode(text.slice(lastIndex, index)));
                }

                const inlineContent = m[1];
                const displayContent = m[2];

                if (inlineContent != null) {
                    const latex = inlineContent.trim();
                    const placeholder = createMathPlaceholder(latex, true);
                    frag.appendChild(document.createTextNode(placeholder));
                } else if (displayContent != null) {
                    const latex = displayContent.trim();
                    const placeholder = createMathPlaceholder(latex, false);
                    frag.appendChild(document.createTextNode('\n' + placeholder + '\n'));
                }

                lastIndex = regex.lastIndex;
            }

            if (lastIndex < text.length) {
                frag.appendChild(document.createTextNode(text.slice(lastIndex)));
            }

            parent.replaceChild(frag, textNode);
        });
    }

    // ---------------------------------------------------------------------
    // Editables auslassen
    // ---------------------------------------------------------------------
    function isInEditable(node) {
        while (node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const el = /** @type {HTMLElement} */ (node);
                const tag = el.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) {
                    return true;
                }
            }
            node = node.parentNode;
        }
        return false;
    }

    // ---------------------------------------------------------------------
    // Selection -> Markdown
    // ---------------------------------------------------------------------
    function selectionToMarkdown() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

        const range = sel.getRangeAt(0);
        const ancestor = range.commonAncestorContainer;
        if (isInEditable(ancestor)) return null;

        const fragment = range.cloneContents();
        const container = document.createElement('div');
        container.appendChild(fragment);

        MATH_SNIPPETS = [];

        // 1) Wikipedia/MediaWiki normalisieren
        convertMediaWikiMath(container);

        // 2) Generelle Math-Pipeline
        convertMathInContainer(container);

        // 3) rohe \(...\)/\[...\]
        convertInlineTeXTextNodes(container);

        const html = container.innerHTML;
        if (!html.trim()) return null;

        let md = turndownService.turndown(html);
        md = restoreMathPlaceholders(md);
        md = md.trim();

        if (DEBUG) console.log('[AutoMarkdown] FINAL MD:\n', md);

        return md;
    }

    // ---------------------------------------------------------------------
    // Mini Copy-Toast
    // ---------------------------------------------------------------------
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

        requestAnimationFrame(() => {
            div.style.opacity = '1';
        });

        setTimeout(() => {
            div.style.opacity = '0';
            setTimeout(() => div.remove(), 250);
        }, 600);
    }

    // ---------------------------------------------------------------------
    // Auto-copy logic
    // ---------------------------------------------------------------------
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
