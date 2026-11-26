/* Чтение вслух: системный голос по умолчанию + «естественный голос» (нейросеть на телефоне, Android).
 * Текст главы режется на предложения; текущее подсвечивается, страница прокручивается сама.
 */
'use strict';

const NEURAL_VOICES = [
  [0, 'Женский 1'], [1, 'Женский 2'], [2, 'Женский 3'], [3, 'Женский 4'], [4, 'Женский 5'],
  [5, 'Мужской 1'], [6, 'Мужской 2'], [7, 'Мужской 3'], [8, 'Мужской 4'], [9, 'Мужской 5'],
];
const NEURAL_LANGS = new Set('en ko ja ar bg cs da de el es et fi fr hi hr hu id it lt lv nl pl pt ro ru sk sl sv tr uk vi'.split(' '));
const SPEECH_RATES = [0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
const LANG_TAGS = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', pt: 'pt-PT', ru: 'ru-RU', nl: 'nl-NL', pl: 'pl-PL', tr: 'tr-TR', uk: 'uk-UA', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN' };

/** Делит текст блока на предложения: [{start, end}] */
function splitSentences(text, maxLen = 240) {
  const ABBR = /(?:^|[\s(«"])(?:mr|mrs|ms|dr|st|prof|sr|jr|vs|etc|mt|no|fig|vol|ch|pp|gen|col|lt|sgt|capt|rev|hon|e\.g|i\.e|т\.е|т\.д|т\.п|др|см|г|гг|ул|им|англ|нем|фр)\.$/i;
  const out = [];
  let s = 0;
  const push = (a, b) => {
    while (a < b && /\s/.test(text[a])) a++;
    let e = b;
    while (e > a && /\s/.test(text[e - 1])) e--;
    if (e > a && /[\p{L}\p{N}]/u.test(text.slice(a, e))) out.push({ start: a, end: e });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!'.!?…'.includes(ch)) continue;
    let j = i + 1;
    while (j < text.length && '.!?…'.includes(text[j])) j++;
    while (j < text.length && '"\'»”’)]'.includes(text[j])) j++;
    if (j < text.length && !/\s/.test(text[j])) { i = j - 1; continue; }
    const before = text.slice(Math.max(s, i - 12), i + 1);
    if (ch === '.' && (ABBR.test(before) || /(?:^|\s)\p{Lu}\.$/u.test(before))) { i = j - 1; continue; } // сокращения и инициалы
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (k < text.length && /[\p{Ll}]/u.test(text[k]) && ch !== '?' && ch !== '!') { i = j - 1; continue; } // «...» внутри фразы
    push(s, j);
    s = j;
    i = j - 1;
  }
  push(s, text.length);
  // слишком длинные предложения режем по запятым/точкам с запятой — так голос начинает быстрее
  const res = [];
  for (const p of out) {
    let a = p.start;
    while (p.end - a > maxLen) {
      const seg = text.slice(a, a + maxLen);
      let cut = Math.max(seg.lastIndexOf('; '), seg.lastIndexOf(', '), seg.lastIndexOf(': '), seg.lastIndexOf(' — '), seg.lastIndexOf(' – '));
      if (cut < maxLen * 0.4) cut = seg.lastIndexOf(' ');
      if (cut <= 0) break;
      res.push({ start: a, end: a + cut + 1 });
      a += cut + 1;
      while (a < p.end && /\s/.test(text[a])) a++;
    }
    res.push({ start: a, end: p.end });
  }
  return res;
}

const ReadAloud = {
  active: false,      // показана панель плеера
  state: 'idle',      // idle | loading | playing | paused
  items: [],          // [{text, range?, page?}]
  index: 0,
  scope: null,        // {kind:'chapter', ci} | {kind:'pdf', from, to}
  engine: 'system',
  token: 0,
  sleepAt: 0,
  userScrollAt: 0,

  get plugin() { return Platform.native ? Platform.plugin('LexiSpeech') : null; },
  get reader() { return App.reader; },
  get lang() { return this.reader?.lang || App.settings.srcLang || 'en'; },
  get wantNeural() { return App.settings.ttsEngine === 'neural' && !!this.plugin && this.modelInstalled && NEURAL_LANGS.has(this.lang); },

  init() {
    $('#rListen').onclick = () => (this.active ? this.toggle() : this.open());
    const sc = $('#rScroll');
    ['touchstart', 'wheel', 'mousedown'].forEach(ev => sc.addEventListener(ev, () => { this.userScrollAt = Date.now(); }, { passive: true }));
    const P = this.plugin;
    if (P) {
      P.addListener('progress', (e) => this.onProgress(e.index));
      P.addListener('state', (e) => this.onState(e.state, e.engine));
      P.addListener('ended', () => this.onEnded());
      P.addListener('error', (e) => {
        if (e.message === 'lang') toast(`В телефоне нет системного голоса для языка «${e.lang}». Установите его в настройках синтеза речи или скачайте естественный голос.`, 6000);
        else toast(e.message, 5000);
      });
      P.addListener('download', (e) => this.onDownload(e));
      this.refreshModel();
    }
    if ('speechSynthesis' in window) speechSynthesis.getVoices();
  },

  async refreshModel() {
    try { this.model = await this.plugin.modelStatus(); this.modelInstalled = !!this.model.installed; }
    catch (e) { this.model = null; this.modelInstalled = false; }
    return this.model;
  },

  /* ---------- Сбор предложений ---------- */

  /** Предложения текущей главы (обычная книга) */
  collectChapter() {
    const root = this.reader.content;
    const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dd,dt,td,th,figcaption,div,section,article,aside,tr,table,ul,ol,dl,body';
    const blocks = new Map();
    const order = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('.chapter-end,script,style,rt,sup a[data-link],a[data-link] sup') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = w.nextNode())) {
      const b = n.parentElement.closest(BLOCK) || root;
      if (!blocks.has(b)) { blocks.set(b, { nodes: [], text: '' }); order.push(b); }
      const g = blocks.get(b);
      g.nodes.push({ node: n, start: g.text.length });
      g.text += n.nodeValue;
    }
    const items = [];
    for (const b of order) {
      const g = blocks.get(b);
      const locate = (pos, end) => {
        let lo = 0, hi = g.nodes.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (g.nodes[mid].start < pos + (end ? 0 : 1)) lo = mid; else hi = mid - 1; }
        const x = g.nodes[lo];
        return [x.node, Math.max(0, Math.min(pos - x.start, x.node.nodeValue.length))];
      };
      for (const s of splitSentences(g.text)) {
        const r = document.createRange();
        try { r.setStart(...locate(s.start, false)); r.setEnd(...locate(s.end, true)); } catch (e) { continue; }
        items.push({ text: g.text.slice(s.start, s.end).replace(/\s+/g, ' ').trim(), range: r });
      }
    }
    return items;
  },

  /** Предложения нескольких страниц PDF (текст берём прямо из файла) */
  async collectPdf(from, count = 3) {
    const pdf = this.reader.parsed.pdf;
    const to = Math.min(pdf.numPages, from + count - 1);
    const items = [];
    for (let p = from; p <= to; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      let text = '';
      for (const it of tc.items) { text += it.str; if (it.hasEOL) text += ' '; }
      text = text.replace(/(\p{L})-\s+(\p{Ll})/gu, '$1$2'); // перенос слов
      for (const s of splitSentences(text)) items.push({ text: text.slice(s.start, s.end).replace(/\s+/g, ' ').trim(), page: p });
    }
    return { items, to };
  },

  /** Первое предложение, видимое на экране */
  firstVisible() {
    const top = $('#rScroll').getBoundingClientRect().top + 8;
    for (let i = 0; i < this.items.length; i++) {
      const r = this.items[i].range?.getBoundingClientRect();
      if (r && r.height && r.bottom > top) return i;
    }
    return 0;
  },

  /* ---------- Управление ---------- */

  async open(startRange) {
    if (!this.reader.open) return;
    this.active = true;
    $('#reader').classList.add('listening');
    this.renderBar();
    if (this.plugin && !this.model) await this.refreshModel();
    await this.loadScope(startRange);
    this.play();
  },

  async loadScope(startRange, pdfFrom) {
    const R = this.reader;
    if (R.isPdf) {
      const from = pdfFrom || R.currentPdfPage();
      const { items, to } = await this.collectPdf(from);
      this.items = items;
      this.scope = { kind: 'pdf', from, to };
      this.index = 0;
    } else {
      this.items = this.collectChapter();
      this.scope = { kind: 'chapter', ci: R.ci };
      this.index = startRange
        ? Math.max(0, this.items.findIndex(it => it.range.compareBoundaryPoints(Range.START_TO_START, startRange) <= 0 && it.range.compareBoundaryPoints(Range.START_TO_END, startRange) >= 0))
        : this.firstVisible();
    }
  },

  /** Сменилась глава вручную (оглавление, кнопки) — останавливаемся и читаем заново с нового места */
  onChapterOpened() {
    if (!this.active || this.navigating) return;
    const playing = this.state === 'playing' || this.state === 'loading';
    this.stopEngine();
    this.items = [];
    this.scope = null;
    this.highlight(null);
    if (playing) setTimeout(() => this.restartHere(), 50); else this.setState('paused');
  },

  async restartHere(startRange) {
    this.stopEngine();
    await this.loadScope(startRange);
    this.play();
  },

  play() {
    if (!this.items.length) {
      if (this.scope?.kind === 'chapter' || this.scope?.kind === 'pdf') return this.onEnded();
      return toast('Здесь нечего читать');
    }
    const tok = ++this.token;
    this.engine = this.wantNeural ? 'neural' : 'system';
    const R = this.reader;
    const subtitle = R.chapterTitle?.() || '';
    if (this.plugin) {
      this.setState('loading');
      this.plugin.play({
        items: this.items.map(x => x.text), start: this.index, lang: this.lang,
        rate: App.settings.ttsRate, engine: this.engine, voice: App.settings.ttsVoice,
        title: R.meta?.title || 'LexiReader', subtitle,
      }).catch(e => toast('Чтение вслух недоступно: ' + (e?.message || e)));
    } else if ('speechSynthesis' in window) {
      this.webSpeak(this.index, tok);
    } else {
      toast('Этот браузер не умеет читать вслух');
      return this.close();
    }
    this.onProgress(this.index);
  },

  toggle() {
    if (this.state === 'playing' || this.state === 'loading') this.pause();
    else if (this.state === 'paused' && this.items.length) this.resume();
    else this.restartHere();
  },

  pause() {
    if (this.plugin) this.plugin.pause();
    else { this.token++; speechSynthesis.cancel(); }
    this.setState('paused');
  },

  resume() {
    if (this.plugin) {
      // остановили из уведомления — очереди в телефоне уже нет, запускаем заново с того же места
      if (this.nativeState === 'paused') { this.plugin.resume(); this.setState('playing'); } else this.play();
    }
    else { this.webSpeak(this.index, ++this.token); }
  },

  skip(d) {
    if (!this.items.length) return;
    const i = Math.max(0, Math.min(this.items.length - 1, this.index + d));
    this.index = i;
    this.userScrollAt = 0;
    if (this.plugin) this.plugin.seek({ index: i });
    else if (this.state === 'playing') this.webSpeak(i, ++this.token);
    this.onProgress(i);
  },

  stopEngine() {
    this.token++;
    if (this.plugin) this.plugin.stop().catch(() => { });
    else if ('speechSynthesis' in window) speechSynthesis.cancel();
  },

  close() {
    if (!this.active) return;
    this.stopEngine();
    this.active = false;
    this.items = [];
    this.scope = null;
    this.sleepAt = 0;
    clearTimeout(this.sleepTimer);
    this.highlight(null);
    this.setState('idle');
    $('#reader').classList.remove('listening');
    $('#ttsBar')?.remove();
    $('#rListen').classList.remove('active');
  },

  setRate(r) {
    App.setSetting('ttsRate', r);
    if (this.plugin) this.plugin.setRate({ rate: r });
    else if (this.state === 'playing') this.webSpeak(this.index, ++this.token);
    this.renderBar();
  },

  cycleSleep() {
    const opts = [0, 15, 30, 60];
    const cur = this.sleepAt ? Math.round((this.sleepAt - Date.now()) / 60000) : 0;
    const next = opts[(opts.findIndex(m => m >= cur && m > 0) + 1) % opts.length] || 0;
    clearTimeout(this.sleepTimer);
    this.sleepAt = next ? Date.now() + next * 60000 : 0;
    if (next) {
      this.sleepTimer = setTimeout(() => { this.sleepAt = 0; if (this.state === 'playing') this.pause(); this.renderBar(); }, next * 60000);
      toast(`Остановлю чтение через ${next} мин`);
    } else toast('Таймер сна выключен');
    this.renderBar();
  },

  /* ---------- Веб-версия (iPhone, браузер): Web Speech API ---------- */
  webVoice() {
    const voices = speechSynthesis.getVoices();
    const tag = (LANG_TAGS[this.lang] || this.lang).toLowerCase();
    const mine = voices.filter(v => v.lang.toLowerCase().replace('_', '-').startsWith(this.lang));
    const chosen = App.settings.ttsWebVoice && mine.find(v => v.voiceURI === App.settings.ttsWebVoice);
    if (chosen) return chosen;
    const score = (v) => (/premium|enhanced|natural|neural|online/i.test(v.name) ? 4 : 0) + (/google|siri|samantha|daniel|karen/i.test(v.name) ? 2 : 0) +
      (v.lang.toLowerCase().replace('_', '-') === tag ? 1 : 0) + (v.localService ? 0.5 : 0);
    return mine.sort((a, b) => score(b) - score(a))[0] || null;
  },

  webSpeak(i, tok) {
    speechSynthesis.cancel();
    if (i >= this.items.length) return this.onEnded();
    const u = new SpeechSynthesisUtterance(this.items[i].text);
    u.lang = LANG_TAGS[this.lang] || this.lang;
    u.rate = App.settings.ttsRate;
    const v = this.webVoice();
    if (v) u.voice = v;
    u.onstart = () => { if (tok === this.token) { this.setState('playing'); this.onProgress(i); } };
    u.onend = () => { if (tok === this.token) { this.index = i + 1; this.webSpeak(i + 1, tok); } };
    u.onerror = (e) => {
      if (tok !== this.token || e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('speech', e.error);
      this.index = i + 1;
      setTimeout(() => tok === this.token && this.webSpeak(i + 1, tok), 200);
    };
    this.index = i;
    this.setState('loading');
    // Safari иногда «засыпает» — маленькая задержка после cancel помогает
    setTimeout(() => { if (tok === this.token) speechSynthesis.speak(u); }, 60);
  },

  /* ---------- События ---------- */

  onState(state, engine) {
    if (engine) this.engine = engine;
    this.nativeState = state;
    if (state === 'idle' && this.active) {
      if (this.navigating || !this.items.length) return; // конец главы — обработает onEnded
      return this.setState('paused'); // «Стоп» в уведомлении: плеер остаётся, можно продолжить
    }
    this.setState(state);
  },

  setState(s) {
    this.state = s;
    this.renderBar();
  },

  onProgress(i) {
    if (!this.active || i == null || !this.items[i]) return;
    this.index = i;
    const it = this.items[i];
    const R = this.reader;
    if (it.page) {
      const pageEl = R.pageEls?.[it.page - 1];
      const sc = $('#rScroll').getBoundingClientRect();
      const pr = pageEl?.getBoundingClientRect();
      if (pr && (pr.bottom < sc.top + 60 || pr.top > sc.bottom - 60) && Date.now() - this.userScrollAt > 5000) R.goPage(it.page);
      const tl = pageEl?.querySelector('.textLayer');
      const r = tl && findTextRanges(tl, it.text.split(' ').slice(0, 12).join(' '), 1)[0];
      this.highlight(r || null);
      if (!r) setTimeout(() => { if (this.index === i) { const t2 = pageEl?.querySelector('.textLayer'); const r2 = t2 && findTextRanges(t2, it.text.split(' ').slice(0, 12).join(' '), 1)[0]; if (r2) this.highlight(r2); } }, 900);
    } else {
      this.highlight(it.range);
      this.scrollTo(it.range);
    }
    this.renderBar();
  },

  highlight(range) {
    if (!(window.CSS && CSS.highlights && window.Highlight)) return;
    if (range) CSS.highlights.set('tts-current', new Highlight(range)); else CSS.highlights.delete('tts-current');
  },

  scrollTo(range) {
    if (Date.now() - this.userScrollAt < 5000) return; // человек сам листает — не мешаем
    const sc = $('#rScroll');
    const box = sc.getBoundingClientRect();
    const r = range.getBoundingClientRect();
    if (!r.height) return;
    const bar = $('#ttsBar')?.offsetHeight || 0;
    if (r.top < box.top + 40 || r.bottom > box.bottom - bar - 60) {
      sc.scrollTo({ top: sc.scrollTop + r.top - box.top - box.height * 0.28, behavior: document.hidden ? 'auto' : 'smooth' });
    }
  },

  async onEnded() {
    if (!this.active) return;
    const R = this.reader;
    this.navigating = true;
    try {
      if (this.scope?.kind === 'pdf') {
        if (this.scope.to >= R.parsed.numPages) return this.finishBook();
        await this.loadScope(null, this.scope.to + 1);
        this.play();
      } else {
        if (R.ci >= R.parsed.chapters.length - 1) return this.finishBook();
        await R.openChapter(R.ci + 1);
        this.items = this.collectChapter();
        this.scope = { kind: 'chapter', ci: R.ci };
        this.index = 0;
        this.play();
      }
    } finally {
      this.navigating = false;
    }
  },

  finishBook() {
    this.highlight(null);
    this.items = [];
    this.setState('idle');
    toast('Книга прочитана до конца 🎉');
  },

  /* ---------- Панель плеера ---------- */

  renderBar() {
    if (!this.active) return;
    let bar = $('#ttsBar');
    if (!bar) {
      // кнопки создаём один раз, дальше только обновляем — иначе нажатие может попасть в уже удалённую кнопку
      const b = (cls, title, onclick, text) => h('button', { class: cls, title, onclick }, text);
      this.ui = {
        prev: b('icon-btn', 'Предыдущее предложение', () => this.skip(-1), '⏮'),
        play: b('icon-btn tts-play', 'Слушать', () => this.toggle(), '▶'),
        next: b('icon-btn', 'Следующее предложение', () => this.skip(1), '⏭'),
        rate: b('btn sm ghost tts-chip', 'Скорость', () => { const r = App.settings.ttsRate; const i = SPEECH_RATES.indexOf(r); this.setRate(SPEECH_RATES[(i + 1) % SPEECH_RATES.length]); }, ''),
        voice: b('btn sm ghost tts-chip', 'Голос', () => this.openVoiceDialog(), ''),
        sleep: b('btn sm ghost tts-chip', 'Таймер сна', () => this.cycleSleep(), '⏲'),
        status: h('span', { class: 'tts-status muted small grow' }),
        close: b('icon-btn', 'Закрыть плеер', () => this.close(), '✕'),
      };
      bar = h('div', { id: 'ttsBar', class: 'tts-bar' }, Object.values(this.ui));
      $('#reader').insertBefore(bar, $('#reader .reader-foot'));
    }
    const u = this.ui;
    const playing = this.state === 'playing' || this.state === 'loading';
    const rate = App.settings.ttsRate;
    const neural = this.plugin && (this.engine === 'neural' && this.state !== 'idle' ? true : this.wantNeural);
    const sleepMin = this.sleepAt ? Math.max(1, Math.round((this.sleepAt - Date.now()) / 60000)) : 0;
    let status = '';
    if (this.state === 'loading') status = neural ? 'Готовлю естественный голос…' : 'Загрузка…';
    else if (this.items.length) status = `${this.index + 1} / ${this.items.length}`;
    u.play.textContent = playing ? '⏸' : '▶';
    u.play.title = playing ? 'Пауза' : 'Слушать';
    u.play.classList.toggle('busy', this.state === 'loading');
    u.rate.textContent = (rate % 1 ? String(rate) : rate) + '×';
    u.voice.textContent = neural ? '✨ Естеств.' : '🗣 Систем.';
    u.sleep.textContent = sleepMin ? `⏲ ${sleepMin}′` : '⏲';
    u.sleep.classList.toggle('on', !!sleepMin);
    u.status.textContent = status;
    $('#rListen').classList.add('active');
  },

  /* ---------- Выбор голоса и скачивание естественного голоса ---------- */

  async openVoiceDialog() {
    const s = App.settings;
    if (this.plugin) await this.refreshModel();
    const root = h('div', { class: 'settings voice-dialog' });
    const draw = () => {
      const m = this.model;
      const langOk = NEURAL_LANGS.has(this.lang);
      const opt = (id, title, desc, extra, disabled) => h('label', { class: 'voice-opt' + (s.ttsEngine === id ? ' active' : '') + (disabled ? ' disabled' : '') },
        h('input', {
          type: 'radio', name: 'ttsEngine', checked: s.ttsEngine === id, disabled,
          onchange: () => { App.setSetting('ttsEngine', id); this.applyEngineChange(); draw(); },
        }),
        h('div', { class: 'grow' }, h('b', null, title), h('div', { class: 'muted small' }, desc), extra));

      // системный голос
      let sysExtra = null;
      if (!this.plugin && 'speechSynthesis' in window) {
        const voices = speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith(this.lang));
        if (voices.length) {
          const sel = h('select', { class: 'input', onchange: (e) => { App.setSetting('ttsWebVoice', e.target.value); this.applyEngineChange(); } },
            h('option', { value: '' }, 'Лучший доступный'), voices.map(v => h('option', { value: v.voiceURI }, `${v.name}${v.localService ? '' : ' (онлайн)'}`)));
          sel.value = s.ttsWebVoice || '';
          sysExtra = h('div', { class: 'row gap wrap mt' }, sel, h('button', { class: 'btn sm', onclick: () => speak('This is how I sound when reading your book.', this.lang) }, '▶ Проба'));
        }
      }
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const tip = this.plugin
        ? 'Качество зависит от телефона. Улучшить: Настройки → Специальные возможности → Синтез речи (или «Преобразование текста в речь») → выберите «Синтезатор речи Google» и скачайте голос нужного языка.'
        : isIOS
          ? 'Лучший голос на iPhone: Настройки → Универсальный доступ → Устный контент → Голоса → English → скачайте голос с пометкой «улучшенный» или «высокое качество» (например, Ava, Zoe, Evan).'
          : 'Используются голоса браузера и системы.';

      // естественный голос
      let neuExtra;
      if (!this.plugin) {
        neuExtra = h('div', { class: 'muted small mt' }, 'Доступен в Android-приложении LexiReader. В версии для iPhone пока работает только системный голос.');
      } else if (!m) {
        neuExtra = h('div', { class: 'muted small mt' }, 'Не удалось проверить состояние голоса.');
      } else if (m.installed) {
        const vs = h('select', { class: 'input', onchange: (e) => { App.setSetting('ttsVoice', Number(e.target.value)); this.plugin.setVoice({ voice: Number(e.target.value) }); } },
          NEURAL_VOICES.map(([id, n]) => h('option', { value: id }, n)));
        vs.value = s.ttsVoice;
        neuExtra = h('div', null,
          h('div', { class: 'row gap wrap mt' }, vs,
            h('button', {
              class: 'btn sm', onclick: async () => {
                App.setSetting('ttsEngine', 'neural'); draw();
                if (!this.active) return toast('Откройте книгу и нажмите 🎧, чтобы послушать');
                this.restartHere();
              },
            }, '▶ Слушать'),
            h('button', {
              class: 'btn sm ghost', onclick: async () => {
                if (!confirm('Удалить естественный голос с телефона? Освободится около 145 МБ.')) return;
                await this.plugin.deleteModel();
                if (s.ttsEngine === 'neural') App.setSetting('ttsEngine', 'system');
                await this.refreshModel(); draw();
              },
            }, '🗑 Удалить')),
          !langOk && h('div', { class: 'warn small mt' }, `Язык этой книги («${this.lang}») естественный голос не знает — будет системный.`));
      } else {
        const pct = m.total ? Math.round(m.loaded / m.total * 100) : 0;
        neuExtra = m.downloading
          ? h('div', { class: 'mt' },
            h('div', { class: 'progress' }, h('div', { id: 'voiceDlBar', style: { width: pct + '%' } })),
            h('div', { class: 'row gap mt' }, h('span', { id: 'voiceDlText', class: 'muted small grow' }, `Скачано ${fmtMB(m.loaded)} из ${fmtMB(m.total)} МБ`),
              h('button', { class: 'btn sm ghost', onclick: () => this.plugin.cancelDownload() }, 'Отменить')))
          : h('div', { class: 'mt' },
            h('button', {
              class: 'btn primary', onclick: async () => {
                await this.plugin.downloadModel();
                this.model = { ...m, downloading: true };
                draw();
              },
            }, m.loaded > 0 ? `⭳ Продолжить скачивание (${fmtMB(m.total - m.loaded)} МБ)` : `⭳ Скачать естественный голос (${fmtMB(m.total)} МБ)`),
            h('div', { class: 'muted small mt' }, 'Скачивается один раз (лучше по Wi-Fi), потом работает без интернета. 10 голосов, 31 язык: английский, немецкий, французский, испанский, итальянский, русский и др.'));
      }
      root.innerHTML = '';
      root.append(
        h('h2', null, '🎧 Голос для чтения вслух'),
        opt('system', 'Системный голос', 'Работает сразу, без скачивания. ' + tip, sysExtra),
        opt('neural', '✨ Естественный голос', 'Нейросеть прямо на телефоне — звучит почти как живой диктор.', neuExtra, !this.plugin || !m?.installed),
        h('p', { class: 'muted small' }, 'Естественный голос — модель Supertonic 3 (Supertone, лицензия OpenRAIL-M), движок sherpa-onnx (Apache 2.0).'),
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => App.closeModal() }, 'Готово')));
    };
    this.voiceDialogDraw = draw;
    draw();
    App.modal(root);
  },

  /** Сменили голос во время чтения — продолжаем с того же предложения */
  applyEngineChange() {
    if (!this.active || !this.items.length) return this.renderBar();
    if (this.state === 'playing' || this.state === 'loading') { this.stopEngine(); this.play(); }
    else this.renderBar();
  },

  onDownload(e) {
    const m = this.model || {};
    if (e.error) {
      this.model = { ...m, downloading: false };
      if (e.error !== 'cancelled') toast('Не удалось скачать голос: ' + e.error + '. Проверьте интернет и нажмите «Продолжить».', 6000);
      this.refreshModel().then(() => this.voiceDialogDraw?.());
      return;
    }
    if (e.done) {
      toast('Естественный голос установлен ✨');
      App.setSetting('ttsEngine', 'neural');
      this.refreshModel().then(() => { this.voiceDialogDraw?.(); this.applyEngineChange(); });
      return;
    }
    this.model = { ...m, downloading: true, loaded: e.loaded, total: e.total };
    const bar = $('#voiceDlBar'), txt = $('#voiceDlText');
    if (bar) bar.style.width = Math.round(e.loaded / e.total * 100) + '%';
    if (txt) txt.textContent = `Скачано ${fmtMB(e.loaded)} из ${fmtMB(e.total)} МБ`;
  },
};

function fmtMB(b) { return Math.round((b || 0) / 1048576); }
