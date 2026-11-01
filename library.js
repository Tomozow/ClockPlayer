// --- Browser Library: GitHub Pages など bgm フォルダを置けない環境向けの曲置き場 ---
// 曲の置き方は2通り。
// 1. 「曲を追加」: オリジンごとの保存領域（Origin Private File System）の bgm/<枠>/<ファイル名> にコピーする
// 2. 「フォルダを指定」: コピーせず、フォルダのハンドルだけを IndexedDB に置いて直接読む（パスは link/<枠>/<相対パス>）
// OBS のカスタムブラウザドックとブラウザソースは同じオリジンなら保存領域と IndexedDB を共有する。
// ただし指定フォルダの読み取り許可はページごと・起動ごとに必要で、許可を求められないページ（ブラウザソース）は
// 許可を持つページ（ドック）に BroadcastChannel 経由でファイルを渡してもらう（setRelay）。
window.ClockLibrary = (() => {
  const FOLDERS = ['bgmA', 'bgmB', 'bgmC', 'bgmD', 'bgmE', 'bgmF'];
  const MANIFEST_FILE = 'manifest.json';
  const AUDIO_PATTERN = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
  const LINK_PREFIX = 'link/';
  const LINK_DB = 'clockplayer_library';
  const LINK_STORE = 'links';

  const isSupported = !!(navigator.storage && typeof navigator.storage.getDirectory === 'function');
  const canLinkFolder = typeof window.showDirectoryPicker === 'function';

  // bgm_manifest.js が無く http(s) で配信されているときだけライブラリを使う
  const isActive = isSupported && !window.bgmManifest && /^https?:$/.test(location.protocol);

  let currentObjectUrl = null;
  let relay = null; // (path) => Promise<File>

  // --- 曲リスト ---
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

  async function saveManifest(manifest) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(MANIFEST_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(manifest));
    await writable.close();
  }

  function toTitle(name, meta) {
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
    return { artist, title };
  }

  function isLinkedPath(path) {
    return path.startsWith(LINK_PREFIX);
  }

  // --- 1. コピーして取り込む ---
  async function getBgmDir(folder) {
    const root = await navigator.storage.getDirectory();
    const bgm = await root.getDirectoryHandle('bgm', { create: true });
    return folder ? bgm.getDirectoryHandle(folder, { create: true }) : bgm;
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
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();

      let meta = null;
      try { meta = await readMeta(file); } catch (e) { /* メタデータが読めなくても取り込む */ }
      manifest[folder].push(Object.assign({ name, path: `bgm/${folder}/${name}` }, toTitle(name, meta)));
      if (onProgress) onProgress(i + 1, audioFiles.length, file.name);
    }

    manifest[folder].sort((a, b) => a.name.localeCompare(b.name));
    await saveManifest(manifest);
    if (navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return manifest;
  }

  async function removeFile(folder, name) {
    const dir = await getBgmDir(folder);
    try { await dir.removeEntry(name); } catch (e) { /* 既に無い */ }
    const manifest = await loadManifest();
    manifest[folder] = manifest[folder].filter(f => isLinkedPath(f.path) || f.name !== name);
    await saveManifest(manifest);
    return manifest;
  }

  // コピーした曲だけを消す。指定フォルダの曲（元ファイル）には触れない
  async function clearFolder(folder) {
    const bgm = await getBgmDir();
    try { await bgm.removeEntry(folder, { recursive: true }); } catch (e) { /* 既に無い */ }
    const manifest = await loadManifest();
    manifest[folder] = manifest[folder].filter(f => isLinkedPath(f.path));
    await saveManifest(manifest);
    return manifest;
  }

  async function clearAll() {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry('bgm', { recursive: true }); } catch (e) { /* 既に無い */ }
    const manifest = await loadManifest();
    FOLDERS.forEach(f => { manifest[f] = manifest[f].filter(e => isLinkedPath(e.path)); });
    await saveManifest(manifest);
    return manifest;
  }

  async function getUsage() {
    try {
      const { usage } = await navigator.storage.estimate();
      return usage || 0;
    } catch (e) {
      return 0;
    }
  }

  // --- 2. フォルダを指定する（コピーしない） ---
  function openLinkDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(LINK_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(LINK_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function linkStore(mode, fn) {
    const db = await openLinkDB();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(LINK_STORE, mode).objectStore(LINK_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getLinks() {
    const links = {};
    for (const folder of FOLDERS) {
      const handle = await linkStore('readonly', store => store.get(folder));
      if (handle) links[folder] = handle;
    }
    return links;
  }

  async function getLinkedFolderName(folder) {
    const handle = await linkStore('readonly', store => store.get(folder));
    return handle ? handle.name : null;
  }

  async function hasPermission(handle) {
    try {
      return (await handle.queryPermission({ mode: 'read' })) === 'granted';
    } catch (e) {
      return false;
    }
  }

  // 読み取り許可の切れている指定フォルダの枠名
  async function foldersNeedingPermission() {
    const links = await getLinks();
    const result = [];
    for (const folder of Object.keys(links)) {
      if (!(await hasPermission(links[folder]))) result.push(folder);
    }
    return result;
  }

  // ボタン操作の中から呼ぶ。すべて許可されたら true
  async function requestPermissions() {
    const links = await getLinks();
    let ok = true;
    for (const handle of Object.values(links)) {
      if (await hasPermission(handle)) continue;
      try {
        if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') ok = false;
      } catch (e) {
        ok = false;
      }
    }
    return ok;
  }

  async function scanDirectory(dirHandle, relPath, readMeta, onProgress, results) {
    for await (const entry of dirHandle.values()) {
      const entryPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        await scanDirectory(entry, entryPath, readMeta, onProgress, results);
      } else if (AUDIO_PATTERN.test(entry.name)) {
        let meta = null;
        try { meta = await readMeta(await entry.getFile()); } catch (e) { /* メタデータが読めなくても登録する */ }
        results.push(Object.assign({ name: entry.name, relPath: entryPath }, toTitle(entry.name, meta)));
        if (onProgress) onProgress(results.length, 0, entry.name);
      }
    }
    return results;
  }

  // 枠にフォルダを指定して曲リストに登録する。指定済みなら置き換える（再指定で曲リストを更新できる）
  async function linkFolder(folder, dirHandle, readMeta, onProgress) {
    const found = await scanDirectory(dirHandle, '', readMeta, onProgress, []);
    await linkStore('readwrite', store => store.put(dirHandle, folder));
    const manifest = await loadManifest();
    manifest[folder] = manifest[folder]
      .filter(f => !isLinkedPath(f.path))
      .concat(found.map(f => ({
        name: f.name,
        path: `${LINK_PREFIX}${folder}/${f.relPath}`,
        artist: f.artist,
        title: f.title
      })));
    manifest[folder].sort((a, b) => a.name.localeCompare(b.name));
    await saveManifest(manifest);
    return manifest;
  }

  async function unlinkFolder(folder) {
    await linkStore('readwrite', store => store.delete(folder));
    const manifest = await loadManifest();
    manifest[folder] = manifest[folder].filter(f => !isLinkedPath(f.path));
    await saveManifest(manifest);
    return manifest;
  }

  // --- 再生 ---
  // このページの権限でファイルを読む。指定フォルダの許可が無ければ NotAllowedError
  async function readFile(path) {
    const parts = path.split('/');
    let dir;
    let rest;
    if (isLinkedPath(path)) {
      dir = await linkStore('readonly', store => store.get(parts[1]));
      if (!dir) throw new Error('指定フォルダが見つかりません');
      if (!(await hasPermission(dir))) {
        const err = new Error('フォルダの読み取りが許可されていません');
        err.name = 'NotAllowedError';
        throw err;
      }
      rest = parts.slice(2);
    } else {
      dir = await navigator.storage.getDirectory();
      rest = parts;
    }
    for (const part of rest.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part);
    }
    return (await dir.getFileHandle(rest[rest.length - 1])).getFile();
  }

  function setRelay(fn) {
    relay = fn;
  }

  // 再生用の URL を返す。自分で読めないときはドックから受け取る。前回の URL は解放する
  async function getTrackUrl(path) {
    let file;
    try {
      file = await readFile(path);
    } catch (e) {
      if (!relay || e.name !== 'NotAllowedError') throw e;
      file = await relay(path);
    }
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);
    return currentObjectUrl;
  }

  return {
    isSupported, isActive, canLinkFolder,
    loadManifest, importFiles, removeFile, clearFolder, clearAll, getUsage,
    linkFolder, unlinkFolder, getLinkedFolderName, isLinkedPath,
    foldersNeedingPermission, requestPermissions, readFile, setRelay, getTrackUrl
  };
})();
