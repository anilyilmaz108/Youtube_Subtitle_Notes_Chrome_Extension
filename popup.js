const statusText = document.getElementById("statusText");
const debugText = document.getElementById("debugText");
const saveCurrentBtn = document.getElementById("saveCurrentBtn");
const downloadLatestBtn = document.getElementById("downloadLatestBtn");
const clearAllBtn = document.getElementById("clearAllBtn");
const notesList = document.getElementById("notesList");
const noteItemTemplate = document.getElementById("noteItemTemplate");
const captureBadge = document.getElementById("captureBadge");
const modeValue = document.getElementById("modeValue");
const noteCountValue = document.getElementById("noteCountValue");
const captureCountValue = document.getElementById("captureCountValue");
const pulseDot = document.getElementById("pulseDot");

document.addEventListener("DOMContentLoaded", init);
saveCurrentBtn.addEventListener("click", handleSaveCurrentVideo);
downloadLatestBtn.addEventListener("click", handleDownloadLatest);
clearAllBtn.addEventListener("click", handleClearAll);

async function init() {
  await refreshCaptureUi();
  await renderNotes();
  await renderDebugInfo();
  await renderHeaderStats();
}

async function handleSaveCurrentVideo() {
  setStatus("Aktif YouTube videosu kontrol ediliyor...");
  toggleButtons(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id || !tab.url?.includes("youtube.com/watch")) {
      throw new Error("Önce bir YouTube video sayfası aç.");
    }

    const state = await sendMessageToVideoTab(tab.id, { type: "GET_CAPTURE_STATE" });

    if (state?.isCapturing) {
      const response = await sendMessageToVideoTab(tab.id, { type: "STOP_CAPTION_CAPTURE" });

      if (!response?.success) {
        throw new Error(response?.error || "Yakalama durdurulamadı.");
      }

      await saveNote(response.note);
      await chrome.storage.local.set({ subtitleDebug: null });
      setStatus(`Kaydedildi: ${response.note.title}`);
    } else {
      const response = await sendMessageToVideoTab(tab.id, { type: "START_CAPTION_CAPTURE" });

      if (!response?.success) {
        throw new Error(response?.error || "Yakalama başlatılamadı.");
      }

      setStatus("Yakalama basladi. Video oynarken altyazilar toplanacak. Bitince tekrar tiklayip kaydet.");
    }

    await refreshCaptureUi();
    await renderNotes();
    await renderDebugInfo();
    await renderHeaderStats();
  } catch (error) {
    setStatus(error.message || "Bir hata oluştu.");
  } finally {
    toggleButtons(false);
  }
}

async function handleDownloadLatest() {
  const { subtitleNotes = [] } = await chrome.storage.local.get("subtitleNotes");
  const latestNote = subtitleNotes[0];

  if (!latestNote) {
    setStatus("İndirilecek kayıt bulunamadı.");
    return;
  }

  const noteToDownload = await ensureTranslatedNote(latestNote);
  await downloadNote(noteToDownload);
  setStatus(`İndirildi: ${latestNote.title}`);
}

async function handleClearAll() {
  await chrome.storage.local.set({ subtitleNotes: [], subtitleDebug: null, subtitleCaptureState: null });
  await renderNotes();
  await renderDebugInfo();
  await refreshCaptureUi();
  await renderHeaderStats();
  setStatus("Tüm kayıtlar temizlendi.");
}

async function renderDebugInfo() {
  const { subtitleDebug, subtitleCaptureState } = await chrome.storage.local.get([
    "subtitleDebug",
    "subtitleCaptureState"
  ]);

  if (subtitleCaptureState?.isCapturing) {
    debugText.hidden = false;
    debugText.textContent = [
      "Canli Yakalama",
      `Video: ${subtitleCaptureState.title || "-"}`,
      `Dil: ${subtitleCaptureState.languageLabel || "-"}`,
      `Baslangic: ${formatDate(subtitleCaptureState.startedAt)}`,
      `Toplanan Satir: ${subtitleCaptureState.segmentCount || 0}`,
      subtitleCaptureState.lastText ? "" : null,
      subtitleCaptureState.lastText ? `Son Altyazi:\n${subtitleCaptureState.lastText}` : ""
    ]
      .filter(Boolean)
      .join("\n");
    return;
  }

  if (!subtitleDebug) {
    debugText.hidden = true;
    debugText.textContent = "";
    return;
  }

  debugText.hidden = false;
  const attempts = Array.isArray(subtitleDebug.attempts) ? subtitleDebug.attempts : [];
  const attemptsText = attempts.length
    ? attempts
        .map(
          (attempt, index) =>
            `${index + 1}. ${attempt.format} | status=${attempt.status} | reason=${attempt.failure}${
              attempt.sample ? `\n${attempt.sample}` : ""
            }`
        )
        .join("\n\n")
    : "";

  debugText.textContent = [
    `Debug`,
    `Video: ${subtitleDebug.videoId || "-"}`,
    `Dil: ${subtitleDebug.languageCode || "-"}`,
    `Format: ${subtitleDebug.format || "-"}`,
    `Durum: ${subtitleDebug.status || "-"}`,
    `Sebep: ${subtitleDebug.failure || "-"}`,
    `Zaman: ${formatDate(subtitleDebug.loggedAt)}`,
    "",
    attemptsText ? `Denemeler:\n${attemptsText}` : "",
    subtitleDebug.sample ? `Ornek:\n${subtitleDebug.sample}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function renderNotes() {
  const { subtitleNotes = [] } = await chrome.storage.local.get("subtitleNotes");
  notesList.innerHTML = "";
  noteCountValue.textContent = String(subtitleNotes.length);

  downloadLatestBtn.disabled = subtitleNotes.length === 0;
  clearAllBtn.disabled = subtitleNotes.length === 0;

  if (subtitleNotes.length === 0) {
    const emptyText = document.createElement("p");
    emptyText.className = "empty-state";
    emptyText.textContent = "Henüz kayıt yok.";
    notesList.appendChild(emptyText);
    return;
  }

  subtitleNotes.forEach((note) => {
    const fragment = noteItemTemplate.content.cloneNode(true);
    const noteItem = fragment.querySelector(".note-item");
    const title = fragment.querySelector(".note-title");
    const meta = fragment.querySelector(".note-meta");
    const preview = fragment.querySelector(".note-preview");
    const downloadBtn = fragment.querySelector(".download-note-btn");
    const languageTag = fragment.querySelector(".note-lang");
    const kindTag = fragment.querySelector(".note-kind");

    title.textContent = note.title;
    meta.textContent = formatDate(note.savedAt);
    languageTag.textContent = note.languageLabel;
    kindTag.textContent =
      note.originalText && note.originalText !== note.text ? "Ceviri + Orijinal" : "Tek Metin";
    preview.textContent = note.text.slice(0, 220);
    downloadBtn.addEventListener("click", async () => {
      const noteToDownload = await ensureTranslatedNote(note);
      await downloadNote(noteToDownload);
      setStatus(`İndirildi: ${note.title}`);
    });

    noteItem.dataset.noteId = note.id;
    notesList.appendChild(fragment);
  });
}

async function saveNote(note) {
  const { subtitleNotes = [] } = await chrome.storage.local.get("subtitleNotes");
  const nextNotes = [note, ...subtitleNotes].slice(0, 50);
  await chrome.storage.local.set({ subtitleNotes: nextNotes });
}

async function downloadNote(note) {
  const blob = new Blob([buildDownloadContent(note)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename: `youtube-subtitle-notes/${sanitizeFilename(note.title)}.txt`,
      saveAs: true
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function ensureTranslatedNote(note) {
  const hasOriginal = Boolean(note.originalText?.trim());
  const hasUsableTranslation =
    Boolean(note.text?.trim()) &&
    normalizeText(note.text) !== normalizeText(note.originalText || "") &&
    note.languageLabel?.includes("Turkce");

  if (!hasOriginal || hasUsableTranslation) {
    return note;
  }

  setStatus("Turkce ceviri hazirlaniyor...");
  const translatedText = await translateToTurkish(note.originalText);
  const nextNote = {
    ...note,
    text: translatedText,
    languageLabel: note.languageLabel?.includes("Turkce")
      ? note.languageLabel
      : `${note.languageLabel} -> Turkce`
  };

  await replaceStoredNote(nextNote);
  return nextNote;
}

function buildDownloadContent(note) {
  const hasOriginal = Boolean(note.originalText?.trim());
  const translationText = hasOriginal ? note.text || note.originalText : note.text;

  return [
    "YOUTUBE SUBTITLE NOTE",
    "====================",
    "",
    `Baslik       : ${note.title}`,
    `Video URL    : ${note.videoUrl}`,
    `Dil          : ${note.languageLabel}`,
    `Kayit Tarihi : ${formatDate(note.savedAt)}`,
    "",
    "OZET",
    "----",
    hasOriginal
      ? "Bu rapor canli yakalanan altyazinin Turkce cevirisini ve orijinal metnini birlikte icerir."
      : "Bu rapor canli yakalanan altyazi metnini icerir.",
    "",
    hasOriginal ? "TURKCE CEVIRI" : "METIN",
    hasOriginal ? "-------------" : "-----",
    translationText,
    hasOriginal ? "" : null,
    hasOriginal ? "ORIJINAL METIN" : null,
    hasOriginal ? "--------------" : null,
    hasOriginal ? note.originalText : null
  ].join("\n");
}

function sanitizeFilename(value) {
  return value.replace(/[\\/:*?"<>|]+/g, "").trim().slice(0, 80) || "subtitle-note";
}

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

async function replaceStoredNote(updatedNote) {
  const { subtitleNotes = [] } = await chrome.storage.local.get("subtitleNotes");
  const nextNotes = subtitleNotes.map((note) => (note.id === updatedNote.id ? updatedNote : note));
  await chrome.storage.local.set({ subtitleNotes: nextNotes });
  await renderNotes();
}

async function translateToTurkish(text) {
  const chunks = splitIntoChunks(text, 3500);
  const translatedParts = [];

  for (const chunk of chunks) {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", "tr");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", chunk);

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error("Turkce ceviri alinamadi.");
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

function formatDate(isoString) {
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(isoString));
}

function setStatus(message) {
  statusText.textContent = message;
}

function toggleButtons(isBusy) {
  saveCurrentBtn.disabled = isBusy;
  downloadLatestBtn.disabled = isBusy;
  clearAllBtn.disabled = isBusy;
}

async function refreshCaptureUi() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !tab.url?.includes("youtube.com/watch")) {
    saveCurrentBtn.textContent = "Yakalamayi Baslat";
    return;
  }

  try {
    const state = await sendMessageToVideoTab(tab.id, { type: "GET_CAPTURE_STATE" });
    saveCurrentBtn.textContent = state?.isCapturing ? "Durdur ve Kaydet" : "Yakalamayi Baslat";
    captureBadge.textContent = state?.isCapturing ? "Kayit Acik" : "Hazir";
    captureCountValue.textContent = state?.isCapturing ? `${state.segmentCount || 0} satir` : "Beklemede";
    pulseDot.style.background = state?.isCapturing ? "var(--success)" : "var(--accent)";
  } catch {
    saveCurrentBtn.textContent = "Yakalamayi Baslat";
    captureBadge.textContent = "Hazir";
    captureCountValue.textContent = "Beklemede";
    pulseDot.style.background = "var(--accent)";
  }
}

async function renderHeaderStats() {
  const { subtitleCaptureState, subtitleNotes = [] } = await chrome.storage.local.get([
    "subtitleCaptureState",
    "subtitleNotes"
  ]);

  noteCountValue.textContent = String(subtitleNotes.length);
  modeValue.textContent = "Canli Yakalama";
  captureBadge.textContent = subtitleCaptureState?.isCapturing ? "Kayit Acik" : "Hazir";
  captureCountValue.textContent = subtitleCaptureState?.isCapturing
    ? `${subtitleCaptureState.segmentCount || 0} satir`
    : "Beklemede";
  pulseDot.style.background = subtitleCaptureState?.isCapturing ? "var(--success)" : "var(--accent)";
}

async function sendMessageToVideoTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const needsInjection =
      error?.message?.includes("Receiving end does not exist") ||
      error?.message?.includes("Could not establish connection");

    if (!needsInjection) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}
