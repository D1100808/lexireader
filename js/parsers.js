/* Разбор форматов книг: EPUB, FB2, FB2.ZIP, PDF, DOCX, TXT, HTML, Markdown.
 *
 * Текстовые форматы возвращают:
 *   { format, title, author, lang, coverBlob, chapters:[{title, load()}], toc:[{title, chapter, anchor, depth}],
 *     resolveLink(link) -> {chapter, anchor} | null, dispose() }
 * PDF возвращает: { format:'pdf', pdf, title, author, lang, outline:[{title, page, depth}], numPages }
 */
'use strict';

const Parsers = (() => {
  const XLINK = 'http://www.w3.org/1999/xlink';
  const DROP = new Set(['script', 'style', 'link', 'meta', 'head', 'title', 'noscript', 'iframe', 'object', 'embed',
    'form', 'input', 'button', 'select', 'textarea', 'template', 'audio', 'video', 'canvas', 'math']);
  const KEEP = new Set(('p div span a em i b strong u s strike sub sup small big h1 h2 h3 h4 h5 h6 blockquote pre code ' +
    'ul ol li dl dt dd table thead tbody tfoot tr td th caption br hr figure figcaption section article aside header ' +
    'footer cite q abbr mark ruby rt rp center del ins var kbd samp tt nav main').split(' '));

  const SUPPORTED = ['epub', 'pdf', 'fb2', 'fb2.zip', 'zip', 'docx', 'txt', 'html', 'htm', 'xhtml', 'md', 'markdown'];

  function formatOf(name) {
    const n = name.toLowerCase();
    if (n.endsWith('.fb2.zip')) return 'fb2.zip';
    const m = n.match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function baseName(name) {
    return name.replace(/\.fb2\.zip$/i, '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  }

  /* ---------- Кодировки ---------- */
  function decodeText(buf) {
    const b = new Uint8Array(buf);
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
    const head = new TextDecoder('latin1').decode(b.subarray(0, 400));
    const m = head.match(/encoding\s*=\s*["']([\w-]+)["']/i) || head.match(/charset\s*=\s*["']?([\w-]+)/i);
    if (m) {
      try { return new TextDecoder(m[1].toLowerCase()).decode(b); } catch (e) { /* неизвестная кодировка */ }
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
    catch (e) { return new TextDecoder('windows-1251').decode(b); }
  }

  function parseXml(text, type = 'application/xml') {
    let doc = new DOMParser().parseFromString(text, type);
    if (doc.getElementsByTagName('parsererror').length) {
      doc = new DOMParser().parseFromString(text, 'text/html');
    }
    return doc;
  }

  const byTag = (root, name) => root ? Array.from(root.getElementsByTagNameNS('*', name)) : [];
  const firstText = (root, name) => { const e = byTag(root, name)[0]; return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; };

  /* ---------- Очистка HTML (санитайзер + перенос в документ) ---------- */
  function cleanInto(src, parent, ctx) {
    for (const n of Array.from(src.childNodes)) {
      if (n.nodeType === 3) { parent.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      const tag = (n.localName || '').toLowerCase();
      if (DROP.has(tag)) continue;
      if (tag === 'svg') {
        const im = byTag(n, 'image')[0];
        if (im) {
          const s = im.getAttributeNS(XLINK, 'href') || im.getAttribute('href') || im.getAttribute('xlink:href');
          if (s) parent.appendChild(mkImg(s, ctx));
        }
        continue;
      }
      if (tag === 'img' || tag === 'image') {
        const s = n.getAttribute('src') || n.getAttributeNS(XLINK, 'href') || n.getAttribute('href');
        if (s) parent.appendChild(mkImg(s, ctx, n.getAttribute('alt')));
        continue;
      }
      if (!KEEP.has(tag)) { cleanInto(n, parent, ctx); continue; }
      const el = document.createElement(tag);
      const id = n.getAttribute('id') || (tag === 'a' && n.getAttribute('name'));
      if (id) el.id = 'bk-' + id;
      for (const a of ['colspan', 'rowspan', 'title']) if (n.hasAttribute(a)) el.setAttribute(a, n.getAttribute(a));
      if (tag === 'a') {
        const href = n.getAttribute('href') || n.getAttributeNS(XLINK, 'href');
        if (href) {
          if (/^(https?:|mailto:)/i.test(href)) { el.href = href; el.target = '_blank'; el.rel = 'noopener'; }
          else el.dataset.link = ctx.resolve ? ctx.resolve(href) : href;
        }
      }
      cleanInto(n, el, ctx);
      parent.appendChild(el);
    }
  }

  function mkImg(src, ctx, alt) {
    const i = document.createElement('img');
    i.dataset.src = ctx.resolve && !/^data:/.test(src) ? ctx.resolve(src) : src;
    i.alt = alt || '';
    i.loading = 'lazy';
    return i;
  }

  async function loadImages(root, getUrl) {
    for (const img of Array.from(root.querySelectorAll('img[data-src]'))) {
      const s = img.dataset.src;
      let url = null;
      try { url = /^data:/.test(s) ? s : await getUrl(s.split('#')[0]); } catch (e) { url = null; }
      if (url) { img.src = url; img.removeAttribute('data-src'); } else img.remove();
    }
  }

  function resolvePath(baseDir, href) {
    let [p, frag] = href.split('#');
    try { p = decodeURIComponent(p.split('?')[0]); } catch (e) { p = p.split('?')[0]; }
    const parts = (p.startsWith('/') ? p.slice(1) : baseDir + p).split('/');
    const out = [];
    for (const s of parts) {
      if (s === '..') out.pop();
      else if (s !== '.' && s !== '') out.push(s);
    }
    return out.join('/') + (frag != null ? '#' + frag : '');
  }
  const dirOf = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';

  /* ---------- Деление HTML на главы по заголовкам ---------- */
  function hasText(n) {
    return n.nodeType === 1 ? (n.textContent.trim() !== '' || n.querySelector?.('img')) : n.nodeValue?.trim();
  }

  function splitIntoChapters(frag) {
    let root = frag;
    while (root.children.length === 1 && root.childNodes.length <= 3 &&
      /^(div|section|article|main)$/i.test(root.firstElementChild.tagName)) root = root.firstElementChild;
    const nodes = Array.from(root.childNodes).filter(hasText);
    const level = ['H1', 'H2', 'H3'].find(t => nodes.filter(n => n.tagName === t).length >= 2);
    let parts = [];
    if (level) {
      let cur = { title: null, nodes: [] };
      for (const n of nodes) {
        if (n.tagName === level) {
          if (cur.nodes.length) parts.push(cur);
          cur = { title: n.textContent.replace(/\s+/g, ' ').trim(), nodes: [n] };
        } else cur.nodes.push(n);
      }
      if (cur.nodes.length) parts.push(cur);
      if (parts[0] && !parts[0].title) parts[0].title = 'Начало';
    } else if (nodes.length > 150) {
      for (let i = 0; i < nodes.length; i += 120) parts.push({ title: `Часть ${i / 120 + 1}`, nodes: nodes.slice(i, i + 120) });
    } else {
      parts = [{ title: null, nodes }];
    }
    return parts.map((p, i) => ({
      title: p.title ? p.title.slice(0, 100) : (parts.length === 1 ? 'Текст' : `Часть ${i + 1}`),
      ids: new Set(p.nodes.flatMap(n => n.nodeType === 1 ? [n, ...n.querySelectorAll('[id]')] : [])
        .map(e => (e.id || '').replace(/^bk-/, '')).filter(Boolean)),
      load: async () => {
        const f = document.createDocumentFragment();
        p.nodes.forEach(n => f.appendChild(n.cloneNode(true)));
        return f;
      },
    }));
  }

  function simpleBook(chapters, extra) {
    const anchorMap = new Map();
    return Object.assign({
      chapters,
      toc: chapters.map((c, i) => ({ title: c.title, chapter: i, depth: 0 })),
      resolveLink: (link) => {
        const id = link.split('#')[1];
        if (!id) return null;
        for (let i = 0; i < chapters.length; i++) {
          if (chapters[i].ids && chapters[i].ids.has(id)) return { chapter: i, anchor: id };
        }
        return anchorMap.get(id) || null;
      },
      dispose() { },
    }, extra);
  }

  /* ---------- HTML / Markdown / DOCX / TXT ---------- */
  function parseHtmlString(html, name, format) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const frag = document.createDocumentFragment();
    cleanInto(doc.body, frag, { resolve: null });
    // в обычном HTML оставляем только встроенные (data:) картинки
    frag.querySelectorAll('img').forEach(i => { if (!/^data:/.test(i.dataset.src || '')) i.remove(); else { i.src = i.dataset.src; i.removeAttribute('data-src'); } });
    const chapters = splitIntoChapters(frag);
    const title = (doc.title || '').trim() || baseName(name);
    return simpleBook(chapters, { format, title, author: '', lang: doc.documentElement.lang || '' });
  }

  function mdToHtml(md) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
    const out = [];
    const blocks = md.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
    for (const b of blocks) {
      const t = b.trim();
      if (!t) continue;
      const hm = t.match(/^(#{1,6})\s+(.*)$/);
      if (hm && !t.includes('\n')) { out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); continue; }
      if (/^([-*+]|\d+\.)\s/.test(t)) {
        const ordered = /^\d+\./.test(t);
        const items = t.split('\n').map(l => l.replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(i => `<li>${inline(i)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (/^>/.test(t)) { out.push(`<blockquote><p>${inline(t.replace(/^>\s?/gm, ''))}</p></blockquote>`); continue; }
      out.push(`<p>${inline(t).replace(/\n/g, ' ')}</p>`);
    }
    return out.join('\n');
  }

  function parseTxt(text, name) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const headRe = /^\s*((chapter|глава|part|часть|book|книга|prologue|epilogue|пролог|эпилог|letter|письмо)\b[^\n]{0,60}|[IVXLC]{1,7}\.?)\s*$/i;
    const hasBlank = /\n\s*\n/.test(text);
    const frag = document.createDocumentFragment();
    let para = [];
    const flush = () => {
      if (para.length) frag.append(h('p', null, para.join(' ').replace(/\s+/g, ' ').trim()));
      para = [];
    };
    for (const line of lines) {
      const t = line.trim();
      if (!t) { flush(); continue; }
      if (t.length < 70 && headRe.test(t)) { flush(); frag.append(h('h2', null, t)); continue; }
      para.push(t);
      if (!hasBlank) flush();
    }
    flush();
    const book = simpleBook(splitIntoChapters(frag), { format: 'txt', title: baseName(name), author: '', lang: '' });
    return book;
  }

  /* ---------- EPUB ---------- */
  async function parseEpub(input) {
    const zip = input instanceof JSZip ? input : await JSZip.loadAsync(input);
    const lowerMap = {};
    zip.forEach((p) => { lowerMap[p.toLowerCase()] = p; });
    const getFile = (p) => zip.file(p) || zip.file(lowerMap[p.toLowerCase()] || '\0');
    const read = async (p) => { const f = getFile(p); return f ? f.async('text') : ''; };

    const container = parseXml(await read('META-INF/container.xml'));
    const rootfile = byTag(container, 'rootfile')[0];
    if (!rootfile) throw new Error('Некорректный EPUB: нет rootfile');
    const opfPath = rootfile.getAttribute('full-path');
    const opf = parseXml(await read(opfPath));
    const base = dirOf(opfPath);

    const manifest = {};
    for (const it of byTag(opf, 'item')) {
      manifest[it.getAttribute('id')] = {
        href: resolvePath(base, it.getAttribute('href') || ''),
        type: it.getAttribute('media-type') || '',
        props: it.getAttribute('properties') || '',
      };
    }
    const spineEl = byTag(opf, 'spine')[0];
    const spine = byTag(spineEl, 'itemref')
      .filter(r => r.getAttribute('linear') !== 'no')
      .map(r => manifest[r.getAttribute('idref')])
      .filter(m => m && /html|xml/.test(m.type));

    // обложка
    const items = Object.values(manifest);
    let coverItem = items.find(m => m.props.split(/\s+/).includes('cover-image'));
    if (!coverItem) {
      const cm = byTag(opf, 'meta').find(m => m.getAttribute('name') === 'cover');
      if (cm) coverItem = manifest[cm.getAttribute('content')];
    }
    if (!coverItem) coverItem = items.find(m => /cover/i.test(m.href) && /^image\//.test(m.type));
    let coverBlob = null;
    if (coverItem && getFile(coverItem.href)) {
      coverBlob = new Blob([await getFile(coverItem.href).async('uint8array')], { type: coverItem.type });
    }

    // оглавление: nav (EPUB3) или NCX (EPUB2)
    const tocRaw = [];
    const navItem = items.find(m => m.props.split(/\s+/).includes('nav'));
    if (navItem) {
      const nd = parseXml(await read(navItem.href), 'application/xhtml+xml');
      const navs = byTag(nd, 'nav');
      const tocNav = navs.find(n => /toc/.test(n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || n.getAttribute('epub:type') || '')) || navs[0];
      const walk = (ol, depth) => {
        if (!ol) return;
        for (const li of Array.from(ol.children).filter(c => c.localName === 'li')) {
          const a = Array.from(li.children).find(c => c.localName === 'a' || c.localName === 'span');
          if (a && a.getAttribute('href')) tocRaw.push({ title: a.textContent.replace(/\s+/g, ' ').trim(), href: resolvePath(dirOf(navItem.href), a.getAttribute('href')), depth });
          walk(Array.from(li.children).find(c => c.localName === 'ol'), depth + 1);
        }
      };
      if (tocNav) walk(Array.from(tocNav.children).find(c => c.localName === 'ol'), 0);
    }
    if (!tocRaw.length) {
      const ncx = manifest[spineEl?.getAttribute('toc')] || items.find(m => /ncx/.test(m.type));
      if (ncx) {
        const nd = parseXml(await read(ncx.href));
        const walk = (parent, depth) => {
          for (const np of Array.from(parent.children).filter(c => c.localName === 'navPoint')) {
            const label = firstText(np, 'text');
            const src = byTag(np, 'content')[0]?.getAttribute('src');
            if (src) tocRaw.push({ title: label, href: resolvePath(dirOf(ncx.href), src), depth });
            walk(np, depth + 1);
          }
        };
        const navMap = byTag(nd, 'navMap')[0];
        if (navMap) walk(navMap, 0);
      }
    }

    const pathIndex = new Map(spine.map((s, i) => [s.href, i]));
    const toc = tocRaw.map(t => {
      const [p, a] = t.href.split('#');
      return { title: t.title || 'Без названия', chapter: pathIndex.has(p) ? pathIndex.get(p) : null, anchor: a || null, depth: t.depth };
    }).filter(t => t.chapter != null);

    // blob-URL картинок
    const urlCache = new Map();
    const getUrl = async (p) => {
      if (urlCache.has(p)) return urlCache.get(p);
      const f = getFile(p);
      if (!f) return null;
      const type = items.find(m => m.href === p)?.type || (/\.svg$/i.test(p) ? 'image/svg+xml' : '');
      const url = URL.createObjectURL(new Blob([await f.async('uint8array')], { type }));
      urlCache.set(p, url);
      return url;
    };

    const chapters = spine.map((item, i) => {
      const fromToc = toc.find(t => t.chapter === i);
      return {
        title: fromToc ? fromToc.title : null,
        path: item.href,
        load: async () => {
          const text = await read(item.href);
          const doc = parseXml(text, 'application/xhtml+xml');
          const body = byTag(doc, 'body')[0] || doc.documentElement;
          const frag = document.createDocumentFragment();
          const dir = dirOf(item.href);
          cleanInto(body, frag, { resolve: (href) => href.startsWith('#') ? item.href + href : resolvePath(dir, href) });
          await loadImages(frag, getUrl);
          return frag;
        },
      };
    });
    // главы без названия в оглавлении — наследуют последнее известное
    let last = null;
    chapters.forEach((c, i) => {
      if (c.title) last = c.title;
      else c.title = last ? `${last} (продолжение)` : (i === 0 ? 'Начало' : `Раздел ${i + 1}`);
      c.generic = !toc.some(t => t.chapter === i);
    });

    return {
      format: 'epub',
      title: firstText(opf, 'title'),
      author: byTag(opf, 'creator').map(c => c.textContent.trim()).filter(Boolean).join(', '),
      lang: firstText(opf, 'language'),
      coverBlob,
      chapters,
      toc: toc.length ? toc : chapters.map((c, i) => ({ title: c.title, chapter: i, depth: 0 })),
      resolveLink(link) {
        const [p, a] = link.split('#');
        if (!pathIndex.has(p)) return null;
        return { chapter: pathIndex.get(p), anchor: a || null };
      },
      dispose() { urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear(); },
    };
  }

  /* ---------- FB2 ---------- */
  function parseFb2(text) {
    const doc = parseXml(text);
    const info = byTag(doc, 'title-info')[0];
    const author = byTag(info, 'author').map(a =>
      ['first-name', 'middle-name', 'last-name'].map(t => firstText(a, t)).filter(Boolean).join(' ')
    ).filter(Boolean).join(', ');

    const binaries = new Map();
    for (const b of byTag(doc, 'binary')) {
      binaries.set(b.getAttribute('id'), `data:${b.getAttribute('content-type') || 'image/jpeg'};base64,${b.textContent.replace(/\s+/g, '')}`);
    }
    const hrefOf = (e) => (e.getAttributeNS(XLINK, 'href') || e.getAttribute('l:href') || e.getAttribute('xlink:href') || e.getAttribute('href') || '');
    const imgSrc = (e) => binaries.get(hrefOf(e).replace(/^#/, ''));

    let coverBlob = null;
    const coverImg = byTag(byTag(info, 'coverpage')[0], 'image')[0];
    if (coverImg && imgSrc(coverImg)) {
      const [hd, b64] = imgSrc(coverImg).split(',');
      try {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        coverBlob = new Blob([arr], { type: hd.slice(5, hd.indexOf(';')) });
      } catch (e) { coverBlob = null; }
    }

    const MAP = { section: 'section', p: 'p', emphasis: 'em', strong: 'strong', strikethrough: 's', sub: 'sub', sup: 'sup',
      code: 'code', epigraph: 'blockquote', cite: 'blockquote', poem: 'div', stanza: 'div', v: 'p', 'text-author': 'p',
      subtitle: 'h4', table: 'table', tr: 'tr', td: 'td', th: 'th', a: 'a', style: 'span' };
    const CLS = { epigraph: 'epigraph', poem: 'poem', stanza: 'stanza', 'text-author': 'text-author', v: 'verse' };

    function conv(src, parent, depth) {
      for (const n of Array.from(src.childNodes)) {
        if (n.nodeType === 3) { parent.appendChild(document.createTextNode(n.nodeValue)); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.localName;
        if (tag === 'empty-line') { parent.appendChild(document.createElement('br')); continue; }
        if (tag === 'image') {
          const s = imgSrc(n);
          if (s) parent.appendChild(h('img', { src: s, alt: '', loading: 'lazy' }));
          continue;
        }
        let el;
        if (tag === 'title') el = document.createElement('h' + Math.min(2 + depth, 4));
        else if (MAP[tag]) el = document.createElement(MAP[tag]);
        else { conv(n, parent, depth); continue; }
        if (CLS[tag]) el.className = CLS[tag];
        const id = n.getAttribute('id');
        if (id) el.id = 'bk-' + id;
        if (tag === 'a') {
          const href = hrefOf(n);
          if (/^https?:/i.test(href)) { el.href = href; el.target = '_blank'; el.rel = 'noopener'; }
          else if (href) el.dataset.link = href;
          if (n.getAttribute('type') === 'note') el.className = 'note-ref';
        }
        if (tag === 'title') {
          // строки заголовка через <br>
          const ps = Array.from(n.children).filter(c => c.localName === 'p');
          if (ps.length > 1) {
            ps.forEach((p, i) => { if (i) el.appendChild(document.createElement('br')); conv(p, el, depth); });
            parent.appendChild(el);
            continue;
          }
        }
        conv(n, el, tag === 'section' ? depth + 1 : depth);
        parent.appendChild(el);
      }
    }

    const bodies = byTag(doc, 'body');
    const main = bodies.find(b => !b.getAttribute('name')) || bodies[0];
    const notes = bodies.filter(b => b !== main);
    if (!main) throw new Error('Некорректный FB2: нет <body>');

    let sections = Array.from(main.children).filter(c => c.localName === 'section');
    const pre = Array.from(main.children).filter(c => c.localName !== 'section');
    if (sections.length === 1 && Array.from(sections[0].children).filter(c => c.localName === 'section').length > 1) {
      sections = Array.from(sections[0].children).filter(c => c.localName === 'section');
    }
    const secTitle = (s, i) => {
      const t = Array.from(s.children).find(c => c.localName === 'title');
      return t ? t.textContent.replace(/\s+/g, ' ').trim().slice(0, 100) : `Глава ${i + 1}`;
    };
    const idsOf = (els) => new Set(els.flatMap(e => [e, ...e.getElementsByTagName('*')]).map(e => e.getAttribute?.('id')).filter(Boolean));

    const chapters = [];
    if (!sections.length) {
      chapters.push({ title: 'Текст', srcs: [main], ids: idsOf([main]) });
    } else {
      sections.forEach((s, i) => {
        const srcs = i === 0 ? [...pre, s] : [s];
        chapters.push({ title: secTitle(s, i), srcs, ids: idsOf(srcs) });
      });
    }
    notes.forEach(b => {
      const t = Array.from(b.children).find(c => c.localName === 'title');
      chapters.push({ title: t ? t.textContent.replace(/\s+/g, ' ').trim() : 'Примечания', srcs: [b], ids: idsOf([b]) });
    });
    chapters.forEach(c => {
      c.load = async () => {
        const f = document.createDocumentFragment();
        c.srcs.forEach(s => { if (s.localName === 'section' || s.localName === 'body') conv(s, f, 0); else { const w = document.createElement('div'); conv({ childNodes: [s] }, w, 0); f.append(...w.childNodes); } });
        return f;
      };
    });

    return simpleBook(chapters, {
      format: 'fb2',
      title: firstText(info, 'book-title'),
      author,
      lang: firstText(info, 'lang'),
      coverBlob,
    });
  }

  /* ---------- PDF ---------- */
  async function parsePdf(blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const md = await pdf.getMetadata().catch(() => null);
    const outline = [];
    try {
      const raw = await pdf.getOutline();
      const walk = async (list, depth) => {
        for (const it of list || []) {
          let page = null;
          try {
            const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest;
            if (dest && dest[0] != null) page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
          } catch (e) { /* битая ссылка */ }
          if (page) outline.push({ title: (it.title || '').trim() || `Стр. ${page}`, page, depth });
          if (depth < 2) await walk(it.items, depth + 1);
        }
      };
      await walk(raw, 0);
    } catch (e) { /* без оглавления */ }
    return {
      format: 'pdf',
      pdf,
      title: md?.info?.Title || '',
      author: md?.info?.Author || '',
      lang: '', // язык в метаданных PDF обычно ставит программа-конвертер, а не автор — не доверяем ему
      outline,
      numPages: pdf.numPages,
      dispose() { pdf.destroy(); },
    };
  }

  async function pdfCover(pdf) {
    try {
      const page = await pdf.getPage(1);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 240 / vp0.width });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      return c.toDataURL('image/jpeg', 0.8);
    } catch (e) { return null; }
  }

  /* ---------- Точка входа ---------- */
  async function parse(blob, name) {
    const fmt = formatOf(name);
    let book;
    switch (fmt) {
      case 'epub': book = await parseEpub(blob); break;
      case 'pdf': book = await parsePdf(blob); break;
      case 'fb2': book = parseFb2(decodeText(await blob.arrayBuffer())); break;
      case 'txt': book = parseTxt(decodeText(await blob.arrayBuffer()), name); break;
      case 'html': case 'htm': case 'xhtml': book = parseHtmlString(decodeText(await blob.arrayBuffer()), name, 'html'); break;
      case 'md': case 'markdown': book = parseHtmlString(mdToHtml(decodeText(await blob.arrayBuffer())), name, 'md'); break;
      case 'docx': {
        const res = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
        book = parseHtmlString(res.value, name, 'docx');
        break;
      }
      case 'fb2.zip': case 'zip': {
        const zip = await JSZip.loadAsync(blob);
        if (zip.file('META-INF/container.xml')) { book = await parseEpub(zip); break; }
        const entry = zip.file(/\.fb2$/i)[0];
        if (entry) { book = parseFb2(decodeText(await entry.async('arraybuffer'))); book.format = 'fb2'; break; }
        const inner = zip.file(/\.(epub|txt|html?|md|docx)$/i)[0];
        if (inner) return parse(await inner.async('blob'), inner.name.split('/').pop());
        throw new Error('В архиве не найдено книги');
      }
      case 'mobi': case 'azw': case 'azw3': case 'djvu':
        throw new Error(`Формат ${fmt.toUpperCase()} пока не поддерживается — сконвертируйте в EPUB (например, в Calibre)`);
      default:
        throw new Error('Неизвестный формат: ' + (fmt || name));
    }
    if (!book.title) book.title = baseName(name);
    return book;
  }

  return { parse, formatOf, pdfCover, SUPPORTED };
})();
