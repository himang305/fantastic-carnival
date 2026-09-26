import { Browser, Controller } from "jsnes";
import marioRomUrl from "../roms/mario.nes?url";

// Global state
let browser = null;
let currentMode = "tv"; // 'tv' or 'keyboard'
let audioUnlocked = false;

// DOM Elements
const gameContainer = document.getElementById("game");
const startupModal = document.getElementById("startup-modal");
const optTvRemote = document.getElementById("opt-tv-remote");
const optKeyboard = document.getElementById("opt-keyboard");
const btnStart = document.getElementById("btn-start");

// Keyboard Mode Key Mappings
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

  // Jump: X, K, Space
  88: [1, Controller.BUTTON_A, "X"],
  75: [1, Controller.BUTTON_A, "K"],
  32: [1, Controller.BUTTON_A, "Space"],

  // Run / Fireball: Z, J
  90: [1, Controller.BUTTON_B, "Z"],
  74: [1, Controller.BUTTON_B, "J"],

  // Start & Select
  13: [1, Controller.BUTTON_START, "Enter"],
  16: [1, Controller.BUTTON_SELECT, "Shift"],
  9: [1, Controller.BUTTON_SELECT, "Tab"],
};

// TV Remote Mode Key Mappings (Standard TV D-Pad, OK button, Media/Color keys)
const TV_REMOTE_MAPPINGS = {
  // Standard D-Pad & Android TV / Tizen / WebOS D-Pad codes
  38: [1, Controller.BUTTON_UP, "Up"],
  19: [1, Controller.BUTTON_UP, "DPadUp"],
  40: [1, Controller.BUTTON_DOWN, "Down"],
  20: [1, Controller.BUTTON_DOWN, "DPadDown"],
  37: [1, Controller.BUTTON_LEFT, "Left"],
  21: [1, Controller.BUTTON_LEFT, "DPadLeft"],
  39: [1, Controller.BUTTON_RIGHT, "Right"],
  22: [1, Controller.BUTTON_RIGHT, "DPadRight"],

  // Center OK / Select Button on TV Remote -> Button A (Jump)
  13: [1, Controller.BUTTON_A, "OK"],
  23: [1, Controller.BUTTON_A, "Select"],
  65385: [1, Controller.BUTTON_A, "Enter"],

  // Media / Color / Number Keys -> Button B (Run / Fireball)
  // FastForward (417), Play (415), Red (403), Blue (406), Number 0 (48), Number 2 (50)
  417: [1, Controller.BUTTON_B, "FastForward"],
  415: [1, Controller.BUTTON_B, "Play"],
  403: [1, Controller.BUTTON_B, "Red"],
  406: [1, Controller.BUTTON_B, "Blue"],
  48: [1, Controller.BUTTON_B, "0"],
  96: [1, Controller.BUTTON_B, "Num0"],
  50: [1, Controller.BUTTON_B, "2"],
  90: [1, Controller.BUTTON_B, "Z"],

  // Pause / Play / Menu / Yellow / Number 1 -> Start
  179: [1, Controller.BUTTON_START, "PlayPause"],
  405: [1, Controller.BUTTON_START, "Yellow"],
  49: [1, Controller.BUTTON_START, "1"],
  18: [1, Controller.BUTTON_START, "Menu"],

  // Back / Green / Return -> Select
  10009: [1, Controller.BUTTON_SELECT, "Back"],
  27: [1, Controller.BUTTON_SELECT, "Escape"],
  404: [1, Controller.BUTTON_SELECT, "Green"],
  16: [1, Controller.BUTTON_SELECT, "Shift"],
};

// Selection helper
function selectMode(mode) {
  currentMode = mode;
  if (mode === "tv") {
    optTvRemote.classList.add("active");
    optKeyboard.classList.remove("active");
  } else {
    optKeyboard.classList.add("active");
    optTvRemote.classList.remove("active");
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
  // Enter full screen
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

  // Apply chosen controller mappings
  const mappings =
    currentMode === "tv" ? TV_REMOTE_MAPPINGS : KEYBOARD_MAPPINGS;
  if (browser) {
    browser.keyboard.setKeys(mappings);
    browser.fitInParent();
  }

  audioUnlocked = true;
}

// Load and Initialize ROM
async function initGame() {
  try {
    const urlsToTry = [marioRomUrl, "/roms/mario.nes", "./roms/mario.nes"];
    let res = null;
    let loadedUrl = "";

    for (const url of urlsToTry) {
      if (!url) continue;
      try {
        const testRes = await fetch(url);
        if (testRes.ok) {
          res = testRes;
          loadedUrl = url;
          break;
        }
      } catch {
        // try next
      }
    }

    if (!res || !res.ok) {
      throw new Error(`Failed to load mario.nes from available paths`);
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

    // Start with TV remote mappings by default
    browser.keyboard.setKeys(TV_REMOTE_MAPPINGS);

    setTimeout(() => {
      if (browser) browser.fitInParent();
    }, 100);
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

// Setup Event Listeners for Startup Modal
function setupModalEvents() {
  // Click option cards
  optTvRemote.addEventListener("click", () => {
    selectMode("tv");
  });

  optKeyboard.addEventListener("click", () => {
    selectMode("keyboard");
  });

  // Launch button
  btnStart.addEventListener("click", () => {
    launchGame();
  });

  // Keyboard and TV D-Pad navigation for modal
  window.addEventListener("keydown", (e) => {
    // If modal is still visible, navigate options
    if (!audioUnlocked && !startupModal.classList.contains("hidden")) {
      // Up/Down/Left/Right changes selection
      if (
        e.keyCode === 38 ||
        e.keyCode === 19 ||
        e.keyCode === 37 ||
        e.keyCode === 21
      ) {
        e.preventDefault();
        selectMode("tv");
      } else if (
        e.keyCode === 40 ||
        e.keyCode === 20 ||
        e.keyCode === 39 ||
        e.keyCode === 22
      ) {
        e.preventDefault();
        selectMode("keyboard");
      } else if (e.keyCode === 13 || e.keyCode === 23 || e.keyCode === 32) {
        // Enter / OK / Space launches game
        e.preventDefault();
        launchGame();
      }
    }
  });

  // Keep screen fit on resize or fullscreen toggle
  window.addEventListener("resize", () => {
    if (browser) browser.fitInParent();
  });

  document.addEventListener("fullscreenchange", () => {
    setTimeout(() => {
      if (browser) browser.fitInParent();
    }, 100);
  });
}

// Start everything
setupModalEvents();
initGame();
