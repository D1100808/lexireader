/* Карточки: интервальные повторения (SM-2), перевод, словари и режим повторения */
'use strict';

/* ---------- Интервальные повторения ---------- */
const SRS = (() => {
  const MIN = 60000, DAY = 86400000;
  function next(card, rating) { // 0 — снова, 1 — трудно, 2 — хорошо, 3 — легко
    const c = { ...card };
    c.ease = c.ease || 2.5;
    c.interval = c.interval || 0;
    let delay;
    if (!c.reps) {
      if (rating === 0) delay = MIN;
      else if (rating === 1) delay = 6 * MIN;
      else if (rating === 2) { c.reps = 1; c.interval = 1; delay = DAY; }
      else { c.reps = 1; c.interval = 4; c.ease = Math.min(3.2, c.ease + 0.15); delay = 4 * DAY; }
    } else if (rating === 0) {
      c.lapses = (c.lapses || 0) + 1; c.reps = 0; c.interval = 0;
      c.ease = Math.max(1.3, c.ease - 0.2); delay = 10 * MIN;
    } else {
      if (rating === 1) { c.interval = Math.max(1, c.interval * 1.2); c.ease = Math.max(1.3, c.ease - 0.15); }
      else if (rating === 2) c.interval = Math.max(c.interval + 1, c.interval * c.ease);
      else { c.interval = Math.max(c.interval + 2, c.interval * c.ease * 1.3); c.ease = Math.min(3.5, c.ease + 0.15); }
      c.reps++;
      delay = Math.round(c.interval) * DAY;
    }
    c.due = Date.now() + delay;
    c.lastReview = Date.now();
    return c;
  }
  return { next, preview: (card, r) => fmtInterval(next(card, r).due - Date.now()) };
})();

/* ---------- Перевод и словарь ---------- */
const Translator = (() => {
  const cache = new Map();
  const ta = document.createElement('textarea');
  const decode = (s) => { ta.innerHTML = s; return ta.value; };

  async function translate(text, from, to) {
    const key = `${from}|${to}|${text.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key);
    if (from === to) return { main: text, alts: [] };
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Сервис перевода недоступен');
    const j = await r.json();
    if (j.responseStatus && Number(j.responseStatus) !== 200) throw new Error(j.responseDetails || 'Ошибка перевода');
    const main = decode(j.responseData?.translatedText || '').trim();
    const alts = [...new Set((j.matches || [])
      .filter(m => m.translation && Number(m.quality || 0) >= 50)
      .map(m => decode(m.translation).trim()))]
      .filter(t => t && t.toLowerCase() !== main.toLowerCase() && t.length < 60 && t.toLowerCase() !== text.toLowerCase())
      .slice(0, 4);
    const res = { main, alts };
    cache.set(key, res);
    return res;
  }

  async function define(word, lang) {
    if (lang !== 'en' || /\s/.test(word)) return null;
    try {
      const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word.toLowerCase()));
      if (!r.ok) return null;
      const j = await r.json();
      const e = j[0];
      return {
        phonetic: e.phonetic || e.phonetics?.find(p => p.text)?.text || '',
        meanings: (e.meanings || []).slice(0, 3).map(m => ({ pos: m.partOfSpeech, def: m.definitions?.[0]?.definition || '' })),
      };
    } catch (e) { return null; }
  }

  return { translate, define };
})();

/* ---------- Данные карточек (кэш в памяти + IndexedDB) ---------- */
const Cards = {
  all: [],
  async load() { this.all = await DB.all('cards'); },
  ofBook(bookId) { return this.all.filter(c => c.bookId === bookId); },
  find(bookId, word) {
    const w = word.toLowerCase();
    return this.all.filter(c => c.bookId === bookId && c.word.toLowerCase() === w);
  },
  /** Словари книги: [{name, cards}] в порядке глав */
  decks(bookId) {
    const m = new Map();
    for (const c of this.ofBook(bookId)) {
      if (!m.has(c.deck)) m.set(c.deck, []);
      m.get(c.deck).push(c);
    }
    return [...m.entries()]
      .map(([name, cards]) => ({ name, cards, order: Math.min(...cards.map(c => c.chapterIndex ?? 9999)) }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  },
  due(list = this.all) { const now = Date.now(); return list.filter(c => c.due <= now); },
  async save(card) {
    await DB.put('cards', card);
    const i = this.all.findIndex(c => c.id === card.id);
    if (i >= 0) this.all[i] = card; else this.all.push(card);
    App.updateBadge();
  },
  async remove(id) {
    await DB.del('cards', id);
    this.all = this.all.filter(c => c.id !== id);
    App.updateBadge();
  },
  async saveMany(list) {
    await DB.putMany('cards', list);
    for (const c of list) {
      const i = this.all.findIndex(x => x.id === c.id);
      if (i >= 0) this.all[i] = c; else this.all.push(c);
    }
    App.updateBadge();
  },
  create(data) {
    return Object.assign({
      id: uid(), note: '', createdAt: Date.now(), due: Date.now(), interval: 0, ease: 2.5, reps: 0, lapses: 0,
    }, data);
  },
  toCSV(list) {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['Слово', 'Перевод', 'Контекст', 'Заметка', 'Словарь (глава)', 'Книга'].map(q).join(';')];
    for (const c of list) rows.push([c.word, c.translation, c.context, c.note, c.deck, App.bookTitle(c.bookId)].map(q).join(';'));
    return '﻿' + rows.join('\r\n');
  },
};

/** Контекст с выделенным словом (или пропуском) — безопасный HTML */
function ctxHtml(context, words, blank) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!context) return '';
  const alt = [].concat(words).filter(Boolean).sort((a, b) => b.length - a.length)
    .map(w => escapeRe(esc(w)).replace(/\s+/g, '\\s+')).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'giu');
  return esc(context).replace(re, (m) => blank ? '<span class="blank">_____</span>' : `<mark>${m}</mark>`);
}

/* ---------- Экран «Словари» ---------- */
const Vocab = {
  state: { bookId: null, deck: null, q: '' },

  open(bookId = null, deck = null) {
    this.state = { bookId, deck, q: '' };
    App.show('vocab');
  },

  render() {
    const root = $('#vocabRoot');
    root.innerHTML = '';
    const { bookId, deck, q } = this.state;
    const search = h('input', {
      class: 'input search', type: 'search', placeholder: 'Поиск по всем словам…', value: q,
      oninput: debounce((e) => { this.state.q = e.target.value; this.render(); $('#vocabRoot .search')?.focus(); }, 250),
    });
    root.append(h('div', { class: 'view-head' },
      h('h1', null, 'Словари'),
      h('div', { class: 'row gap' }, search,
        h('button', { class: 'btn', onclick: () => downloadFile('lexi-all-words.csv', Cards.toCSV(Cards.all), 'text/csv') }, '⭳ Экспорт CSV'))));

    if (!Cards.all.length) {
      root.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-ico' }, '🗂'),
        h('p', null, 'Пока нет сохранённых слов.'),
        h('p', { class: 'muted' }, 'Откройте книгу, выделите незнакомое слово и нажмите «Сохранить» — оно попадёт в словарь текущей главы.')));
      return;
    }

    if (q.trim()) {
      const t = q.trim().toLowerCase();
      const found = Cards.all.filter(c => c.word.toLowerCase().includes(t) || (c.translation || '').toLowerCase().includes(t));
      root.append(h('p', { class: 'muted' }, `Найдено: ${found.length}`), this.cardList(found, true));
      return;
    }

    if (bookId && deck != null) {
      const cards = Cards.ofBook(bookId).filter(c => deck === '*' || c.deck === deck);
      const due = Cards.due(cards).length;
      root.append(
        h('div', { class: 'crumbs' },
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.open(); } }, '← Все словари'),
          ' / ', App.bookTitle(bookId), ' / ', h('b', null, deck === '*' ? 'Все слова книги' : deck)),
        h('div', { class: 'row gap wrap deck-actions' },
          h('button', { class: 'btn primary', disabled: !due, onclick: () => Review.start(cards, { title: deck === '*' ? App.bookTitle(bookId) : deck }) }, `Повторить (${due})`),
          h('button', { class: 'btn', onclick: () => Review.start(cards, { cram: true, title: deck === '*' ? App.bookTitle(bookId) : deck }) }, 'Учить все подряд'),
          h('button', { class: 'btn', onclick: () => downloadFile(`${App.bookTitle(bookId)} - ${deck === '*' ? 'все' : deck}.csv`.replace(/[\\/:*?"<>|]/g, '_'), Cards.toCSV(cards), 'text/csv') }, '⭳ CSV'),
          deck !== '*' && h('button', { class: 'btn ghost', onclick: () => this.renameDeck(bookId, deck) }, '✎ Переименовать')),
        this.cardList(cards, false));
      return;
    }

    for (const b of App.vocabBooks()) root.append(this.bookBlock(b));
  },

  bookBlock(b, compact) {
    const cards = Cards.ofBook(b.id);
    const due = Cards.due(cards).length;
    const decks = Cards.decks(b.id);
    return h('div', { class: 'vbook' },
      h('div', { class: 'vbook-head' },
        b.cover ? h('img', { class: 'vbook-cover', src: b.cover, alt: '' }) : h('div', { class: 'vbook-cover ph' }, '📘'),
        h('div', { class: 'grow' },
          h('div', { class: 'vbook-title' }, b.title),
          h('div', { class: 'muted small' }, `${cards.length} ${plural(cards.length, 'слово', 'слова', 'слов')} · ${decks.length} ${plural(decks.length, 'словарь', 'словаря', 'словарей')} · `,
            h('span', { class: due ? 'due' : '' }, `${due} к повторению`))),
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn primary sm', disabled: !due, onclick: () => Review.start(cards, { title: b.title }) }, 'Повторить'),
          !compact && h('button', { class: 'btn sm', onclick: () => this.open(b.id, '*') }, 'Все слова'))),
      h('div', { class: 'decks' }, decks.map(d => {
        const dd = Cards.due(d.cards).length;
        return h('div', { class: 'deck', onclick: () => this.open(b.id, d.name) },
          h('span', { class: 'deck-ico' }, '📁'),
          h('span', { class: 'deck-name' }, d.name),
          h('span', { class: 'muted small' }, `${d.cards.length}`),
          dd ? h('span', { class: 'pill' }, `${dd} к повт.`) : h('span', { class: 'pill ok' }, '✓'),
          h('button', { class: 'btn sm ghost', title: 'Повторить', onclick: (e) => { e.stopPropagation(); Review.start(d.cards, { title: d.name, cram: !dd }); } }, dd ? '▶' : '↻'));
      })));
  },

  cardList(cards, showDeck) {
    if (!cards.length) return h('p', { class: 'muted' }, 'Слов нет.');
    const sorted = [...cards].sort((a, b) => b.createdAt - a.createdAt);
    return h('div', { class: 'card-list' }, sorted.map(c => h('div', { class: 'card-row' },
      h('div', { class: 'cr-main' },
        h('div', { class: 'cr-word' }, c.word,
          h('button', { class: 'icon-btn sm', title: 'Произнести', onclick: () => speak(c.word, c.lang) }, '🔊')),
        h('div', { class: 'cr-tr' }, c.translation || h('span', { class: 'muted' }, 'без перевода')),
        c.context && h('div', { class: 'cr-ctx', html: ctxHtml(c.context, [c.word, c.form]) }),
        c.note && h('div', { class: 'cr-note' }, '📝 ' + c.note)),
      h('div', { class: 'cr-side' },
        showDeck && h('div', { class: 'muted small' }, App.bookTitle(c.bookId) + ' · ' + c.deck),
        h('div', { class: 'muted small' }, 'Повтор: ' + fmtDue(c.due)),
        h('div', { class: 'row gap' },
          h('button', { class: 'icon-btn sm', title: 'Изменить', onclick: () => this.editCard(c) }, '✎'),
          h('button', {
            class: 'icon-btn sm', title: 'Удалить', onclick: async () => {
              if (!confirm(`Удалить «${c.word}»?`)) return;
              await Cards.remove(c.id); this.render();
            },
          }, '🗑'))))));
  },

  editCard(c, onDone) {
    const decks = Cards.decks(c.bookId).map(d => d.name);
    const f = {
      word: h('input', { class: 'input', value: c.word }),
      translation: h('input', { class: 'input', value: c.translation || '' }),
      deck: h('input', { class: 'input', value: c.deck, list: 'deckList' }),
      context: h('textarea', { class: 'input', rows: 3 }, c.context || ''),
      note: h('textarea', { class: 'input', rows: 2, placeholder: 'Ассоциация, пример, грамматика…' }, c.note || ''),
    };
    App.modal(h('div', null,
      h('h2', null, 'Карточка'),
      h('label', null, 'Слово', f.word),
      h('label', null, 'Перевод', f.translation),
      h('label', null, 'Словарь (глава)', f.deck, h('datalist', { id: 'deckList' }, decks.map(d => h('option', { value: d })))),
      h('label', null, 'Контекст', f.context),
      h('label', null, 'Заметка', f.note),
      h('div', { class: 'row gap end' },
        h('button', { class: 'btn ghost', onclick: () => App.closeModal() }, 'Отмена'),
        h('button', {
          class: 'btn primary', onclick: async () => {
            const upd = { ...c, word: f.word.value.trim() || c.word, translation: f.translation.value.trim(), deck: f.deck.value.trim() || c.deck, context: f.context.value.trim(), note: f.note.value.trim() };
            await Cards.save(upd);
            App.closeModal();
            toast('Сохранено');
            onDone ? onDone(upd) : this.render();
          },
        }, 'Сохранить'))));
  },

  async renameDeck(bookId, deck) {
    const name = prompt('Новое название словаря:', deck);
    if (!name || !name.trim() || name.trim() === deck) return;
    const list = Cards.ofBook(bookId).filter(c => c.deck === deck).map(c => ({ ...c, deck: name.trim() }));
    await Cards.saveMany(list);
    this.state.deck = name.trim();
    this.render();
  },
};

/* ---------- Экран «Повторение» ---------- */
const Review = {
  session: null,

  start(cards, { cram = false, title = 'Все слова', returnBook = null } = {}) {
    const now = Date.now();
    let queue = cram ? [...cards].sort(() => Math.random() - 0.5) : cards.filter(c => c.due <= now).sort((a, b) => a.due - b.due);
    if (!queue.length) {
      if (!cards.length) return toast('В словаре пока нет слов');
      toast('Всё повторено! Запускаю свободную тренировку');
      queue = [...cards].sort(() => Math.random() - 0.5);
      cram = true;
    }
    if (App.reader.open) App.reader.close();
    this.session = { queue, total: queue.length, done: 0, cram, title, returnBook, flipped: false, dir: null, options: null, answer: null };
    this.pickDir();
    App.show('review');
    // мало своих слов для неправильных вариантов — догружаем встроенный словарь
    if (this.choiceMode() && !Dict.ready) Dict.load().then(() => {
      const ss = this.session;
      if (ss && ss.queue.length && !ss.answer && (ss.options?.length || 0) < 4) { ss.options = this.buildOptions(ss.queue[0]); this.render(); }
    }).catch(() => { });
  },

  choiceMode() { return App.settings.studyMode !== 'classic'; },

  /** 4 варианта ответа: правильный + неправильные из той же главы, книги, всех слов, затем встроенного словаря */
  buildOptions(c) {
    if (!c || !this.choiceMode()) return null;
    const ask = this.session.dir === 'word'; // показано слово — выбираем перевод
    const val = (x) => ((ask ? x.translation : x.word) || '').trim();
    const right = val(c);
    if (!right) return null;
    const norm = (t) => t.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const seen = new Set([norm(right)]);
    const wrong = [];
    const add = (t) => {
      t = (t || '').trim();
      const k = norm(t);
      if (wrong.length >= 3 || !k || seen.has(k) || t.length > 60) return;
      seen.add(k); wrong.push(t);
    };
    const lang = c.lang || 'en';
    const others = Cards.all.filter(x => x.id !== c.id && (x.lang || 'en') === lang && x.word.toLowerCase() !== c.word.toLowerCase());
    for (const pool of [others.filter(x => x.bookId === c.bookId && x.deck === c.deck), others.filter(x => x.bookId === c.bookId), others]) {
      for (const x of shuffle([...pool])) add(val(x));
    }
    if (wrong.length < 3 && lang === 'en' && Dict.ready) for (const d of Dict.sample(15)) add(ask ? d.tr : d.word);
    if (!wrong.length) return null;
    return shuffle([right, ...wrong]).map(text => ({ text, ok: text === right }));
  },

  pickDir() {
    const s = App.settings.cardDir;
    this.session.dir = s === 'mixed' ? (Math.random() < 0.5 ? 'word' : 'translation') : s;
    this.session.flipped = false;
    this.session.answer = null;
    this.session.options = this.buildOptions(this.session.queue[0]);
  },

  render() {
    const root = $('#reviewRoot');
    root.innerHTML = '';
    const s = this.session;
    if (!s) return this.renderOverview(root);
    if (!s.queue.length) {
      root.append(h('div', { class: 'review-done' },
        h('div', { class: 'empty-ico' }, '🎉'),
        h('h2', null, 'Готово!'),
        h('p', null, `Пройдено карточек: ${s.done}`),
        h('div', { class: 'row gap center' },
          h('button', { class: 'btn', onclick: () => { this.session = null; this.render(); } }, 'К повторению'),
          s.returnBook && h('button', { class: 'btn primary', onclick: () => { this.session = null; App.openBook(s.returnBook); } }, 'Вернуться к книге'))));
      return;
    }
    const c = s.queue[0];
    const front = s.dir === 'word';
    if (s.options) return this.renderChoice(root, c, front);
    const card = h('div', { class: 'flashcard' + (s.flipped ? ' flipped' : '') },
      h('div', { class: 'fc-deck muted small' }, `${App.bookTitle(c.bookId)} · ${c.deck}`),
      front
        ? h('div', { class: 'fc-front' }, h('div', { class: 'fc-word' }, c.word), h('button', { class: 'icon-btn', onclick: () => speak(c.word, c.lang) }, '🔊'))
        : h('div', { class: 'fc-front' }, h('div', { class: 'fc-word' }, c.translation || '(без перевода)')),
      c.context && h('div', { class: 'fc-ctx', html: ctxHtml(c.context, [c.word, c.form], !front && !s.flipped) }),
      s.flipped && h('div', { class: 'fc-back' },
        h('hr'),
        front
          ? h('div', { class: 'fc-answer' }, c.translation || h('span', { class: 'muted' }, 'перевод не указан'))
          : h('div', { class: 'fc-answer' }, c.word, ' ', h('button', { class: 'icon-btn', onclick: () => speak(c.word, c.lang) }, '🔊')),
        c.note && h('div', { class: 'cr-note' }, '📝 ' + c.note)));

    const controls = s.flipped
      ? h('div', { class: 'rate-row' }, ['Снова', 'Трудно', 'Хорошо', 'Легко'].map((label, r) =>
        h('button', { class: `btn rate r${r}`, onclick: () => this.rate(r) },
          h('b', null, label), h('small', null, s.cram ? `${r + 1}` : SRS.preview(c, r)))))
      : h('button', { class: 'btn primary big', onclick: () => this.flip() }, 'Показать ответ', h('small', null, ' пробел'));

    root.append(
      h('div', { class: 'review-top' },
        h('button', { class: 'btn ghost sm', onclick: () => { this.session = null; this.render(); } }, '✕ Завершить'),
        h('div', { class: 'grow center-text' }, h('b', null, s.title), s.cram && h('span', { class: 'pill' }, 'тренировка')),
        h('div', { class: 'muted' }, `${s.done} / ${s.total}`)),
      h('div', { class: 'progress thin' }, h('div', { style: { width: (100 * s.done / Math.max(1, s.total)) + '%' } })),
      card,
      h('div', { class: 'review-controls' }, controls),
      h('p', { class: 'muted small center-text' }, 'Клавиши: пробел — показать ответ, 1–4 — оценка, E — изменить карточку'));
  },

  head() {
    const s = this.session;
    return [
      h('div', { class: 'review-top' },
        h('button', { class: 'btn ghost sm', onclick: () => { this.session = null; this.render(); } }, '✕ Завершить'),
        h('div', { class: 'grow center-text' }, h('b', null, s.title), s.cram && h('span', { class: 'pill' }, 'тренировка')),
        h('div', { class: 'muted' }, `${s.done} / ${s.total}`)),
      h('div', { class: 'progress thin' }, h('div', { style: { width: (100 * s.done / Math.max(1, s.total)) + '%' } }))];
  },

  /** Карточка с вариантами ответа */
  renderChoice(root, c, front) {
    const s = this.session;
    const a = s.answer;
    const sayBtn = () => h('button', { class: 'icon-btn', title: 'Произнести', onclick: () => speak(c.word, c.lang) }, '🔊');
    const card = h('div', { class: 'flashcard choice-card' + (a ? (a.ok ? ' is-ok' : ' is-bad') : '') },
      h('div', { class: 'fc-deck muted small' }, `${App.bookTitle(c.bookId)} · ${c.deck}`),
      h('div', { class: 'fc-front' },
        h('div', { class: 'fc-word' }, front ? c.word : c.translation),
        (front || a) && sayBtn()),
      h('div', { class: 'muted small' }, front ? 'Выберите перевод' : 'Выберите слово'),
      c.context && h('div', { class: 'fc-ctx', html: ctxHtml(c.context, [c.word, c.form], !front && !a) }),
      a && c.note && h('div', { class: 'cr-note' }, '📝 ' + c.note));

    const opts = h('div', { class: 'choice-grid' }, s.options.map((o, i) => {
      let cls = 'btn choice';
      if (a) cls += o.ok ? ' right' : (i === a.i ? ' wrong' : ' dim');
      return h('button', { class: cls, disabled: !!a, onclick: () => this.answer(i) },
        h('span', { class: 'choice-num' }, String(i + 1)), h('span', { class: 'choice-text' }, o.text));
    }));

    const foot = a
      ? h('div', { class: 'choice-foot' },
        h('div', { class: a.ok ? 'choice-msg ok' : 'choice-msg bad' }, a.ok ? '✓ Верно!' : (a.i < 0 ? 'Запомните ответ' : '✗ Неверно')),
        h('button', { class: 'btn primary big', onclick: () => this.next() }, 'Дальше →'))
      : h('div', { class: 'choice-foot' }, h('button', { class: 'btn ghost', onclick: () => this.answer(-1) }, 'Не знаю'));

    root.append(...this.head(), card, h('div', { class: 'review-controls col' }, opts, foot),
      h('p', { class: 'muted small center-text kbd-hint' }, 'Клавиши: 1–4 — вариант, Enter — дальше, E — изменить карточку'));
  },

  answer(i) {
    const s = this.session;
    if (!s || s.answer || !s.options) return;
    const ok = i >= 0 && s.options[i].ok;
    s.answer = { i, ok };
    this.render();
    const c = s.queue[0];
    if (ok) setTimeout(() => { if (this.session === s && s.answer && s.queue[0] === c) this.next(); }, 900);
  },

  next() {
    const s = this.session;
    if (!s || !s.answer) return;
    const ok = s.answer.ok;
    s.answer = null; // защита от двойного нажатия
    this.apply(ok ? 2 : 0);
  },

  renderOverview(root) {
    const due = Cards.due().length;
    root.append(h('div', { class: 'view-head' }, h('h1', null, 'Повторение')));
    if (!Cards.all.length) {
      root.append(h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, '🧠'),
        h('p', null, 'Здесь будут карточки для повторения.'),
        h('p', { class: 'muted' }, 'Сохраняйте слова во время чтения — приложение напомнит повторить их в нужный момент (интервальные повторения).')));
      return;
    }
    root.append(h('div', { class: 'due-hero' },
      h('div', { class: 'due-num' }, due),
      h('div', null, h('div', null, plural(due, 'карточка', 'карточки', 'карточек') + ' к повторению сейчас'),
        h('div', { class: 'muted small' }, `Всего слов: ${Cards.all.length}`)),
      h('button', { class: 'btn primary', disabled: !due, onclick: () => this.start(Cards.all, { title: 'Все книги' }) }, 'Начать')));
    const dirSel = h('select', { class: 'input inline', onchange: (e) => App.setSetting('cardDir', e.target.value) },
      h('option', { value: 'word' }, 'Слово → перевод'),
      h('option', { value: 'translation' }, 'Перевод → слово'),
      h('option', { value: 'mixed' }, 'Вперемешку'));
    dirSel.value = App.settings.cardDir;
    const modeSel = h('select', { class: 'input inline', onchange: (e) => App.setSetting('studyMode', e.target.value) },
      h('option', { value: 'choice' }, 'Выбор из 4 вариантов'),
      h('option', { value: 'classic' }, 'Показать ответ и оценить'));
    modeSel.value = App.settings.studyMode || 'choice';
    root.append(h('div', { class: 'row gap wrap muted' }, 'Как учить: ', modeSel, ' Направление: ', dirSel));
    for (const b of App.vocabBooks()) root.append(Vocab.bookBlock(b, true));
  },

  flip() { if (this.session && !this.session.flipped) { this.session.flipped = true; this.render(); } },

  rate(r) {
    if (this.session && this.session.flipped) this.apply(r);
  },

  async apply(r) {
    const s = this.session;
    const c = s.queue.shift();
    if (s.cram) {
      if (r === 0) s.queue.splice(Math.min(3, s.queue.length), 0, c); else s.done++;
    } else {
      const upd = SRS.next(c, r);
      await Cards.save(upd);
      if (upd.due - Date.now() < 20 * 60000) s.queue.splice(Math.min(4, s.queue.length), 0, upd);
      else s.done++;
    }
    this.pickDir();
    this.render();
  },

  onKey(e) {
    const s = this.session;
    if (!s || !s.queue.length || App.modalOpen()) return;
    if (e.key.toLowerCase() === 'e' || e.key.toLowerCase() === 'у') {
      return Vocab.editCard(s.queue[0], (upd) => { s.queue[0] = upd; if (s.options) { s.answer = null; s.options = this.buildOptions(upd); } this.render(); });
    }
    if (s.options) {
      if (!s.answer && /^[1-9]$/.test(e.key) && Number(e.key) <= s.options.length) this.answer(Number(e.key) - 1);
      else if (s.answer && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.next(); }
      return;
    }
    if ((e.key === ' ' || e.key === 'Enter') && !s.flipped) { e.preventDefault(); this.flip(); }
    else if (s.flipped && /^[1-4]$/.test(e.key)) this.rate(Number(e.key) - 1);
  },
};
