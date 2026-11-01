// --- Browser Library: GitHub Pages など bgm フォルダを置けない環境向けの曲置き場 ---
// 曲はオリジンごとの保存領域（Origin Private File System）に bgm/<フォルダ>/<ファイル名> で置く。
// OBS のカスタムブラウザドックとブラウザソースは同じオリジンなら保存領域を共有するため、
// ドックで取り込んだ曲をブラウザソースの obs.html から再生できる。
window.ClockLibrary = (() => {
  const FOLDERS = ['bgmA', 'bgmB', 'bgmC', 'bgmD', 'bgmE', 'bgmF'];
  const MANIFEST_FILE = 'manifest.json';
  const AUDIO_PATTERN = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;

  const isSupported = !!(navigator.storage && typeof navigator.storage.getDirectory === 'function');

  // bgm_manifest.js が無く http(s) で配信されているときだけライブラリを使う
  const isActive = isSupported && !window.bgmManifest && /^https?:$/.test(location.protocol);

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

  return { isSupported, isActive, loadManifest, pruneMissing, importFiles, removeFile, clearFolder, clearAll, getUsage, requestPersist, isPersisted, getTrackUrl };
})();
