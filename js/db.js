/* Хранилище IndexedDB: книги, файлы книг, карточки */
'use strict';

const DB = (() => {
  let dbp;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      // v2: добавлены заметки (стикеры). Старые данные при обновлении сохраняются.
      const r = indexedDB.open('lexireader', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        const has = (n) => db.objectStoreNames.contains(n);
        if (!has('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!has('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!has('cards')) db.createObjectStore('cards', { keyPath: 'id' }).createIndex('bookId', 'bookId');
        if (!has('notes')) db.createObjectStore('notes', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }

  async function run(stores, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      let out;
      const r = fn(t);
      if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  return {
    get: (store, id) => run(store, 'readonly', t => t.objectStore(store).get(id)),
    put: (store, val) => run(store, 'readwrite', t => t.objectStore(store).put(val)),
    del: (store, id) => run(store, 'readwrite', t => t.objectStore(store).delete(id)),
    all: (store) => run(store, 'readonly', t => t.objectStore(store).getAll()),
    cardsOf: (bookId) => run('cards', 'readonly', t => t.objectStore('cards').index('bookId').getAll(bookId)),
    putMany: (store, vals) => run(store, 'readwrite', t => { const s = t.objectStore(store); vals.forEach(v => s.put(v)); }),
    deleteBook: (id) => run(['books', 'files', 'cards', 'notes'], 'readwrite', t => {
      t.objectStore('books').delete(id);
      t.objectStore('files').delete(id);
      for (const store of ['cards', 'notes']) {
        t.objectStore(store).index('bookId').openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
          const c = e.target.result;
          if (c) { c.delete(); c.continue(); }
        };
      }
    }),
  };
})();
