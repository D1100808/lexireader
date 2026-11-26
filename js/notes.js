/* Заметки-стикеры (付箋, «фусэн»): цитаты из книги с комментарием, разных цветов */
'use strict';

const NOTE_COLORS = [
  ['yellow', 'Жёлтый', '#f6e27f'],
  ['pink', 'Розовый', '#f4b6c2'],
  ['green', 'Зелёный', '#bfe1b0'],
  ['blue', 'Голубой', '#b3d4f2'],
  ['purple', 'Сиреневый', '#d4c2ee'],
  ['orange', 'Оранжевый', '#f7c792'],
];

const Notes = {
  all: [],
  async load() { this.all = await DB.all('notes'); },
  ofBook(bookId) { return this.all.filter(n => n.bookId === bookId); },
  color(id) { return NOTE_COLORS.find(c => c[0] === id) || NOTE_COLORS[0]; },
  create(data) {
    const now = Date.now();
    return { id: uid(), color: App.settings.noteColor || 'yellow', text: '', createdAt: now, updatedAt: now, ...data };
  },
  async save(n) {
    n.updatedAt = Date.now();
    await DB.put('notes', n);
    const i = this.all.findIndex(x => x.id === n.id);
    if (i >= 0) this.all[i] = n; else this.all.push(n);
  },
  async remove(id) {
    await DB.del('notes', id);
    this.all = this.all.filter(n => n.id !== id);
  },
  async saveMany(list) {
    await DB.putMany('notes', list);
    for (const n of list) {
      const i = this.all.findIndex(x => x.id === n.id);
      if (i >= 0) this.all[i] = n; else this.all.push(n);
    }
  },
  /** Текст для экспорта: «Цитаты из книги» */
  toText(list) {
    const byBook = new Map();
    for (const n of [...list].sort((a, b) => (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0) || a.createdAt - b.createdAt)) {
      const t = n.bookTitle || App.bookTitle(n.bookId);
      if (!byBook.has(t)) byBook.set(t, []);
      byBook.get(t).push(n);
    }
    let out = '';
    for (const [title, notes] of byBook) {
      out += `# ${title}\n\n`;
      for (const n of notes) {
        out += `> ${n.quote.replace(/\n/g, '\n> ')}\n`;
        if (n.text) out += `\n${n.text}\n`;
        out += `\n— ${n.chapterTitle || ''}${n.page ? `, стр. ${n.page}` : ''}\n\n`;
      }
    }
    return '﻿' + out.trim() + '\n';
  },
};

/** Ищет цитату в тексте (может проходить через несколько узлов: курсив, ссылки, строки PDF) */
function findTextRanges(root, quote, max = 20) {
  const words = quote.trim().split(/\s+/).filter(Boolean).map(escapeRe);
  if (!words.length) return [];
  const nodes = [];
  let text = '';
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) { nodes.push({ node: n, start: text.length }); text += n.nodeValue; }
  const locate = (pos) => {
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid].start <= pos) lo = mid; else hi = mid - 1; }
    return { node: nodes[lo].node, offset: Math.min(pos - nodes[lo].start, nodes[lo].node.nodeValue.length) };
  };
  const re = new RegExp(words.join('\\s*'), 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < max) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const a = locate(m.index), b = locate(m.index + m[0].length - 1);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset + 1);
    out.push(r);
  }
  return out;
}

/** Редактор стикера */
function openNoteEditor(note, { isNew = false, onSaved, onDeleted } = {}) {
  const card = h('div', { class: 'note-editor' });
  const paint = () => {
    card.style.setProperty('--note', Notes.color(note.color)[2]);
    $('#modalCard').style.setProperty('--note', Notes.color(note.color)[2]);
    card.querySelectorAll('.color-dot').forEach(d => d.classList.toggle('active', d.dataset.c === note.color));
  };
  const quote = h('textarea', { class: 'note-quote', rows: 4 }, note.quote);
  const text = h('textarea', { class: 'note-text', rows: 3, placeholder: 'Ваша мысль, перевод, вопрос…' }, note.text || '');
  const dots = h('div', { class: 'color-dots' }, NOTE_COLORS.map(([id, name, hex]) =>
    h('button', { class: 'color-dot', 'data-c': id, title: name, style: { background: hex }, onclick: () => { note.color = id; paint(); } })));
  const readerOnBook = App.reader.open && App.reader.meta?.id === note.bookId;
  card.append(
    h('div', { class: 'row gap' }, h('b', { class: 'grow' }, isNew ? 'Новая заметка' : 'Заметка'), dots),
    quote,
    text,
    h('div', { class: 'note-meta' }, `${note.bookTitle || App.bookTitle(note.bookId)} · ${note.chapterTitle || ''}${note.page ? ` · стр. ${note.page}` : ''}`),
    h('div', { class: 'row gap wrap' },
      !isNew && h('button', {
        class: 'btn sm ghost', onclick: async () => {
          if (!confirm('Удалить заметку?')) return;
          await Notes.remove(note.id);
          App.closeModal();
          onDeleted?.();
        },
      }, '🗑'),
      !isNew && h('button', {
        class: 'btn sm ghost', onclick: async () => {
          App.closeModal();
          if (!readerOnBook) await App.openBook(note.bookId);
          App.reader.goToNote(note);
        },
      }, readerOnBook ? '↧ К цитате' : '📖 Открыть в книге'),
      h('button', { class: 'btn sm ghost', onclick: () => copyText(`«${quote.value.trim()}»${text.value.trim() ? '\n\n' + text.value.trim() : ''}\n— ${note.bookTitle || ''}`) }, '⧉ Копировать'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm ghost', onclick: () => App.closeModal() }, 'Отмена'),
      h('button', {
        class: 'btn sm primary', onclick: async () => {
          note.quote = quote.value.trim() || note.quote;
          note.text = text.value.trim();
          App.setSetting('noteColor', note.color);
          await Notes.save(note);
          App.closeModal();
          toast(isNew ? 'Заметка сохранена' : 'Сохранено');
          onSaved?.(note);
        },
      }, 'Сохранить')));
  App.modal(card);
  $('#modalCard').classList.add('sticky-modal');
  paint();
  (isNew ? text : quote).focus();
}

function copyText(s) {
  (navigator.clipboard?.writeText(s) || Promise.reject()).then(() => toast('Скопировано'), () => {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, s);
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Скопировано'); } catch (e) { toast('Не удалось скопировать'); }
    ta.remove();
  });
}

/* ---------- Экран «Заметки»: доска со стикерами ---------- */
const NotesView = {
  state: { bookId: '*', color: '*', q: '' },

  open(bookId = '*') { this.state = { bookId, color: '*', q: '' }; App.show('notes'); },

  filtered() {
    const { bookId, color, q } = this.state;
    const t = q.trim().toLowerCase();
    return Notes.all
      .filter(n => (bookId === '*' || n.bookId === bookId) && (color === '*' || n.color === color))
      .filter(n => !t || n.quote.toLowerCase().includes(t) || (n.text || '').toLowerCase().includes(t))
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  render() {
    const root = $('#notesRoot');
    root.innerHTML = '';
    const s = this.state;
    const books = [...new Map(Notes.all.map(n => [n.bookId, n.bookTitle || App.bookTitle(n.bookId)])).entries()];
    const bookSel = h('select', { class: 'input inline', onchange: (e) => { s.bookId = e.target.value; this.render(); } },
      h('option', { value: '*' }, 'Все книги'), books.map(([id, t]) => h('option', { value: id }, t)));
    bookSel.value = s.bookId;
    const list = this.filtered();
    root.append(h('div', { class: 'view-head' },
      h('h1', null, 'Заметки'),
      h('div', { class: 'row gap wrap' },
        h('input', {
          class: 'input search', type: 'search', placeholder: 'Поиск по заметкам…', value: s.q,
          oninput: debounce((e) => { s.q = e.target.value; this.render(); $('#notesRoot .search')?.focus(); }, 250),
        }),
        h('button', { class: 'btn', disabled: !list.length, onclick: () => downloadFile('lexireader-заметки.md', Notes.toText(list), 'text/markdown') }, '⭳ Экспорт'))));

    if (!Notes.all.length) {
      root.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-ico' }, '🗒️'),
        h('p', null, 'Здесь будут ваши заметки-стикеры.'),
        h('p', { class: 'muted' }, 'Выделите в книге цитату и выберите цвет стикера — она сохранится сюда и подсветится в тексте. Можно добавить свою мысль.')));
      return;
    }
    root.append(h('div', { class: 'row gap wrap notes-filters' }, bookSel,
      h('div', { class: 'color-dots' },
        h('button', { class: 'color-dot all' + (s.color === '*' ? ' active' : ''), title: 'Все цвета', onclick: () => { s.color = '*'; this.render(); } }, '✱'),
        NOTE_COLORS.map(([id, name, hex]) => h('button', {
          class: 'color-dot' + (s.color === id ? ' active' : ''), title: name, style: { background: hex },
          onclick: () => { s.color = s.color === id ? '*' : id; this.render(); },
        }))),
      h('span', { class: 'muted small' }, `${list.length} ${plural(list.length, 'заметка', 'заметки', 'заметок')}`)));
    root.append(this.wall(list, () => this.render()));
  },

  /** Доска со стикерами (используется и на экране «Заметки», и в боковой панели читалки) */
  wall(list, refresh, compact) {
    return h('div', { class: 'sticky-wall' + (compact ? ' compact' : '') }, list.map(n => {
      const tilt = ((parseInt(n.id.slice(-3), 36) % 7) - 3) * 0.45;
      return h('div', {
        class: 'sticky', style: { '--note': Notes.color(n.color)[2], '--tilt': tilt + 'deg' },
        onclick: () => compact ? App.reader.goToNote(n) : openNoteEditor(n, { onSaved: refresh, onDeleted: refresh }),
      },
        h('div', { class: 'sticky-quote' }, n.quote.length > 400 ? n.quote.slice(0, 400) + '…' : n.quote),
        n.text && h('div', { class: 'sticky-text' }, n.text),
        h('div', { class: 'sticky-meta' },
          compact ? (n.chapterTitle || '') : `${n.bookTitle || App.bookTitle(n.bookId)} · ${n.chapterTitle || ''}`,
          compact && h('button', { class: 'icon-btn sm', title: 'Изменить', onclick: (e) => { e.stopPropagation(); openNoteEditor(n, { onSaved: refresh, onDeleted: refresh }); } }, '✎')));
    }));
  },
};
