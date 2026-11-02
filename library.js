// --- 曲置き場 ---
// ローカル版（server.ps1 から配信）: 曲はダウンロードしたフォルダの bgm/<フォルダ>/ に、設定は data/ に置く。
//   サーバーが配る config.js が window.clockServer を定めるので、それで見分ける。
// GitHub Pages 版: 曲はオリジンごとの保存領域（Origin Private File System）に bgm/<フォルダ>/<ファイル名> で置く。
//   OBS のカスタムブラウザドックとブラウザソースは同じオリジンなら保存領域を共有するため、
//   ドックで取り込んだ曲をブラウザソースの obs.html から再生できる。
// どちらも同じ関数をそろえ、index.js からは区別せずに使う。
window.ClockServerLibrary = (() => {
  const API_HEADERS = { 'X-ClockPlayer': '1' };

  async function request(method, url, options = {}) {
    const res = await fetch(url, Object.assign({ method, cache: 'no-store' }, options, {
      headers: Object.assign({}, API_HEADERS, options.headers || {})
    }));
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try { message = (await res.json()).error || message; } catch (e) { /* 本文が JSON でない */ }
      throw new Error(message);
    }
    return res.json();
  }

  const query = (params) => Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  async function loadManifest() {
    return request('GET', 'api/manifest');
  }

  // bgm フォルダを走査し直す。手で入れた曲を拾い、無くなった曲を外す。外した件数を返す
  async function pruneMissing() {
    return (await request('POST', 'api/rescan')).removed;
  }

  async function importFiles(folder, files, readMeta, onProgress) {
    const AUDIO_PATTERN = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
    const audioFiles = Array.from(files).filter(f => AUDIO_PATTERN.test(f.name));
    let manifest = null;
    for (let i = 0; i < audioFiles.length; i++) {
      const file = audioFiles[i];
      let meta = null;
      try { meta = await readMeta(file); } catch (e) { /* メタデータが読めなくても取り込む */ }
      // File をそのまま本文に渡すと、曲全体をメモリに載せずに送れる
      manifest = await request('PUT', `api/files?${query({
        folder,
        name: file.name,
        artist: (meta && meta.artist) || '',
        title: (meta && meta.title) || ''
      })}`, { body: file });
      if (onProgress) onProgress(i + 1, audioFiles.length, file.name);
    }
    return manifest || loadManifest();
  }

  const removeFile = (folder, name) => request('DELETE', `api/files?${query({ folder, name })}`);
  const clearFolder = (folder) => request('DELETE', `api/folder?${query({ folder })}`);
  const clearAll = () => request('DELETE', 'api/all');

  async function getUsage() {
    try {
      return (await request('GET', 'api/usage')).usage;
    } catch (e) {
      return 0;
    }
  }

  // ディスク上のファイルなので、ブラウザに消されることはない
  const requestPersist = async () => true;
  const isPersisted = async () => true;

  async function getTrackUrl(path) {
    const url = path.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (res.status === 404) throw new DOMException(`${path} not found`, 'NotFoundError');
    return url;
  }

  const saveConfig = (config) => request('PUT', 'api/config', { body: JSON.stringify(config) });
  const savePresets = (presets) => request('PUT', 'api/presets', { body: JSON.stringify(presets) });

  return {
    isSupported: true, isActive: true, canRescan: true,
    loadManifest, pruneMissing, importFiles, removeFile, clearFolder, clearAll,
    getUsage, requestPersist, isPersisted, getTrackUrl, saveConfig, savePresets
  };
})();

window.ClockLibrary = window.clockServer ? window.ClockServerLibrary : (() => {
  const FOLDERS = ['bgmA', 'bgmB', 'bgmC', 'bgmD', 'bgmE', 'bgmF'];
  const MANIFEST_FILE = 'manifest.json';
  const AUDIO_PATTERN = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;

  const isSupported = !!(navigator.storage && typeof navigator.storage.getDirectory === 'function');

  // http(s) で配信されているときだけ使う（index.html を直接開いたときは使い方の案内を出す）
  const isActive = isSupported && /^https?:$/.test(location.protocol) && location.hostname !== 'absolute';

  let currentObjectUrl = null;

  async function getBgmDir(folder) {
    const root = await navigator.storage.getDirectory();
    const bgm = await root.getDirectoryHandle('bgm', { create: true });
    return folder ? bgm.getDirectoryHandle(folder, { create: true }) : bgm;
  }

  function emptyManifest() {
    const m = {};
    FOLDERS.forEach(f => { m[f] = []; });
    return m;
  }

  async function loadManifest() {
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(MANIFEST_FILE);
      const data = JSON.parse(await (await handle.getFile()).text());
      return Object.assign(emptyManifest(), data);
    } catch (e) {
      return emptyManifest();
    }
  }

  async function fileExists(path) {
    try {
      const parts = path.split('/');
      let dir = await navigator.storage.getDirectory();
      for (const part of parts.slice(0, -1)) {
        dir = await dir.getDirectoryHandle(part);
      }
      await dir.getFileHandle(parts[parts.length - 1]);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 曲リストからファイルの無い記録を取り除く（旧版の記録や、別の画面で消された曲など）。取り除いた件数を返す
  async function pruneMissing() {
    const manifest = await loadManifest();
    let removed = 0;
    for (const folder of FOLDERS) {
      const kept = [];
      for (const entry of manifest[folder]) {
        if (await fileExists(entry.path)) kept.push(entry);
        else removed++;
      }
      manifest[folder] = kept;
    }
    if (removed > 0) await saveManifest(manifest);
    return removed;
  }

  async function saveManifest(manifest) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(MANIFEST_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(manifest));
    await writable.close();
  }

  async function uniqueName(dir, name) {
    const dot = name.lastIndexOf('.');
    const base = dot !== -1 ? name.substring(0, dot) : name;
    const ext = dot !== -1 ? name.substring(dot) : '';
    let candidate = name;
    for (let i = 1; ; i++) {
      try {
        await dir.getFileHandle(candidate);
        candidate = `${base} (${i})${ext}`;
      } catch (e) {
        return candidate;
      }
    }
  }

  // files: File の配列。readMeta(file) は { artist, title } を返す関数
  async function importFiles(folder, files, readMeta, onProgress) {
    const dir = await getBgmDir(folder);
    const manifest = await loadManifest();
    const audioFiles = Array.from(files).filter(f => AUDIO_PATTERN.test(f.name));

    for (let i = 0; i < audioFiles.length; i++) {
      const file = audioFiles[i];
      const name = await uniqueName(dir, file.name);
      const handle = await dir.getFileHandle(name, { create: true });
      // 曲全体をメモリに載せずに少しずつ書き込む（pipeTo が書き込み後に閉じる）
      await file.stream().pipeTo(await handle.createWritable());

      let meta = null;
      try { meta = await readMeta(file); } catch (e) { /* メタデータが読めなくても取り込む */ }
      let artist = (meta && meta.artist) || '';
      let title = (meta && meta.title) || '';
      if (!title) {
        const baseName = name.replace(/\.[^/.]+$/, '');
        const match = baseName.match(/^(.+?)\s*-\s*(.+)$/);
        if (match) {
          artist = match[1].trim();
          title = match[2].trim();
        } else {
          title = baseName;
        }
      }

      manifest[folder].push({ name, path: `bgm/${folder}/${name}`, artist, title });
      if (onProgress) onProgress(i + 1, audioFiles.length, file.name);
    }

    manifest[folder].sort((a, b) => a.name.localeCompare(b.name));
    await saveManifest(manifest);
    await requestPersist();
    return manifest;
  }

  async function removeFile(folder, name) {
    const dir = await getBgmDir(folder);
    try { await dir.removeEntry(name); } catch (e) { /* 既に無い */ }
    const manifest = await loadManifest();
    manifest[folder] = manifest[folder].filter(f => f.name !== name);
    await saveManifest(manifest);
    return manifest;
  }

  async function clearFolder(folder) {
    const bgm = await getBgmDir();
    try { await bgm.removeEntry(folder, { recursive: true }); } catch (e) { /* 既に無い */ }
    const manifest = await loadManifest();
    manifest[folder] = [];
    await saveManifest(manifest);
    return manifest;
  }

  async function clearAll() {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry('bgm', { recursive: true }); } catch (e) { /* 既に無い */ }
    try { await root.removeEntry(MANIFEST_FILE); } catch (e) { /* 既に無い */ }
    return emptyManifest();
  }

  // 保存領域の永続化を求める。認められないと、ディスクが足りなくなったときにブラウザが消すことがある
  async function requestPersist() {
    try {
      if (await isPersisted()) return true;
      return navigator.storage.persist ? await navigator.storage.persist() : false;
    } catch (e) {
      return false;
    }
  }

  async function isPersisted() {
    try {
      return navigator.storage.persisted ? await navigator.storage.persisted() : false;
    } catch (e) {
      return false;
    }
  }

  async function getUsage() {
    try {
      const { usage } = await navigator.storage.estimate();
      return usage || 0;
    } catch (e) {
      return 0;
    }
  }

  // 再生用の URL を返す。前回の URL は解放する
  async function getTrackUrl(path) {
    const parts = path.split('/');
    let dir = await navigator.storage.getDirectory();
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part);
    }
    const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);
    return currentObjectUrl;
  }

  return { isSupported, isActive, canRescan: false, loadManifest, pruneMissing, importFiles, removeFile, clearFolder, clearAll, getUsage, requestPersist, isPersisted, getTrackUrl };
})();
