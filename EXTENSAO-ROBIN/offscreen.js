"use strict";

(() => {
  const Core = globalThis.RobinCore || globalThis.JDarkCore;
  const IG_APP_ID = "936619743392459";
  const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
  const MAX_ZIP_PART_BYTES = 1.2 * 1024 * 1024 * 1024;
  let workerBusy = false;
  let cancelFlag = false;
  const activeAbortControllers = new Set();
  const createdObjectUrls = new Set();

  function emitProgress(job, patch) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    chrome.runtime.sendMessage({ type: "OFFSCREEN_PROGRESS", job }).catch(() => {});
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    activeAbortControllers.add(controller);
    try {
      if (cancelFlag) throw new Error("Download cancelado pelo usuário.");
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      activeAbortControllers.delete(controller);
    }
  }

  async function resolveFreshIgVideoUrl(reel) {
    const mediaId = Core.shortcodeToInstagramMediaId(reel.shortcode);
    const candidates = [
      mediaId ? `https://www.instagram.com/api/v1/media/${encodeURIComponent(mediaId)}/info/` : "",
      mediaId ? `https://www.instagram.com/api/v1/clips/item/?clips_media_id=${encodeURIComponent(mediaId)}` : "",
      `https://www.instagram.com/api/v1/media/shortcode/${encodeURIComponent(reel.shortcode)}/info/`
    ].filter(Boolean);

    for (const endpoint of candidates) {
      try {
        const res = await fetchWithTimeout(endpoint, {
          credentials: "include",
          cache: "no-store",
          headers: {
            Accept: "*/*",
            "X-IG-App-ID": IG_APP_ID,
            "X-ASBD-ID": "129477",
            "X-Requested-With": "XMLHttpRequest"
          }
        }, 22000);
        if (!res.ok) continue;
        const data = await res.json();
        const node = data?.items?.[0] || data?.item || data?.media || data?.clips?.items?.[0] || data?.data?.xdt_shortcode_media;
        const media = node?.media || node;
        const url = String(media?.video_url || media?.video_versions?.[0]?.url || "");
        if (Core.isValidMediaUrl(url, "instagram")) return url;
      } catch (_) {}
    }
    return "";
  }

  async function downloadBinaryBytes(url) {
    const res = await fetchWithTimeout(url, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`CDN retornou HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (!bytes.length || bytes.length > MAX_VIDEO_BYTES) {
      throw new Error("Arquivo de vídeo vazio ou acima de 300 MB.");
    }
    return bytes;
  }

  async function fetchItemBytes(reel, job) {
    if (reel.demo) {
      const demoContent = [
        "Robin Minerador — Arquivo de Demonstração",
        `Plataforma: ${job.platform}`,
        `Perfil: @${job.profile}`,
        `Código: ${reel.shortcode}`,
        `Score Viral: ${Core.computeViralScore(reel)}`,
        `Visualizações: ${reel.views || 0}`,
        `Curtidas: ${reel.likes || 0}`,
        `Comentários: ${reel.comments || 0}`,
        `URL: ${reel.permalink}`
      ].join("\r\n");
      return new TextEncoder().encode(demoContent);
    }

    let mediaUrl = reel.videoUrl || "";
    if (!Core.isValidMediaUrl(mediaUrl, job.platform)) {
      if (job.platform === "instagram") {
        mediaUrl = await resolveFreshIgVideoUrl(reel);
      }
    }
    if (!mediaUrl) {
      throw new Error("URL direta do vídeo não liberada pela plataforma (inicie o Robin Companion para TikTok/YouTube).");
    }
    return await downloadBinaryBytes(mediaUrl);
  }

  async function sendBlobToBackground(blob, filename, shortcodes, jobSnapshot) {
    const objectUrl = URL.createObjectURL(blob);
    createdObjectUrls.add(objectUrl);
    const resp = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_FILE_READY",
      objectUrl,
      filename,
      shortcodes,
      job: { ...jobSnapshot }
    });
    if (!resp?.ok) throw new Error(resp?.error || "Não foi possível salvar o arquivo no navegador.");
  }

  async function processBatchPart({ chunk, partIndex, totalParts, baseOffset, job, includeCsv, counters }) {
    const archive = new (Core.RobinZipArchive || Core.JDarkZipArchive)();
    const completedReels = new Array(chunk.length);
    const partFailures = [];
    const safeProfile = Core.sanitizeSlug(job.profile, "perfil");
    let partBytes = 0;
    let cursor = 0;

    async function runWorker() {
      while (cursor < chunk.length) {
        const localIdx = cursor++;
        const item = chunk[localIdx];
        emitProgress(job, {
          stage: item.demo
            ? `Gerando pacote de demonstração ${partIndex + 1}/${totalParts}`
            : `Baixando mídia · ${counters.processed}/${job.total} (${item.shortcode})`,
          percent: Math.max(6, Math.round((counters.processed / job.total) * 85))
        });

        try {
          const fileBytes = await fetchItemBytes(item, job);
          if (partBytes + fileBytes.length > MAX_ZIP_PART_BYTES) {
            throw new Error("Lote atingiu o limite de 1,2 GB.");
          }
          partBytes += fileBytes.length;
          const ext = item.demo ? "txt" : "mp4";
          const seq = String(baseOffset + localIdx + 1).padStart(3, "0");
          archive.addFile(`videos/${safeProfile}_${seq}_${Core.sanitizeSlug(item.shortcode, "video")}.${ext}`, fileBytes);
          completedReels[localIdx] = item;
          counters.completed += 1;
        } catch (err) {
          const failRecord = { shortcode: item.shortcode, error: err.message };
          partFailures.push(failRecord);
          counters.failures.push(failRecord);
        }

        counters.processed += 1;
        emitProgress(job, {
          completed: counters.completed,
          failed: counters.failures.length,
          failures: counters.failures,
          percent: Math.max(10, Math.round((counters.processed / job.total) * 85))
        });
      }
    }

    await Promise.all(Array.from({ length: Math.min(3, chunk.length) }, runWorker));
    const succeeded = completedReels.filter(Boolean);
    if (!succeeded.length) return { succeeded, filename: "" };

    const partSuffix = totalParts > 1
      ? `_lote_${String(partIndex + 1).padStart(2, "0")}_de_${String(totalParts).padStart(2, "0")}`
      : "";

    if (includeCsv) {
      const csvText = Core.generateMetricsCsv(job.profile, succeeded, job.platform);
      archive.addFile(`metricas_${safeProfile}${partSuffix}.csv`, new TextEncoder().encode(csvText));
    }
    if (partFailures.length) {
      const errLines = partFailures.map((f) => `${f.shortcode}: ${f.error}`).join("\r\n");
      archive.addFile("falhas.txt", new TextEncoder().encode(errLines));
    }

    emitProgress(job, {
      stage: `Compactando ZIP ${partIndex + 1} de ${totalParts}...`,
      percent: 88 + Math.round(((partIndex + 1) / totalParts) * 10)
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    const zipFilename = `Robin/Robin_${Core.sanitizeSlug(job.platform)}_${safeProfile}_${dateStr}${partSuffix}.zip`;
    await sendBlobToBackground(archive.toBlob(), zipFilename, succeeded.map((r) => r.shortcode), {
      ...job,
      part: partIndex + 1,
      partCount: totalParts
    });
    return { succeeded, filename: zipFilename };
  }

  async function executeOffscreenDownload(message) {
    if (workerBusy) throw new Error("Já existe uma compactação em andamento.");
    workerBusy = true;
    cancelFlag = false;

    const { job, reels, includeCsv } = message;
    const counters = { processed: 0, completed: 0, failures: [] };
    const allSucceeded = [];
    const savedFilenames = [];

    try {
      const batchCap = Math.min(500, Math.max(1, Number(message.batchSize || job.batchSize) || 50));
      const itemsPerZip = (message.archiveMode || job.archiveMode) === "single" ? reels.length : batchCap;
      const totalParts = Math.max(1, Math.ceil(reels.length / itemsPerZip));

      emitProgress(job, { stage: "Iniciando preparação dos vídeos...", percent: 4, partCount: totalParts });

      for (let p = 0; p < totalParts; p += 1) {
        const slice = reels.slice(p * itemsPerZip, (p + 1) * itemsPerZip);
        const res = await processBatchPart({
          chunk: slice,
          partIndex: p,
          totalParts,
          baseOffset: p * itemsPerZip,
          job,
          includeCsv,
          counters
        });
        allSucceeded.push(...res.succeeded);
        if (res.filename) savedFilenames.push(res.filename);
      }

      if (!allSucceeded.length) {
        throw new Error(counters.failures[0]?.error || "Nenhum vídeo pôde ser baixado.");
      }

      await chrome.runtime.sendMessage({
        type: "OFFSCREEN_COMPLETE",
        job: {
          ...job,
          status: "complete",
          stage: "Concluído com sucesso",
          percent: 100,
          completed: allSucceeded.length,
          failed: counters.failures.length,
          failures: counters.failures,
          filename: savedFilenames[0] || "",
          filenames: savedFilenames,
          partCount: savedFilenames.length,
          updatedAt: Date.now()
        }
      });
    } catch (err) {
      const isCancelled = cancelFlag || err.name === "AbortError" || /cancelado/i.test(err.message || "");
      emitProgress(job, {
        status: "error",
        stage: isCancelled ? "Cancelado" : "Falha no download",
        error: isCancelled ? "Download cancelado." : err.message,
        failures: counters.failures
      });
    } finally {
      workerBusy = false;
      cancelFlag = false;
      activeAbortControllers.clear();
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen") return false;

    if (message.type === "OFFSCREEN_REVOKE_URL") {
      if (createdObjectUrls.has(message.objectUrl)) {
        setTimeout(() => {
          URL.revokeObjectURL(message.objectUrl);
          createdObjectUrls.delete(message.objectUrl);
        }, 45000);
      }
      return false;
    }

    if (message.type === "OFFSCREEN_CANCEL_DOWNLOAD") {
      cancelFlag = true;
      for (const ctrl of activeAbortControllers) ctrl.abort();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "OFFSCREEN_START_DOWNLOAD") {
      if (workerBusy) {
        sendResponse({ accepted: false, error: "Já existe um processamento em execução." });
        return false;
      }
      executeOffscreenDownload(message);
      sendResponse({ accepted: true });
      return false;
    }

    return false;
  });
})();
