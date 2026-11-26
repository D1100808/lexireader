/* Читалка: текстовые форматы (по главам) и PDF (постранично), всплывающее окно перевода */
'use strict';

class Reader {
  constructor() {
    this.open = false;
    this.history = [];
    this.mouseDown = false;
    this.popupState = null;
    this.saveProgressSoon = debounce(() => this.saveProgress(), 800);
    this.highlightSoon = debounce(() => this.applyHighlights(), 250);
    this.bind();
  }

  get scroller() { return $('#rScroll'); }
  get content() { return $('#rContent'); }
  get isPdf() { return this.parsed?.format === 'pdf'; }

  bind() {
    $('#rBack').onclick = () => this.close();
    $('#rToc').onclick = () => this.togglePanel('toc');
    $('#rWords').onclick = () => this.togglePanel('words');
    $('#rNotes').onclick = () => this.togglePanel('notes');
    $('#rAa').onclick = () => App.openSettings();
    $('#rPrev').onclick = () => this.stepChapter(-1);
    $('#rNext').onclick = () => this.stepChapter(1);
    $('#rZoomOut').onclick = () => this.zoom(-0.15);
    $('#rZoomIn').onclick = () => this.zoom(0.15);
    $('#rBackLink').onclick = () => this.goBackLink();

    const sc = this.scroller;
    sc.addEventListener('scroll', () => {
      this.onScroll();
      if (this.popupState && !$('#selPopup').contains(document.activeElement)) this.hidePopup();
    }, { passive: true });
    sc.addEventListener('mousedown', (e) => {
      this.mouseDown = true;
      this.popupWasOpen = !!this.popupState;
      if (!$('#selPopup').contains(e.target)) this.hidePopup();
    });
    document.addEventListener('mouseup', () => {
      if (!this.mouseDown) return;
      this.mouseDown = false;
      setTimeout(() => this.onSelection(), 10);
    });
    document.addEventListener('selectionchange', debounce(() => {
      if (this.open && !this.mouseDown) this.onSelection();
    }, 550));
    sc.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-link]');
      if (a) { e.preventDefault(); this.followLink(a.dataset.link); return; }
      // касание по подсвеченной цитате — открыть её заметку
      const sel = getSelection();
      if (!this.popupWasOpen && (sel.isCollapsed || !sel.toString().trim())) {
        const note = this.noteAt(e.clientX, e.clientY);
        if (note) { this.popupWasOpen = false; return openNoteEditor(note, { onSaved: () => this.refreshNotes(), onDeleted: () => this.refreshNotes() }); }
      }
      // касание по слову — сразу перевод (первое касание при открытом окне только закрывает его)
      if (App.settings.tapTranslate && !this.popupWasOpen && !e.target.closest('a,button')) this.tapWord(e.clientX, e.clientY);
      this.popupWasOpen = false;
    });
    window.addEventListener('resize', debounce(() => {
      if (this.open && this.isPdf && Math.abs(this.scroller.clientWidth - this.layoutWidth) > 40) this.layoutPdf(this.page);
    }, 300));
  }

  /* ---------- Открытие / закрытие ---------- */
  async openBook(meta) {
    App.loading(true, 'Открываю книгу…');
    try {
      const rec = await DB.get('files', meta.id);
      if (!rec) throw new Error('Файл книги не найден');
      this.parsed = await Parsers.parse(rec.blob, meta.fileName);
    } catch (e) {
      App.loading(false);
      console.error(e);
      return toast('Не удалось открыть: ' + e.message, 5000);
    }
    this.meta = meta;
    this.open = true;
    this.history = [];
    this.lang = (meta.lang || this.parsed.lang || App.settings.srcLang || 'en').slice(0, 2).toLowerCase();
    $('#reader').classList.remove('hidden');
    document.body.classList.add('reading');
    $('#rBookTitle').textContent = meta.title;
    this.content.lang = this.lang;
    $('#reader').classList.toggle('is-pdf', this.isPdf);
    $('#rBackLink').classList.add('hidden');
    const pr = meta.progress || {};
    try {
      if (this.isPdf) await this.setupPdf(pr.page || 1);
      else await this.openChapter(pr.chapter || 0, { frac: pr.frac || 0 });
    } finally {
      App.loading(false);
    }
    meta.lastOpened = Date.now();
    DB.put('books', meta);
    this.renderToc();
    App.startReadingTimer();
  }

  close() {
    if (!this.open) return;
    ReadAloud.close();
    this.saveProgress();
    this.hidePopup();
    this.observer?.disconnect();
    this.parsed?.dispose?.();
    this.parsed = null;
    this.open = false;
    this.content.innerHTML = '';
    if (window.CSS?.highlights) {
      CSS.highlights.delete('lexi-saved');
      NOTE_COLORS.forEach(([c]) => CSS.highlights.delete('note-' + c));
    }
    this.noteRanges = [];
    $('#reader').classList.add('hidden');
    ['#tocPanel', '#wordsPanel', '#notesPanel'].forEach(s => $(s).classList.add('hidden'));
    document.body.classList.remove('reading');
    App.stopReadingTimer();
    App.renderLibrary();
  }

  /* ---------- Текстовые форматы ---------- */
  async openChapter(i, { frac = 0, anchor = null } = {}) {
    const chapters = this.parsed.chapters;
    i = Math.max(0, Math.min(chapters.length - 1, i));
    const ch = chapters[i];
    this.hidePopup();
    let frag;
    try { frag = await ch.load(); }
    catch (e) { console.error(e); frag = h('p', { class: 'muted' }, 'Не удалось загрузить главу: ' + e.message); }
    this.ci = i;
    const c = this.content;
    c.className = 'r-content';
    c.innerHTML = '';
    c.append(frag);
    if (ch.generic) {
      const hd = c.querySelector('h1,h2,h3');
      if (hd && hd.textContent.trim()) { ch.title = hd.textContent.replace(/\s+/g, ' ').trim().slice(0, 100); ch.generic = false; }
    }
    c.append(h('div', { class: 'chapter-end' },
      i < chapters.length - 1
        ? h('button', { class: 'btn', onclick: () => this.stepChapter(1) }, 'Следующая глава →')
        : h('div', { class: 'muted' }, '— Конец книги —')));
    this.updateChapterUI();
    await new Promise(r => requestAnimationFrame(r));
    const sc = this.scroller;
    if (anchor) {
      const el = document.getElementById('bk-' + anchor);
      if (el) el.scrollIntoView(); else sc.scrollTop = 0;
    } else {
      sc.scrollTop = frac * (sc.scrollHeight - sc.clientHeight);
    }
    this.applyHighlights();
    this.onScroll();
    ReadAloud.onChapterOpened();
    if (!$('#tocPanel').classList.contains('hidden')) this.renderToc();
    if (!$('#wordsPanel').classList.contains('hidden')) this.renderWords();
  }

  stepChapter(d) {
    if (this.isPdf) {
      const idx = this.pdfChapterIndex() + d;
      if (idx >= 0 && idx < this.pdfChapters.length) this.goPage(this.pdfChapters[idx].page);
      return;
    }
    const n = this.ci + d;
    if (n >= 0 && n < this.parsed.chapters.length) this.openChapter(n);
  }

  followLink(link) {
    const res = this.parsed.resolveLink?.(link);
    if (!res) return;
    this.history.push({ chapter: this.ci, top: this.scroller.scrollTop });
    $('#rBackLink').classList.remove('hidden');
    if (res.chapter == null || res.chapter === this.ci) {
      const el = res.anchor && document.getElementById('bk-' + res.anchor);
      if (el) el.scrollIntoView({ block: 'center' });
    } else {
      this.openChapter(res.chapter, { anchor: res.anchor });
    }
  }

  async goBackLink() {
    const st = this.history.pop();
    if (!this.history.length) $('#rBackLink').classList.add('hidden');
    if (!st) return;
    if (st.chapter !== this.ci) await this.openChapter(st.chapter);
    this.scroller.scrollTop = st.top;
  }

  /* ---------- PDF ---------- */
  async setupPdf(page) {
    const P = this.parsed;
    let chs = P.outline.filter(o => o.depth <= 1).sort((a, b) => a.page - b.page);
    if (!chs.length) {
      chs = [];
      for (let s = 1; s <= P.numPages; s += 10) chs.push({ title: `Стр. ${s}–${Math.min(s + 9, P.numPages)}`, page: s, depth: 0 });
    } else if (chs[0].page > 1) {
      chs.unshift({ title: 'Начало', page: 1, depth: 0 });
    }
    this.pdfChapters = chs;
    await this.layoutPdf(page);
  }

  async layoutPdf(goPage = 1) {
    const pdf = this.parsed.pdf;
    this.observer?.disconnect();
    const p1 = await pdf.getPage(Math.min(goPage, pdf.numPages) || 1);
    const vp = p1.getViewport({ scale: 1 });
    this.layoutWidth = this.scroller.clientWidth;
    const base = Math.min(this.layoutWidth - 24, 900);
    this.scale = (base * (App.settings.pdfZoom || 1)) / vp.width;
    const c = this.content;
    c.className = 'r-content pdf-mode';
    c.innerHTML = '';
    const wrap = h('div', { class: 'pdf-pages' });
    this.pageEls = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const d = h('div', { class: 'pdf-page', 'data-page': i, style: { width: vp.width * this.scale + 'px', height: vp.height * this.scale + 'px' } },
        h('div', { class: 'pdf-num' }, i));
      this.pageEls.push(d);
      wrap.append(d);
    }
    c.append(wrap);
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = +e.target.dataset.page;
        if (e.isIntersecting) this.renderPage(e.target, n); else this.unrenderPage(e.target);
      }
    }, { root: this.scroller, rootMargin: '1500px 0px' });
    this.pageEls.forEach(d => this.observer.observe(d));
    this.page = goPage;
    this.updateChapterUI();
    await new Promise(r => requestAnimationFrame(r));
    this.goPage(goPage, true);
  }

  goPage(n, instant) {
    const el = this.pageEls?.[n - 1];
    if (!el) return;
    this.scroller.scrollTo({ top: el.offsetTop - 8, behavior: instant ? 'auto' : 'smooth' });
  }

  async renderPage(div, n) {
    if (div.dataset.state) return;
    div.dataset.state = 'loading';
    const token = (div._token = (div._token || 0) + 1);
    try {
      const page = await this.parsed.pdf.getPage(n);
      const vp = page.getViewport({ scale: this.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      if (div._token !== token || !this.open) return;
      const tl = h('div', { class: 'textLayer' });
      tl.style.setProperty('--scale-factor', this.scale);
      const textContent = await page.getTextContent();
      if (div._token !== token || !this.open) return;
      div.style.width = vp.width + 'px';
      div.style.height = vp.height + 'px';
      div.append(canvas, tl);
      await pdfjsLib.renderTextLayer({ textContentSource: textContent, container: tl, viewport: vp, textDivs: [] }).promise;
      div.dataset.state = 'done';
      this.highlightSoon();
    } catch (e) {
      if (div._token === token) div.dataset.state = '';
      console.warn('PDF page', n, e);
    }
  }

  unrenderPage(div) {
    if (!div.dataset.state) return;
    div._token = (div._token || 0) + 1;
    div.dataset.state = '';
    div.querySelectorAll('canvas,.textLayer').forEach(x => x.remove());
  }

  zoom(d) {
    if (!this.isPdf) return;
    App.setSetting('pdfZoom', Math.max(0.5, Math.min(3, Math.round(((App.settings.pdfZoom || 1) + d) * 100) / 100)));
    this.layoutPdf(this.page);
  }

  currentPdfPage() {
    const top = this.scroller.scrollTop + this.scroller.clientHeight * 0.3;
    let lo = 0, hi = this.pageEls.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.pageEls[mid].offsetTop <= top) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans + 1;
  }

  pdfChapterIndex(page = this.page) {
    let idx = 0;
    this.pdfChapters.forEach((c, i) => { if (c.page <= page) idx = i; });
    return idx;
  }

  /* ---------- Прогресс и интерфейс ---------- */
  chapterTitle() {
    if (this.isPdf) return this.pdfChapters[this.pdfChapterIndex()].title.slice(0, 100);
    return this.parsed.chapters[this.ci].title;
  }
  chapterIndex() { return this.isPdf ? this.pdfChapterIndex() : this.ci; }

  onScroll() {
    if (!this.open) return;
    const sc = this.scroller;
    let pct, text;
    if (this.isPdf) {
      if (!this.pageEls?.length) return;
      const prevChapter = this.pdfChapterIndex();
      this.page = this.currentPdfPage();
      const n = this.parsed.numPages;
      pct = n > 1 ? (this.page - 1) / (n - 1) : 1;
      text = `Стр. ${this.page} / ${n}`;
      if (prevChapter !== this.pdfChapterIndex()) this.updateChapterUI();
    } else {
      const max = sc.scrollHeight - sc.clientHeight;
      this.frac = max > 0 ? sc.scrollTop / max : 1;
      const n = this.parsed.chapters.length;
      pct = (this.ci + this.frac) / n;
      text = `Глава ${this.ci + 1} / ${n}`;
    }
    this.pct = Math.min(1, Math.max(0, pct));
    $('#rProgressBar').style.width = (this.pct * 100).toFixed(1) + '%';
    $('#rProgressText').textContent = `${text} · ${Math.round(this.pct * 100)}%`;
    this.saveProgressSoon();
  }

  updateChapterUI() {
    $('#rChapterTitle').textContent = this.chapterTitle();
    const idx = this.chapterIndex();
    const total = this.isPdf ? this.pdfChapters.length : this.parsed.chapters.length;
    $('#rPrev').disabled = idx <= 0;
    $('#rNext').disabled = idx >= total - 1;
  }

  saveProgress() {
    if (!this.open || !this.meta) return;
    this.meta.progress = this.isPdf ? { page: this.page } : { chapter: this.ci, frac: this.frac || 0 };
    this.meta.percent = this.pct || 0;
    DB.put('books', this.meta);
  }

  togglePanel(which) {
    const panels = { toc: '#tocPanel', words: '#wordsPanel', notes: '#notesPanel' };
    for (const [k, sel] of Object.entries(panels)) {
      const p = $(sel);
      if (k === which) p.classList.toggle('hidden'); else p.classList.add('hidden');
    }
    if ($(panels[which]).classList.contains('hidden')) return;
    if (which === 'toc') this.renderToc();
    else if (which === 'words') this.renderWords();
    else this.renderNotes();
  }

  renderNotes() {
    const p = $('#notesPanel');
    p.innerHTML = '';
    const notes = Notes.ofBook(this.meta.id).sort((a, b) => (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0) || (a.page ?? 0) - (b.page ?? 0) || a.createdAt - b.createdAt);
    p.append(h('div', { class: 'panel-title' }, `Заметки книги (${notes.length})`),
      h('div', { class: 'row gap wrap pad' },
        h('button', { class: 'btn sm', disabled: !notes.length, onclick: () => downloadFile(`${this.meta.title} - заметки.md`.replace(/[\\/:*?"<>|]/g, '_'), Notes.toText(notes), 'text/markdown') }, '⭳ Экспорт'),
        h('button', { class: 'btn sm', onclick: () => { const id = this.meta.id; this.close(); NotesView.open(id); } }, 'Все заметки')));
    if (!notes.length) {
      p.append(h('p', { class: 'muted pad' }, 'Выделите в тексте цитату и выберите цвет — получится стикер. Его можно дополнить своей мыслью.'));
      return;
    }
    p.append(NotesView.wall(notes, () => this.refreshNotes(), true));
  }

  /** Обновить подсветку цитат и панель заметок после изменений */
  refreshNotes() {
    this.applyHighlights();
    if (!$('#notesPanel').classList.contains('hidden')) this.renderNotes();
  }

  /** Перейти к цитате заметки */
  async goToNote(note) {
    this.closePanelsOnMobile();
    if (this.isPdf) {
      if (note.page) this.goPage(note.page);
      return;
    }
    if (note.chapterIndex != null && note.chapterIndex !== this.ci) await this.openChapter(note.chapterIndex);
    const r = findTextRanges(this.content, note.quote, 1)[0];
    if (!r) return toast('Цитата не найдена в тексте');
    const top = r.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    this.scroller.scrollTop += top - 120;
  }

  /** Заметка, на цитату которой нажали */
  noteAt(x, y) {
    if (!this.noteRanges?.length) return null;
    let node, off;
    if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (!r) return null; node = r.startContainer; off = r.startOffset; }
    else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (!p) return null; node = p.offsetNode; off = p.offset; }
    if (!node) return null;
    for (const { range, note } of this.noteRanges) {
      try {
        if (range.isPointInRange(node, off)) {
          // убеждаемся, что палец действительно на тексте цитаты
          const hit = [...range.getClientRects()].some(rc => x >= rc.left - 2 && x <= rc.right + 2 && y >= rc.top - 2 && y <= rc.bottom + 2);
          if (hit) return Notes.all.find(n => n.id === note.id) || null;
        }
      } catch (e) { /* узел из другой главы */ }
    }
    return null;
  }

  /** Подсветка цитат заметок цветом стикера */
  applyNoteHighlights() {
    this.noteRanges = [];
    const groups = Object.fromEntries(NOTE_COLORS.map(([c]) => [c, []]));
    for (const n of Notes.ofBook(this.meta.id)) {
      if (!this.isPdf && n.chapterIndex != null && n.chapterIndex !== this.ci) continue;
      for (const r of findTextRanges(this.content, n.quote, 3)) {
        (groups[n.color] || groups.yellow).push(r);
        this.noteRanges.push({ range: r, note: n });
      }
    }
    for (const [c, ranges] of Object.entries(groups)) {
      if (ranges.length) CSS.highlights.set('note-' + c, new Highlight(...ranges)); else CSS.highlights.delete('note-' + c);
    }
  }

  /** Место цитаты в книге */
  locOf(range) {
    const loc = { chapterIndex: this.chapterIndex(), chapterTitle: this.chapterTitle() };
    if (this.isPdf) {
      const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      loc.page = Number(el?.closest('.pdf-page')?.dataset.page) || this.page;
    }
    return loc;
  }

  /** Создать заметку из выделения: сразу (цвет) или через редактор */
  async addNote(quote, range, color, withEditor) {
    const note = Notes.create({ bookId: this.meta.id, bookTitle: this.meta.title, quote, ...this.locOf(range) });
    if (color) note.color = color;
    this.hidePopup();
    getSelection().removeAllRanges();
    if (withEditor) return openNoteEditor(note, { isNew: true, onSaved: () => this.refreshNotes() });
    App.setSetting('noteColor', note.color);
    await Notes.save(note);
    toast('Стикер сохранён — нажмите на цитату, чтобы добавить мысль');
    this.refreshNotes();
  }

  /** Окно для длинного выделения: цитата → стикер */
  showQuotePopup(quote, range, rect) {
    const P = $('#selPopup');
    this.popupState = { word: quote, orig: quote, rect };
    P.replaceChildren(
      h('div', { class: 'pp-head' }, h('b', { class: 'grow' }, '🗒️ Цитата в заметки'),
        h('button', { class: 'icon-btn sm', title: 'Закрыть', onclick: () => this.hidePopup() }, '✕')),
      h('div', { class: 'pp-ctx' }, quote.length > 220 ? quote.slice(0, 220) + '…' : quote),
      h('div', { class: 'muted small' }, 'Выберите цвет стикера:'),
      h('div', { class: 'color-dots big' }, NOTE_COLORS.map(([id, name, hex]) =>
        h('button', { class: 'color-dot' + (id === (App.settings.noteColor || 'yellow') ? ' active' : ''), title: name, style: { background: hex }, onclick: () => this.addNote(quote, range, id, false) }))),
      h('div', { class: 'pp-row' },
        h('button', { class: 'btn sm ghost', onclick: () => copyText(quote) }, '⧉ Копировать'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn primary sm', onclick: () => this.addNote(quote, range, null, true) }, '✎ С комментарием')));
    P.classList.remove('hidden');
    this.placePopup();
  }

  renderToc() {
    const p = $('#tocPanel');
    p.innerHTML = '';
    const m = this.meta;
    p.append(h('div', { class: 'panel-head' },
      m.cover && h('img', { class: 'toc-cover', src: m.cover, alt: '' }),
      h('div', null, h('b', null, m.title), h('div', { class: 'muted small' }, m.author || ''))),
      h('div', { class: 'panel-title' }, 'Оглавление'));
    const list = h('div', { class: 'toc-list' });
    if (this.isPdf) {
      const cur = this.pdfChapterIndex();
      const entries = this.parsed.outline.length ? this.parsed.outline : this.pdfChapters;
      entries.forEach(o => {
        const isCur = this.pdfChapters[cur] && o.page === this.pdfChapters[cur].page && o.title === this.pdfChapters[cur].title;
        list.append(h('a', { href: '#', class: 'toc-item' + (isCur ? ' current' : ''), style: { paddingLeft: 12 + o.depth * 16 + 'px' }, onclick: (e) => { e.preventDefault(); this.goPage(o.page); this.closePanelsOnMobile(); } },
          h('span', { class: 'grow' }, o.title), h('span', { class: 'muted small' }, o.page)));
      });
    } else {
      this.parsed.toc.forEach(t => {
        const ch = this.parsed.chapters[t.chapter];
        list.append(h('a', { href: '#', class: 'toc-item' + (t.chapter === this.ci ? ' current' : ''), style: { paddingLeft: 12 + t.depth * 16 + 'px' }, onclick: (e) => { e.preventDefault(); this.openChapter(t.chapter, { anchor: t.anchor }); this.closePanelsOnMobile(); } },
          h('span', { class: 'grow' }, t.title || ch.title),
          (() => { const n = Cards.ofBook(m.id).filter(c => c.chapterIndex === t.chapter).length; return n ? h('span', { class: 'pill', title: 'Сохранённых слов' }, n) : null; })()));
      });
    }
    p.append(list);
    p.querySelector('.current')?.scrollIntoView({ block: 'center' });
  }

  renderWords() {
    const p = $('#wordsPanel');
    p.innerHTML = '';
    const decks = Cards.decks(this.meta.id);
    const cur = this.chapterTitle();
    const curDeck = decks.find(d => d.name === cur);
    p.append(h('div', { class: 'panel-title' }, `Слова книги (${Cards.ofBook(this.meta.id).length})`),
      h('div', { class: 'row gap wrap pad' },
        h('button', { class: 'btn primary sm', disabled: !curDeck, onclick: () => Review.start(curDeck.cards, { title: cur, cram: true, returnBook: this.meta.id }) }, 'Учить слова главы'),
        h('button', { class: 'btn sm', onclick: () => { const id = this.meta.id; this.close(); Vocab.open(id, '*'); } }, 'Открыть словари')));
    if (!decks.length) {
      p.append(h('p', { class: 'muted pad' }, 'Выделите слово в тексте, чтобы сохранить его. Для каждой главы создаётся свой словарь.'));
      return;
    }
    for (const d of decks) {
      p.append(h('details', { class: 'wp-deck', open: d.name === cur },
        h('summary', null, h('span', { class: 'grow' }, d.name), h('span', { class: 'muted small' }, d.cards.length)),
        h('ul', { class: 'wp-list' }, d.cards.sort((a, b) => a.createdAt - b.createdAt).map(c =>
          h('li', { title: c.context || '' }, h('b', { onclick: () => speak(c.word, c.lang) }, c.word), ' — ', c.translation || '…')))));
    }
  }

  closePanelsOnMobile() {
    if (window.innerWidth < 900) ['#tocPanel', '#wordsPanel', '#notesPanel'].forEach(s => $(s).classList.add('hidden'));
  }

  /* ---------- Подсветка сохранённых слов (CSS Highlight API) ---------- */
  applyHighlights() {
    if (!this.open || !(window.CSS && CSS.highlights && window.Highlight)) return;
    this.applyNoteHighlights();
    if (!App.settings.highlightSaved) { CSS.highlights.delete('lexi-saved'); return; }
    const words = [...new Set(Cards.ofBook(this.meta.id).flatMap(c => [c.word, c.form]).filter(Boolean).map(w => w.toLowerCase()))];
    if (!words.length) { CSS.highlights.delete('lexi-saved'); return; }
    const alt = words.sort((a, b) => b.length - a.length).map(w => escapeRe(w).replace(/\s+/g, '\\s+')).join('|');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'giu');
    const ranges = [];
    const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(node.nodeValue))) {
        const r = new Range();
        r.setStart(node, m.index);
        r.setEnd(node, m.index + m[0].length);
        ranges.push(r);
        if (ranges.length > 5000) break;
      }
    }
    CSS.highlights.set('lexi-saved', new Highlight(...ranges));
  }

  /* ---------- Выделение → перевод → карточка ---------- */
  onSelection() {
    if (!this.open) return;
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!this.content.contains(range.commonAncestorContainer)) return;
    const raw = sel.toString();
    const word = cleanWord(raw);
    if (!word) return;
    const rect = range.getBoundingClientRect();
    // длинное выделение — это цитата: предлагаем сохранить стикером
    if (word.length > 80 || word.split(' ').length > 6) {
      const quote = raw.replace(/\s+/g, ' ').trim();
      if (quote.length > 4000) return toast('Слишком длинный фрагмент для заметки');
      if (this.popupState && this.popupState.orig === quote) return;
      return this.showQuotePopup(quote, range.cloneRange(), rect);
    }
    if (this.popupState && this.popupState.orig === word && Math.abs(this.popupState.rect.top - rect.top) < 2) return;
    let context = '';
    try { context = this.contextOf(range); } catch (e) { /* без контекста */ }
    this.popupRange = range.cloneRange();
    this.popupRaw = raw.replace(/\s+/g, ' ').trim();
    this.showPopup(word, context, rect);
  }

  /** Выделяет слово под точкой касания и открывает перевод */
  tapWord(x, y) {
    const sel = getSelection();
    if (!sel.isCollapsed && sel.toString().trim()) return;
    let node, off;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (!r) return;
      node = r.startContainer; off = r.startOffset;
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return;
      node = p.offsetNode; off = p.offset;
    }
    if (!node || node.nodeType !== 3 || !this.content.contains(node)) return;
    const t = node.nodeValue;
    const isW = (ch) => /[\p{L}\p{N}'’-]/u.test(ch);
    let s = off, e = off;
    while (s > 0 && isW(t[s - 1])) s--;
    while (e < t.length && isW(t[e])) e++;
    while (s < e && /['’-]/.test(t[s])) s++;
    while (e > s && /['’-]/.test(t[e - 1])) e--;
    if (e <= s) return;
    const r = document.createRange();
    r.setStart(node, s);
    r.setEnd(node, e);
    const rc = r.getBoundingClientRect();
    if (x < rc.left - 6 || x > rc.right + 6 || y < rc.top - 6 || y > rc.bottom + 6) return; // нажали мимо текста
    sel.removeAllRanges();
    sel.addRange(r);
    this.onSelection();
  }

  contextOf(range) {
    const textOf = (node) => {
      let s = '';
      const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = w.nextNode())) {
        if (n.nodeType === 3) s += n.nodeValue;
        else if (n.tagName === 'BR' || (this.isPdf && n.tagName === 'SPAN' && !/\s$/.test(s))) s += ' ';
      }
      return s;
    };
    const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const block = (this.isPdf ? start.closest('.textLayer') : start.closest('p,li,blockquote,td,th,dd,dt,h1,h2,h3,h4,h5,h6,pre,div,section')) || this.content;
    const pre = document.createRange();
    pre.setStart(block, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const pos = textOf(pre.cloneContents()).length;
    return sentenceAround(textOf(block), pos, range.toString().length);
  }

  showPopup(word, context, rect) {
    const P = $('#selPopup');
    const bookId = this.meta.id;
    const orig = word;
    // слово в начале предложения: «The» → «the»
    if (/^\p{Lu}\p{Ll}+$/u.test(word) && context.startsWith(word)) word = word.toLowerCase();
    this.popupState = { word, orig, rect };
    const existing = Cards.find(bookId, word);
    const cur = this.chapterTitle();
    const deckNames = Cards.decks(bookId).map(d => d.name);
    if (!deckNames.includes(cur)) deckNames.unshift(cur);
    const deckSel = h('select', { class: 'input sm grow' },
      deckNames.map(d => h('option', { value: d }, d === cur ? `${d} (текущая)` : d)),
      h('option', { value: '__new' }, '＋ Новый словарь…'));
    deckSel.value = cur;
    deckSel.onchange = () => {
      if (deckSel.value !== '__new') return;
      const n = prompt('Название нового словаря:', '');
      if (n && n.trim()) {
        deckSel.insertBefore(h('option', { value: n.trim() }, n.trim()), deckSel.lastChild);
        deckSel.value = n.trim();
      } else deckSel.value = cur;
    };
    const wordIn = h('input', { class: 'pp-word', value: word, spellcheck: 'false' });
    const tr = h('input', { class: 'input', placeholder: 'Перевод…', value: existing[0]?.translation || '' });
    const alts = h('div', { class: 'alts' });
    const dict = h('div', { class: 'dict' });
    const from = this.lang, to = App.settings.tgtLang;
    const mode = App.settings.translator || 'auto'; // auto | offline | online
    const useDict = mode !== 'online' && Dict.supports(from, to);
    let form = null; // форма из текста, если сохраняем начальную (went → go)

    const save = async () => {
      const w = cleanWord(wordIn.value) || word;
      const deck = deckSel.value === '__new' ? cur : deckSel.value;
      const same = Cards.find(bookId, w).find(c => c.deck === deck);
      const f = form && form.toLowerCase() !== w.toLowerCase() ? form : undefined;
      if (same) await Cards.save({ ...same, translation: tr.value.trim() || same.translation, context: context || same.context, form: same.form || f });
      else {
        await Cards.save(Cards.create({
          bookId, deck, chapterIndex: deck === cur ? this.chapterIndex() : (Cards.decks(bookId).find(d => d.name === deck)?.order ?? this.chapterIndex()),
          word: w, form: f, translation: tr.value.trim(), context, lang: from, tlang: to, bookTitle: this.meta.title,
        }));
      }
      toast(`«${w}» сохранено в «${deck}»`);
      this.hidePopup();
      getSelection().removeAllRanges();
      this.applyHighlights();
      if (!$('#wordsPanel').classList.contains('hidden')) this.renderWords();
      if (!$('#tocPanel').classList.contains('hidden')) this.renderToc();
    };
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    wordIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { form = null; delete tr.dataset.auto; tr.value = ''; lookupAll(true); } });

    const setTr = (text) => { if (text && (!tr.value || tr.dataset.auto)) { tr.value = text; tr.dataset.auto = '1'; } };

    // встроенный словарь
    const renderDict = (blocks) => {
      dict.replaceChildren(...blocks.map(b => h('div', { class: 'dict-block' },
        b.via && h('div', { class: 'dict-via' }, b.via),
        b.entries.slice(0, 4).map(([pos, ipa, senses, ex]) => h('div', { class: 'dict-entry' },
          h('div', { class: 'dict-pos' }, b.via || blocks.length > 1 ? h('b', null, b.head + ' ') : '', h('i', null, pos), ipa ? h('span', { class: 'muted' }, ' ' + ipa) : ''),
          h('ol', { class: 'dict-senses' }, senses.map((s, i) => h('li', {
            class: i >= 3 ? 'more' : null, title: 'Взять этот перевод',
            onclick: () => { tr.value = Dict.shortGloss(s); delete tr.dataset.auto; if (wordIn.value !== b.head && b.via) { wordIn.value = b.head; form = word; } },
          }, s))),
          senses.length > 3 && h('button', {
            class: 'link-btn', onclick: (e) => { e.target.closest('.dict-entry').classList.add('open'); e.target.remove(); this.placePopup(); },
          }, `ещё ${senses.length - 3}`),
          ex && h('div', { class: 'dict-ex' }, ex[0], h('br'), h('span', { class: 'muted' }, ex[1])))))));
    };
    const runDict = async () => {
      try { await Dict.load(); } catch (e) { return false; }
      if (this.popupState?.word !== word) return true;
      const blocks = Dict.lookup(cleanWord(wordIn.value) || word);
      if (!blocks) return false;
      if (blocks[0].via && !form) { form = cleanWord(wordIn.value) || word; wordIn.value = blocks[0].head; }
      renderDict(blocks);
      setTr(Dict.shortGloss(blocks[0].entries[0][2][0]));
      return true;
    };

    const lookupAll = async (force) => {
      let hit = false;
      if (useDict) {
        dict.replaceChildren(h('div', { class: 'muted small' }, 'Ищу в словаре…'));
        hit = await runDict();
        if (!hit) dict.replaceChildren();
        this.placePopup();
      }
      if (this.popupState?.word !== word) return;
      if (hit) return;
      if (mode === 'offline') {
        alts.replaceChildren(h('span', { class: 'muted small' }, 'Нет во встроенном словаре — введите перевод вручную.'));
        this.placePopup();
      } else if (force || (App.settings.autoTranslate && !existing.length)) runTranslate(true);
    };

    // онлайн-перевод
    const runTranslate = async (withDefinition) => {
      const w = cleanWord(wordIn.value) || word;
      if (from === to) { alts.replaceChildren(h('span', { class: 'muted small' }, 'Язык книги совпадает с языком перевода — измените в настройках')); return; }
      tr.placeholder = 'Перевожу…';
      if (withDefinition) Translator.define(w, from).then(d => {
        if (!d || this.popupState?.word !== word) return;
        dict.replaceChildren(
          d.phonetic ? h('div', { class: 'muted small' }, d.phonetic) : '',
          ...d.meanings.map(m => h('div', { class: 'small' }, h('i', null, m.pos), ' — ', m.def)));
        this.placePopup();
      });
      try {
        const r = await Translator.translate(w, from, to);
        if (this.popupState?.word !== word) return;
        if (!tr.value || tr.dataset.auto) { tr.value = r.main; tr.dataset.auto = '1'; }
        alts.replaceChildren(...r.alts.map(a => h('button', { class: 'chip', onclick: () => { tr.value = a; tr.focus(); } }, a)));
      } catch (e) {
        alts.replaceChildren(h('span', { class: 'muted small' }, 'Нет перевода (' + e.message + '). Введите вручную.'));
      } finally {
        tr.placeholder = 'Перевод…';
        this.placePopup();
      }
    };
    tr.addEventListener('input', () => { delete tr.dataset.auto; });

    P.replaceChildren(
      h('div', { class: 'pp-head' }, wordIn,
        h('button', { class: 'icon-btn sm', title: 'Произнести', onclick: () => speak(wordIn.value, from) }, '🔊'),
        !this.isPdf && this.popupRange && h('button', {
          class: 'icon-btn sm', title: 'Читать вслух отсюда',
          onclick: () => { const r = this.popupRange; this.hidePopup(); getSelection().removeAllRanges(); ReadAloud.active ? ReadAloud.restartHere(r) : ReadAloud.open(r); },
        }, '🎧'),
        h('button', { class: 'icon-btn sm', title: 'Закрыть', onclick: () => this.hidePopup() }, '✕')),
      existing.length ? h('div', { class: 'pp-exists' }, `✓ Уже в словаре: ${existing.map(c => c.deck).join(', ')}`) : '',
      dict,
      tr,
      alts,
      context ? h('div', { class: 'pp-ctx', html: ctxHtml(context, word) }) : '',
      h('div', { class: 'pp-row' }, h('span', { title: 'Словарь (глава)' }, '📁'), deckSel),
      h('div', { class: 'pp-row' },
        mode !== 'offline' && h('button', { class: 'btn sm ghost', title: 'Перевод через интернет', onclick: () => runTranslate(!useDict) }, '🌐'),
        h('button', { class: 'btn sm ghost', title: 'Сохранить как заметку-стикер', onclick: () => this.addNote(this.popupRaw || orig, this.popupRange, null, true) }, '🗒️ Заметка'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn primary sm', onclick: save }, '＋ В карточки')));
    P.classList.remove('hidden');
    this.placePopup();
    lookupAll(false);
  }

  placePopup() {
    const P = $('#selPopup');
    if (!this.popupState) return;
    // на телефоне — шторка снизу
    const sheet = innerWidth < 700;
    P.classList.toggle('sheet', sheet);
    if (sheet) { P.style.left = P.style.top = P.style.width = ''; return; }
    const rect = this.popupState.rect;
    const W = Math.min(360, innerWidth - 16);
    P.style.width = W + 'px';
    let left = rect.left + rect.width / 2 - W / 2;
    left = Math.max(8, Math.min(innerWidth - W - 8, left));
    const ph = P.offsetHeight;
    let top = rect.bottom + 10;
    if (top + ph > innerHeight - 8) top = Math.max(8, rect.top - ph - 10);
    P.style.left = left + 'px';
    P.style.top = top + 'px';
  }

  hidePopup() {
    this.popupState = null;
    $('#selPopup').classList.add('hidden');
  }
}
