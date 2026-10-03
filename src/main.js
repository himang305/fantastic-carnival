import { Browser, Controller, NES } from "jsnes";
import gameRomUrl from "../roms/1200-in-1.nes?url";

// Register custom Mapper 227 for 1200-in-1 multicart support in JSNES
function registerMapper227() {
  // Use a temporary NES instance to retrieve the base NoMapper class
  const tempNes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  const dummyHeader = new Uint8Array([
    0x4e, 0x45, 0x53, 0x1a, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...new Array(16384).fill(0)
  ]);
  tempNes.loadROM(dummyHeader);
  const NoMapper = Object.getPrototypeOf(tempNes.mmap).constructor;

  // Implementation of iNES Mapper 227 (BMC 1200-in-1 multicart)
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
      // Bit decoding according to NESDev Mapper 227 spec:
      // addr bits: [A~1... .mLQ OQQP PpMS]
      // bit 0: S (PRG A14 mode)
      // bit 1: M (mirroring: 0 = Vertical, 1 = Horizontal)
      // bit 2: p (PRG A14)
      // bits 4..3: PP (PRG A16..A15)
      // bits 6..5: QQ (PRG A18..A17)
      // bit 7: O (0: UNROM-like mode, 1: NROM mode)
      // bit 8: Q (PRG A19)
      // bit 9: L (Value for PRG A16..14 when CPU A14=1 and O=0)
      const s = addr & 1;
      const m = (addr >> 1) & 1;
      const p = (addr >> 2) & 1;
      const pp = (addr >> 3) & 3;
      const qq = (addr >> 5) & 3;
      const o = (addr >> 7) & 1;
      const Q = (addr >> 8) & 1;
      const l = (addr >> 9) & 1;

      // Mirroring: bit 1 (0: Vertical, 1: Horizontal)
      if (m === 1) {
        this.nes.ppu.setMirroring(this.nes.rom.HORIZONTAL_MIRRORING);
      } else {
        this.nes.ppu.setMirroring(this.nes.rom.VERTICAL_MIRRORING);
      }

      const inner = (pp << 1) | p;
      const outer = (Q << 2) | qq;
      const fullBank = (outer << 3) | inner;

      if (o === 1) {
        // NROM modes
        if (s === 0) {
          // NROM-128: 16 KiB inner bank mirrored at $8000-$BFFF and $C000-$FFFF
          this.loadRomBank(fullBank, 0x8000);
          this.loadRomBank(fullBank, 0xc000);
        } else {
          // NROM-256: 32 KiB inner bank mapped across $8000-$FFFF
          const bank32 = (outer << 2) | pp;
          this.load32kRomBank(bank32, 0x8000);
        }
      } else {
        // UNROM modes
        const bank8000 = (s === 1) ? ((outer << 3) | (pp << 1)) : fullBank;
        this.loadRomBank(bank8000, 0x8000);
        const fixedInner = (l === 1) ? 7 : 0;
        const bankC000 = (outer << 3) | fixedInner;
        this.loadRomBank(bankC000, 0xc000);
      }
    }

    loadROM() {
      // Power-on reset default: inner bank 0, outer bank 0 at $8000 and $C000
      this.loadRomBank(0, 0x8000);
      this.loadRomBank(0, 0xc000);
      this.loadCHRROM();
      this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
    }
  }

  // Hook into ROM prototype to handle mapper 227
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

// Initialize custom mapper
registerMapper227();

// Global state
let browser = null;
let currentMode = "keyboard"; // Default to keyboard for easy laptop play
let audioUnlocked = false;

// DOM Elements
const gameContainer = document.getElementById("game");
const startupModal = document.getElementById("startup-modal");
const optTvRemote = document.getElementById("opt-tv-remote");
const optKeyboard = document.getElementById("opt-keyboard");
const btnStart = document.getElementById("btn-start");

// Keyboard Mode Key Mappings (Optimized for laptops: WASD / Arrows, Space/X, Z, Enter)
const KEYBOARD_MAPPINGS = {
  // Arrow Keys
  38: [1, Controller.BUTTON_UP, "Up"],
  40: [1, Controller.BUTTON_DOWN, "Down"],
  37: [1, Controller.BUTTON_LEFT, "Left"],
  39: [1, Controller.BUTTON_RIGHT, "Right"],

  // WASD Keys
  87: [1, Controller.BUTTON_UP, "W"],
  83: [1, Controller.BUTTON_DOWN, "S"],
  65: [1, Controller.BUTTON_LEFT, "A"],
  68: [1, Controller.BUTTON_RIGHT, "D"],

  // Button A (Jump / Select in menu): Space, X, K
  32: [1, Controller.BUTTON_A, "Space"],
  88: [1, Controller.BUTTON_A, "X"],
  75: [1, Controller.BUTTON_A, "K"],

  // Button B (Fire / Cancel): Z, J
  90: [1, Controller.BUTTON_B, "Z"],
  74: [1, Controller.BUTTON_B, "J"],

  // Start & Select: Enter, Shift, Tab
  13: [1, Controller.BUTTON_START, "Enter"],
  16: [1, Controller.BUTTON_SELECT, "Shift"],
  9: [1, Controller.BUTTON_SELECT, "Tab"],
};

// TV Remote Mode Key Mappings
const TV_REMOTE_MAPPINGS = {
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

// Selection helper
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

// Request true full screen on the document
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

// Launch Game in Full Screen
async function launchGame() {
  // Enter full screen if user prefers
  enterFullScreen();

  // Hide startup modal completely
  startupModal.classList.add("hidden");

  // Unlock audio
  if (browser && browser._speakers?.audioCtx) {
    try {
      if (browser._speakers.audioCtx.state === "suspended") {
        await browser._speakers.audioCtx.resume();
      }
    } catch (e) {
      console.warn("AudioContext resume error:", e);
    }
  }

  // Apply chosen controller mappings (defaulting to laptop keyboard)
  const mappings =
    currentMode === "keyboard" ? KEYBOARD_MAPPINGS : TV_REMOTE_MAPPINGS;
  if (browser) {
    browser.keyboard.setKeys(mappings);
    browser.fitInParent();
  }

  audioUnlocked = true;
}

// Load and Initialize ROM
async function initGame() {
  try {
    const urlsToTry = [
      gameRomUrl,
      "/roms/1200-in-1.nes",
      "./roms/1200-in-1.nes",
      "../roms/1200-in-1.nes"
    ];
    let res = null;

    for (const url of urlsToTry) {
      if (!url) continue;
      try {
        const testRes = await fetch(url);
        if (testRes.ok) {
          res = testRes;
          break;
        }
      } catch {
        // try next
      }
    }

    if (!res || !res.ok) {
      throw new Error("Failed to load 1200-in-1.nes from available paths");
    }

    const buf = await res.arrayBuffer();
    const romData = new Uint8Array(buf);

    browser = new Browser({
      container: gameContainer,
      romData: romData,
      onError: (err) => {
        console.error("NES Emulation error:", err);
      },
    });

    // Set keyboard mappings by default
    browser.keyboard.setKeys(KEYBOARD_MAPPINGS);

    setTimeout(() => {
      if (browser) browser.fitInParent();
    }, 100);
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

// Setup Event Listeners for Startup Modal
function setupModalEvents() {
  optKeyboard.addEventListener("click", () => {
    selectMode("keyboard");
  });

  optTvRemote.addEventListener("click", () => {
    selectMode("tv");
  });

  btnStart.addEventListener("click", () => {
    launchGame();
  });

  window.addEventListener("keydown", (e) => {
    if (!audioUnlocked && !startupModal.classList.contains("hidden")) {
      if (
        e.keyCode === 38 ||
        e.keyCode === 19 ||
        e.keyCode === 37 ||
        e.keyCode === 21
      ) {
        e.preventDefault();
        selectMode("keyboard");
      } else if (
        e.keyCode === 40 ||
        e.keyCode === 20 ||
        e.keyCode === 39 ||
        e.keyCode === 22
      ) {
        e.preventDefault();
        selectMode("tv");
      } else if (e.keyCode === 13 || e.keyCode === 23 || e.keyCode === 32) {
        e.preventDefault();
        launchGame();
      }
    }
  });

  window.addEventListener("resize", () => {
    if (browser) browser.fitInParent();
  });

  document.addEventListener("fullscreenchange", () => {
    setTimeout(() => {
      if (browser) browser.fitInParent();
    }, 100);
  });
}

// Setup Touch Controls for Mobile Screen
function setupTouchControls() {
  const BUTTON_MAP = {
    up: Controller.BUTTON_UP,
    down: Controller.BUTTON_DOWN,
    left: Controller.BUTTON_LEFT,
    right: Controller.BUTTON_RIGHT,
    a: Controller.BUTTON_A,
    b: Controller.BUTTON_B,
    start: Controller.BUTTON_START,
    select: Controller.BUTTON_SELECT,
  };

  const touchButtons = document.querySelectorAll(
    "#touch-controls button[data-btn]"
  );

  touchButtons.forEach((btn) => {
    const btnKey = btn.getAttribute("data-btn");
    const nesButton = BUTTON_MAP[btnKey];

    if (nesButton === undefined) return;

    const handlePress = (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add("touch-active");
      if (browser?.nes) {
        browser.nes.buttonDown(1, nesButton);
      }
      if (navigator.vibrate) {
        try {
          navigator.vibrate(15);
        } catch {}
      }
    };

    const handleRelease = (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.remove("touch-active");
      if (browser?.nes) {
        browser.nes.buttonUp(1, nesButton);
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
setupModalEvents();
setupTouchControls();
initGame();

