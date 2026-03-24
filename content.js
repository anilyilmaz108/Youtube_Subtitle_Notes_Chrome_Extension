const CAPTURE_STORAGE_KEY = "subtitleCaptureState";

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
