const CAPTURE_STORAGE_KEY = "subtitleCaptureState";
const WORD_TRANSLATION_CACHE = new Map();

const hoverState = {
  overlay: null,
  tooltip: null,
  syncIntervalId: null,
  lastSignature: "",
  resumeOnLeave: false,
  tooltipHideTimer: null
};

const captureState = {
  active: false,
  observer: null,
  intervalId: null,
  endedHandler: null,
  segments: [],
  lastText: "",
  videoId: "",
  videoUrl: "",
  title: "",
  languageCode: "unknown",
  languageLabel: "Bilinmiyor",
  startedAt: ""
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_CAPTURE_STATE") {
    getCaptureState().then(sendResponse);
    return true;
  }

  if (message?.type === "START_CAPTION_CAPTURE") {
    startCaptionCapture().then(sendResponse);
    return true;
  }

  if (message?.type === "STOP_CAPTION_CAPTURE") {
    stopCaptionCapture().then(sendResponse);
    return true;
  }

  return false;
});

initInteractiveSubtitleOverlay();

async function getCaptureState() {
  if (captureState.active) {
    const video = document.querySelector("video");

    return {
      success: true,
      isCapturing: true,
      segmentCount: captureState.segments.length,
      videoId: captureState.videoId,
      title: captureState.title,
      startedAt: captureState.startedAt,
      currentTime: video?.currentTime || 0
    };
  }

  return {
    success: true,
    isCapturing: false
  };
}

async function startCaptionCapture() {
  if (captureState.active) {
    return {
      success: true,
      isCapturing: true,
      message: "Yakalama zaten aktif."
    };
  }

  const video = document.querySelector("video");
  const videoId = new URL(location.href).searchParams.get("v");

  if (!video || !videoId) {
    return {
      success: false,
      error: "Önce bir YouTube video sayfası aç ve videonun yüklendiğinden emin ol."
    };
  }

  const trackInfo = getTrackInfoFromPage();

  captureState.active = true;
  captureState.segments = [];
  captureState.lastText = "";
  captureState.videoId = videoId;
  captureState.videoUrl = location.href;
  captureState.title = document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim();
  captureState.languageCode = trackInfo.languageCode;
  captureState.languageLabel = trackInfo.languageLabel;
  captureState.startedAt = new Date().toISOString();

  captureState.observer = new MutationObserver(() => {
    collectVisibleCaptions();
  });

  captureState.observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  captureState.intervalId = window.setInterval(() => {
    collectVisibleCaptions();
    persistCaptureState();
  }, 800);

  captureState.endedHandler = async () => {
    if (captureState.active) {
      await persistCaptureState();
    }
  };

  video.addEventListener("ended", captureState.endedHandler);
  collectVisibleCaptions();
  await persistCaptureState();

  return {
    success: true,
    isCapturing: true,
    message: "Canlı altyazı yakalama başlatıldı."
  };
}

async function stopCaptionCapture() {
  if (!captureState.active) {
    return {
      success: false,
      error: "Aktif bir yakalama oturumu yok."
    };
  }

  collectVisibleCaptions();
  teardownCapture();

  if (!captureState.segments.length) {
    await chrome.storage.local.remove(CAPTURE_STORAGE_KEY);
    return {
      success: false,
      error: "Yakalama sırasında görünür altyazı bulunamadı. Video oynarken altyazının açık olduğundan emin ol."
    };
  }

  const originalText = captureState.segments
    .map((segment) => `[${formatSeconds(segment.time)}] ${segment.text}`)
    .join("\n");

  const needsTranslation = captureState.languageCode.toLowerCase().startsWith("en");
  const translatedText = needsTranslation ? await translateToTurkish(originalText) : originalText;

  const note = {
    id: `${captureState.videoId}-${Date.now()}`,
    title: captureState.title,
    videoId: captureState.videoId,
    videoUrl: captureState.videoUrl,
    languageCode: captureState.languageCode,
    languageLabel: needsTranslation
      ? `${captureState.languageLabel} -> Turkce`
      : captureState.languageLabel,
    originalText,
    text: translatedText,
    savedAt: new Date().toISOString()
  };

  await chrome.storage.local.remove(CAPTURE_STORAGE_KEY);
  resetCaptureMemory();

  return {
    success: true,
    note
  };
}

function collectVisibleCaptions() {
  if (!captureState.active) {
    return;
  }

  const video = document.querySelector("video");
  const text = readVisibleCaptionText();

  if (!text || text === captureState.lastText) {
    return;
  }

  captureState.lastText = text;
  captureState.segments.push({
    time: video?.currentTime || 0,
    text
  });
}

function readVisibleCaptionText() {
  const selectors = [
    ".ytp-caption-window-container .ytp-caption-segment",
    ".captions-text .ytp-caption-segment",
    ".ytp-caption-window-container .caption-visual-line",
    "ytd-transcript-search-panel-renderer .segment-text"
  ];

  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    const text = nodes
      .map((node) => normalizeCaptionText(node.textContent || ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (text) {
      return text;
    }
  }

  return "";
}

function initInteractiveSubtitleOverlay() {
  injectInteractiveSubtitleStyles();
  createInteractiveSubtitleOverlay();

  hoverState.syncIntervalId = window.setInterval(() => {
    syncInteractiveSubtitleOverlay();
  }, 250);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hideWordTooltip();
      hideOverlay();
    }
  });
}

function injectInteractiveSubtitleStyles() {
  if (document.getElementById("yt-subtitle-hover-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "yt-subtitle-hover-styles";
  style.textContent = `
    .yt-subtitle-hover-overlay {
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      display: none;
      padding: 6px 10px;
      border-radius: 14px;
      background: rgba(16, 10, 7, 0.18);
      backdrop-filter: blur(4px);
    }

    .yt-subtitle-hover-line {
      text-align: center;
      line-height: 1.45;
      color: #ffffff;
      font-weight: 700;
      text-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
      font-size: 20px;
    }

    .yt-subtitle-hover-word {
      pointer-events: auto;
      cursor: help;
      border-radius: 8px;
      transition: background-color 0.14s ease, color 0.14s ease;
    }

    .yt-subtitle-hover-word:hover {
      background: rgba(255, 232, 214, 0.94);
      color: #231711;
      text-shadow: none;
    }

    .yt-subtitle-translate-tooltip {
      position: fixed;
      z-index: 2147483647;
      display: none;
      max-width: 240px;
      padding: 10px 12px;
      border-radius: 14px;
      background: rgba(255, 248, 240, 0.98);
      color: #2c1d16;
      border: 1px solid rgba(118, 78, 52, 0.14);
      box-shadow: 0 18px 40px rgba(24, 12, 8, 0.22);
      font-size: 13px;
      line-height: 1.45;
      white-space: normal;
      pointer-events: none;
    }

    .yt-subtitle-translate-tooltip strong {
      display: block;
      margin-bottom: 4px;
      color: #9d431e;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
  `;

  document.documentElement.appendChild(style);
}

function createInteractiveSubtitleOverlay() {
  if (hoverState.overlay && hoverState.tooltip) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "yt-subtitle-hover-overlay";

  const tooltip = document.createElement("div");
  tooltip.className = "yt-subtitle-translate-tooltip";

  document.body.appendChild(overlay);
  document.body.appendChild(tooltip);

  hoverState.overlay = overlay;
  hoverState.tooltip = tooltip;
}

function syncInteractiveSubtitleOverlay() {
  const captionData = getVisibleCaptionData();

  if (!captionData) {
    hideOverlay();
    return;
  }

  const signature = JSON.stringify(captionData.lines);

  if (hoverState.lastSignature !== signature) {
    hoverState.lastSignature = signature;
    renderOverlayWords(captionData.lines);
  }

  positionOverlay(captionData.rect);
}

function getVisibleCaptionData() {
  const windowContainer = document.querySelector(".ytp-caption-window-container");
  const lineNodes = Array.from(
    document.querySelectorAll(".ytp-caption-window-container .caption-visual-line")
  ).filter((node) => normalizeCaptionText(node.textContent || ""));

  if (!windowContainer || !lineNodes.length) {
    return null;
  }

  const rect = mergeRects(lineNodes.map((node) => node.getBoundingClientRect()));

  if (!rect || rect.width < 10 || rect.height < 10) {
    return null;
  }

  return {
    rect,
    lines: lineNodes.map((node) => normalizeCaptionText(node.textContent || "")).filter(Boolean)
  };
}

function mergeRects(rects) {
  const validRects = rects.filter((rect) => rect && rect.width > 0 && rect.height > 0);

  if (!validRects.length) {
    return null;
  }

  const left = Math.min(...validRects.map((rect) => rect.left));
  const top = Math.min(...validRects.map((rect) => rect.top));
  const right = Math.max(...validRects.map((rect) => rect.right));
  const bottom = Math.max(...validRects.map((rect) => rect.bottom));

  return {
    left,
    top,
    width: right - left,
    height: bottom - top
  };
}

function renderOverlayWords(lines) {
  if (!hoverState.overlay) {
    return;
  }

  hoverState.overlay.innerHTML = "";

  lines.forEach((line) => {
    const lineElement = document.createElement("div");
    lineElement.className = "yt-subtitle-hover-line";

    tokenizeLine(line).forEach((token) => {
      if (token.type === "space") {
        lineElement.appendChild(document.createTextNode(token.value));
        return;
      }

      const word = document.createElement("span");
      word.className = "yt-subtitle-hover-word";
      word.textContent = token.value;
      word.dataset.word = token.value;
      word.addEventListener("mouseenter", handleWordHoverStart);
      word.addEventListener("mouseleave", handleWordHoverEnd);
      lineElement.appendChild(word);
    });

    hoverState.overlay.appendChild(lineElement);
  });
}

function tokenizeLine(line) {
  return line.split(/(\s+)/).filter(Boolean).map((part) => ({
    type: /\s+/.test(part) ? "space" : "word",
    value: part
  }));
}

function positionOverlay(rect) {
  if (!hoverState.overlay) {
    return;
  }

  hoverState.overlay.style.display = "block";
  hoverState.overlay.style.left = `${Math.max(0, rect.left - 10)}px`;
  hoverState.overlay.style.top = `${Math.max(0, rect.top - 6)}px`;
  hoverState.overlay.style.width = `${rect.width + 20}px`;
  hoverState.overlay.style.minHeight = `${rect.height + 12}px`;
}

function hideOverlay() {
  if (hoverState.overlay) {
    hoverState.overlay.style.display = "none";
  }

  hoverState.lastSignature = "";
  hideWordTooltip();
}

async function handleWordHoverStart(event) {
  const word = (event.currentTarget?.dataset.word || "").trim();

  if (!word) {
    return;
  }

  clearTimeout(hoverState.tooltipHideTimer);

  const video = document.querySelector("video");
  hoverState.resumeOnLeave = Boolean(video && !video.paused);

  if (hoverState.resumeOnLeave) {
    video.pause();
  }

  showWordTooltip(event.currentTarget, "Yukleniyor...");

  try {
    const translated = await translateHoveredWord(word);
    showWordTooltip(event.currentTarget, translated || "Ceviri bulunamadi.");
  } catch {
    showWordTooltip(event.currentTarget, "Ceviri alinamadi.");
  }
}

function handleWordHoverEnd() {
  hoverState.tooltipHideTimer = window.setTimeout(() => {
    hideWordTooltip();
    const video = document.querySelector("video");

    if (hoverState.resumeOnLeave && video?.paused) {
      video.play().catch(() => {});
    }

    hoverState.resumeOnLeave = false;
  }, 80);
}

function showWordTooltip(target, meaning) {
  if (!hoverState.tooltip) {
    return;
  }

  const rect = target.getBoundingClientRect();
  hoverState.tooltip.replaceChildren();
  const label = document.createElement("strong");
  label.textContent = "Turkce";
  const textNode = document.createElement("span");
  textNode.textContent = meaning;
  hoverState.tooltip.appendChild(label);
  hoverState.tooltip.appendChild(textNode);
  hoverState.tooltip.style.display = "block";

  const tooltipRect = hoverState.tooltip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - tooltipRect.width - 16, Math.max(12, rect.left));
  const top = Math.max(12, rect.top - tooltipRect.height - 12);

  hoverState.tooltip.style.left = `${left}px`;
  hoverState.tooltip.style.top = `${top}px`;
}

function hideWordTooltip() {
  if (hoverState.tooltip) {
    hoverState.tooltip.style.display = "none";
  }
}

async function translateHoveredWord(word) {
  const normalizedWord = word.toLowerCase();

  if (WORD_TRANSLATION_CACHE.has(normalizedWord)) {
    return WORD_TRANSLATION_CACHE.get(normalizedWord);
  }

  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", "tr");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", word);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error("Ceviri alinamadi.");
  }

  const data = await response.json();
  const translatedWord = Array.isArray(data?.[0])
    ? data[0].map((item) => item[0] || "").join("")
    : "";

  WORD_TRANSLATION_CACHE.set(normalizedWord, translatedWord);
  return translatedWord;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeCaptionText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function getTrackInfoFromPage() {
  const tracks = readCaptionTracksFromScripts();
  const selectedTrack = tracks[0];
  const languageCode = selectedTrack?.languageCode || "unknown";
  const simpleText = selectedTrack?.name?.simpleText;
  const runs = Array.isArray(selectedTrack?.name?.runs) ? selectedTrack.name.runs : [];
  const languageLabel = simpleText || runs.map((item) => item.text || "").join("").trim() || languageCode;

  return {
    languageCode,
    languageLabel
  };
}

function readCaptionTracksFromScripts() {
  const scripts = Array.from(document.scripts);

  for (const script of scripts) {
    const content = script.textContent || "";

    if (!content.includes("ytInitialPlayerResponse")) {
      continue;
    }

    const jsonText = extractJsonAfterMarker(content, "var ytInitialPlayerResponse = ");

    if (!jsonText) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonText);
      return parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    } catch {
      continue;
    }
  }

  return [];
}

async function persistCaptureState() {
  await chrome.storage.local.set({
    [CAPTURE_STORAGE_KEY]: {
      isCapturing: captureState.active,
      videoId: captureState.videoId,
      title: captureState.title,
      startedAt: captureState.startedAt,
      segmentCount: captureState.segments.length,
      languageLabel: captureState.languageLabel,
      lastText: captureState.lastText
    }
  });
}

function teardownCapture() {
  if (captureState.observer) {
    captureState.observer.disconnect();
  }

  if (captureState.intervalId) {
    window.clearInterval(captureState.intervalId);
  }

  const video = document.querySelector("video");
  if (video && captureState.endedHandler) {
    video.removeEventListener("ended", captureState.endedHandler);
  }
}

function resetCaptureMemory() {
  captureState.active = false;
  captureState.observer = null;
  captureState.intervalId = null;
  captureState.endedHandler = null;
  captureState.segments = [];
  captureState.lastText = "";
  captureState.videoId = "";
  captureState.videoUrl = "";
  captureState.title = "";
  captureState.languageCode = "unknown";
  captureState.languageLabel = "Bilinmiyor";
  captureState.startedAt = "";
}

function formatSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `${String(remainingMinutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

async function translateToTurkish(text) {
  const chunks = splitIntoChunks(text, 3500);
  const translatedParts = [];

  for (const chunk of chunks) {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "en");
    url.searchParams.set("tl", "tr");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", chunk);

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error("Ceviri servisine ulasilamadi.");
    }

    const data = await response.json();
    const translatedChunk = Array.isArray(data?.[0])
      ? data[0].map((item) => item[0] || "").join("")
      : "";

    translatedParts.push(translatedChunk);
  }

  return translatedParts.join(" ").replace(/\s+/g, " ").trim();
}

function splitIntoChunks(text, maxLength) {
  const lines = text.split("\n");
  const chunks = [];
  let currentChunk = "";

  for (const line of lines) {
    if ((currentChunk + "\n" + line).length > maxLength && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = line;
    } else {
      currentChunk += `${currentChunk ? "\n" : ""}${line}`;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

function extractJsonAfterMarker(text, marker) {
  const startIndex = text.indexOf(marker);

  if (startIndex === -1) {
    return null;
  }

  let index = startIndex + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;

  for (; index < text.length; index += 1) {
    const char = text[index];

    if (!started) {
      if (char === "{") {
        started = true;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(startIndex + marker.length, index + 1);
      }
    }
  }

  return null;
}
