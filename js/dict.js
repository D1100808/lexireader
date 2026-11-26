/* Встроенный англо-русский словарь (офлайн).
 * Данные: Викисловарь (CC BY-SA 4.0) через kaikki.org, собираются скриптом tools/build-dict.py в dict/en-ru.js.
 * Поиск понимает словоформы: went → go, children → child, stopped → stop, happier → happy.
 */
'use strict';

const Dict = (() => {
  let data = null;
  let loading = null;

  // Неправильные глаголы: "начальная:формы через запятую"
  const IRREGULAR_VERBS = (
    'arise:arose,arisen;awake:awoke,awoken;be:was,were,been,am,is,are,being;bear:bore,borne,born;beat:beaten;' +
    'become:became;begin:began,begun;bend:bent;bet:bet;bid:bade,bidden;bind:bound;bite:bit,bitten;bleed:bled;' +
    'blow:blew,blown;break:broke,broken;breed:bred;bring:brought;build:built;burn:burnt;burst:burst;buy:bought;' +
    'cast:cast;catch:caught;choose:chose,chosen;cling:clung;come:came;cost:cost;creep:crept;cut:cut;deal:dealt;' +
    'dig:dug;do:did,done,does;draw:drew,drawn;dream:dreamt;drink:drank,drunk;drive:drove,driven;dwell:dwelt;' +
    'eat:ate,eaten;fall:fell,fallen;feed:fed;feel:felt;fight:fought;find:found;flee:fled;fling:flung;fly:flew,flown,flies;' +
    'forbid:forbade,forbidden;forget:forgot,forgotten;forgive:forgave,forgiven;freeze:froze,frozen;get:got,gotten;' +
    'give:gave,given;go:went,gone,goes;grind:ground;grow:grew,grown;hang:hung;have:had,has,having;hear:heard;' +
    'hide:hid,hidden;hit:hit;hold:held;hurt:hurt;keep:kept;kneel:knelt;know:knew,known;lay:laid;lead:led;' +
    'lean:leant;leap:leapt;learn:learnt;leave:left;lend:lent;let:let;lie:lay,lain,lying;light:lit;lose:lost;' +
    'make:made;mean:meant;meet:met;mistake:mistook,mistaken;overcome:overcame;pay:paid;prove:proven;put:put;' +
    'quit:quit;read:read;rid:rid;ride:rode,ridden;ring:rang,rung;rise:rose,risen;run:ran;say:said;see:saw,seen;' +
    'seek:sought;sell:sold;send:sent;set:set;sew:sewn;shake:shook,shaken;shed:shed;shine:shone;shoot:shot;' +
    'show:shown;shrink:shrank,shrunk;shut:shut;sing:sang,sung;sink:sank,sunk;sit:sat;sleep:slept;slide:slid;' +
    'sling:slung;slit:slit;smell:smelt;speak:spoke,spoken;speed:sped;spell:spelt;spend:spent;spill:spilt;' +
    'spin:spun;spit:spat;split:split;spoil:spoilt;spread:spread;spring:sprang,sprung;stand:stood;steal:stole,stolen;' +
    'stick:stuck;sting:stung;stink:stank,stunk;stride:strode,stridden;strike:struck,stricken;string:strung;' +
    'strive:strove,striven;swear:swore,sworn;sweep:swept;swell:swollen;swim:swam,swum;swing:swung;take:took,taken;' +
    'teach:taught;tear:tore,torn;tell:told;think:thought;throw:threw,thrown;thrust:thrust;tread:trod,trodden;' +
    'understand:understood;undertake:undertook,undertaken;wake:woke,woken;wear:wore,worn;weave:wove,woven;' +
    'weep:wept;win:won;wind:wound;withdraw:withdrew,withdrawn;wring:wrung;write:wrote,written;' +
    'can:could;may:might;shall:should;will:would;' +
    // существительные и прилагательные
    'man:men;woman:women;child:children;foot:feet;tooth:teeth;mouse:mice;goose:geese;person:people;ox:oxen;' +
    'louse:lice;criterion:criteria;phenomenon:phenomena;crisis:crises;analysis:analyses;thesis:theses;' +
    'good:better,best;well:better,best;bad:worse,worst;much:more,most;many:more,most;little:less,least;' +
    'far:further,furthest,farther,farthest;old:elder,eldest;' +
    'i:me,my,mine;he:him,his;she:her,hers;we:us,our,ours;they:them,their,theirs;you:your,yours;it:its'
  );
  const IRR = new Map();
  for (const part of IRREGULAR_VERBS.split(';')) {
    const [lemma, forms] = part.split(':');
    for (const f of forms.split(',')) {
      if (!IRR.has(f)) IRR.set(f, []);
      if (!IRR.get(f).includes(lemma)) IRR.get(f).push(lemma);
    }
  }

  /** Кандидаты начальной формы по правилам английских окончаний */
  function stems(w) {
    const c = [];
    const add = (x) => { if (x && x.length > 1 && x !== w && !c.includes(x)) c.push(x); };
    const dbl = (b) => /([b-df-hj-np-tv-z])\1$/.test(b) ? b.slice(0, -1) : null;
    if (/'s$/.test(w)) add(w.slice(0, -2));
    if (/s'$/.test(w)) add(w.slice(0, -1));
    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ves$/.test(w)) { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe'); }
    if (/(ses|xes|zes|ches|shes|oes)$/.test(w)) add(w.slice(0, -2));
    if (/[^s]s$/.test(w)) add(w.slice(0, -1));
    if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ed$/.test(w)) { const b = w.slice(0, -2); add(b); add(w.slice(0, -1)); add(dbl(b)); }
    if (/ying$/.test(w)) add(w.slice(0, -4) + 'ie');
    if (/ing$/.test(w)) { const b = w.slice(0, -3); add(b); add(b + 'e'); add(dbl(b)); }
    if (/iest$/.test(w)) add(w.slice(0, -4) + 'y');
    if (/ier$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/est$/.test(w)) { const b = w.slice(0, -3); add(b); add(b + 'e'); add(dbl(b)); }
    if (/er$/.test(w)) { const b = w.slice(0, -2); add(b); add(b + 'e'); add(dbl(b)); }
    if (/ily$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ly$/.test(w)) add(w.slice(0, -2));
    return c;
  }

  function load() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      // <script> вместо fetch — работает и при открытии index.html как файла
      const s = document.createElement('script');
      s.src = 'dict/en-ru.js';
      s.async = true;
      s.onload = () => { data = window.LEXI_DICT_EN_RU; delete window.LEXI_DICT_EN_RU; res(data); };
      s.onerror = () => { loading = null; rej(new Error('словарь не найден')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  /** Убирает пометы в начале толкования: «зоол. собака, пёс» → «собака, пёс» */
  function shortGloss(g) {
    let s = g.replace(/^(?:(?:[а-яё]{2,8}\.(?:\s?[а-яё]{1,6}\.)?|\([^)]{0,40}\))[,\s]*)+/i, '').trim() || g;
    s = s.split(';')[0].trim();
    const parts = s.split(/,\s*/);
    return (parts.length > 3 ? parts.slice(0, 3).join(', ') : s).slice(0, 80);
  }

  /**
   * Поиск слова. Возвращает [{head, via, entries:[[pos, ipa, [значения], [пример, перевод]?]]}] или null.
   * via — пояснение, если найдено через начальную форму («форма от see»).
   */
  function lookup(raw) {
    if (!data) return null;
    const E = data.e, F = data.f;
    const w = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/^to /, '');
    const blocks = [];
    const seen = new Set();
    const irrVerb = (IRR.get(w) || []).length && !/^(better|best|worse|worst|more|most|less|least|further|furthest|farther|farthest|elder|eldest|me|my|mine|him|his|her|hers|us|our|ours|them|their|theirs|your|yours|its)$/.test(w);
    // stopped, lying, went — сначала значения глагола
    const preferVerb = /(ed|ing)$/.test(w) || irrVerb;
    const push = (head, via) => {
      if (seen.has(head) || !E[head]) return false;
      seen.add(head);
      let entries = E[head];
      if (via && preferVerb) entries = [...entries].sort((a, b) => (b[0] === 'гл.') - (a[0] === 'гл.'));
      blocks.push({ head, via, entries });
      return true;
    };
    const viaText = (lemma) => `${w} → ${lemma}`;

    const irr = IRR.get(w) || [];
    const fromForms = F[w] ? [F[w]] : [];
    if (irr.length) {
      irr.forEach(l => push(l, viaText(l)));
      push(w, null);
    } else if (E[w]) {
      push(w, null);
      fromForms.forEach(l => push(l, viaText(l)));
    } else {
      fromForms.forEach(l => push(l, viaText(l)));
      if (!blocks.length) {
        for (const s of stems(w)) {
          if (E[s]) { push(s, viaText(s)); break; }
          if (F[s] && push(F[s], viaText(F[s]))) break;
        }
      }
    }
    // фразовые глаголы и выражения: gave up → give up
    if (!blocks.length && w.includes(' ')) {
      const [first, ...rest] = w.split(' ');
      const cands = [...(IRR.get(first) || []), ...(F[first] ? [F[first]] : []), ...stems(first)];
      for (const c of cands) {
        const phrase = [c, ...rest].join(' ');
        if (push(phrase, viaText(phrase))) break;
      }
    }
    return blocks.length ? blocks.slice(0, 3) : null;
  }

  /** Случайные слова словаря с коротким переводом — неправильные варианты для тренировки */
  let keys = null;
  function sample(n) {
    if (!data) return [];
    keys = keys || Object.keys(data.e).filter(k => /^[a-z]{3,12}$/.test(k));
    const out = [];
    for (let i = 0; i < n * 4 && out.length < n; i++) {
      const w = keys[Math.floor(Math.random() * keys.length)];
      const g = data.e[w]?.[0]?.[2]?.[0];
      const tr = g && shortGloss(g).split(/[;,(]/)[0].trim();
      if (tr && tr.length <= 30 && !/фамили|имя|город|рек[аи]|штат|сокр|аббрев|назван|^[A-ZА-ЯЁ]/.test(tr)) out.push({ word: w, tr });
    }
    return out;
  }

  return {
    load,
    lookup,
    sample,
    shortGloss,
    get ready() { return !!data; },
    get size() { return data ? Object.keys(data.e).length : 0; },
    supports: (from, to) => from === 'en' && to === 'ru',
  };
})();
