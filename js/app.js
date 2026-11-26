/* Главный модуль: библиотека, навигация, настройки, импорт */
'use strict';

const LANGS = [
  ['en', 'Английский'], ['de', 'Немецкий'], ['fr', 'Французский'], ['es', 'Испанский'], ['it', 'Итальянский'],
  ['pt', 'Португальский'], ['nl', 'Нидерландский'], ['pl', 'Польский'], ['cs', 'Чешский'], ['sv', 'Шведский'],
  ['fi', 'Финский'], ['tr', 'Турецкий'], ['uk', 'Украинский'], ['ru', 'Русский'], ['kk', 'Казахский'],
  ['zh', 'Китайский'], ['ja', 'Японский'], ['ko', 'Корейский'], ['ar', 'Арабский'],
];

const THEMES = [
  ['sepia', 'Сепия'], ['paper', 'Бумага'], ['green', 'Олива'], ['dusk', 'Сумерки'], ['night', 'Ночь'],
];

const FONTS = [
  ['literata', 'Literata', "'Literata', Georgia, serif"],
  ['ptserif', 'PT Serif', "'PT Serif', Georgia, serif"],
  ['georgia', 'Georgia', "Georgia, 'Times New Roman', serif"],
  ['sans', 'Без засечек', "'Inter', 'Segoe UI', system-ui, sans-serif"],
  ['verdana', 'Verdana (крупный)', "Verdana, Geneva, sans-serif"],
];

const App = {
  DEFAULTS: {
    theme: 'sepia', font: 'literata', fontSize: 20, lineHeight: 1.7, width: 720, align: 'left',
    warm: 0, dim: 0, breakReminder: true,
    srcLang: 'en', tgtLang: 'ru', translator: 'auto', autoTranslate: true, highlightSaved: true,
    cardDir: 'word', studyMode: 'choice', pdfZoom: 1,
    // чтение вслух: system — системный голос, neural — естественный (скачивается по кнопке)
    ttsEngine: 'system', ttsRate: 1, ttsVoice: 0, ttsWebVoice: '',
    // на телефоне и в Android-приложении — перевод по касанию
    tapTranslate: !!window.Capacitor?.isNativePlatform?.() || matchMedia('(pointer: coarse)').matches,
  },
  settings: {},
  books: [],
  view: 'library',
  reader: null,

  async init() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('lexi.settings') || '{}'); } catch (e) { /* приватный режим */ }
    this.settings = { ...this.DEFAULTS, ...saved };
    this.applySettings();
    this.reader = new Reader();
    Platform.init();
    ReadAloud.init();

    $$('.tab').forEach(t => t.addEventListener('click', () => this.show(t.dataset.view)));
    $('#settingsBtn').onclick = () => this.openSettings();
    $('#fileInput').addEventListener('change', (e) => { this.importFiles([...e.target.files]); e.target.value = ''; });
    $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') this.closeModal(); });
    document.addEventListener('keydown', (e) => this.onKey(e));

    // перетаскивание файлов
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
      if (e.dataTransfer?.files?.length) this.importFiles([...e.dataTransfer.files]);
    });

    try {
      await Cards.load();
      await Notes.load();
      this.books = await DB.all('books');
    } catch (e) {
      toast('Хранилище браузера недоступно: ' + e.message, 8000);
    }
    this.renderLibrary();
    this.updateBadge();
    setInterval(() => this.updateBadge(), 60000);
    // словарь грузим заранее, в фоне, чтобы первое выделенное слово переводилось мгновенно
    if (this.settings.translator !== 'online') setTimeout(() => Dict.load().catch(() => { }), 1200);
    window.addEventListener('beforeunload', () => this.reader.saveProgress());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reader.saveProgress(); });
  },

  /* ---------- Навигация ---------- */
  show(view) {
    if (this.reader.open) this.reader.close();
    this.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    if (view === 'library') this.renderLibrary();
    if (view === 'vocab') Vocab.render();
    if (view === 'review') Review.render();
    if (view === 'notes') NotesView.render();
    window.scrollTo(0, 0);
  },

  onKey(e) {
    if (e.key === 'Escape') {
      if (this.modalOpen()) return this.closeModal();
      if (this.reader.open) {
        if (this.reader.popupState) return this.reader.hidePopup();
        $('#tocPanel').classList.add('hidden');
        $('#wordsPanel').classList.add('hidden');
        $('#notesPanel').classList.add('hidden');
      }
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (typing) return;
    if (this.view === 'review' && !this.reader.open) Review.onKey(e);
  },

  /** Кнопка «Назад» на Android: закрывает верхний слой. false — выйти из приложения */
  handleBack() {
    if (this.modalOpen()) { this.closeModal(); return true; }
    if (this.reader.open) {
      if (this.reader.popupState) { this.reader.hidePopup(); return true; }
      const panels = ['#tocPanel', '#wordsPanel', '#notesPanel'].map(s => $(s)).filter(p => !p.classList.contains('hidden'));
      if (panels.length) { panels.forEach(p => p.classList.add('hidden')); return true; }
      this.reader.close();
      return true;
    }
    if (this.view === 'review' && Review.session) { Review.session = null; Review.render(); return true; }
    if (this.view === 'vocab' && (Vocab.state.deck != null || Vocab.state.q)) { Vocab.open(); return true; }
    if (this.view === 'notes' && (NotesView.state.bookId !== '*' || NotesView.state.color !== '*' || NotesView.state.q)) { NotesView.open(); return true; }
    if (this.view !== 'library') { this.show('library'); return true; }
    return false;
  },

  updateBadge() {
    const n = Cards.due().length;
    const b = $('#dueBadge');
    b.textContent = n > 99 ? '99+' : n;
    b.classList.toggle('hidden', !n);
  },

  bookTitle(id) {
    return this.books.find(b => b.id === id)?.title || Cards.all.find(c => c.bookId === id)?.bookTitle || 'Книга удалена';
  },

  /** Книги, у которых есть карточки (включая карточки из резервной копии без файла книги) */
  vocabBooks() {
    const list = this.books.filter(b => Cards.ofBook(b.id).length);
    const known = new Set(this.books.map(b => b.id));
    const orphans = new Map();
    Cards.all.forEach(c => { if (!known.has(c.bookId) && !orphans.has(c.bookId)) orphans.set(c.bookId, { id: c.bookId, title: c.bookTitle || 'Без книги', cover: null }); });
    return [...list.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0)), ...orphans.values()];
  },

  /* ---------- Библиотека ---------- */
  renderLibrary() {
    const grid = $('#bookGrid');
    grid.innerHTML = '';
    if (!this.books.length) {
      grid.append(h('div', { class: 'empty wide' },
        h('div', { class: 'empty-ico' }, '📚'),
        h('p', null, 'Библиотека пуста'),
        h('p', { class: 'muted' }, 'Нажмите «Добавить книгу» или перетащите файлы в окно.')));
      return;
    }
    const sorted = [...this.books].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0) || b.addedAt - a.addedAt);
    for (const b of sorted) {
      const words = Cards.ofBook(b.id).length;
      const hue = [...b.title].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) % 360, 7);
      grid.append(h('div', { class: 'book', title: b.title },
        h('div', { class: 'cover', onclick: () => this.openBook(b.id) },
          b.cover ? h('img', { src: b.cover, alt: '', class: b.format === 'pdf' ? 'pdf-thumb' : null })
            : h('div', { class: 'gen-cover', style: { background: `linear-gradient(160deg, hsl(${hue} 30% 45%), hsl(${(hue + 40) % 360} 28% 30%))` } },
              h('div', { class: 'gc-title' }, b.title), h('div', { class: 'gc-author' }, b.author || '')),
          h('span', { class: 'fmt' }, b.format.toUpperCase())),
        h('div', { class: 'b-info', onclick: () => this.openBook(b.id) },
          h('div', { class: 'b-title' }, b.title),
          h('div', { class: 'b-author muted small' }, b.author || ' ')),
        h('div', { class: 'progress thin' }, h('div', { style: { width: ((b.percent || 0) * 100).toFixed(1) + '%' } })),
        h('div', { class: 'b-meta small muted' },
          h('span', null, b.lastOpened ? Math.round((b.percent || 0) * 100) + '%' : 'новая'),
          words ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); Vocab.open(b.id, '*'); } }, `🗂 ${words}`) : '',
          Notes.ofBook(b.id).length ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); NotesView.open(b.id); } }, `🗒️ ${Notes.ofBook(b.id).length}`) : '',
          h('button', { class: 'icon-btn sm', title: 'Свойства', onclick: () => this.editBook(b) }, '⋯'))));
    }
  },

  async openBook(id) {
    const meta = this.books.find(b => b.id === id);
    if (!meta) return;
    await this.reader.openBook(meta);
  },

  editBook(b) {
    const title = h('input', { class: 'input', value: b.title });
    const author = h('input', { class: 'input', value: b.author || '' });
    const lang = this.langSelect(b.lang || this.settings.srcLang);
    this.modal(h('div', null,
      h('h2', null, 'Книга'),
      h('label', null, 'Название', title),
      h('label', null, 'Автор', author),
      h('label', null, 'Язык книги (для перевода и озвучки)', lang),
      h('p', { class: 'muted small' }, `Файл: ${b.fileName} · ${(b.size / 1048576).toFixed(1)} МБ · ${b.format.toUpperCase()}`),
      h('div', { class: 'row gap' },
        h('button', {
          class: 'btn danger', onclick: async () => {
            const n = Cards.ofBook(b.id).length;
            if (!confirm(`Удалить «${b.title}»${n ? ` и ${n} ${plural(n, 'карточку', 'карточки', 'карточек')}` : ''}?`)) return;
            await DB.deleteBook(b.id);
            this.books = this.books.filter(x => x.id !== b.id);
            Cards.all = Cards.all.filter(c => c.bookId !== b.id);
            Notes.all = Notes.all.filter(n => n.bookId !== b.id);
            this.updateBadge();
            this.closeModal();
            this.renderLibrary();
          },
        }, 'Удалить'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost', onclick: () => this.closeModal() }, 'Отмена'),
        h('button', {
          class: 'btn primary', onclick: async () => {
            b.title = title.value.trim() || b.title;
            b.author = author.value.trim();
            b.lang = lang.value;
            await DB.put('books', b);
            this.closeModal();
            this.renderLibrary();
          },
        }, 'Сохранить'))));
  },

  async importFiles(files) {
    let ok = 0;
    for (const file of files) {
      if (this.books.some(b => b.fileName === file.name && b.size === file.size)) { toast(`«${file.name}» уже в библиотеке`); continue; }
      this.loading(true, `Добавляю «${file.name}»…`);
      try {
        const parsed = await Parsers.parse(file, file.name);
        let cover = null;
        if (parsed.format === 'pdf') cover = await Parsers.pdfCover(parsed.pdf);
        else if (parsed.coverBlob) cover = await makeThumb(parsed.coverBlob);
        const meta = {
          id: uid(), title: parsed.title, author: parsed.author || '',
          lang: (parsed.lang || '').slice(0, 2).toLowerCase(), format: parsed.format,
          fileName: file.name, size: file.size, cover, addedAt: Date.now(), lastOpened: 0, progress: null, percent: 0,
        };
        parsed.dispose?.();
        await DB.put('files', { id: meta.id, blob: file });
        await DB.put('books', meta);
        this.books.push(meta);
        ok++;
      } catch (e) {
        console.error(e);
        toast(`Не удалось добавить «${file.name}»: ${e.message}`, 6000);
      }
    }
    this.loading(false);
    if (ok) { toast(`Добавлено книг: ${ok}`); this.show('library'); }
  },

  /* ---------- Модальное окно, загрузка ---------- */
  modal(content) {
    $('#modalCard').replaceChildren(content);
    $('#modal').classList.remove('hidden');
    content.querySelector('input,select,textarea')?.focus();
  },
  closeModal() { $('#modal').classList.add('hidden'); $('#modalCard').innerHTML = ''; $('#modalCard').className = 'modal-card'; $('#modalCard').removeAttribute('style'); },
  modalOpen() { return !$('#modal').classList.contains('hidden'); },
  loading(on, msg = '') {
    $('#loading').classList.toggle('hidden', !on);
    $('#loadingText').textContent = msg;
  },

  /* ---------- Настройки ---------- */
  setSetting(k, v) {
    this.settings[k] = v;
    try { localStorage.setItem('lexi.settings', JSON.stringify(this.settings)); } catch (e) { /* приватный режим */ }
    this.applySettings();
  },

  applySettings() {
    const s = this.settings;
    const root = document.documentElement;
    root.dataset.theme = s.theme;
    root.style.setProperty('--fs', s.fontSize + 'px');
    root.style.setProperty('--lh', s.lineHeight);
    root.style.setProperty('--w', s.width + 'px');
    root.style.setProperty('--align', s.align);
    root.style.setProperty('--font-reader', (FONTS.find(f => f[0] === s.font) || FONTS[0])[2]);
    $('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
    // Android-приложение: значки статус-бара тёмные на светлых темах и светлые на тёмных
    Platform.plugin?.('SystemBars')?.setStyle({ style: ['dusk', 'night'].includes(s.theme) ? 'DARK' : 'LIGHT' }).catch(() => { });
    $('#eyeWarm').style.opacity = (s.warm / 100).toFixed(2);
    $('#eyeDim').style.opacity = (s.dim / 100 * 0.7).toFixed(2);
    if (this.reader?.open) {
      this.reader.applyHighlights();
      this.reader.onScroll();
    }
  },

  langSelect(value) {
    const sel = h('select', { class: 'input' }, LANGS.map(([c, n]) => h('option', { value: c }, n)));
    sel.value = value;
    return sel;
  },

  openSettings() {
    const s = this.settings;
    const range = (key, min, max, step, fmt) => {
      const out = h('span', { class: 'rv' }, fmt(s[key]));
      return h('label', { class: 'range-row' },
        h('span', { class: 'grow' }, ''),
        h('input', { type: 'range', min, max, step, value: s[key], oninput: (e) => { this.setSetting(key, Number(e.target.value)); out.textContent = fmt(Number(e.target.value)); } }),
        out);
    };
    const field = (label, ctrl) => h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, label), ctrl);
    const check = (key, label) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: s[key], onchange: (e) => this.setSetting(key, e.target.checked) }), label);
    const select = (key, opts) => {
      const sel = h('select', { class: 'input', onchange: (e) => this.setSetting(key, e.target.value) }, opts.map(([v, n]) => h('option', { value: v }, n)));
      sel.value = s[key];
      return sel;
    };

    const themes = h('div', { class: 'themes' }, THEMES.map(([id, name]) =>
      h('button', {
        class: 'theme-sw' + (s.theme === id ? ' active' : ''), 'data-sw': id,
        onclick: (e) => { this.setSetting('theme', id); $$('.theme-sw').forEach(b => b.classList.toggle('active', b === e.currentTarget)); },
      }, h('span', { class: 'sw-aa' }, 'Аа'), h('span', { class: 'sw-name' }, name))));

    const tgt = select('tgtLang', LANGS);
    const src = select('srcLang', LANGS);

    this.modal(h('div', { class: 'settings' },
      h('h2', null, 'Настройки'),
      h('h3', null, 'Оформление'),
      themes,
      field('Шрифт', select('font', FONTS.map(f => [f[0], f[1]]))),
      field('Размер шрифта', range('fontSize', 14, 34, 1, v => v + ' px')),
      field('Межстрочный интервал', range('lineHeight', 1.3, 2.3, 0.05, v => v.toFixed(2))),
      field('Ширина колонки', range('width', 460, 1100, 20, v => v + ' px')),
      field('Выравнивание', select('align', [['left', 'По левому краю'], ['justify', 'По ширине']])),
      h('h3', null, 'Защита глаз'),
      field('Тёплый фильтр (меньше синего света)', range('warm', 0, 70, 1, v => v + '%')),
      field('Затемнение экрана', range('dim', 0, 70, 1, v => v + '%')),
      check('breakReminder', 'Напоминать о перерыве каждые 20 минут (правило 20-20-20)'),
      h('h3', null, 'Перевод и карточки'),
      field('Язык книг по умолчанию', src),
      field('Переводить на', tgt),
      field('Переводчик', select('translator', [
        ['auto', 'Встроенный словарь, если слова нет — онлайн'],
        ['offline', 'Только встроенный словарь (без интернета)'],
        ['online', 'Только онлайн-перевод']])),
      check('autoTranslate', 'Автоматически переводить онлайн, если слова нет в словаре'),
      h('p', { class: 'muted small' }, 'Встроенный словарь: английский → русский, около 58 000 слов и выражений, с транскрипцией и примерами. ' +
        'Источник — Викисловарь (лицензия CC BY-SA 4.0), данные kaikki.org.'),
      check('tapTranslate', 'Переводить слово по одному касанию / щелчку'),
      check('highlightSaved', 'Подчёркивать в тексте уже сохранённые слова'),
      field('Как учить', select('studyMode', [['choice', 'Выбор из 4 вариантов'], ['classic', 'Классические карточки (показать ответ и оценить)']])),
      field('Направление карточек', select('cardDir', [['word', 'Слово → перевод'], ['translation', 'Перевод → слово'], ['mixed', 'Вперемешку']])),
      h('h3', null, 'Чтение вслух'),
      h('p', { class: 'muted small' }, 'В книге нажмите 🎧 — текст будет читаться вслух с подсветкой предложения. В Android-приложении чтение продолжается при выключенном экране.'),
      h('div', { class: 'row gap wrap' }, h('button', { class: 'btn', onclick: () => ReadAloud.openVoiceDialog() },
        s.ttsEngine === 'neural' ? '🎧 Голос: естественный ✨' : '🎧 Голос: системный — выбрать / скачать естественный')),
      h('h3', null, 'Данные'),
      h('p', { class: 'muted small' }, 'Книги и карточки хранятся только в этом браузере. Сделайте резервную копию карточек и заметок, чтобы перенести их на другое устройство.'),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn', onclick: () => this.exportBackup() }, '⭳ Резервная копия карточек и заметок'),
        h('label', { class: 'btn' }, '⭱ Восстановить из копии',
          h('input', { type: 'file', accept: '.json', hidden: true, onchange: (e) => this.importBackup(e.target.files[0]) }))),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => this.closeModal() }, 'Готово'))));
  },

  exportBackup() {
    const data = { app: 'lexireader', version: 1, exportedAt: new Date().toISOString(), cards: Cards.all.map(c => ({ ...c, bookTitle: c.bookTitle || this.bookTitle(c.bookId) })), notes: Notes.all };
    downloadFile(`lexireader-cards-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1), 'application/json');
  },

  async importBackup(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.cards)) throw new Error('нет списка карточек');
      const valid = data.cards.filter(c => c && c.id && c.word && c.bookId);
      await Cards.saveMany(valid);
      const notes = (Array.isArray(data.notes) ? data.notes : []).filter(n => n && n.id && n.quote && n.bookId);
      if (notes.length) await Notes.saveMany(notes);
      toast(`Восстановлено карточек: ${valid.length}, заметок: ${notes.length}`);
      this.closeModal();
      if (this.view === 'vocab') Vocab.render();
      if (this.view === 'notes') NotesView.render();
    } catch (e) {
      toast('Не удалось прочитать файл: ' + e.message, 5000);
    }
  },

  /* ---------- Таймер чтения / перерывы ---------- */
  startReadingTimer() {
    this.stopReadingTimer();
    this.readMinutes = 0;
    this.readTimer = setInterval(() => {
      if (document.hidden) return;
      this.readMinutes++;
      if (this.settings.breakReminder && this.readMinutes % 20 === 0) {
        toast('👀 Вы читаете 20 минут. Посмотрите вдаль (6 м) 20 секунд и поморгайте.', 9000);
      }
    }, 60000);
  },
  stopReadingTimer() { clearInterval(this.readTimer); },
};

document.addEventListener('DOMContentLoaded', () => App.init());
