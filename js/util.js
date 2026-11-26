/* Общие утилиты */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Мини-конструктор DOM: h('div', {class:'x', onclick: fn}, 'text', childEl) */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? e.style.setProperty(sk, sv) : (e.style[sk] = sv);
      }
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Убирает пунктуацию по краям выделения */
function cleanWord(s) {
  return s.replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Возвращает предложение вокруг позиции pos в тексте */
function sentenceAround(text, pos, len) {
  const isEnd = (i) => /[.!?…。！？]/.test(text[i]) && (i + 1 >= text.length || /[\s"'»”’)]/.test(text[i + 1]));
  let s = pos;
  while (s > 0 && pos - s < 300 && !isEnd(s - 1)) s--;
  let e = pos + len;
  while (e < text.length && e - pos < 300 && !isEnd(e)) e++;
  return text.slice(s, Math.min(e + 1, text.length)).replace(/\s+/g, ' ').trim();
}

function fmtInterval(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return Math.max(1, min) + ' мин';
  const hrs = Math.round(min / 60);
  if (hrs < 24) return hrs + ' ч';
  const days = Math.round(hrs / 24);
  if (days < 31) return days + ' дн.';
  const mon = Math.round(days / 30);
  if (mon < 12) return mon + ' мес.';
  return (days / 365).toFixed(1) + ' г.';
}

function fmtDue(due) {
  const d = due - Date.now();
  if (d <= 0) return 'сейчас';
  return 'через ' + fmtInterval(d);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function downloadFile(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  if (typeof Platform !== 'undefined' && Platform.native) return Platform.saveFile(name, blob);
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function speak(text, lang) {
  // произношение отдельного слова приостанавливает чтение книги вслух
  if (typeof ReadAloud !== 'undefined' && ReadAloud.active && (ReadAloud.state === 'playing' || ReadAloud.state === 'loading')) ReadAloud.pause();
  if (typeof Platform !== 'undefined' && Platform.native && Platform.speak(text, lang)) return;
  if (!('speechSynthesis' in window)) return toast('Озвучка не поддерживается браузером');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang || 'en';
  u.rate = 0.9;
  const voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(u.lang.toLowerCase()));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
}

/** Уменьшенная обложка в dataURL (чтобы хранить в метаданных книги) */
async function makeThumb(blob, width = 240) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const scale = width / img.naturalWidth;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } catch (e) {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
