const reportTitle = document.getElementById("reportTitle");
const reportSummary = document.getElementById("reportSummary");
const metaVideo = document.getElementById("metaVideo");
const metaLanguage = document.getElementById("metaLanguage");
const metaSavedAt = document.getElementById("metaSavedAt");
const translationText = document.getElementById("translationText");
const originalText = document.getElementById("originalText");

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const params = new URLSearchParams(location.search);
  const reportKey = params.get("reportKey");
  const autoPrint = params.get("autoprint") === "1";

  if (!reportKey) {
    renderMissing("Rapor anahtari bulunamadi.");
    return;
  }

  const data = await chrome.storage.local.get(reportKey);
  const payload = data?.[reportKey];
  const note = payload?.note;

  if (!note) {
    renderMissing("Rapor verisi bulunamadi.");
    return;
  }

  renderNote(note);

  if (autoPrint) {
    setTimeout(() => window.print(), 350);
  }
}

function renderNote(note) {
  reportTitle.textContent = note.title;
  reportSummary.textContent =
    "Bu PDF raporu canli yakalanan altyazinin Turkce cevirisini ve orijinal metnini birlikte sunar.";
  metaVideo.textContent = note.title;
  metaLanguage.textContent = note.languageLabel;
  metaSavedAt.textContent = formatDate(note.savedAt);
  translationText.textContent = note.text || note.originalText || "Ceviri bulunamadi.";
  originalText.textContent = note.originalText || note.text || "Metin bulunamadi.";
}

function renderMissing(message) {
  reportTitle.textContent = "Rapor Yuklenemedi";
  reportSummary.textContent = message;
  metaVideo.textContent = "-";
  metaLanguage.textContent = "-";
  metaSavedAt.textContent = "-";
  translationText.textContent = message;
  originalText.textContent = message;
}

function formatDate(isoString) {
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(isoString));
}
