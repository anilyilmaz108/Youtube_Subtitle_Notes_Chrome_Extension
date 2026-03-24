(function () {
  window.__ytSubtitleExtractorRun = async function () {
    const debug = {
      videoId: new URL(location.href).searchParams.get("v") || "",
      languageCode: "",
      format: "-",
      status: "-",
      failure: "-",
      attempts: [],
      loggedAt: new Date().toISOString()
    };

    try {
      const playerResponse = getPlayerResponse();
      const captionTrack = pickBestCaptionTrack(playerResponse);

      if (!captionTrack) {
        debug.failure = "caption_track_not_found";
        throw new Error("Bu videoda kullanılabilir altyazı bulunamadı.");
      }

      debug.languageCode = captionTrack.languageCode || "";
      debug.baseUrlSample = (captionTrack.baseUrl || "").slice(0, 300);

      const transcript = await fetchTranscript(captionTrack.baseUrl, debug);

      if (!transcript.trim()) {
        debug.failure = "all_formats_empty";
        throw new Error("Altyazi metni bos geldi.");
      }

      const needsTranslation = (captionTrack.languageCode || "").toLowerCase().startsWith("en");
      const translatedText = needsTranslation ? await translateToTurkish(transcript, debug) : transcript;
      const title = document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim();
      const note = {
        id: `${debug.videoId}-${Date.now()}`,
        title,
        videoId: debug.videoId,
        videoUrl: `https://www.youtube.com/watch?v=${debug.videoId}`,
        languageCode: captionTrack.languageCode || "unknown",
        languageLabel: needsTranslation
          ? `${readCaptionName(captionTrack) || (captionTrack.languageCode || "unknown")} -> Turkce`
          : readCaptionName(captionTrack) || (captionTrack.languageCode || "unknown"),
        originalText: transcript,
        text: translatedText,
        savedAt: new Date().toISOString(),
        debug
      };

      debug.failure = "success";
      debug.loggedAt = new Date().toISOString();
      return note;
    } catch (error) {
      debug.loggedAt = new Date().toISOString();
      return {
        error: error.message || "Bilinmeyen hata",
        debug
      };
    }
  };

  function getPlayerResponse() {
    if (window.ytInitialPlayerResponse?.captions) {
      return window.ytInitialPlayerResponse;
    }

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
        if (parsed?.captions) {
          return parsed;
        }
      } catch {}
    }

    throw new Error("Video verisi sayfadan alınamadı.");
  }

  function pickBestCaptionTrack(playerResponse) {
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) {
      return null;
    }

    const manualEnglish = tracks.find(
      (track) => track.languageCode?.toLowerCase().startsWith("en") && !track.kind
    );
    const manualAny = tracks.find((track) => !track.kind);
    return manualEnglish || manualAny || tracks[0];
  }

  function readCaptionName(track) {
    const simpleText = track?.name?.simpleText;
    if (simpleText) {
      return simpleText;
    }

    const runs = Array.isArray(track?.name?.runs) ? track.name.runs : [];
    return runs.map((item) => item.text || "").join("").trim();
  }

  async function fetchTranscript(baseUrl, debug) {
    const resourceTranscript = await fetchTranscriptFromObservedResources(debug);
    if (resourceTranscript) {
      debug.format = "resource";
      debug.failure = "success";
      return resourceTranscript;
    }

    const attempts = [
      { format: "json3", loader: fetchTranscriptAsJson },
      { format: "srv3", loader: fetchTranscriptAsSrv3 },
      { format: "xml", loader: fetchTranscriptAsXml },
      { format: "vtt", loader: fetchTranscriptAsVtt },
      { format: "panel", loader: fetchTranscriptFromPanel }
    ];

    for (const attempt of attempts) {
      const text = await attempt.loader(baseUrl, debug);
      if (text) {
        debug.format = attempt.format;
        debug.failure = "success";
        return text;
      }
    }

    return "";
  }

  async function fetchTranscriptFromObservedResources(debug) {
    const urls = getObservedTimedTextUrls();

    if (!urls.length) {
      pushAttempt(debug, "resource", "-", "no_observed_timedtext_url");
      return "";
    }

    for (const url of urls) {
      const parsed = await fetchTextFromUrl(url, "resource", debug, parseTimedTextByUrl(url));
      if (parsed) {
        return parsed;
      }
    }

    return "";
  }

  async function fetchTranscriptAsJson(baseUrl, debug) {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    return fetchTextFromUrl(url.toString(), "json3", debug, (rawText) => {
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        return "";
      }

      const events = Array.isArray(data?.events) ? data.events : [];
      return events
        .flatMap((event) => (Array.isArray(event?.segs) ? event.segs : []))
        .map((segment) => decodeHtml(segment?.utf8 || ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    });
  }

  async function fetchTranscriptAsSrv3(baseUrl, debug) {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "srv3");
    return fetchTextFromUrl(url.toString(), "srv3", debug, parseXmlTranscript);
  }

  async function fetchTranscriptAsXml(baseUrl, debug) {
    const url = new URL(baseUrl);
    url.searchParams.delete("fmt");
    return fetchTextFromUrl(url.toString(), "xml", debug, parseXmlTranscript);
  }

  async function fetchTranscriptAsVtt(baseUrl, debug) {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "vtt");
    return fetchTextFromUrl(url.toString(), "vtt", debug, (rawText) =>
      rawText
        .replace(/^WEBVTT[\s\S]*?\n\n/, "")
        .split(/\n\n+/)
        .map((block) => block.split("\n"))
        .map((lines) =>
          lines.filter((line) => line && !line.includes("-->") && !/^\d+$/.test(line)).join(" ")
        )
        .join(" ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  async function fetchTranscriptFromPanel(baseUrl, debug) {
    try {
      const opened = await openTranscriptPanel();
      if (!opened) {
        pushAttempt(debug, "panel", "-", "panel_not_opened");
        return "";
      }

      const text = await collectTranscriptFromPanel();
      if (!text) {
        pushAttempt(debug, "panel", "-", "panel_empty");
        return "";
      }

      pushAttempt(debug, "panel", "-", "success", text.slice(0, 400));
      return text;
    } catch (error) {
      pushAttempt(debug, "panel", "-", `panel_error:${error.message}`);
      return "";
    }
  }

  function parseTimedTextByUrl(url) {
    const format = new URL(url).searchParams.get("fmt") || "";

    if (format === "json3") {
      return (rawText) => {
        let data;
        try {
          data = JSON.parse(rawText);
        } catch {
          return "";
        }

        const events = Array.isArray(data?.events) ? data.events : [];
        return events
          .flatMap((event) => (Array.isArray(event?.segs) ? event.segs : []))
          .map((segment) => decodeHtml(segment?.utf8 || ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      };
    }

    if (format === "vtt") {
      return (rawText) =>
        rawText
          .replace(/^WEBVTT[\s\S]*?\n\n/, "")
          .split(/\n\n+/)
          .map((block) => block.split("\n"))
          .map((lines) =>
            lines.filter((line) => line && !line.includes("-->") && !/^\d+$/.test(line)).join(" ")
          )
          .join(" ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
    }

    return parseXmlTranscript;
  }

  async function fetchTextFromUrl(url, format, debug, parser) {
    try {
      const response = await fetch(url, {
        credentials: "include"
      });

      if (!response.ok) {
        pushAttempt(debug, format, response.status, "response_not_ok");
        return "";
      }

      const rawText = await response.text();
      if (!rawText.trim()) {
        const xhrText = await fetchTextWithXhr(url);

        if (!xhrText.trim()) {
          pushAttempt(debug, format, "-", "empty_body", url.slice(0, 400));
          return "";
        }

        const xhrParsed = parser(xhrText);
        if (!xhrParsed) {
          pushAttempt(debug, format, "-", "xhr_parsed_empty", xhrText.slice(0, 400));
          return "";
        }

        pushAttempt(debug, format, "-", "xhr_success", xhrParsed.slice(0, 400));
        return xhrParsed;
      }

      const parsed = parser(rawText);
      if (!parsed) {
        pushAttempt(debug, format, "-", "parsed_empty", rawText.slice(0, 400));
        return "";
      }

      pushAttempt(debug, format, "-", "success", parsed.slice(0, 400));
      return parsed;
    } catch (error) {
      pushAttempt(debug, format, "-", `fetch_error:${error.message}`);
      return "";
    }
  }

  function fetchTextWithXhr(url) {
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.onload = () => resolve(xhr.responseText || "");
        xhr.onerror = () => resolve("");
        xhr.send();
      } catch {
        resolve("");
      }
    });
  }

  function parseXmlTranscript(rawText) {
    const xmlDocument = new DOMParser().parseFromString(rawText, "text/xml");
    if (xmlDocument.querySelector("parsererror")) {
      return "";
    }

    const paragraphNodes = Array.from(xmlDocument.getElementsByTagName("p"));
    if (paragraphNodes.length) {
      return paragraphNodes
        .map((node) => {
          const segments = Array.from(node.getElementsByTagName("s"));
          if (segments.length) {
            return segments.map((segment) => decodeHtml(segment.textContent || "")).join(" ");
          }
          return decodeHtml(node.textContent || "");
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }

    const textNodes = Array.from(xmlDocument.getElementsByTagName("text"));
    return textNodes
      .map((node) => decodeHtml(node.textContent || ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function translateToTurkish(text, debug) {
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
        debug.failure = "translation_failed";
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
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    const chunks = [];
    let currentChunk = "";

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > maxLength && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  function decodeHtml(text) {
    if (!text || !text.includes("&")) {
      return text || "";
    }

    try {
      const documentNode = new DOMParser().parseFromString(`<!doctype html><body>${text}`, "text/html");
      return documentNode.body.textContent || "";
    } catch {
      return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'");
    }
  }

  function pushAttempt(debug, format, status, failure, sample = "") {
    debug.status = status;
    debug.format = format;
    debug.failure = failure;
    debug.attempts.push({
      format,
      status,
      failure,
      sample,
      loggedAt: new Date().toISOString()
    });
  }

  async function openTranscriptPanel() {
    const existingPanel = findTranscriptRoot();
    if (existingPanel) {
      return true;
    }

    const buttons = findAllElementsDeep("button, tp-yt-paper-item, ytd-menu-service-item-renderer");
    const moreButton = buttons.find((element) => {
      const label =
        (element.getAttribute("aria-label") || element.textContent || "").trim().toLowerCase();
      return label.includes("more actions") || label.includes("diğer işlemler");
    });

    if (!moreButton) {
      return false;
    }

    moreButton.click();
    await wait(700);

    const menuItems = findAllElementsDeep("tp-yt-paper-item, ytd-menu-service-item-renderer");
    const transcriptItem = menuItems.find((element) => {
      const text = (element.textContent || "").trim().toLowerCase();
      return (
        text.includes("show transcript") ||
        text.includes("transcript") ||
        text.includes("metin dökümü") ||
        text.includes("transkript")
      );
    });

    if (!transcriptItem) {
      document.body.click();
      return false;
    }

    transcriptItem.click();
    await wait(1200);
    return Boolean(findTranscriptRoot());
  }

  async function collectTranscriptFromPanel() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const root = findTranscriptRoot();
      if (!root) {
        await wait(400);
        continue;
      }

      await scrollTranscriptRoot(root);

      const texts = extractTranscriptTexts(root);
      if (texts.length >= 3) {
        return dedupeSequential(texts).join(" ").replace(/\s+/g, " ").trim();
      }

      await wait(400);
    }

    return "";
  }

  function findTranscriptRoot() {
    const selectors = [
      "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']",
      "ytd-transcript-search-panel-renderer",
      "ytd-transcript-renderer",
      "ytd-transcript-segment-list-renderer"
    ];

    for (const selector of selectors) {
      const match = findFirstElementDeep(selector);
      if (match) {
        return match;
      }
    }

    return null;
  }

  async function scrollTranscriptRoot(root) {
    const candidates = [
      root,
      ...findAllElementsDeep("#segments-container, #content, ytd-transcript-segment-list-renderer", root)
    ];

    const scrollable = candidates.find(
      (element) => element && element.scrollHeight > element.clientHeight
    );

    if (!scrollable) {
      return;
    }

    let previousHeight = -1;
    let stableCount = 0;

    for (let index = 0; index < 24; index += 1) {
      scrollable.scrollTop = scrollable.scrollHeight;
      await wait(220);

      if (scrollable.scrollHeight === previousHeight) {
        stableCount += 1;
      } else {
        stableCount = 0;
        previousHeight = scrollable.scrollHeight;
      }

      if (stableCount >= 3) {
        break;
      }
    }

    scrollable.scrollTop = 0;
    await wait(120);
  }

  function extractTranscriptTexts(root) {
    const segmentSelectors = [
      ".segment-text",
      "[id='segment-text']",
      "ytd-transcript-segment-renderer yt-formatted-string",
      "yt-formatted-string"
    ];

    const values = [];

    for (const selector of segmentSelectors) {
      const nodes = findAllElementsDeep(selector, root);
      for (const node of nodes) {
        const normalized = normalizeTranscriptText(node.textContent || "");
        if (normalized) {
          values.push(normalized);
        }
      }
      if (values.length >= 3) {
        break;
      }
    }

    return values;
  }

  function normalizeTranscriptText(text) {
    const value = decodeHtml(text).replace(/\s+/g, " ").trim();
    if (!value) {
      return "";
    }

    if (/^(\d{1,2}:)?\d{1,2}:\d{2}$/.test(value) || /^\d{1,2}:\d{2}$/.test(value)) {
      return "";
    }

    const blocked = [
      "transcript",
      "show transcript",
      "hide transcript",
      "metin dökümü",
      "konuşma metni",
      "konuşma sırasında"
    ];

    if (blocked.includes(value.toLowerCase())) {
      return "";
    }

    return value;
  }

  function dedupeSequential(values) {
    return values.filter((value, index) => index === 0 || value !== values[index - 1]);
  }

  function findFirstElementDeep(selector, root = document) {
    return findAllElementsDeep(selector, root)[0] || null;
  }

  function findAllElementsDeep(selector, root = document) {
    const results = [];
    const visited = new Set();
    const queue = [root];

    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }

      visited.add(current);

      if (current.querySelectorAll) {
        results.push(...current.querySelectorAll(selector));
      }

      const children = current.children ? Array.from(current.children) : [];
      for (const child of children) {
        queue.push(child);
        if (child.shadowRoot) {
          queue.push(child.shadowRoot);
        }
      }

      if (current.shadowRoot) {
        queue.push(current.shadowRoot);
      }
    }

    return results;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getObservedTimedTextUrls() {
    const entries = performance.getEntriesByType("resource");
    const urls = entries
      .map((entry) => entry.name)
      .filter((name) => name.includes("/api/timedtext"))
      .reverse();

    return Array.from(new Set(urls));
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
})();
