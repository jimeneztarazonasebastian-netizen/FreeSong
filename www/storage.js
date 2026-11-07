// FreeSong - Acceso seguro a localStorage.
//
// Un valor corrupto o un modo privado con cuota llena no deben impedir que la
// app arranque. Este módulo centraliza la lectura/escritura y devuelve siempre
// un valor utilizable.
(() => {
  'use strict';

  function read(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const value = JSON.parse(raw);
      return value === null || value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function readArray(key) {
    const value = read(key, []);
    return Array.isArray(value) ? value : [];
  }

  function readObject(key) {
    const value = read(key, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function readRaw(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : raw;
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  window.FreeSongStorage = { read, readArray, readObject, readRaw, write };
})();
