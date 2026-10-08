import { Browser, Controller, NES } from "jsnes";
import { Nostalgist } from "nostalgist";

// Auto-discover all NES and SNES rom files in ../roms/
const nesModules = import.meta.glob("../roms/*.nes", { eager: true, query: "?url" });
const sfcModules = import.meta.glob("../roms/*.sfc", { eager: true, query: "?url" });
const smcModules = import.meta.glob("../roms/*.smc", { eager: true, query: "?url" });

const allRomModules = { ...nesModules, ...sfcModules, ...smcModules };

// Build ROM list with friendly display names and system type
const ROM_LIST = Object.entries(allRomModules).map(([path, mod]) => {
  const filename = path.split("/").pop();
  const ext = filename.split(".").pop().toLowerCase();
  const isSnes = ext === "sfc" || ext === "smc";
  const system = isSnes ? "SNES" : "NES";
  const displayName = filename.replace(/\.(nes|sfc|smc)$/i, "");
  const url = typeof mod === "string" ? mod : mod.default;
  return {
    filename,
    displayName: `[${system}] ${displayName}`,
    rawTitle: displayName,
    system,
    url,
  };
});

// Helper: format title
function formatGameTitle(title) {
  return title.replace(/_/g, " ");
}

// Register custom Mapper 227 for 1200-in-1 multicart support in JSNES
function registerMapper227() {
  const tempNes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  const dummyHeader = new Uint8Array([
    0x4e, 0x45, 0x53, 0x1a, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...new Array(16384).fill(0)
  ]);
  tempNes.loadROM(dummyHeader);
  const NoMapper = Object.getPrototypeOf(tempNes.mmap).constructor;

  class Mapper227 extends NoMapper {
    constructor(nesInstance) {
      super(nesInstance);
    }

    write(address, value) {
      if (address < 0x8000) {
        super.write(address, value);
        return;
      }
      this.sync(address);
    }

    sync(addr) {
      const s = addr & 1;
      const m = (addr >> 1) & 1;
      const p = (addr >> 2) & 1;
      const pp = (addr >> 3) & 3;
      const qq = (addr >> 5) & 3;
      const o = (addr >> 7) & 1;
      const Q = (addr >> 8) & 1;
      const l = (addr >> 9) & 1;

      if (m === 1) {
        this.nes.ppu.setMirroring(this.nes.rom.HORIZONTAL_MIRRORING);
      } else {
        this.nes.ppu.setMirroring(this.nes.rom.VERTICAL_MIRRORING);
      }

      const inner = (pp << 1) | p;
      const outer = (Q << 2) | qq;
      const fullBank = (outer << 3) | inner;

      if (o === 1) {
        if (s === 0) {
          this.loadRomBank(fullBank, 0x8000);
          this.loadRomBank(fullBank, 0xc000);
        } else {
          const bank32 = (outer << 2) | pp;
          this.load32kRomBank(bank32, 0x8000);
        }
      } else {
        const bank8000 = (s === 1) ? ((outer << 3) | (pp << 1)) : fullBank;
        this.loadRomBank(bank8000, 0x8000);
        const fixedInner = (l === 1) ? 7 : 0;
        const bankC000 = (outer << 3) | fixedInner;
        this.loadRomBank(bankC000, 0xc000);
      }
    }

    loadROM() {
      this.loadRomBank(0, 0x8000);
      this.loadRomBank(0, 0xc000);
      this.loadCHRROM();
      this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
    }
  }

  const romProto = tempNes.rom.constructor.prototype;
  const originalCreateMapper = romProto.createMapper;
  const originalMapperSupported = romProto.mapperSupported;

  romProto.createMapper = function () {
    if (this.mapperType === 227) {
      return new Mapper227(this.nes);
    }
    return originalCreateMapper.call(this);
  };

  romProto.mapperSupported = function () {
    if (this.mapperType === 227) {
      return true;
    }
    return originalMapperSupported.call(this);
  };
}

registerMapper227();

// Global state
let activeSystem = "NES"; // 'NES' or 'SNES'
let jsnesBrowser = null;
let nostalgistInstance = null;
let currentMode = "keyboard";
let audioUnlocked = false;
let currentSelectedRom = ROM_LIST.length > 0 ? ROM_LIST[0] : null;

// DOM Elements
const gameContainer = document.getElementById("game");
const startupModal = document.getElementById("startup-modal");
const optTvRemote = document.getElementById("opt-tv-remote");
const optKeyboard = document.getElementById("opt-keyboard");
const btnStart = document.getElementById("btn-start");
const romSelect = document.getElementById("rom-select");
const romFileInput = document.getElementById("rom-file-input");
const customRomName = document.getElementById("custom-rom-name");
const btnSwitchGame = document.getElementById("btn-switch-game");
const modalTitle = document.querySelector(".modal-title");

// NES Keyboard Mappings
const NES_KEYBOARD_MAPPINGS = {
  // P1 Arrow Keys
  38: [1, Controller.BUTTON_UP, "Up"],
  40: [1, Controller.BUTTON_DOWN, "Down"],
  37: [1, Controller.BUTTON_LEFT, "Left"],
  39: [1, Controller.BUTTON_RIGHT, "Right"],

  // P1 WASD
  87: [1, Controller.BUTTON_UP, "W"],
  83: [1, Controller.BUTTON_DOWN, "S"],
  65: [1, Controller.BUTTON_LEFT, "A"],
  68: [1, Controller.BUTTON_RIGHT, "D"],

  // P1 Action
  32: [1, Controller.BUTTON_A, "Space"],
  88: [1, Controller.BUTTON_A, "X"],
  90: [1, Controller.BUTTON_B, "Z"],
  13: [1, Controller.BUTTON_START, "Enter"],
  16: [1, Controller.BUTTON_SELECT, "Shift"],

  // P2
  73: [2, Controller.BUTTON_UP, "I"],
  75: [2, Controller.BUTTON_DOWN, "K"],
  74: [2, Controller.BUTTON_LEFT, "J"],
  76: [2, Controller.BUTTON_RIGHT, "L"],
  85: [2, Controller.BUTTON_A, "U"],
  79: [2, Controller.BUTTON_B, "O"],
  80: [2, Controller.BUTTON_START, "P"],
  186: [2, Controller.BUTTON_SELECT, "Semicolon"],
};

// NES TV Remote Mappings
const NES_TV_REMOTE_MAPPINGS = {
  38: [1, Controller.BUTTON_UP, "Up"],
  19: [1, Controller.BUTTON_UP, "DPadUp"],
  40: [1, Controller.BUTTON_DOWN, "Down"],
  20: [1, Controller.BUTTON_DOWN, "DPadDown"],
  37: [1, Controller.BUTTON_LEFT, "Left"],
  21: [1, Controller.BUTTON_LEFT, "DPadLeft"],
  39: [1, Controller.BUTTON_RIGHT, "Right"],
  22: [1, Controller.BUTTON_RIGHT, "DPadRight"],
  13: [1, Controller.BUTTON_A, "OK"],
  23: [1, Controller.BUTTON_A, "Select"],
  65385: [1, Controller.BUTTON_A, "Enter"],
  417: [1, Controller.BUTTON_B, "FastForward"],
  415: [1, Controller.BUTTON_B, "Play"],
  403: [1, Controller.BUTTON_B, "Red"],
  406: [1, Controller.BUTTON_B, "Blue"],
  48: [1, Controller.BUTTON_B, "0"],
  96: [1, Controller.BUTTON_B, "Num0"],
  50: [1, Controller.BUTTON_B, "2"],
  90: [1, Controller.BUTTON_B, "Z"],
  179: [1, Controller.BUTTON_START, "PlayPause"],
  405: [1, Controller.BUTTON_START, "Yellow"],
  49: [1, Controller.BUTTON_START, "1"],
  18: [1, Controller.BUTTON_START, "Menu"],
  10009: [1, Controller.BUTTON_SELECT, "Back"],
  27: [1, Controller.BUTTON_SELECT, "Escape"],
  404: [1, Controller.BUTTON_SELECT, "Green"],
  16: [1, Controller.BUTTON_SELECT, "Shift"],
};

// Stop and clean up any active emulator
async function stopActiveEmulator() {
  if (jsnesBrowser) {
    try {
      if (jsnesBrowser.stop) jsnesBrowser.stop();
      if (jsnesBrowser._speakers?.stop) jsnesBrowser._speakers.stop();
    } catch (e) {
      console.warn("JSNES cleanup error:", e);
    }
    jsnesBrowser = null;
  }

  if (nostalgistInstance) {
    try {
      nostalgistInstance.exit();
    } catch (e) {
      console.warn("Nostalgist cleanup error:", e);
    }
    nostalgistInstance = null;
  }

  gameContainer.innerHTML = "";
}

function updateTitle(title, system = "NES") {
  if (modalTitle) {
    modalTitle.textContent = formatGameTitle(title).toUpperCase();
  }
  document.title = `${formatGameTitle(title)} (${system} Retro)`;
  if (system === "NES") {
    document.body.classList.add("mode-nes");
    document.body.classList.remove("mode-snes");
  } else {
    document.body.classList.add("mode-snes");
    document.body.classList.remove("mode-nes");
  }
}

// Populate ROM select dropdown
function populateRomSelect() {
  romSelect.innerHTML = "";
  ROM_LIST.forEach((rom, idx) => {
    const opt = document.createElement("option");
    opt.value = idx;
    opt.textContent = formatGameTitle(rom.displayName);
    romSelect.appendChild(opt);
  });

  if (ROM_LIST.length > 0) {
    currentSelectedRom = ROM_LIST[0];
    updateTitle(currentSelectedRom.rawTitle, currentSelectedRom.system);
  }
}

function selectMode(mode) {
  currentMode = mode;
  if (mode === "keyboard") {
    optKeyboard.classList.add("active");
    optTvRemote.classList.remove("active");
  } else {
    optTvRemote.classList.add("active");
    optKeyboard.classList.remove("active");
  }
}

function enterFullScreen() {
  const elem = document.documentElement;
  if (elem.requestFullscreen) {
    elem.requestFullscreen().catch(() => {});
  } else if (elem.webkitRequestFullscreen) {
    elem.webkitRequestFullscreen();
  } else if (elem.msRequestFullscreen) {
    elem.msRequestFullscreen();
  }
}

async function launchGame() {
  enterFullScreen();
  startupModal.classList.add("hidden");

  if (jsnesBrowser && jsnesBrowser._speakers?.audioCtx) {
    try {
      if (jsnesBrowser._speakers.audioCtx.state === "suspended") {
        await jsnesBrowser._speakers.audioCtx.resume();
      }
    } catch (e) {
      console.warn("AudioContext resume error:", e);
    }
  }

  if (jsnesBrowser) {
    const mappings =
      currentMode === "keyboard" ? NES_KEYBOARD_MAPPINGS : NES_TV_REMOTE_MAPPINGS;
    jsnesBrowser.keyboard.setKeys(mappings);
    jsnesBrowser.fitInParent();
  }

  audioUnlocked = true;
}

// Load NES ROM
async function loadNesGame(romData, name = "NES Game") {
  await stopActiveEmulator();
  activeSystem = "NES";

  jsnesBrowser = new Browser({
    container: gameContainer,
    romData: romData,
    onError: (err) => {
      console.error("NES Emulation error:", err);
    },
  });

  const mappings =
    currentMode === "keyboard" ? NES_KEYBOARD_MAPPINGS : NES_TV_REMOTE_MAPPINGS;
  jsnesBrowser.keyboard.setKeys(mappings);

  setTimeout(() => {
    if (jsnesBrowser) jsnesBrowser.fitInParent();
  }, 100);

  updateTitle(name, "NES");
}

// Load SNES ROM via Nostalgist Snes9x core
async function loadSnesGame(romSource, name = "SNES Game", filename = "game.sfc") {
  await stopActiveEmulator();
  activeSystem = "SNES";

  // Create canvas element inside game container
  const canvas = document.createElement("canvas");
  canvas.id = "snes-canvas";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.objectFit = "contain";
  canvas.style.imageRendering = "pixelated";
  gameContainer.appendChild(canvas);

  try {
    let resolvedRom = romSource;

    // If it's a URL or path string, fetch it locally first so Nostalgist doesn't redirect to external GitHub repos
    if (typeof romSource === "string") {
      const res = await fetch(romSource);
      if (!res.ok) throw new Error(`HTTP error ${res.status} fetching ${romSource}`);
      const buf = await res.arrayBuffer();
      resolvedRom = {
        fileName: filename || "game.sfc",
        fileContent: new Blob([buf], { type: "application/octet-stream" }),
      };
    }

    nostalgistInstance = await Nostalgist.snes({
      rom: resolvedRom,
      element: canvas,
      resolveRom(file) {
        return file; // Prevent Nostalgist from replacing local files with jsdelivr URLs
      },
      retroarchConfig: {
        // Controls configuration for SNES
        input_player1_a: "x",
        input_player1_b: "z",
        input_player1_x: "s",
        input_player1_y: "a",
        input_player1_l: "q",
        input_player1_r: "w",
        input_player1_start: "enter",
        input_player1_select: "rshift",
        input_player1_up: "up",
        input_player1_down: "down",
        input_player1_left: "left",
        input_player1_right: "right",
      },
    });

    updateTitle(name, "SNES");
  } catch (err) {
    console.error("Failed to load SNES ROM with Nostalgist:", err);
    alert("Could not load SNES ROM: " + err.message);
  }
}

// Universal loader
async function loadGame(romSource, name, filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  const isSnes = ext === "sfc" || ext === "smc";

  if (isSnes) {
    await loadSnesGame(romSource, name, filename);
  } else {
    // If romSource is a URL, fetch it first for jsnes
    if (typeof romSource === "string") {
      const res = await fetch(romSource);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const buf = await res.arrayBuffer();
      await loadNesGame(new Uint8Array(buf), name);
    } else if (romSource instanceof Uint8Array) {
      await loadNesGame(romSource, name);
    } else if (romSource instanceof Blob || romSource instanceof File) {
      const buf = await romSource.arrayBuffer();
      await loadNesGame(new Uint8Array(buf), name);
    }
  }
}

// Setup Event Listeners
function setupModalEvents() {
  optKeyboard.addEventListener("click", () => selectMode("keyboard"));
  optTvRemote.addEventListener("click", () => selectMode("tv"));
  btnStart.addEventListener("click", () => launchGame());

  // Dropdown selection
  romSelect.addEventListener("change", async (e) => {
    const idx = parseInt(e.target.value, 10);
    const selected = ROM_LIST[idx];
    if (selected) {
      currentSelectedRom = selected;
      if (customRomName) customRomName.textContent = "";
      await loadGame(selected.url, selected.rawTitle, selected.filename);
    }
  });

  // Custom ROM upload (.nes, .sfc, .smc)
  romFileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const gameTitle = file.name.replace(/\.(nes|sfc|smc)$/i, "");
      if (customRomName) {
        customRomName.textContent = `✓ ${file.name}`;
      }
      await loadGame(file, gameTitle, file.name);
    } catch (err) {
      alert("Failed to load ROM file: " + err.message);
    }
  });

  // Switch game button
  btnSwitchGame.addEventListener("click", () => {
    startupModal.classList.remove("hidden");
    if (jsnesBrowser && jsnesBrowser._speakers?.audioCtx) {
      try {
        jsnesBrowser._speakers.audioCtx.suspend();
      } catch {}
    }
  });

  window.addEventListener("keydown", (e) => {
    if (!startupModal.classList.contains("hidden")) {
      if ([38, 19, 37, 21].includes(e.keyCode)) {
        e.preventDefault();
        selectMode("keyboard");
      } else if ([40, 20, 39, 22].includes(e.keyCode)) {
        e.preventDefault();
        selectMode("tv");
      } else if ([13, 23, 32].includes(e.keyCode)) {
        if (document.activeElement !== romSelect) {
          e.preventDefault();
          launchGame();
        }
      }
    }
  });

  window.addEventListener("resize", () => {
    if (jsnesBrowser) jsnesBrowser.fitInParent();
  });

  document.addEventListener("fullscreenchange", () => {
    setTimeout(() => {
      if (jsnesBrowser) jsnesBrowser.fitInParent();
    }, 100);
  });
}

// Touch Controls for Mobile
function setupTouchControls() {
  const NES_BUTTON_MAP = {
    up: Controller.BUTTON_UP,
    down: Controller.BUTTON_DOWN,
    left: Controller.BUTTON_LEFT,
    right: Controller.BUTTON_RIGHT,
    a: Controller.BUTTON_A,
    b: Controller.BUTTON_B,
    start: Controller.BUTTON_START,
    select: Controller.BUTTON_SELECT,
  };

  const SNES_BUTTON_MAP = {
    up: "up",
    down: "down",
    left: "left",
    right: "right",
    a: "a",
    b: "b",
    x: "x",
    y: "y",
    start: "start",
    select: "select",
  };

  const touchButtons = document.querySelectorAll("#touch-controls button[data-btn]");

  touchButtons.forEach((btn) => {
    const btnKey = btn.getAttribute("data-btn");

    const handlePress = (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add("touch-active");

      if (activeSystem === "NES" && jsnesBrowser?.nes) {
        const nesBtn = NES_BUTTON_MAP[btnKey];
        if (nesBtn !== undefined) jsnesBrowser.nes.buttonDown(1, nesBtn);
      } else if (activeSystem === "SNES" && nostalgistInstance) {
        const snesBtn = SNES_BUTTON_MAP[btnKey];
        if (snesBtn) nostalgistInstance.pressDown(snesBtn);
      }

      if (navigator.vibrate) {
        try { navigator.vibrate(15); } catch {}
      }
    };

    const handleRelease = (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.remove("touch-active");

      if (activeSystem === "NES" && jsnesBrowser?.nes) {
        const nesBtn = NES_BUTTON_MAP[btnKey];
        if (nesBtn !== undefined) jsnesBrowser.nes.buttonUp(1, nesBtn);
      } else if (activeSystem === "SNES" && nostalgistInstance) {
        const snesBtn = SNES_BUTTON_MAP[btnKey];
        if (snesBtn) nostalgistInstance.pressUp(snesBtn);
      }
    };

    btn.addEventListener("touchstart", handlePress, { passive: false });
    btn.addEventListener("touchend", handleRelease, { passive: false });
    btn.addEventListener("touchcancel", handleRelease, { passive: false });
    btn.addEventListener("mousedown", handlePress);
    btn.addEventListener("mouseup", handleRelease);
    btn.addEventListener("mouseleave", handleRelease);
  });
}

// Start everything
populateRomSelect();
setupModalEvents();
setupTouchControls();

// Preload the default game
if (currentSelectedRom) {
  loadGame(currentSelectedRom.url, currentSelectedRom.rawTitle, currentSelectedRom.filename);
}


