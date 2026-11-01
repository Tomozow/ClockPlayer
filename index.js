// --- Load OBS modes immediately to prevent flashing ---
// 保存済みの設定を返す。ブラウザライブラリ利用時（GitHub Pages など）は config.js が書き換えられないため localStorage を優先する
function readSavedConfig() {
  let stored = null;
  try {
    const rawData = localStorage.getItem('bgm_clock_config');
    if (rawData) stored = JSON.parse(rawData);
  } catch (e) {
    console.error('Failed to read config from localStorage:', e);
  }
  if (window.ClockLibrary && window.ClockLibrary.isActive) {
    return stored || window.bgmClockConfig || null;
  }
  return window.bgmClockConfig || stored;
}

// ドックでは OBS 向けの表示設定（透過・ミニマルなど）を自分には適用しない
function isDockMode() {
  return document.documentElement.classList.contains('dock-mode');
}

(function applyInitialOBSModes() {
  try {
    const data = readSavedConfig();
    if (data && !isDockMode()) {
      if (data.obsTransparent) {
        document.body.classList.add('transparent-mode');
      }
      if (data.obsHideControls) {
        document.body.classList.add('hide-controls-mode');
      }
      if (data.obsKeepWindowBg) {
        document.body.classList.add('keep-window-bg-mode');
      }
      if (data.layoutSwapPanels) {
        document.body.classList.add('swap-panels-mode');
      }
      if (data.layoutMinimal) {
        document.body.classList.add('minimal-mode');
      }
    }
  } catch (e) {
    console.error('Failed to apply initial OBS modes:', e);
  }
})();

// --- Player State and Constants ---
const MIN_SEGMENT_DURATION = 30; // 30 minutes minimum segment
const COLORS = [
  'hsl(230, 45%, 35%)', // Dark night
  'hsl(45, 80%, 55%)',  // Sun morning
  'hsl(200, 80%, 50%)', // Sky afternoon
  'hsl(15, 80%, 50%)',  // Sunset evening
  'hsl(270, 50%, 35%)', // Purple night
  'hsl(160, 60%, 40%)', // Mint/teal
  'hsl(330, 70%, 45%)', // Pink
];

// Default configurations
const DEFAULT_CONFIG = {
  segments: [
    { id: '1', name: '深夜', start: 0, end: 360, color: COLORS[0], folderPath: 'bgmA' },
    { id: '2', name: '朝のBGM', start: 360, end: 720, color: COLORS[1], folderPath: 'bgmB' },
    { id: '3', name: '昼 of BGM', start: 720, end: 1020, color: COLORS[2], folderPath: 'bgmC' },
    { id: '4', name: '夕方BGM', start: 1020, end: 1140, color: COLORS[3], folderPath: 'bgmD' },
    { id: '5', name: '夜のBGM', start: 1140, end: 1440, color: COLORS[4], folderPath: 'bgmE' }
  ],
  isShuffle: true,
  globalVolume: 0.7,
  obsTransparent: false,
  obsHideControls: false,
  obsKeepWindowBg: false,
  layoutSwapPanels: false,
  layoutMinimal: false
};

// Initial state, will be loaded from localStorage
let segments = [];
let isShuffle = true;
let isMuted = false;
let globalVolume = 0.7;

// BGM Manifest (holds file list scanned from bgmA-F)
let bgmManifest = {
  bgmA: [], bgmB: [], bgmC: [], bgmD: [], bgmE: [], bgmF: []
};

let appFolderHandle = null;
const useBrowserLibrary = !!(window.ClockLibrary && window.ClockLibrary.isActive);
// obs.html（ブラウザソース）は再生役、index.html（ドック）は操作役
const isPlayerRole = document.body.dataset.role === 'player';
const isFileSystemAccessSupported = typeof window.showDirectoryPicker === 'function';

let cfgObsTransparent = false;
let cfgObsHideControls = false;
let cfgObsKeepWindowBg = false;
let cfgLayoutSwapPanels = false;
let cfgLayoutMinimal = false;

let activeSegmentIndex = -1;
let selectedSegmentIndex = 0;

// Playlist Management
let currentPlaylist = [];
let currentTrackIndex = -1;

const audio = new Audio();
audio.preload = 'auto';

let fadeIntervalId = null;
let isFading = false;

// DOM Elements
const timeDisplay = document.getElementById('time');
const dateDisplay = document.getElementById('date');
const activePeriodName = document.getElementById('active-period-name');


const trackTitle = document.getElementById('track-title');
const trackFolderName = document.getElementById('track-folder-name');
const progressWrapper = document.getElementById('progress-wrapper');
const progressFill = document.getElementById('progress-fill');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');

const btnPlay = document.getElementById('btn-play');
const playIcon = document.getElementById('play-icon');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnShuffle = document.getElementById('btn-shuffle');
const btnMute = document.getElementById('btn-mute');
const btnToggleConfig = document.getElementById('btn-toggle-config');
const configContainer = document.getElementById('config-container');
const volumeIcon = document.getElementById('volume-icon');
const volumeSlider = document.getElementById('volume-slider');

const timelineBar = document.getElementById('timeline-bar');
const btnAddSegment = document.getElementById('btn-add-segment');
const btnExportTemplate = document.getElementById('btn-export-template');
const btnImportTemplate = document.getElementById('btn-import-template');
const templateFileInput = document.getElementById('template-file-input');

const editorPanel = document.getElementById('editor-panel');
const editorNameInput = document.getElementById('editor-name');
const editorStartTime = document.getElementById('editor-start-time');
const editorEndTime = document.getElementById('editor-end-time');
const editorColor = document.getElementById('editor-color');

const btnDeleteSegment = document.getElementById('btn-delete-segment');
const folderStatusText = document.getElementById('folder-status-text');
let editorFolderSelect;

// Preset elements
let presetSelect;
const btnSavePreset = document.getElementById('btn-save-preset');
const btnDeletePreset = document.getElementById('btn-delete-preset');

const playlistModal = document.getElementById('playlist-modal');
const btnClosePlaylist = document.getElementById('btn-close-playlist');
const modalPlaylistList = document.getElementById('modal-playlist-list');
const trackFolder = document.getElementById('track-folder');
const obsTransparent = document.getElementById('obs-transparent');
const obsKeepWindowBg = document.getElementById('obs-keep-window-bg');
const obsHideControls = document.getElementById('obs-hide-controls');

const layoutSwapPanels = document.getElementById('layout-swap-panels');
const layoutMinimal = document.getElementById('layout-minimal');

// Debug elements
const debugTimeEnable = document.getElementById('debug-time-enable');
const debugTimeVal = document.getElementById('debug-time-val');

// --- Helper Formatting ---
function formatTime(minutes) {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function formatAudioTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function hslToHex(h, s, l) {
  l /= 100;
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function parseColorToHex(colorStr) {
  if (!colorStr) return '#ffffff';
  if (colorStr.startsWith('#')) return colorStr;
  const match = colorStr.match(/hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)/);
  if (match) {
    const h = parseInt(match[1], 10);
    const s = parseInt(match[2], 10);
    const l = parseInt(match[3], 10);
    return hslToHex(h, s, l);
  }
  return '#ffffff';
}

function timeStringToMinutes(timeStr) {
  const parts = timeStr.split(':');
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// Map Folder key to Display Name
function getFolderDisplayName(key) {
  const mapping = {
    'bgmA': 'bgmA',
    'bgmB': 'bgmB',
    'bgmC': 'bgmC',
    'bgmD': 'bgmD',
    'bgmE': 'bgmE',
    'bgmF': 'bgmF'
  };
  return mapping[key] || 'フォルダ未設定';
}

// --- Preset Management (localStorage) ---
function loadPresetsList() {
  if (!presetSelect) return;
  
  const options = [{ value: '', text: '-- プリセット選択 --' }];
  
  let presets = {};
  try {
    const rawPresets = localStorage.getItem('bgm_clock_presets');
    if (rawPresets) {
      presets = JSON.parse(rawPresets);
    } else {
      // Default sample presets
      presets = {
        "1. 標準スケジュール (5区分)": [
          { "name": "深夜", "start": 0, "end": 360, "color": COLORS[0], "folderPath": "bgmA" },
          { "name": "朝のBGM", "start": 360, "end": 720, "color": COLORS[1], "folderPath": "bgmB" },
          { "name": "昼のBGM", "start": 720, "end": 1020, "color": COLORS[2], "folderPath": "bgmC" },
          { "name": "夕方BGM", "start": 1020, "end": 1140, "color": COLORS[3], "folderPath": "bgmD" },
          { "name": "夜のBGM", "start": 1140, "end": 1440, "color": COLORS[4], "folderPath": "bgmE" }
        ],
        "2. チルアウト・ヒーリング": [
          { "name": "夜明けの海", "start": 0, "end": 300, "color": "hsl(230, 45%, 35%)", "folderPath": "bgmA" },
          { "name": "朝陽の部屋", "start": 300, "end": 600, "color": "hsl(45, 80%, 55%)", "folderPath": "bgmB" },
          { "name": "午後の森", "start": 600, "end": 1080, "color": "hsl(160, 60%, 40%)", "folderPath": "bgmC" },
          { "name": "夕暮れの街", "start": 1080, "end": 1260, "color": "hsl(15, 80%, 50%)", "folderPath": "bgmD" },
          { "name": "星空と瞑想", "start": 1260, "end": 1440, "color": "hsl(270, 50%, 35%)", "folderPath": "bgmE" }
        ],
        "3. 作業集中・ブースト": [
          { "name": "深夜フォーカス", "start": 0, "end": 360, "color": "hsl(270, 50%, 35%)", "folderPath": "bgmA" },
          { "name": "早朝リフレッシュ", "start": 360, "end": 540, "color": "hsl(160, 60%, 40%)", "folderPath": "bgmB" },
          { "name": "午前集中ワーク", "start": 540, "end": 720, "color": "hsl(200, 80%, 50%)", "folderPath": "bgmC" },
          { "name": "午後スパート", "start": 720, "end": 1080, "color": "hsl(330, 70%, 45%)", "folderPath": "bgmD" },
          { "name": "イブニングダウン", "start": 1080, "end": 1440, "color": "hsl(230, 45%, 35%)", "folderPath": "bgmE" }
        ]
      };
      localStorage.setItem('bgm_clock_presets', JSON.stringify(presets));
    }
  } catch (e) {
    console.error('Failed to parse presets:', e);
  }
  
  Object.keys(presets).sort().forEach(name => {
    options.push({ value: name, text: name });
  });
  
  presetSelect.setOptions(options);
  
  if (btnDeletePreset) {
    btnDeletePreset.style.display = 'none';
  }
}

// --- Init & Load ---
window.addEventListener('DOMContentLoaded', async () => {
  // 1. Load BGM playlist manifest
  await loadBgmManifest();

  // Initialize custom dropdowns
  presetSelect = createCustomDropdown('custom-preset-select', (selected) => {
    if (!selected) {
      if (btnDeletePreset) btnDeletePreset.style.display = 'none';
      return;
    }
    
    if (btnDeletePreset) btnDeletePreset.style.display = 'inline-block';
    
    let presets = {};
    try {
      const rawPresets = localStorage.getItem('bgm_clock_presets');
      if (rawPresets) presets = JSON.parse(rawPresets);
    } catch (e) {}
    
    const presetData = presets[selected];
    if (presetData && Array.isArray(presetData)) {
      segments = presetData.map((s, idx) => ({
        id: (Date.now() + idx).toString(),
        name: s.name,
        start: s.start,
        end: s.end,
        color: s.color,
        folderPath: s.folderPath || '',
        files: []
      }));
      
      for (let s of segments) {
        loadFilesForSegment(s);
      }
      
      saveConfig();
      renderTimeline();
      selectSegment(0);
      updateActiveTimeZone(true);
    }
  });

  editorFolderSelect = createCustomDropdown('custom-folder-select', (val) => {
    const activeSeg = segments[selectedSegmentIndex];
    activeSeg.folderPath = val;
    
    // Assign local files instantly
    loadFilesForSegment(activeSeg);
    saveConfig();
    
    updateFolderStatus(activeSeg);
    updateFolderConnectionUI();
    
    if (selectedSegmentIndex === activeSegmentIndex) {
      updateActiveTimeZone(true);
    }
  });

  // 2. Load configuration
  loadConfig();
  
  // Initialize folder connection for serverless copy
  if (useBrowserLibrary) {
    initBrowserLibraryUI();
  } else {
    initFolderConnection();
  }

  // 3. Load presets list
  loadPresetsList();

  // 4. Render UI
  renderTimeline();
  selectSegment(0);

  // Restore config panel open/close state
  const configPanelOpen = isDockMode() || localStorage.getItem('config_panel_open') === 'true';
  if (configPanelOpen && configContainer && btnToggleConfig) {
    configContainer.style.display = 'block';
    btnToggleConfig.classList.add('active-toggle');
  } else if (configContainer && btnToggleConfig) {
    configContainer.style.display = 'none';
    btnToggleConfig.classList.remove('active-toggle');
  }

  // 5. Start Clock
  startClock();
  
  // 6. Volume setup
  volumeSlider.value = globalVolume;
  updateVolumeUI();

  // 7. Playback handlers
  audio.addEventListener('timeupdate', updateProgressBar);
  audio.addEventListener('ended', handleTrackEnded);
  audio.addEventListener('loadedmetadata', () => {
    timeTotal.textContent = formatAudioTime(audio.duration);
  });
  
  if (isShuffle) {
    btnShuffle.classList.add('active-toggle');
  }

  // 8. Check initial time zone immediately
  // 操作役は再生役（OBS のブラウザソース）が居るか確かめてから鳴らす
  initSync();
  if (!isPlayerRole && syncChannel) {
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  updateActiveTimeZone(!isRemoteActive());
  
  // --- Preset Event Listeners ---
  if (btnSavePreset) {
    btnSavePreset.addEventListener('click', () => {
      const presetName = prompt('保存するプリセット名を入力してください:');
      if (!presetName) return;
      const trimmed = presetName.trim();
      if (!trimmed) return;
      
      let presets = {};
      try {
        const rawPresets = localStorage.getItem('bgm_clock_presets');
        if (rawPresets) presets = JSON.parse(rawPresets);
      } catch (e) {}
      
      presets[trimmed] = segments.map(s => ({
        name: s.name,
        start: s.start,
        end: s.end,
        color: s.color,
        folderPath: s.folderPath || ''
      }));
      
      localStorage.setItem('bgm_clock_presets', JSON.stringify(presets));
      loadPresetsList();
      presetSelect.value = trimmed;
      if (btnDeletePreset) btnDeletePreset.style.display = 'inline-block';
      alert(`プリセット「${trimmed}」をブラウザに保存しました。`);
    });
  }

  if (btnDeletePreset && presetSelect) {
    btnDeletePreset.addEventListener('click', () => {
      const selected = presetSelect.value;
      if (!selected) return;
      
      if (!confirm(`プリセット「${selected}」を削除しますか？`)) return;
      
      let presets = {};
      try {
        const rawPresets = localStorage.getItem('bgm_clock_presets');
        if (rawPresets) presets = JSON.parse(rawPresets);
      } catch (e) {}
      
      delete presets[selected];
      localStorage.setItem('bgm_clock_presets', JSON.stringify(presets));
      loadPresetsList();
      
      alert(`プリセット「${selected}」を削除しました。`);
    });
  }

  initSourceUrl();

  // --- Folder Connection & Copy Event Listeners ---
  const btnConnect = document.getElementById('btn-connect-folder');
  if (btnConnect) btnConnect.addEventListener('click', connectAppFolder);

  const btnDisconnect = document.getElementById('btn-disconnect-folder');
  if (btnDisconnect) btnDisconnect.addEventListener('click', disconnectAppFolder);

  const btnCopyFiles = document.getElementById('btn-copy-files');
  if (btnCopyFiles) btnCopyFiles.addEventListener('click', copyFilesToBgmFolder);

  const btnCloseProgress = document.getElementById('btn-close-copy-progress');
  if (btnCloseProgress) {
    btnCloseProgress.addEventListener('click', () => {
      document.getElementById('copy-progress-inline-section').style.display = 'none';
    });
  }

});

function applyOBSModes() {
  if (obsTransparent) cfgObsTransparent = obsTransparent.checked;
  if (obsHideControls) cfgObsHideControls = obsHideControls.checked;
  if (obsKeepWindowBg) cfgObsKeepWindowBg = obsKeepWindowBg.checked;
  if (layoutSwapPanels) cfgLayoutSwapPanels = layoutSwapPanels.checked;
  if (layoutMinimal) cfgLayoutMinimal = layoutMinimal.checked;

  const dock = isDockMode();
  document.body.classList.toggle('transparent-mode', cfgObsTransparent && !dock);
  document.body.classList.toggle('hide-controls-mode', cfgObsHideControls && !dock);
  document.body.classList.toggle('keep-window-bg-mode', cfgObsKeepWindowBg && !dock);
  document.body.classList.toggle('swap-panels-mode', cfgLayoutSwapPanels && !dock);
  document.body.classList.toggle('minimal-mode', cfgLayoutMinimal && !dock);
}

// Load manifest variables from bgm_manifest.js
async function loadBgmManifest() {
  if (useBrowserLibrary) {
    if (!isPlayerRole) await ClockLibrary.pruneMissing();
    bgmManifest = await ClockLibrary.loadManifest();
    return;
  }
  if (window.bgmManifest) {
    bgmManifest = {
      bgmA: window.bgmManifest.bgmA || [],
      bgmB: window.bgmManifest.bgmB || [],
      bgmC: window.bgmManifest.bgmC || [],
      bgmD: window.bgmManifest.bgmD || [],
      bgmE: window.bgmManifest.bgmE || [],
      bgmF: window.bgmManifest.bgmF || []
    };
  } else {
    console.warn('bgm_manifest.js is not loaded or missing. Please run update_bgm.bat to generate it.');
  }
}

let saveConfigPromise = Promise.resolve();
let isSaveConfigPending = false;
let pendingConfigData = null;
let saveDebounceTimeout = null;

// Save settings to LocalStorage and disk (Debounced and Queued to prevent concurrent file locking and .crswap accumulation)
function saveConfig() {
  const configData = {
    segments: segments.map(s => ({
      id: s.id,
      name: s.name,
      start: s.start,
      end: s.end,
      color: s.color,
      folderPath: s.folderPath || ''
    })),
    isShuffle,
    globalVolume,
    obsTransparent: obsTransparent ? obsTransparent.checked : cfgObsTransparent,
    obsHideControls: obsHideControls ? obsHideControls.checked : cfgObsHideControls,
    obsKeepWindowBg: obsKeepWindowBg ? obsKeepWindowBg.checked : cfgObsKeepWindowBg,
    layoutSwapPanels: layoutSwapPanels ? layoutSwapPanels.checked : cfgLayoutSwapPanels,
    layoutMinimal: layoutMinimal ? layoutMinimal.checked : cfgLayoutMinimal
  };

  try {
    localStorage.setItem('bgm_clock_config', JSON.stringify(configData));
  } catch (e) {
    console.error('LocalStorage save config failed:', e);
  }

  // Update window global cache
  window.bgmClockConfig = configData;

  // Debounce the disk write by 300ms
  if (saveDebounceTimeout) {
    clearTimeout(saveDebounceTimeout);
  }

  saveDebounceTimeout = setTimeout(() => {
    saveDebounceTimeout = null;
    triggerDiskSave(configData);
  }, 300);
}

// Queue writes to disk sequentially
function triggerDiskSave(configData) {
  if (!appFolderHandle) return;

  pendingConfigData = configData;

  if (isSaveConfigPending) {
    return;
  }

  isSaveConfigPending = true;

  saveConfigPromise = saveConfigPromise.then(async () => {
    const dataToWrite = pendingConfigData;
    pendingConfigData = null;

    if (!dataToWrite) {
      isSaveConfigPending = false;
      return;
    }

    try {
      if (await verifyPermission(appFolderHandle, true)) {
        const configContent = `window.bgmClockConfig = ${JSON.stringify(dataToWrite, null, 4)};`;
        const configFile = await appFolderHandle.getFileHandle('config.js', { create: true });
        const writable = await configFile.createWritable();
        await writable.write(configContent);
        await writable.close();
      }
    } catch (e) {
      console.error('Failed to save config.js to disk:', e);
    } finally {
      isSaveConfigPending = false;
      if (pendingConfigData) {
        triggerDiskSave(pendingConfigData);
      }
    }
  });
}

// Load settings
function loadConfig() {
  try {
    const data = readSavedConfig() || DEFAULT_CONFIG;

    if (data.segments && Array.isArray(data.segments)) {
      segments = data.segments.map(s => ({
        ...s,
        files: []
      }));
    }
    isShuffle = data.isShuffle !== undefined ? data.isShuffle : true;
    globalVolume = data.globalVolume !== undefined ? data.globalVolume : 0.7;
    
    cfgObsTransparent = data.obsTransparent !== undefined ? !!data.obsTransparent : false;
    cfgObsHideControls = data.obsHideControls !== undefined ? !!data.obsHideControls : false;
    cfgObsKeepWindowBg = data.obsKeepWindowBg !== undefined ? !!data.obsKeepWindowBg : false;
    cfgLayoutSwapPanels = data.layoutSwapPanels !== undefined ? !!data.layoutSwapPanels : false;
    cfgLayoutMinimal = data.layoutMinimal !== undefined ? !!data.layoutMinimal : false;

    if (obsTransparent) {
      obsTransparent.checked = cfgObsTransparent;
    }
    if (obsHideControls) {
      obsHideControls.checked = cfgObsHideControls;
    }

    if (obsKeepWindowBg) {
      obsKeepWindowBg.checked = cfgObsKeepWindowBg;
    }
    if (layoutSwapPanels) {
      layoutSwapPanels.checked = cfgLayoutSwapPanels;
    }
    if (layoutMinimal) {
      layoutMinimal.checked = cfgLayoutMinimal;
    }
    applyOBSModes();

    // Map scanned files to segments
    for (let s of segments) {
      loadFilesForSegment(s);
    }
  } catch (e) {
    console.error('LocalStorage load config failed, using defaults:', e);
    segments = DEFAULT_CONFIG.segments.map(s => ({ ...s, files: [] }));
    isShuffle = DEFAULT_CONFIG.isShuffle;
    globalVolume = DEFAULT_CONFIG.globalVolume;
    for (let s of segments) {
      loadFilesForSegment(s);
    }
  }
}

// Assign files locally from preloaded bgmManifest
function loadFilesForSegment(segment) {
  if (!segment.folderPath || !bgmManifest[segment.folderPath]) {
    segment.files = [];
    return;
  }
  segment.files = bgmManifest[segment.folderPath];
}

// --- Clock Logic ---
function startClock() {
  setInterval(updateClock, 1000);
  updateClock();
}

function updateClock() {
  let dateObj = new Date();
  
  if (debugTimeEnable && debugTimeEnable.checked) {
    const [h, m] = debugTimeVal.value.split(':');
    dateObj.setHours(parseInt(h), parseInt(m), 0);
  }

  // Render Time
  const hours = dateObj.getHours().toString().padStart(2, '0');
  const minutes = dateObj.getMinutes().toString().padStart(2, '0');
  const seconds = dateObj.getSeconds().toString().padStart(2, '0');
  if (timeDisplay) {
    timeDisplay.textContent = `${hours}:${minutes}:${seconds}`;
  }

  // Render Date
  const month = dateObj.getMonth() + 1;
  const day = dateObj.getDate();
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const wday = weekdays[dateObj.getDay()];
  if (dateDisplay) {
    dateDisplay.textContent = `${month}/${day} ${wday}`;
  }

  // Update Active timezone checking
  updateActiveTimeZone(false);
}

// Get current minute count (0 - 1439)
function getCurrentTimeInMinutes() {
  let dateObj = new Date();
  if (debugTimeEnable && debugTimeEnable.checked) {
    const [h, m] = debugTimeVal.value.split(':');
    return parseInt(h) * 60 + parseInt(m);
  }
  return dateObj.getHours() * 60 + dateObj.getMinutes();
}

// Evaluate active segment based on current time
function updateActiveTimeZone(forcePlay = false) {
  const currentMin = getCurrentTimeInMinutes();
  let foundIndex = -1;
  
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (currentMin >= s.start && currentMin < s.end) {
      foundIndex = i;
      break;
    }
  }

  if (foundIndex !== activeSegmentIndex || forcePlay) {
    const oldIndex = activeSegmentIndex;
    activeSegmentIndex = foundIndex;
    handleActiveSegmentChange(oldIndex, activeSegmentIndex, forcePlay);
  }
}

// Trigger transition when timezone switches
function handleActiveSegmentChange(oldIndex, newIndex, forcePlay) {
  // 時間帯を切り替える前の再生状態を保持し、停止中の意図しない自動再生を防ぐ
  const wasPlaying = !audio.paused;

  // Update Theme
  updateThemeClass(newIndex);
  
  if (newIndex === -1) {
    if (activePeriodName) activePeriodName.textContent = 'BGM設定なし';
    fadeAndStop();
    return;
  }
  
  const currentSeg = segments[newIndex];
  if (activePeriodName) {
    activePeriodName.textContent = `${currentSeg.name} (${formatTime(currentSeg.start)} - ${formatTime(currentSeg.end)})`;
  }
  
  if (currentSeg.files.length === 0) {
    if (trackTitle) trackTitle.textContent = '曲が登録されていません';
    if (trackFolderName) trackFolderName.textContent = getFolderDisplayName(currentSeg.folderPath);
    fadeAndStop();
  } else {
    if (trackFolderName) trackFolderName.textContent = getFolderDisplayName(currentSeg.folderPath);
    buildPlaylistForSegment(currentSeg);
    // 再生中の時間帯切替、または再生ボタンからの明示的な要求の場合だけ再生する
    if (wasPlaying || forcePlay) {
      playNextTrack(true); // Switch & play immediately
    } else if (trackTitle && trackTitle.textContent === '曲が登録されていません') {
      trackTitle.textContent = '再生中の曲はありません';
    }
  }
}

function hexToHsl(hexStr) {
  const hex = hexStr.slice(1);
  let r = parseInt(hex.slice(0, 2), 16) / 255;
  let g = parseInt(hex.slice(2, 4), 16) / 255;
  let b = parseInt(hex.slice(4, 6), 16) / 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100)
  };
}

function parseToHsl(colorStr) {
  if (!colorStr) return { h: 0, s: 0, l: 0 };
  let match = colorStr.match(/hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)/);
  if (match) {
    return {
      h: parseInt(match[1], 10),
      s: parseInt(match[2], 10),
      l: parseInt(match[3], 10)
    };
  }
  if (colorStr.startsWith('#')) {
    return hexToHsl(colorStr);
  }
  return { h: 0, s: 0, l: 50 };
}

function applyThemeColor(color) {
  const hsl = parseToHsl(color);
  const isAchromatic = hsl.s < 5;
  
  // Calculate dark version of the same hue with increased saturation and lowered lightness
  const sDark = isAchromatic ? hsl.s : Math.min(100, Math.max(hsl.s + 15, 60));
  const lDark = Math.max(6, Math.min(16, Math.round(hsl.l * 0.3)));
  const darkColor = `hsl(${hsl.h}, ${sDark}%, ${lDark}%)`;

  // Dynamic gradient: starting from the custom color, ending at the rich dark color with the same hue
  document.body.style.setProperty('--bg-gradient', `linear-gradient(135deg, ${color} 0%, ${darkColor} 100%)`);
  
  const lightness = hsl.l;
  if (lightness > 60) {
    const sat = isAchromatic ? hsl.s : Math.min(100, Math.max(hsl.s, 75));
    const primaryColorVal = `hsl(${hsl.h}, ${sat}%, ${Math.max(20, Math.min(45, hsl.l - 25))}%)`;
    const primaryGlowVal = `hsla(${hsl.h}, ${sat}%, ${Math.max(20, Math.min(45, hsl.l - 25))}%, 0.35)`;
    
    document.body.style.setProperty('--text-main', isAchromatic ? 'hsl(0, 0%, 20%)' : 'hsl(210, 60%, 20%)');
    document.body.style.setProperty('--text-muted', isAchromatic ? 'hsl(0, 0%, 45%)' : 'hsl(210, 40%, 40%)');
    document.body.style.setProperty('--glass-bg', 'rgba(255, 255, 255, 0.35)');
    document.body.style.setProperty('--glass-border', 'rgba(255, 255, 255, 0.45)');
    document.body.style.setProperty('--glass-highlight', 'rgba(255, 255, 255, 0.55)');
    document.body.style.setProperty('--card-shadow', '0 8px 32px 0 rgba(80, 110, 130, 0.15)');
    document.body.style.setProperty('--primary-color', primaryColorVal);
    document.body.style.setProperty('--primary-glow', primaryGlowVal);

    // Dynamic glass styling for OBS transparent background mode (light theme)
    document.body.style.setProperty('--glass-transparent-bg', `hsla(${hsl.h}, ${isAchromatic ? 0 : Math.max(30, hsl.s)}%, 92%, 0.85)`);
    document.body.style.setProperty('--glass-transparent-border', `hsla(${hsl.h}, ${isAchromatic ? 0 : Math.max(30, hsl.s)}%, 70%, 0.4)`);
  } else {
    const sat = isAchromatic ? hsl.s : Math.min(100, Math.max(hsl.s, 85));
    const primaryColorVal = `hsl(${hsl.h}, ${sat}%, ${Math.max(65, Math.min(85, hsl.l + 10))}%)`;
    const primaryGlowVal = `hsla(${hsl.h}, ${sat}%, ${Math.max(65, Math.min(85, hsl.l + 10))}%, 0.45)`;

    document.body.style.setProperty('--text-main', isAchromatic ? '#f0f0f0' : '#f0f3ff');
    document.body.style.setProperty('--text-muted', isAchromatic ? 'rgba(240, 240, 240, 0.5)' : 'rgba(240, 243, 255, 0.5)');
    document.body.style.setProperty('--glass-bg', 'rgba(255, 255, 255, 0.05)');
    document.body.style.setProperty('--glass-border', 'rgba(255, 255, 255, 0.08)');
    document.body.style.setProperty('--glass-highlight', 'rgba(255, 255, 255, 0.12)');
    document.body.style.setProperty('--card-shadow', '0 8px 32px 0 rgba(0, 0, 0, 0.5)');
    document.body.style.setProperty('--primary-color', primaryColorVal);
    document.body.style.setProperty('--primary-glow', primaryGlowVal);

    // Dynamic glass styling for OBS transparent background mode (dark theme)
    document.body.style.setProperty('--glass-transparent-bg', `hsla(${hsl.h}, ${isAchromatic ? 0 : Math.max(35, Math.round(hsl.s * 0.7))}%, 12%, 0.8)`);
    document.body.style.setProperty('--glass-transparent-border', `hsla(${hsl.h}, ${isAchromatic ? 0 : Math.max(35, Math.round(hsl.s * 0.7))}%, 35%, 0.35)`);
  }
}

// Update class on body for dynamic theme gradient
function updateThemeClass(index) {
  document.body.className = '';
  if (index === -1) {
    document.body.classList.add('theme-night');
    applyThemeColor('hsl(230, 50%, 10%)');
    applyOBSModes();
    return;
  }
  
  const segment = segments[index];
  const name = segment.name;
  
  if (name.includes('朝')) {
    document.body.classList.add('theme-morning');
  } else if (name.includes('昼')) {
    document.body.classList.add('theme-afternoon');
  } else if (name.includes('夕')) {
    document.body.classList.add('theme-evening');
  } else if (name.includes('夜') || name.includes('晩') || name.includes('深夜')) {
    document.body.classList.add('theme-night');
  } else {
    const themeIndex = index % 4;
    const themes = ['theme-morning', 'theme-afternoon', 'theme-evening', 'theme-night'];
    document.body.classList.add(themes[themeIndex]);
  }
  
  applyThemeColor(segment.color);
  applyOBSModes();
}

// --- Playlist & Audio Controller ---
function buildPlaylistForSegment(segment) {
  currentPlaylist = [...segment.files];
  if (isShuffle) {
    shuffleArray(currentPlaylist);
  }
  currentTrackIndex = 0;
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// ファイルの無い曲をまとめて曲リストから外し、他の画面にも知らせる（連続で失敗しても1回にまとめる）
let pruneTimer = null;
function schedulePruneMissing() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(async () => {
    pruneTimer = null;
    if (await ClockLibrary.pruneMissing() > 0) notifyLibraryUpdated();
  }, 500);
}

// Smoothly fade out and play next track
function playNextTrack(immediateStart = false) {
  if (currentPlaylist.length === 0) return;

  if (currentTrackIndex >= currentPlaylist.length) {
    if (isShuffle && currentPlaylist.length > 1) {
      const currentSegment = segments[activeSegmentIndex];
      buildPlaylistForSegment(currentSegment);
    } else {
      currentTrackIndex = 0;
    }
  }

  const file = currentPlaylist[currentTrackIndex];
  
  if (isRemoteActive()) return;

  const playlistAtStart = currentPlaylist;
  const playTrack = async () => {
    try {
      if (fadeIntervalId) clearInterval(fadeIntervalId);
      audio.src = useBrowserLibrary ? await ClockLibrary.getTrackUrl(file.path) : file.path;
      updateTrackTitleDisplay(file);
      broadcastPlayerState();

      
      audio.volume = 0;
      audio.play().then(() => {
        setPlayingUI(true);
        // Fade in
        const targetVol = isMuted ? 0 : globalVolume;
        let currentVol = 0;
        const fadeInterval = 50;
        const fadeStep = targetVol / (1000 / fadeInterval); // 1.0 second fade
        
        fadeIntervalId = setInterval(() => {
          currentVol += fadeStep;
          if (currentVol >= targetVol) {
            clearInterval(fadeIntervalId);
            fadeIntervalId = null;
            audio.volume = targetVol;
          } else {
            audio.volume = currentVol;
          }
        }, fadeInterval);
      }).catch(err => {
        console.warn('Auto-play blocked, waiting for user interaction:', err);
        setPlayingUI(false);
      });
    } catch (e) {
      // 読み込み中にプレイリストが作り直されていたら、この失敗は古いので無視する
      if (currentPlaylist !== playlistAtStart) return;
      if (e.name === 'NotFoundError' && useBrowserLibrary) {
        // 曲リストにあるのにファイルが無い。リストから外して次の曲へ
        console.warn('Track file missing, removing from list:', file.path);
        const idx = currentPlaylist.indexOf(file);
        if (idx !== -1) currentPlaylist.splice(idx, 1);
        currentTrackIndex = idx !== -1 ? idx : currentTrackIndex;
        for (const s of segments) s.files = s.files.filter(f => f.path !== file.path);
        schedulePruneMissing();
        if (currentPlaylist.length > 0) {
          if (currentTrackIndex >= currentPlaylist.length) currentTrackIndex = 0;
          playNextTrack(immediateStart);
        } else {
          audio.removeAttribute('src');
          setPlayingUI(false);
          if (trackTitle) trackTitle.textContent = '曲が登録されていません';
        }
        return;
      }
      console.error('Error starting play:', e);
      currentTrackIndex++;
      if (currentTrackIndex < currentPlaylist.length) playNextTrack(immediateStart);
    }
  };

  if (immediateStart || audio.paused || isFading) {
    playTrack();
  } else {
    isFading = true;
    if (fadeIntervalId) clearInterval(fadeIntervalId);
    
    let currentVol = audio.volume;
    const fadeInterval = 50;
    const fadeStep = currentVol / (1200 / fadeInterval); // 1.2 second fade
    
    fadeIntervalId = setInterval(() => {
      currentVol -= fadeStep;
      if (currentVol <= 0) {
        clearInterval(fadeIntervalId);
        fadeIntervalId = null;
        isFading = false;
        playTrack();
      } else {
        audio.volume = currentVol;
      }
    }, fadeInterval);
  }
}

function fadeAndStop() {
  if (fadeIntervalId) clearInterval(fadeIntervalId);
  if (!audio.paused) {
    let currentVol = audio.volume;
    const fadeInterval = 50;
    const fadeStep = currentVol / (1200 / fadeInterval); // 1.2 second fade
    
    fadeIntervalId = setInterval(() => {
      currentVol -= fadeStep;
      if (currentVol <= 0) {
        clearInterval(fadeIntervalId);
        fadeIntervalId = null;
        audio.pause();
        audio.removeAttribute('src');
        setPlayingUI(false);
        audio.volume = isMuted ? 0 : globalVolume;
      } else {
        audio.volume = currentVol;
      }
    }, fadeInterval);
  } else {
    audio.pause();
    audio.removeAttribute('src');
    setPlayingUI(false);
    audio.volume = isMuted ? 0 : globalVolume;
  }
}

function handleTrackEnded() {
  currentTrackIndex++;
  playNextTrack(false);
}

function setPlayingUI(playing) {
  if (playing) {
    if (playIcon) playIcon.innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
  } else {
    if (playIcon) playIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
  }
}

// Media Controls Actions
btnPlay.addEventListener('click', () => {
  if (isRemoteActive()) {
    sendRemoteCommand('toggle');
    return;
  }
  if (audio.paused) {
    if (audio.getAttribute('src')) {
      audio.volume = 0;
      audio.play().then(() => {
        setPlayingUI(true);
        const targetVol = isMuted ? 0 : globalVolume;
        let currentVol = 0;
        const fadeInterval = 50;
        const fadeStep = targetVol / (500 / fadeInterval); // 0.5 second fade
        
        if (fadeIntervalId) clearInterval(fadeIntervalId);
        fadeIntervalId = setInterval(() => {
          currentVol += fadeStep;
          if (currentVol >= targetVol) {
            clearInterval(fadeIntervalId);
            fadeIntervalId = null;
            audio.volume = targetVol;
          } else {
            audio.volume = currentVol;
          }
        }, fadeInterval);
      }).catch(err => {
        // 読み込めない音声が残っていた場合は、今の時間帯の曲を選び直す
        console.warn('Resume failed, restarting playlist:', err);
        audio.removeAttribute('src');
        updateActiveTimeZone(true);
      });
    } else {
      updateActiveTimeZone(true);
    }
  } else {
    audio.pause();
    setPlayingUI(false);
  }
});


btnNext.addEventListener('click', () => {
  if (isRemoteActive()) {
    sendRemoteCommand('next');
    return;
  }
  if (currentPlaylist.length > 0) {
    currentTrackIndex++;
    playNextTrack(true);
  }
});

btnPrev.addEventListener('click', () => {
  if (isRemoteActive()) {
    sendRemoteCommand('prev');
    return;
  }
  if (currentPlaylist.length > 0) {
    currentTrackIndex--;
    if (currentTrackIndex < 0) {
      currentTrackIndex = currentPlaylist.length - 1;
    }
    playNextTrack(true);
  }
});

btnShuffle.addEventListener('click', () => {
  isShuffle = !isShuffle;
  btnShuffle.classList.toggle('active-toggle', isShuffle);
  saveConfig();
  
  if (activeSegmentIndex !== -1) {
    const curSeg = segments[activeSegmentIndex];
    if (curSeg.files.length > 0) {
      buildPlaylistForSegment(curSeg);
    }
  }
});

// Progress controls
function updateProgressBar() {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  if (progressFill) progressFill.style.width = `${pct}%`;
  if (timeCurrent) timeCurrent.textContent = formatAudioTime(audio.currentTime);
}

if (progressWrapper) {
  progressWrapper.addEventListener('click', (e) => {
    const rect = progressWrapper.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const pct = clickX / width;
    if (isRemoteActive()) {
      sendRemoteCommand('seek', pct);
      return;
    }
    if (!audio.duration) return;
    audio.currentTime = pct * audio.duration;
  });
}

// Volume & Mute Actions
if (volumeSlider) {
  volumeSlider.addEventListener('input', (e) => {
    globalVolume = parseFloat(e.target.value);
    if (isMuted) {
      isMuted = false;
    }
    updateVolumeUI();
  });
  
  volumeSlider.addEventListener('change', () => {
    saveConfig();
  });
}

if (btnMute) {
  btnMute.addEventListener('click', () => {
    isMuted = !isMuted;
    updateVolumeUI();
  });
}

if (btnToggleConfig && configContainer) {
  btnToggleConfig.addEventListener('click', () => {
    const isHidden = configContainer.style.display === 'none';
    configContainer.style.display = isHidden ? 'block' : 'none';
    btnToggleConfig.classList.toggle('active-toggle', isHidden);
    localStorage.setItem('config_panel_open', isHidden ? 'true' : 'false');
  });
}

if (obsTransparent) {
  obsTransparent.addEventListener('change', () => {
    applyOBSModes();
    saveConfig();
  });
}

if (obsKeepWindowBg) {
  obsKeepWindowBg.addEventListener('change', () => {
    applyOBSModes();
    saveConfig();
  });
}

if (obsHideControls) {
  obsHideControls.addEventListener('change', () => {
    applyOBSModes();
    saveConfig();
  });
}

if (layoutSwapPanels) {
  layoutSwapPanels.addEventListener('change', () => {
    applyOBSModes();
    saveConfig();
  });
}

if (layoutMinimal) {
  layoutMinimal.addEventListener('change', () => {
    applyOBSModes();
    saveConfig();
  });
}

function updateVolumeUI() {
  audio.volume = isMuted ? 0 : globalVolume;
  if (isRemoteActive()) {
    // ドックの音量操作はブラウザソースの再生に反映する
    sendRemoteCommand('volume', { volume: globalVolume, muted: isMuted });
  }
  
  if (!volumeIcon) return;
  if (isMuted || globalVolume === 0) {
    volumeIcon.innerHTML = `<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>`;
  } else if (globalVolume < 0.4) {
    volumeIcon.innerHTML = `<path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>`;
  } else {
    volumeIcon.innerHTML = `<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>`;
  }
}


// --- Timeline Rendering and Drag-and-Drop Editor ---
function renderTimeline() {
  if (!timelineBar) return;
  timelineBar.innerHTML = '';
  
  segments.forEach((seg, idx) => {
    const widthPct = ((seg.end - seg.start) / 1440) * 100;
    
    const segDiv = document.createElement('div');
    segDiv.className = `timeline-segment ${idx === selectedSegmentIndex ? 'active-segment' : ''}`;
    segDiv.style.width = `${widthPct}%`;
    segDiv.style.backgroundColor = seg.color;
    
    const labelSpan = document.createElement('span');
    labelSpan.className = 'timeline-segment-label';
    labelSpan.textContent = `${seg.name} (${formatTime(seg.start)})`;
    segDiv.appendChild(labelSpan);
    
    segDiv.addEventListener('click', () => selectSegment(idx));
    timelineBar.appendChild(segDiv);
    
    if (idx < segments.length - 1) {
      const handleDiv = document.createElement('div');
      handleDiv.className = 'timeline-handle';
      handleDiv.style.left = `${(seg.end / 1440) * 100}%`;
      
      handleDiv.addEventListener('mousedown', (e) => startDragHandle(e, idx));
      handleDiv.addEventListener('touchstart', (e) => startDragHandle(e, idx), { passive: true });
      
      timelineBar.appendChild(handleDiv);
    }
  });
}

// Drag timeline boundary handle
function startDragHandle(e, index) {
  e.stopPropagation();
  
  const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
  const startX = clientX;
  const startVal = segments[index].end;
  const barRect = timelineBar.getBoundingClientRect();
  const barWidth = barRect.width;
  
  const minVal = segments[index].start + MIN_SEGMENT_DURATION;
  const maxVal = segments[index + 1].end - MIN_SEGMENT_DURATION;

  function onDrag(moveEvent) {
    const moveX = moveEvent.type.startsWith('touch') ? moveEvent.touches[0].clientX : moveEvent.clientX;
    const deltaX = moveX - startX;
    const deltaMin = Math.round((deltaX / barWidth) * 1440);
    
    let newVal = startVal + deltaMin;
    newVal = Math.max(minVal, Math.min(maxVal, newVal));
    
    newVal = Math.round(newVal / 5) * 5;
    
    segments[index].end = newVal;
    segments[index + 1].start = newVal;
    
    renderTimeline();
    updateEditorRangeDisplay();
  }

  async function onDragEnd() {
    window.removeEventListener('mousemove', onDrag);
    window.removeEventListener('mouseup', onDragEnd);
    window.removeEventListener('touchmove', onDrag);
    window.removeEventListener('touchend', onDragEnd);
    
    saveConfig();
    updateActiveTimeZone(false);
  }

  window.addEventListener('mousemove', onDrag);
  window.addEventListener('mouseup', onDragEnd);
  window.addEventListener('touchmove', onDrag, { passive: true });
  window.addEventListener('touchend', onDragEnd);
}

// Update background color of dropdown selects to match time zone (segment) color
function updateDropdownColors(color) {
  const hsl = parseToHsl(color);
  
  // Set background of select menus to a slightly transparent version of the segment color
  const selectBg = `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, 0.25)`;
  const selectBorder = `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, 0.5)`;
  
  // Text color based on lightness
  const selectText = hsl.l > 60 ? 'hsl(210, 60%, 20%)' : '#f0f3ff';
  
  const dropdowns = [editorFolderSelect, presetSelect];
  dropdowns.forEach(dropdown => {
    if (dropdown) {
      dropdown.style.backgroundColor = selectBg;
      dropdown.style.borderColor = selectBorder;
      dropdown.style.color = selectText;
    }
  });
}

// Select a segment in settings panel
function selectSegment(index) {
  selectedSegmentIndex = index;
  renderTimeline();
  
  const seg = segments[index];
  if (editorPanel) editorPanel.style.display = 'block';
  if (editorNameInput) editorNameInput.value = seg.name;
  if (editorFolderSelect) {
    editorFolderSelect.value = seg.folderPath || '';
  }
  updateEditorRangeDisplay();
  updateFolderStatus(seg);
  updateDropdownColors(seg.color);
  updateFolderConnectionUI();
  
  if (btnDeleteSegment) {
    btnDeleteSegment.style.display = segments.length > 1 ? 'block' : 'none';
  }
}

function updateFolderStatus(seg) {
  if (folderStatusText) {
    folderStatusText.textContent = `合計 ${seg.files.length} 曲の音楽がロードされています`;
  }
}

function updateEditorRangeDisplay() {
  const seg = segments[selectedSegmentIndex];
  if (editorStartTime) {
    editorStartTime.value = formatTime(seg.start);
    editorStartTime.disabled = (selectedSegmentIndex === 0);
  }
  if (editorEndTime) {
    editorEndTime.value = formatTime(seg.end);
    editorEndTime.disabled = (selectedSegmentIndex === segments.length - 1);
  }
  if (editorColor) {
    editorColor.value = parseColorToHex(seg.color);
  }
}

// Handle manual time input changes
if (editorStartTime) {
  editorStartTime.addEventListener('change', async (e) => {
    const val = e.target.value;
    const minutes = timeStringToMinutes(val);
    if (minutes === null) return;
    
    if (selectedSegmentIndex === 0) return;
    
    const minVal = segments[selectedSegmentIndex - 1].start + MIN_SEGMENT_DURATION;
    const maxVal = segments[selectedSegmentIndex].end - MIN_SEGMENT_DURATION;
    
    let clampedMinutes = Math.max(minVal, Math.min(maxVal, minutes));
    clampedMinutes = Math.round(clampedMinutes / 5) * 5;
    
    segments[selectedSegmentIndex].start = clampedMinutes;
    segments[selectedSegmentIndex - 1].end = clampedMinutes;
    
    renderTimeline();
    updateEditorRangeDisplay();
    saveConfig();
    updateActiveTimeZone(false);
  });
}

if (editorEndTime) {
  editorEndTime.addEventListener('change', async (e) => {
    const val = e.target.value;
    const minutes = timeStringToMinutes(val);
    if (minutes === null) return;
    
    if (selectedSegmentIndex === segments.length - 1) return;
    
    const minVal = segments[selectedSegmentIndex].start + MIN_SEGMENT_DURATION;
    const maxVal = segments[selectedSegmentIndex + 1].end - MIN_SEGMENT_DURATION;
    
    let clampedMinutes = Math.max(minVal, Math.min(maxVal, minutes));
    clampedMinutes = Math.round(clampedMinutes / 5) * 5;
    
    segments[selectedSegmentIndex].end = clampedMinutes;
    segments[selectedSegmentIndex + 1].start = clampedMinutes;
    
    renderTimeline();
    updateEditorRangeDisplay();
    saveConfig();
    updateActiveTimeZone(false);
  });
}

// Handle color picker changes
if (editorColor) {
  editorColor.addEventListener('input', (e) => {
    const color = e.target.value;
    segments[selectedSegmentIndex].color = color;
    renderTimeline();
    
    if (selectedSegmentIndex === activeSegmentIndex) {
      applyThemeColor(color);
    }
    
    updateDropdownColors(color);
  });
  
  editorColor.addEventListener('change', () => {
    saveConfig();
    updateActiveTimeZone(false);
  });
}

// Handle renaming segment
if (editorNameInput) {
  editorNameInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) {
      segments[selectedSegmentIndex].name = val;
      renderTimeline();
    }
  });

  editorNameInput.addEventListener('change', () => {
    saveConfig();
    updateActiveTimeZone(false);
  });
}

// Custom dropdown handles folder selection via onChange callback now

// Delete selected segment
if (btnDeleteSegment) {
  btnDeleteSegment.addEventListener('click', async () => {
    if (segments.length <= 1) return;
    
    if (selectedSegmentIndex === segments.length - 1) {
      segments[selectedSegmentIndex - 1].end = 1440;
      segments.splice(selectedSegmentIndex, 1);
      selectedSegmentIndex--;
    } else {
      segments[selectedSegmentIndex + 1].start = segments[selectedSegmentIndex].start;
      segments.splice(selectedSegmentIndex, 1);
    }
    
    saveConfig();
    selectSegment(Math.max(0, selectedSegmentIndex));
    updateActiveTimeZone(true);
  });
}

// Add new segment by splitting
if (btnAddSegment) {
  btnAddSegment.addEventListener('click', async () => {
    const seg = segments[selectedSegmentIndex];
    const duration = seg.end - seg.start;
    
    if (duration < MIN_SEGMENT_DURATION * 2) {
      alert('この時間帯は短すぎるため、これ以上分割できません。');
      return;
    }
    
    const splitPoint = seg.start + Math.round(duration / 2);
    
    const newId = Date.now().toString();
    const nextColor = COLORS[segments.length % COLORS.length];
    const newSegment = {
      id: newId,
      name: '新規時間帯',
      start: splitPoint,
      end: seg.end,
      color: nextColor,
      folderPath: '',
      files: []
    };
    
    seg.end = splitPoint;
    segments.splice(selectedSegmentIndex + 1, 0, newSegment);
    
    saveConfig();
    selectSegment(selectedSegmentIndex + 1);
    updateActiveTimeZone(true);
  });
}

// Export schedule template to a file
if (btnExportTemplate) {
  btnExportTemplate.addEventListener('click', () => {
    const templateData = segments.map(s => ({
      name: s.name,
      start: s.start,
      end: s.end,
      color: s.color,
      folderPath: s.folderPath || ''
    }));
    
    const jsonStr = JSON.stringify(templateData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `bgm_schedule_template_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

// Open file dialog when import button clicked
if (btnImportTemplate && templateFileInput) {
  btnImportTemplate.addEventListener('click', () => {
    templateFileInput.value = '';
    templateFileInput.click();
  });
  
  templateFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('テンプレートの形式が正しくありません (配列ではありません)');
        }
        
        const validatedSegments = [];
        parsed.sort((a, b) => a.start - b.start);
        
        for (let i = 0; i < parsed.length; i++) {
          const s = parsed[i];
          if (typeof s.name !== 'string' || typeof s.start !== 'number' || typeof s.end !== 'number' || typeof s.color !== 'string') {
            throw new Error(`時間帯データが破損しているか、必要なプロパティが不足しています (index: ${i})`);
          }
          
          validatedSegments.push({
            id: (Date.now() + i).toString(),
            name: s.name,
            start: s.start,
            end: s.end,
            color: s.color,
            folderPath: s.folderPath || '',
            files: []
          });
        }
        
        if (validatedSegments[0].start !== 0 || validatedSegments[validatedSegments.length - 1].end !== 1440) {
          throw new Error('スケジュールは00:00から始まり、24:00で終わる必要があります');
        }
        
        for (let i = 0; i < validatedSegments.length - 1; i++) {
          if (validatedSegments[i].end !== validatedSegments[i + 1].start) {
            throw new Error('時間帯の間に隙間や重複があります');
          }
          if (validatedSegments[i].end - validatedSegments[i].start < MIN_SEGMENT_DURATION) {
            throw new Error(`各時間帯は最低${MIN_SEGMENT_DURATION}分以上である必要があります`);
          }
        }
        
        segments = validatedSegments;
        
        for (let s of segments) {
          loadFilesForSegment(s);
        }
        
        saveConfig();
        
        selectSegment(0);
        updateActiveTimeZone(true);
        
        alert('テンプレートが正常にロードされました！');
      } catch (err) {
        console.error('Import template failed:', err);
        alert(`テンプレートのインポートに失敗しました:\n${err.message}`);
      }
    };
    reader.readAsText(file);
  });
}

// Debug tool changes listener
if (debugTimeEnable) {
  debugTimeEnable.addEventListener('change', () => {
    updateClock();
  });
}
if (debugTimeVal) {
  debugTimeVal.addEventListener('input', () => {
    if (debugTimeEnable && debugTimeEnable.checked) {
      updateClock();
    }
  });
}

// --- Playlist Modal Controller ---
function openPlaylistModal() {
  if (!playlistModal || !modalPlaylistList) return;
  
  modalPlaylistList.innerHTML = '';
  
  if (currentPlaylist.length === 0) {
    modalPlaylistList.innerHTML = '<div style="color:var(--text-muted); font-size:0.9rem; padding:20px; text-align:center;">プレイリストは空です</div>';
  } else {
    currentPlaylist.forEach((file, idx) => {
      const item = document.createElement('div');
      const isActiveTrack = isRemoteActive() ? (remoteState && file.path === remoteState.path) : idx === currentTrackIndex;
      item.className = `modal-playlist-item ${isActiveTrack ? 'active-track' : ''}`;
      
      const titleSpan = document.createElement('span');
      const displayName = (file.artist && file.title) ? `${file.title} - ${file.artist}` : file.name.replace(/\.[^/.]+$/, "");
      titleSpan.textContent = `${idx + 1}. ${displayName}`;
      item.appendChild(titleSpan);

      
      item.addEventListener('click', () => {
        playTrackByIndex(idx);
      });
      
      modalPlaylistList.appendChild(item);
    });

    // Auto-scroll to active track
    setTimeout(() => {
      const activeEl = modalPlaylistList.querySelector('.active-track');
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  }
  
  playlistModal.style.display = 'flex';
}

function closePlaylistModal() {
  if (playlistModal) {
    playlistModal.style.display = 'none';
  }
}

function playTrackByIndex(index) {
  if (index < 0 || index >= currentPlaylist.length) return;
  if (isRemoteActive()) {
    sendRemoteCommand('play-path', currentPlaylist[index].path);
    setTimeout(openPlaylistModal, 300);
    return;
  }
  currentTrackIndex = index;
  
  playNextTrack(true);
  openPlaylistModal();
}

// Playlist Modal Event Listeners
if (trackFolder) {
  trackFolder.addEventListener('click', openPlaylistModal);
}
if (btnClosePlaylist) {
  btnClosePlaylist.addEventListener('click', closePlaylistModal);
}
if (playlistModal) {
  playlistModal.addEventListener('click', (e) => {
    if (e.target === playlistModal) {
      closePlaylistModal();
    }
  });
}

// --- Custom Dropdown Component to Support OBS Browser Source Interaction ---
function createCustomDropdown(elementId, onChangeCallback) {
  const container = document.getElementById(elementId);
  if (!container) return null;
  
  const trigger = container.querySelector('.custom-dropdown-trigger');
  const valueSpan = container.querySelector('.custom-dropdown-value');
  const optionsContainer = container.querySelector('.custom-dropdown-options');
  
  let value = '';
  
  const dropdownObject = {
    get value() {
      return value;
    },
    set value(newVal) {
      value = newVal;
      const options = optionsContainer.querySelectorAll('.custom-dropdown-option');
      let found = false;
      options.forEach(opt => {
        if (opt.getAttribute('data-value') === newVal) {
          opt.classList.add('selected');
          valueSpan.textContent = opt.textContent;
          found = true;
        } else {
          opt.classList.remove('selected');
        }
      });
      if (!found && newVal === '') {
        valueSpan.textContent = '-- 選択 --';
      }
    },
    setOptions(optionsArray) {
      optionsContainer.innerHTML = '';
      optionsArray.forEach(item => {
        const div = document.createElement('div');
        div.className = 'custom-dropdown-option';
        div.setAttribute('data-value', item.value);
        div.textContent = item.text;
        if (item.value === value) {
          div.classList.add('selected');
          valueSpan.textContent = item.text;
        }
        div.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdownObject.value = item.value;
          container.classList.remove('open');
          if (onChangeCallback) onChangeCallback(item.value);
        });
        optionsContainer.appendChild(div);
      });
    },
    // Mirror styles to the trigger button for dynamic HSL coloring
    style: trigger.style
  };
  
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close other custom dropdowns
    document.querySelectorAll('.custom-dropdown').forEach(dropdown => {
      if (dropdown !== container) dropdown.classList.remove('open');
    });
    container.classList.toggle('open');
  });
  
  // Bind click logic for static options (like folder list)
  const staticOptions = optionsContainer.querySelectorAll('.custom-dropdown-option');
  staticOptions.forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = opt.getAttribute('data-value');
      dropdownObject.value = val;
      container.classList.remove('open');
      if (onChangeCallback) onChangeCallback(val);
    });
  });
  
  return dropdownObject;
}

// Global click-outside listener to close dropdown lists
// Global click-outside listener to close dropdown lists
document.addEventListener('click', () => {
  document.querySelectorAll('.custom-dropdown').forEach(dropdown => {
    dropdown.classList.remove('open');
  });
});

// --- Serverless Folder Connection and File Copy API ---

const DB_NAME = 'bgm_clock_db';
const STORE_NAME = 'handles_store';
const KEY_NAME = 'app_folder_handle';

function getDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function saveHandleToIndexedDB(handle) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(handle, KEY_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function loadHandleFromIndexedDB() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(KEY_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function removeHandleFromIndexedDB() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(KEY_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function initFolderConnection() {
  const connSection = document.getElementById('folder-connection-section');
  if (!connSection) return;

  if (!isFileSystemAccessSupported) {
    document.getElementById('faccess-unsupported-msg').style.display = 'block';
    document.getElementById('faccess-supported-container').style.display = 'none';
    return;
  }

  try {
    const handle = await loadHandleFromIndexedDB();
    if (handle) {
      // Check permission
      if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') {
        appFolderHandle = handle;
      } else {
        // Handle exists but needs permission re-grant. Keep reference to request later.
        appFolderHandle = handle;
      }
    }
  } catch (e) {
    console.error('Failed to load handle from IndexedDB:', e);
  }
  updateFolderConnectionUI(true);
}

async function verifyPermission(handle, readWrite) {
  const options = {};
  if (readWrite) {
    options.mode = 'readwrite';
  }
  if ((await handle.queryPermission(options)) === 'granted') {
    return true;
  }
  if ((await handle.requestPermission(options)) === 'granted') {
    return true;
  }
  return false;
}

function updateFolderConnectionUI(scanDisk = false) {
  const activeSeg = segments[selectedSegmentIndex];
  const connSection = document.getElementById('folder-connection-section');
  if (!connSection) return;

  if (!activeSeg || !activeSeg.folderPath) {
    connSection.style.display = 'none';
    return;
  }

  connSection.style.display = 'block';

  if (useBrowserLibrary) {
    renderLibraryList();
    return;
  }

  const dis = document.getElementById('conn-state-disconnected');
  const conn = document.getElementById('conn-state-connected');
  const folderNameSpan = document.getElementById('connected-folder-name');

  if (appFolderHandle) {
    dis.style.display = 'none';
    conn.style.display = 'block';
    folderNameSpan.textContent = `✅ 接続: ${appFolderHandle.name} (宛先: ${activeSeg.folderPath})`;
    updateConnectedFolderFilesList(scanDisk);
  } else {
    dis.style.display = 'block';
    conn.style.display = 'none';
    const fileListContainer = document.getElementById('connected-folder-files');
    if (fileListContainer) fileListContainer.style.display = 'none';
  }
}

async function updateConnectedFolderFilesList(scanDisk = false) {
  const fileListContainer = document.getElementById('connected-folder-files');
  const fileListUl = document.getElementById('connected-files-list');
  if (!fileListContainer || !fileListUl) return;

  const activeSeg = segments[selectedSegmentIndex];
  if (!appFolderHandle || !activeSeg || !activeSeg.folderPath) {
    fileListContainer.style.display = 'none';
    return;
  }

  // もしディスクスキャンが要求された場合は、非同期でスキャンして manifest を同期する
  if (scanDisk) {
    (async () => {
      try {
        const bgmDir = await appFolderHandle.getDirectoryHandle('bgm');
        const targetFolder = await bgmDir.getDirectoryHandle(activeSeg.folderPath);
        const files = await scanBgmFolderRecursively(targetFolder, `bgm/${activeSeg.folderPath}`);
        // メモリ同期
        if (typeof bgmManifest !== 'undefined') {
          bgmManifest[activeSeg.folderPath] = files;
        }
        if (typeof window.bgmManifest !== 'undefined') {
          window.bgmManifest[activeSeg.folderPath] = files;
        }
        // メモリから再描画
        updateConnectedFolderFilesList(false);
      } catch (err) {
        console.error('Failed to scan disk for file list:', err);
      }
    })();
    return;
  }

  // メモリ（bgmManifest）から即座にリストを構築
  const files = (typeof bgmManifest !== 'undefined' && bgmManifest[activeSeg.folderPath]) || [];

  fileListUl.innerHTML = '';
  if (files.length === 0) {
    const li = document.createElement('li');
    li.textContent = '登録されている曲はありません。';
    li.style.color = 'var(--text-muted)';
    li.style.padding = '8px 4px';
    fileListUl.appendChild(li);
  } else {
    files.forEach(file => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.justifyContent = 'space-between';
      li.style.padding = '6px 8px';
      li.style.borderBottom = '1px solid var(--glass-border)';
      li.style.gap = '8px';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = file.name;
      nameSpan.style.whiteSpace = 'nowrap';
      nameSpan.style.overflow = 'hidden';
      nameSpan.style.textOverflow = 'ellipsis';
      nameSpan.style.flex = '1';

      const actionArea = document.createElement('div');
      actionArea.style.display = 'flex';
      actionArea.style.alignItems = 'center';
      actionArea.style.gap = '4px';

      const deleteBtn = document.createElement('button');
      deleteBtn.innerHTML = '✕';
      deleteBtn.style.background = 'transparent';
      deleteBtn.style.border = 'none';
      deleteBtn.style.color = '#ff6b6b';
      deleteBtn.style.cursor = 'pointer';
      deleteBtn.style.fontWeight = 'bold';
      deleteBtn.style.padding = '2px 6px';
      deleteBtn.style.borderRadius = '4px';
      deleteBtn.title = '削除';

      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        actionArea.innerHTML = '';
        
        const confirmText = document.createElement('span');
        confirmText.textContent = '削除？';
        confirmText.style.color = '#ff6b6b';
        confirmText.style.fontSize = '0.75rem';
        confirmText.style.fontWeight = 'bold';
        confirmText.style.marginRight = '2px';
        
        const yesBtn = document.createElement('button');
        yesBtn.textContent = 'はい';
        yesBtn.style.background = '#ff6b6b';
        yesBtn.style.color = '#ffffff';
        yesBtn.style.border = 'none';
        yesBtn.style.borderRadius = '3px';
        yesBtn.style.padding = '2px 6px';
        yesBtn.style.cursor = 'pointer';
        yesBtn.style.fontSize = '0.7rem';
        yesBtn.addEventListener('click', () => {
          deleteFileFromFolder(activeSeg.folderPath, file.name);
        });

        const noBtn = document.createElement('button');
        noBtn.textContent = 'いいえ';
        noBtn.style.background = 'rgba(255,255,255,0.1)';
        noBtn.style.color = 'var(--text-main)';
        noBtn.style.border = '1px solid var(--glass-border)';
        noBtn.style.borderRadius = '3px';
        noBtn.style.padding = '2px 6px';
        noBtn.style.cursor = 'pointer';
        noBtn.style.fontSize = '0.7rem';
        noBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          updateConnectedFolderFilesList(false);
        });

        actionArea.appendChild(confirmText);
        actionArea.appendChild(yesBtn);
        actionArea.appendChild(noBtn);
      });

      actionArea.appendChild(deleteBtn);
      li.appendChild(nameSpan);
      li.appendChild(actionArea);
      fileListUl.appendChild(li);
    });
  }
  fileListContainer.style.display = 'block';
}

async function deleteFileFromFolder(folderPath, fileName) {
  try {
    if (!appFolderHandle) return;
    if (!await verifyPermission(appFolderHandle, true)) {
      alert('書き込み権限がありません。');
      return;
    }

    // 1. メモリ上のキャッシュから即座に取り除く
    if (typeof bgmManifest !== 'undefined' && bgmManifest[folderPath]) {
      bgmManifest[folderPath] = bgmManifest[folderPath].filter(f => f.name !== fileName);
    }
    if (typeof window.bgmManifest !== 'undefined' && window.bgmManifest[folderPath]) {
      window.bgmManifest[folderPath] = window.bgmManifest[folderPath].filter(f => f.name !== fileName);
    }

    // 2. アプリ全体の読み込み曲数表示やメモリを即時に同期
    for (let s of segments) {
      loadFilesForSegment(s);
    }
    const activeSeg = segments[selectedSegmentIndex];
    updateFolderStatus(activeSeg);
    if (selectedSegmentIndex === activeSegmentIndex) {
      updateActiveTimeZone(true);
    }

    // 3. スキャンを挟まずに即座にUIリストから項目を削除（爆速反映）
    updateConnectedFolderFilesList(false);

    // 4. ディスク削除とマニフェスト再生成は裏（バックグラウンド）で非同期実行
    (async () => {
      try {
        const bgmDir = await appFolderHandle.getDirectoryHandle('bgm');
        const targetFolder = await bgmDir.getDirectoryHandle(folderPath);
        await targetFolder.removeEntry(fileName);
        await rebuildBgmManifest();
      } catch (e) {
        console.error('Failed to execute disk removal/rebuild in background:', e);
      }
    })();
  } catch (err) {
    console.error('Failed to delete file:', err);
    alert('ファイルの削除に失敗しました: ' + err.message);
  }
}

async function connectAppFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    let hasIndex = false;
    let hasManifest = false;
    for await (const entry of handle.values()) {
      if (entry.name === 'index.html' && entry.kind === 'file') hasIndex = true;
      if (entry.name === 'bgm_manifest.js' && entry.kind === 'file') hasManifest = true;
    }

    if (!hasIndex) {
      alert(`「${handle.name}」には index.html がありません。Clock Player の index.html が入っているフォルダを選んでください。`);
      return;
    }

    // ダウンロード直後は bgm フォルダと bgm_manifest.js が無いので、ここで用意する
    const bgmDir = await handle.getDirectoryHandle('bgm', { create: true });
    for (const folder of ['bgmA', 'bgmB', 'bgmC', 'bgmD', 'bgmE', 'bgmF']) {
      await bgmDir.getDirectoryHandle(folder, { create: true });
    }

    await saveHandleToIndexedDB(handle);
    appFolderHandle = handle;
    if (!hasManifest) {
      await rebuildBgmManifest();
      for (const s of segments) loadFilesForSegment(s);
    }
    updateFolderConnectionUI(true);
    await saveConfig();
  } catch (err) {
    console.error('Folder picker error:', err);
    if (err.name !== 'AbortError') {
      alert('フォルダの接続に失敗しました: ' + err.message);
    }
  }
}

async function disconnectAppFolder() {
  if (confirm('フォルダ接続を解除しますか？')) {
    await removeHandleFromIndexedDB();
    appFolderHandle = null;
    updateFolderConnectionUI();
  }
}

// Rebuild manifest by scanning local disk
async function rebuildBgmManifest() {
  if (!appFolderHandle) return;
  try {
    const bgmDir = await appFolderHandle.getDirectoryHandle('bgm');
    const folders = ['bgmA', 'bgmB', 'bgmC', 'bgmD', 'bgmE', 'bgmF'];
    const newManifest = {};

    for (const folder of folders) {
      newManifest[folder] = [];
      try {
        const folderHandle = await bgmDir.getDirectoryHandle(folder);
        const files = await scanBgmFolderRecursively(folderHandle, `bgm/${folder}`);
        newManifest[folder] = files;
      } catch (err) {
        console.warn(`BGM folder ${folder} could not be scanned:`, err);
      }
    }

    // Write file content
    const manifestContent = `window.bgmManifest = ${JSON.stringify(newManifest, null, 4)};`;
    const manifestFile = await appFolderHandle.getFileHandle('bgm_manifest.js', { create: true });
    const writable = await manifestFile.createWritable();
    await writable.write(manifestContent);
    await writable.close();

    // Reassign globally
    bgmManifest = newManifest;
    window.bgmManifest = newManifest;
  } catch (err) {
    console.error('Failed to rebuild manifest:', err);
    throw err;
  }
}

async function scanBgmFolderRecursively(dirHandle, currentPath) {
  let results = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      if (entry.name.match(/\.(mp3|wav|ogg|m4a|aac|flac)$/i)) {
        let artist = "";
        let title = "";
        try {
          const fileObj = await entry.getFile();
          const meta = await extractAudioMetadata(fileObj);
          if (meta) {
            artist = meta.artist || "";
            title = meta.title || "";
          }
        } catch (e) {
          console.warn("Could not read file handle metadata:", e);
        }

        if (!title) {
          const baseName = entry.name.replace(/\.[^/.]+$/, "");
          const match = baseName.match(/^(.+?)\s*-\s*(.+)$/);
          if (match) {
            artist = match[1].trim();
            title = match[2].trim();
          } else {
            title = baseName;
          }
        }

        results.push({
          name: entry.name,
          path: `${currentPath}/${entry.name}`,
          artist: artist,
          title: title
        });
      }
    } else if (entry.kind === 'directory') {
      const subResults = await scanBgmFolderRecursively(entry, `${currentPath}/${entry.name}`);
      results = results.concat(subResults);
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// --- Client-Side Audio Metadata Extraction ---

// タグの読み取りに必要な部分だけを読む（曲全体をメモリに載せない）
const MP3_TAG_READ_LIMIT = 2 * 1024 * 1024;
const M4A_MOOV_READ_LIMIT = 16 * 1024 * 1024;

async function readMp3TagBuffer(fileObj) {
  const header = new DataView(await fileObj.slice(0, 10).arrayBuffer());
  if (header.byteLength < 10) return null;
  const size = ((header.getUint8(6) & 0x7F) << 21) | ((header.getUint8(7) & 0x7F) << 14) |
               ((header.getUint8(8) & 0x7F) << 7) | (header.getUint8(9) & 0x7F);
  return fileObj.slice(0, Math.min(10 + size, MP3_TAG_READ_LIMIT)).arrayBuffer();
}

// 最上位の箱の見出しだけをたどって moov 箱を探し、その部分だけを読む
async function readM4aMoovBuffer(fileObj) {
  let offset = 0;
  while (offset + 8 <= fileObj.size) {
    const head = new DataView(await fileObj.slice(offset, offset + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1 && head.byteLength >= 16) {
      size = Number(head.getBigUint64(8)); // 64bit サイズ
    } else if (size === 0) {
      size = fileObj.size - offset; // ファイル末尾まで
    }
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > M4A_MOOV_READ_LIMIT) return null;
      return fileObj.slice(offset, offset + size).arrayBuffer();
    }
    offset += size;
  }
  return null;
}

async function extractAudioMetadata(fileObj) {
  try {
    const name = fileObj.name.toLowerCase();
    
    let meta = null;
    if (name.endsWith('.mp3')) {
      const buffer = await readMp3TagBuffer(fileObj);
      if (buffer) meta = parseMp3Metadata(buffer);
    } else if (name.endsWith('.m4a')) {
      const buffer = await readM4aMoovBuffer(fileObj);
      if (buffer) meta = parseM4aMetadata(buffer);
    }
    
    if (meta && (meta.artist || meta.title)) {
      return meta;
    }
  } catch (e) {
    console.warn('Failed to extract audio metadata:', e);
  }
  return null;
}

function parseMp3Metadata(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 10) return null;
  // Check "ID3"
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
    return null;
  }
  const version = view.getUint8(3);
  if (version !== 3 && version !== 4) {
    return null; // ID3v2.3 or ID3v2.4 only
  }
  
  // ID3 size (synchsafe 32-bit int)
  const size = ((view.getUint8(6) & 0x7F) << 21) |
               ((view.getUint8(7) & 0x7F) << 14) |
               ((view.getUint8(8) & 0x7F) << 7) |
                (view.getUint8(9) & 0x7F);
                
  let offset = 10;
  let artist = "";
  let albumArtist = "";
  let title = "";
  
  const textDecoderUtf8 = new TextDecoder('utf-8');
  const textDecoderUtf16 = new TextDecoder('utf-16');
  const textDecoderLatin1 = new TextDecoder('iso-8859-1');
  
  function decodeText(encoding, uint8Array) {
    if (encoding === 0) return textDecoderLatin1.decode(uint8Array);
    if (encoding === 1 || encoding === 2) return textDecoderUtf16.decode(uint8Array);
    if (encoding === 3) return textDecoderUtf8.decode(uint8Array);
    return "";
  }
  
  while (offset < size + 10 && offset < arrayBuffer.byteLength - 10) {
    const frameId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    
    let frameSize = 0;
    if (version === 3) {
      frameSize = view.getUint32(offset + 4);
    } else {
      frameSize = ((view.getUint8(offset + 4) & 0x7F) << 21) |
                  ((view.getUint8(offset + 5) & 0x7F) << 14) |
                  ((view.getUint8(offset + 6) & 0x7F) << 7) |
                   (view.getUint8(offset + 7) & 0x7F);
    }
    
    if (frameSize <= 0 || offset + 10 + frameSize > arrayBuffer.byteLength) {
      break;
    }
    
    if (frameId === "TPE1" || frameId === "TPE2" || frameId === "TIT2") {
      const encoding = view.getUint8(offset + 10);
      const dataStart = offset + 11;
      const dataSize = frameSize - 1;
      if (dataSize > 0) {
        const u8 = new Uint8Array(arrayBuffer, dataStart, dataSize);
        let cleanU8 = u8;
        if (u8[u8.length - 1] === 0) {
          cleanU8 = u8.subarray(0, u8.length - 1);
        }
        if (u8[u8.length - 2] === 0 && u8[u8.length - 1] === 0) {
          cleanU8 = u8.subarray(0, u8.length - 2);
        }
        const text = decodeText(encoding, cleanU8).trim().replace(/^\0+/, "");
        if (frameId === "TPE1") artist = text;
        if (frameId === "TPE2") albumArtist = text;
        if (frameId === "TIT2") title = text;
      }
    }
    
    offset += 10 + frameSize;
  }
  
  if (!artist && albumArtist) {
    artist = albumArtist;
  }
  
  return { artist, title };
}


function parseM4aMetadata(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let artist = "";
  let albumArtist = "";
  let title = "";
  const textDecoder = new TextDecoder('utf-8');
  
  function parseBoxes(start, end) {
    let offset = start;
    while (offset < end && offset < arrayBuffer.byteLength - 8) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );
      
      if (size <= 0) break;
      const boxEnd = offset + size;
      
      if (type === "moov" || type === "udta" || type === "ilst") {
        parseBoxes(offset + 8, boxEnd);
      } else if (type === "meta") {
        parseBoxes(offset + 12, boxEnd);
      } else if (type === "\xa9ART" || type === "aART" || type === "\xa9nam") {
        let subOffset = offset + 8;
        while (subOffset < boxEnd - 8) {
          const subSize = view.getUint32(subOffset);
          const subType = String.fromCharCode(
            view.getUint8(subOffset + 4),
            view.getUint8(subOffset + 5),
            view.getUint8(subOffset + 6),
            view.getUint8(subOffset + 7)
          );
          if (subType === "data") {
            const payloadOffset = subOffset + 16;
            const payloadSize = subSize - 16;
            if (payloadSize > 0 && payloadOffset + payloadSize <= arrayBuffer.byteLength) {
              const u8 = new Uint8Array(arrayBuffer, payloadOffset, payloadSize);
              const text = textDecoder.decode(u8).trim();
              if (type === "\xa9ART") artist = text;
              if (type === "aART") albumArtist = text;
              if (type === "\xa9nam") title = text;
            }
            break;
          }
          subOffset += subSize;
        }
      }
      offset += size;
    }
  }
  
  parseBoxes(0, arrayBuffer.byteLength);
  
  if (!artist && albumArtist) {
    artist = albumArtist;
  }
  
  return { artist, title };
}


// --- Track Title Display & Slider Controller ---
let titleScrollInterval = null;

function updateTrackTitleDisplay(file) {
  if (titleScrollInterval) {
    clearInterval(titleScrollInterval);
    titleScrollInterval = null;
  }
  if (!trackTitle) return;

  const title = file.title || file.name.replace(/\.[^/.]+$/, "");
  const artist = file.artist || "";

  trackTitle.classList.remove('animating');
  trackTitle.style.height = '';
  trackTitle.style.overflow = '';
  trackTitle.innerHTML = '';

  if (!artist) {
    trackTitle.textContent = title;
    return;
  }

  const combinedText = `${title} - ${artist}`;
  trackTitle.textContent = combinedText;

  setTimeout(() => {
    const isOverflowing = trackTitle.scrollWidth > trackTitle.clientWidth;
    if (isOverflowing) {
      trackTitle.innerHTML = `
        <div class="track-title-slider">
          <div class="track-title-slide text-title">${title}</div>
          <div class="track-title-slide text-artist">${artist}</div>
        </div>
      `;
      trackTitle.classList.add('animating');

      let showArtist = false;
      const slider = trackTitle.querySelector('.track-title-slider');
      
      titleScrollInterval = setInterval(() => {
        showArtist = !showArtist;
        if (showArtist) {
          slider.classList.add('slide-up');
        } else {
          slider.classList.remove('slide-up');
        }
      }, 10000);
    }
  }, 50);
}


// Copy Files Utility
async function copyFilesToBgmFolder() {
  const activeSeg = segments[selectedSegmentIndex];
  if (!activeSeg || !activeSeg.folderPath) return;

  if (!appFolderHandle) {
    alert('アプリフォルダを先に接続してください。');
    return;
  }

  // Verify permission
  if (!await verifyPermission(appFolderHandle, true)) {
    alert('書き込み権限がありません。');
    return;
  }

  try {
    const fileHandles = await window.showOpenFilePicker({
      multiple: true,
      types: [{
        description: '音楽ファイル',
        accept: {
          'audio/*': ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']
        }
      }]
    });

    if (fileHandles.length === 0) return;

    showProgressModal(activeSeg.folderPath);
    updateProgressLog(`コピーを開始しています...\n選択ファイル数: ${fileHandles.length}件\n`);
    initProgressBar(fileHandles.length);

    const bgmDir = await appFolderHandle.getDirectoryHandle('bgm');
    const targetFolder = await bgmDir.getDirectoryHandle(activeSeg.folderPath);

    let copiedCount = 0;

    for (const srcHandle of fileHandles) {
      try {
        const file = await srcHandle.getFile();
        
        // Resolve name conflict
        let destName = file.name;
        let extIdx = destName.lastIndexOf('.');
        let base = extIdx !== -1 ? destName.substring(0, extIdx) : destName;
        let ext = extIdx !== -1 ? destName.substring(extIdx) : '';
        let counter = 1;

        while (true) {
          try {
            await targetFolder.getFileHandle(destName);
            destName = `${base} (${counter})${ext}`;
            counter++;
          } catch (e) {
            break;
          }
        }

        updateProgressLog(`コピー中: ${file.name} -> ${destName}...`);
        const destFileHandle = await targetFolder.getFileHandle(destName, { create: true });
        // 曲全体をメモリに載せずに少しずつ書き込む（pipeTo が書き込み後に閉じる）
        await file.stream().pipeTo(await destFileHandle.createWritable());

        copiedCount++;
        updateProgressLog(' [完了]\n');
        tickProgressBar(copiedCount);
      } catch (err) {
        updateProgressLog(` [エラー: ${err.message}]\n`);
      }
    }

    updateProgressLog('\nプレイリストとマニフェストファイルを自動生成中...');
    await rebuildBgmManifest();
    
    // Refresh memory
    for (let s of segments) {
      loadFilesForSegment(s);
    }
    updateFolderStatus(activeSeg);
    if (selectedSegmentIndex === activeSegmentIndex) {
      updateActiveTimeZone(true);
    }

    await updateConnectedFolderFilesList();

    updateProgressLog(' [完了]\n\nすべてのコピーが完了しました！');
    finishProgressModal();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('File copy failed:', err);
      alert('コピー中にエラーが発生しました: ' + err.message);
    }
  }
}

// Progress Modal Controllers
let progressBarTotal = 0;

function showProgressModal(destFolder) {
  const container = document.getElementById('copy-progress-inline-section');
  const closeBtn = document.getElementById('btn-close-copy-progress');
  const logEl = document.getElementById('copy-progress-log');
  const barContainer = document.getElementById('copy-progress-bar-container');
  const barFill = document.getElementById('copy-progress-bar-fill');

  logEl.textContent = '';
  barContainer.style.display = 'none';
  barFill.style.width = '0%';
  closeBtn.style.display = 'none';
  if (container) {
    container.style.display = 'block';
  }
}

function updateProgressLog(text) {
  const logEl = document.getElementById('copy-progress-log');
  if (logEl) {
    logEl.textContent += text;
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function initProgressBar(total) {
  progressBarTotal = total;
  const barContainer = document.getElementById('copy-progress-bar-container');
  const barFill = document.getElementById('copy-progress-bar-fill');
  if (barContainer && barFill) {
    barContainer.style.display = 'block';
    barFill.style.width = '0%';
  }
}

function tickProgressBar(current) {
  const barFill = document.getElementById('copy-progress-bar-fill');
  if (barFill && progressBarTotal > 0) {
    const pct = Math.round((current / progressBarTotal) * 100);
    barFill.style.width = `${pct}%`;
  }
}

function finishProgressModal() {
  const closeBtn = document.getElementById('btn-close-copy-progress');
  if (closeBtn) {
    closeBtn.style.display = 'inline-block';
  }
}


// --- ブラウザソース用 URL（設定パネル先頭） ---
function initSourceUrl() {
  const input = document.getElementById('source-url');
  const btn = document.getElementById('btn-copy-source-url');
  if (!input || !btn) return;
  input.value = new URL('obs.html', location.href).href;
  input.addEventListener('focus', () => input.select());
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (e) {
      // OBS のドックなどクリップボード API が使えない場合
      input.select();
      document.execCommand('copy');
    }
    btn.textContent = 'コピーしました';
    setTimeout(() => { btn.textContent = 'コピー'; }, 1500);
  });
}

// --- Dock ⇄ Browser Source Sync ---
// OBS のカスタムブラウザドック（index.html）とブラウザソース（obs.html）は同じオリジンなら
// BroadcastChannel と localStorage を共有する。音は再生役の obs.html が鳴らし、ドックは操作と設定を担う。
const SYNC_CHANNEL_NAME = 'clockplayer-sync';
const REMOTE_TIMEOUT_MS = 3000;
let syncChannel = null;
let remoteState = null;
let remoteSeenAt = 0;
let lastStateBroadcastAt = 0;

function isRemoteActive() {
  return !isPlayerRole && Date.now() - remoteSeenAt < REMOTE_TIMEOUT_MS;
}

function sendRemoteCommand(action, value) {
  if (syncChannel) syncChannel.postMessage({ type: 'command', action, value });
}

function broadcastPlayerState() {
  if (!isPlayerRole || !syncChannel) return;
  lastStateBroadcastAt = Date.now();
  const file = currentPlaylist[currentTrackIndex] || null;
  syncChannel.postMessage({
    type: 'state',
    file: file && !audio.getAttribute('src') ? null : file,
    currentTime: audio.currentTime || 0,
    duration: audio.duration || 0,
    playing: !audio.paused
  });
}

function handleRemoteCommand(msg) {
  if (msg.action === 'toggle') {
    btnPlay.click();
  } else if (msg.action === 'next') {
    btnNext.click();
  } else if (msg.action === 'prev') {
    btnPrev.click();
  } else if (msg.action === 'seek') {
    if (audio.duration) audio.currentTime = msg.value * audio.duration;
  } else if (msg.action === 'volume') {
    globalVolume = msg.value.volume;
    isMuted = msg.value.muted;
    if (volumeSlider) volumeSlider.value = globalVolume;
    if (fadeIntervalId) {
      clearInterval(fadeIntervalId);
      fadeIntervalId = null;
    }
    updateVolumeUI();
  } else if (msg.action === 'play-path') {
    const idx = currentPlaylist.findIndex(f => f.path === msg.value);
    if (idx !== -1) {
      currentTrackIndex = idx;
      playNextTrack(true);
    }
  }
  broadcastPlayerState();
}

function renderRemoteState(state) {
  const wasRemote = isRemoteActive();
  remoteSeenAt = Date.now();

  // 再生役が見つかったら、こちらの音は止めて二重再生を防ぐ
  if (!wasRemote && !audio.paused) {
    audio.pause();
    audio.removeAttribute('src');
  }

  const prevPath = remoteState && remoteState.file ? remoteState.file.path : null;
  const nextPath = state.file ? state.file.path : null;
  if (state.file && nextPath !== prevPath) {
    updateTrackTitleDisplay(state.file);
  }
  remoteState = state;

  setPlayingUI(state.playing);
  if (state.duration) {
    if (progressFill) progressFill.style.width = `${(state.currentTime / state.duration) * 100}%`;
    if (timeCurrent) timeCurrent.textContent = formatAudioTime(state.currentTime);
    if (timeTotal) timeTotal.textContent = formatAudioTime(state.duration);
  }
}

// 他の画面で保存された設定を取り込む（ブラウザライブラリ利用時のみ。ローカル版は config.js が正）
function applyExternalConfig() {
  const prevSeg = segments[activeSegmentIndex];
  const prevFolder = prevSeg ? prevSeg.folderPath : null;
  const prevShuffle = isShuffle;

  loadConfig();

  if (!audio.paused && !fadeIntervalId) {
    audio.volume = isMuted ? 0 : globalVolume;
  }
  if (volumeSlider) volumeSlider.value = globalVolume;
  if (btnShuffle) btnShuffle.classList.toggle('active-toggle', isShuffle);
  if (timelineBar) {
    selectedSegmentIndex = Math.min(selectedSegmentIndex, segments.length - 1);
    selectSegment(selectedSegmentIndex);
  }

  const currentMin = getCurrentTimeInMinutes();
  const newIndex = segments.findIndex(s => currentMin >= s.start && currentMin < s.end);
  const newSeg = segments[newIndex];
  if (!newSeg || newIndex !== activeSegmentIndex || newSeg.folderPath !== prevFolder) {
    activeSegmentIndex = -2; // 強制的に切替処理を走らせる
    updateActiveTimeZone(false);
  } else {
    updateThemeClass(activeSegmentIndex);
    if (activePeriodName) {
      activePeriodName.textContent = `${newSeg.name} (${formatTime(newSeg.start)} - ${formatTime(newSeg.end)})`;
    }
    if (isShuffle !== prevShuffle && newSeg.files.length > 0) {
      const playingPath = audio.getAttribute('src') ? (currentPlaylist[currentTrackIndex] || {}).path : null;
      buildPlaylistForSegment(newSeg);
      const idx = currentPlaylist.findIndex(f => f.path === playingPath);
      if (idx !== -1) currentTrackIndex = idx;
    }
  }
}

// ライブラリの曲が増減したときの反映
async function applyLibraryUpdate() {
  await loadBgmManifest();
  for (const s of segments) loadFilesForSegment(s);
  const selectedSeg = segments[selectedSegmentIndex];
  if (selectedSeg && folderStatusText) updateFolderStatus(selectedSeg);
  if (!isPlayerRole) renderLibraryList();

  const activeSeg = segments[activeSegmentIndex];
  if (!activeSeg || isRemoteActive()) return;
  const playingPath = audio.getAttribute('src') ? (currentPlaylist[currentTrackIndex] || {}).path : null;
  const stillExists = playingPath && activeSeg.files.some(f => f.path === playingPath);
  if (!stillExists) {
    // 再生中の曲が消えた・曲が無かった時間帯に曲が入った場合は選び直す
    const shouldPlay = isPlayerRole || !!playingPath;
    activeSegmentIndex = -2;
    updateActiveTimeZone(shouldPlay);
  }
}

function initSync() {
  if (typeof BroadcastChannel !== 'function') return;
  syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);

  syncChannel.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type === 'hello' && isPlayerRole) {
      broadcastPlayerState();
    } else if (msg.type === 'state' && !isPlayerRole) {
      renderRemoteState(msg);
    } else if (msg.type === 'command' && isPlayerRole) {
      handleRemoteCommand(msg);
    } else if (msg.type === 'library-updated') {
      applyLibraryUpdate();
    }
  });

  if (isPlayerRole) {
    ['play', 'pause', 'loadedmetadata'].forEach(ev => audio.addEventListener(ev, broadcastPlayerState));
    audio.addEventListener('timeupdate', () => {
      if (Date.now() - lastStateBroadcastAt >= 1000) broadcastPlayerState();
    });
    // 曲が無いときもドックに存在を知らせる
    setInterval(() => {
      if (Date.now() - lastStateBroadcastAt >= 1000) broadcastPlayerState();
    }, 1000);
    broadcastPlayerState();
  } else {
    syncChannel.postMessage({ type: 'hello' });
  }

  if (useBrowserLibrary) {
    window.addEventListener('storage', (e) => {
      if (e.key === 'bgm_clock_config') applyExternalConfig();
    });
  }
}

function notifyLibraryUpdated() {
  if (syncChannel) syncChannel.postMessage({ type: 'library-updated' });
  applyLibraryUpdate();
}

// --- Browser Library UI (index.html の設定パネル) ---
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

async function refreshLibraryUsage() {
  const usageEl = document.getElementById('library-usage');
  if (!usageEl) return;
  const usage = await ClockLibrary.getUsage();
  const persisted = usage === 0 || await ClockLibrary.isPersisted();
  usageEl.textContent = persisted ? formatBytes(usage) : `${formatBytes(usage)}・消える可能性あり`;
  usageEl.classList.toggle('library-usage-warn', !persisted);
  usageEl.title = persisted ? '' : 'ディスクの空きが少なくなると、ブラウザが取り込んだ曲を削除することがあります';
}

function renderLibraryList() {
  const listEl = document.getElementById('library-files-list');
  const activeSeg = segments[selectedSegmentIndex];
  if (!listEl || !activeSeg) return;

  listEl.innerHTML = '';
  const files = bgmManifest[activeSeg.folderPath] || [];
  files.forEach(file => {
    const li = document.createElement('li');
    li.className = 'library-file';
    const name = document.createElement('span');
    name.textContent = file.name;
    const del = document.createElement('button');
    del.className = 'library-delete';
    del.textContent = '✕';
    del.title = '削除';
    del.addEventListener('click', async () => {
      await ClockLibrary.removeFile(activeSeg.folderPath, file.name);
      notifyLibraryUpdated();
    });
    li.appendChild(name);
    li.appendChild(del);
    listEl.appendChild(li);
  });

  const clearFolderBtn = document.getElementById('btn-library-clear-folder');
  if (clearFolderBtn) {
    clearFolderBtn.textContent = `${activeSeg.folderPath} を空にする`;
    clearFolderBtn.disabled = files.length === 0;
  }
  refreshLibraryUsage();
}

async function importToLibrary(fileList) {
  const activeSeg = segments[selectedSegmentIndex];
  if (!activeSeg || !activeSeg.folderPath || !fileList || fileList.length === 0) return;
  const progressEl = document.getElementById('library-progress');
  try {
    await ClockLibrary.importFiles(activeSeg.folderPath, fileList, extractAudioMetadata, (done, total) => {
      if (progressEl) progressEl.textContent = `${done} / ${total}`;
    });
  } catch (err) {
    console.error('Library import failed:', err);
    alert('曲の取り込みに失敗しました: ' + err.message);
  }
  if (progressEl) progressEl.textContent = '';
  notifyLibraryUpdated();
}

// フォルダを選び、中の曲（サブフォルダを含む）を保存領域にコピーする
async function pickFolderToLibrary() {
  if (typeof window.showDirectoryPicker !== 'function') {
    document.getElementById('library-dir-input').click();
    return;
  }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ id: 'clockplayer-import' });
  } catch (err) {
    if (err.name === 'AbortError') return;
    // OBS のドックなどで使えない場合は従来のフォルダ選択に切り替える
    document.getElementById('library-dir-input').click();
    return;
  }
  const files = [];
  const collect = async (dir) => {
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') {
        await collect(entry);
      } else {
        files.push(await entry.getFile());
      }
    }
  };
  try {
    await collect(dirHandle);
  } catch (err) {
    alert('フォルダを読み込めませんでした: ' + err.message);
    return;
  }
  await importToLibrary(files);
}

function initBrowserLibraryUI() {
  // 取り込んだ曲をブラウザに消されにくくする
  ClockLibrary.requestPersist().then(refreshLibraryUsage);
  const faccess = document.getElementById('faccess-supported-container');
  const unsupported = document.getElementById('faccess-unsupported-msg');
  const library = document.getElementById('library-container');
  if (faccess) faccess.style.display = 'none';
  if (unsupported) unsupported.style.display = 'none';
  if (library) library.style.display = 'block';

  const filesInput = document.getElementById('library-files-input');
  const dirInput = document.getElementById('library-dir-input');
  [filesInput, dirInput].forEach(input => {
    if (!input) return;
    input.addEventListener('change', async () => {
      await importToLibrary(input.files);
      input.value = '';
    });
  });
  const btnAddFiles = document.getElementById('btn-library-add-files');
  if (btnAddFiles) btnAddFiles.addEventListener('click', () => filesInput.click());
  const btnAddDir = document.getElementById('btn-library-add-dir');
  if (btnAddDir) btnAddDir.addEventListener('click', pickFolderToLibrary);

  const clearFolderBtn = document.getElementById('btn-library-clear-folder');
  if (clearFolderBtn) {
    clearFolderBtn.addEventListener('click', async () => {
      const activeSeg = segments[selectedSegmentIndex];
      if (!activeSeg || !confirm(`${activeSeg.folderPath} の曲をすべて削除しますか？`)) return;
      await ClockLibrary.clearFolder(activeSeg.folderPath);
      notifyLibraryUpdated();
    });
  }
  const clearAllBtn = document.getElementById('btn-library-clear-all');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', async () => {
      if (!confirm('取り込んだ曲をすべて削除しますか？')) return;
      await ClockLibrary.clearAll();
      notifyLibraryUpdated();
    });
  }

  renderLibraryList();
}
