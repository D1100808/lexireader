/* Платформа: Android-приложение (Capacitor) или веб/PWA (iPhone, браузер) */
'use strict';

const Platform = {
  native: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()),

  plugin(name) { return window.Capacitor?.Plugins?.[name]; },

  init() {
    // на телефоне не фильтруем файлы по расширению: у FB2 и др. часто нет «правильного» типа и их не видно в проводнике
    if (matchMedia('(pointer: coarse)').matches) $('#fileInput')?.removeAttribute('accept');

    if (this.native) {
      document.documentElement.classList.add('native');
      const AppPlugin = this.plugin('App');
      AppPlugin?.addListener('backButton', () => { if (!App.handleBack()) AppPlugin.exitApp(); });
    } else {
      // офлайн-режим (PWA): работает только по https или на localhost
      if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
        navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
      }
      // просим браузер не удалять книги и карточки при нехватке места
      navigator.storage?.persist?.().catch(() => { });
    }
  },

  blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  },

  /** В Android-приложении скачивание через ссылку не работает — сохраняем файл и открываем «Поделиться» */
  async saveFile(name, blob) {
    const FS = this.plugin('Filesystem'), Share = this.plugin('Share');
    if (!FS || !Share) return toast('Экспорт недоступен');
    try {
      const { uri } = await FS.writeFile({ path: name, data: await this.blobToBase64(blob), directory: 'CACHE' });
      await Share.share({ title: name, files: [uri], dialogTitle: 'Сохранить или отправить' });
    } catch (e) {
      if (!/cancel/i.test(e?.message || '')) toast('Не удалось сохранить файл: ' + (e?.message || e));
    }
  },

  /** Озвучка: в Android-приложении — через системный синтезатор речи */
  speak(text, lang) {
    const TTS = this.plugin('TextToSpeech');
    if (!TTS) return false;
    const tag = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', pt: 'pt-PT', ru: 'ru-RU' }[lang] || lang || 'en-US';
    TTS.stop().catch(() => { }).finally(() => TTS.speak({ text, lang: tag, rate: 0.9 }).catch(e => toast('Озвучка недоступна: ' + (e?.message || e))));
    return true;
  },
};
