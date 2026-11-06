"use strict";

importScripts("lib/core.js", "lib/supabase-auth.js");

const Core = globalThis.RobinCore || globalThis.JDarkCore;
const Auth = globalThis.RobinAuth;
const COMPANION_BASE_URL = "http://127.0.0.1:17832";
const COMPANION_POLL_ALARM = "robin-companion-poll";

/**
 * Validação Zero-Trust de Assinatura no Servidor
 * O background NUNCA confia em valores locais ou manipulados no client.
 */
async function assertActiveSubscription() {
  if (!globalThis.RobinAuth) {
    throw new Error("Módulo de autenticação não inicializado.");
  }

  const verification = await globalThis.RobinAuth.verifyLicenseWithServer();
  if (!verification || !verification.authorized) {
    const errorMsg = verification?.error || "Conta inativa ou não autenticada. Acesso bloqueado.";
    const err = new Error(errorMsg);
    err.code = verification?.code || "UNAUTHORIZED";
    err.checkoutUrl = null;
    throw err;
  }
  return verification;
}

async function setStorageState(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Montar pacotes ZIP e planilhas CSV de métricas em segundo plano"
  });
}

async function checkCompanionStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2200);
  try {
    const res = await fetch(`${COMPANION_BASE_URL}/health`, {
      cache: "no-store",
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok && data?.ok && ["robin-companion", "jdark-companion", "viralbox-companion"].includes(data?.service)),
      ...data
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

let analysisWatchdogTimer = null;
let currentAnalysisTabId = null;

function resetAnalysisWatchdog(tabId, key, profile, platform) {
  clearTimeout(analysisWatchdogTimer);
  currentAnalysisTabId = tabId || currentAnalysisTabId;
  analysisWatchdogTimer = setTimeout(async () => {
    const stored = await chrome.storage.local.get("analysisJob");
    if (stored.analysisJob?.status === "running") {
      await setStorageState("analysisJob", {
        status: "error",
        platform: platform || stored.analysisJob.platform || "instagram",
        key: key || stored.analysisJob.key,
        profile: profile || stored.analysisJob.profile,
        error: "Tempo limite de coleta excedido. A página do perfil não respondeu.",
        updatedAt: Date.now()
      });
    }
    clearAnalysisWatchdog();
  }, 75000);
}

function clearAnalysisWatchdog() {
  clearTimeout(analysisWatchdogTimer);
  analysisWatchdogTimer = null;
  currentAnalysisTabId = null;
}

chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  if (currentAnalysisTabId && closedTabId === currentAnalysisTabId) {
    clearAnalysisWatchdog();
    const stored = await chrome.storage.local.get("analysisJob");
    if (stored.analysisJob?.status === "running") {
      await setStorageState("analysisJob", {
        ...stored.analysisJob,
        status: "error",
        error: "A aba do perfil foi fechada durante a mineração.",
        updatedAt: Date.now()
      });
    }
  }
});

async function injectPlatformScriptsIfNeeded(tabId, platform) {
  try {
    const probe = await chrome.tabs.sendMessage(tabId, { type: "ROBIN_DETECT_CONTEXT" });
    if (probe?.version) return probe;
  } catch (_) {}

  const filesByPlatform = {
    instagram: ["lib/core.js", "collectors/instagram.js", "overlay.js"],
    tiktok: ["lib/core.js", "collectors/tiktok.js", "overlay.js"],
    youtube: ["lib/core.js", "collectors/youtube.js", "overlay.js"]
  };
  const files = filesByPlatform[platform] || filesByPlatform.instagram;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (err) {
    throw new Error(`Não é possível injetar o minerador nesta aba (${err.message}). Certifique-se de que a aba é uma página social pública aberta.`);
  }

  try {
    return await chrome.tabs.sendMessage(tabId, { type: "ROBIN_DETECT_CONTEXT" });
  } catch (_) {
    await new Promise((r) => setTimeout(r, 150));
    return await chrome.tabs.sendMessage(tabId, { type: "ROBIN_DETECT_CONTEXT" }).catch(() => null);
  }
}

async function handleStartAnalysis(message) {
  const tabId = Number(message.tabId);
  const platform = String(message.platform || "instagram");
  const profile = String(message.profile || "");
  const key = String(message.key || Core.makeContextKey(platform, profile));

  if (!tabId || !profile || profile === "criador_demo") {
    throw new Error("Abra um perfil público do Instagram, TikTok ou a aba Shorts de um canal do YouTube.");
  }

  await injectPlatformScriptsIfNeeded(tabId, platform);

  const stored = await chrome.storage.local.get("downloaded");
  const downloadedMap = stored.downloaded || {};
  const skipShortcodes = message.blockDuplicates
    ? Object.keys(downloadedMap[key] || {})
    : [];

  const limit = Math.min(500, Math.max(1, Number(message.limit) || 50));
  const sort = message.sort || "viral";
  const scope = message.scope || "all";
  const filters = Core.normalizeFilterCriteria(message.filters || {});

  await setStorageState("analysisJob", {
    status: "running",
    platform,
    key,
    profile,
    tabId,
    count: 0,
    limit,
    sort,
    scope,
    filters,
    stage: "Iniciando varredura Robin...",
    percent: 5,
    updatedAt: Date.now()
  });

  resetAnalysisWatchdog(tabId, key, profile, platform);

  const resp = await chrome.tabs.sendMessage(tabId, {
    type: "ROBIN_ANALYZE_PROFILE",
    platform,
    key,
    profile,
    limit,
    skipShortcodes,
    sort,
    scope,
    filters
  });

  if (!resp?.started) {
    clearAnalysisWatchdog();
    throw new Error(resp?.error || "Não foi possível iniciar a mineração nesta aba.");
  }
  return { ok: true };
}

async function handleAnalysisComplete(message, sender) {
  const ctx = Core.detectPlatformContext(sender.tab?.url || "");
  const platform = String(message.platform || ctx?.platform || "instagram");
  const profile = String(message.profile || ctx?.profile || "");
  const key = String(message.key || Core.makeContextKey(platform, profile));
  const reels = Array.isArray(message.reels) ? message.reels.slice(0, 500) : [];

  const stored = await chrome.storage.local.get("profiles");
  const profiles = stored.profiles || {};
  profiles[key] = {
    key,
    platform,
    profile,
    reels,
    limit: message.limit || 50,
    sort: message.sort || "viral",
    scope: message.scope || "all",
    filters: Core.normalizeFilterCriteria(message.filters || {}),
    skippedCount: message.skippedCount || 0,
    qualifiedCount: Number(message.qualifiedCount) || reels.length,
    catalogCount: message.catalogCount || reels.length,
    catalogComplete: message.catalogComplete !== false,
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({ profiles });
  await setStorageState("analysisJob", {
    status: "complete",
    platform,
    key,
    profile,
    count: reels.length,
    limit: message.limit || 50,
    stage: "Mineração concluída",
    filters: Core.normalizeFilterCriteria(message.filters || {}),
    skippedCount: message.skippedCount || 0,
    qualifiedCount: Number(message.qualifiedCount) || reels.length,
    catalogCount: message.catalogCount || reels.length,
    catalogComplete: message.catalogComplete !== false,
    scope: message.scope || "all",
    updatedAt: Date.now()
  });
  clearAnalysisWatchdog();
}

async function recordDownloadedShortcodes(key, shortcodes = []) {
  const stored = await chrome.storage.local.get("downloaded");
  const downloaded = stored.downloaded || {};
  downloaded[key] ||= {};
  const now = Date.now();
  for (const code of shortcodes) {
    downloaded[key][code] = now;
  }
  await chrome.storage.local.set({ downloaded });
}

async function startCompanionJob(job, reels, includeCsv) {
  const health = await checkCompanionStatus();
  if (!health.ok) {
    throw new Error("O Robin Companion não está aberto em 127.0.0.1:17832. Abra o Robin Companion para baixar vídeos do TikTok ou YouTube Shorts.");
  }

  const res = await fetch(`${COMPANION_BASE_URL}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: job.platform,
      profile: job.profile,
      archiveMode: job.archiveMode,
      batchSize: job.batchSize,
      includeCsv: includeCsv !== false,
      items: reels.map((r, i) => ({
        shortcode: r.shortcode,
        permalink: r.permalink,
        videoUrl: r.videoUrl || "",
        index: i,
        score: Core.computeViralScore(r),
        views: r.views || 0,
        likes: r.likes || 0,
        comments: r.comments || 0,
        shares: r.shares || 0,
        timestamp: r.timestamp || 0,
        caption: r.caption || ""
      }))
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok || !data?.job?.id) {
    throw new Error(data?.error || `O Robin Companion recusou a tarefa (HTTP ${res.status}).`);
  }

  const nextJob = {
    ...job,
    ...data.job,
    companionMode: true,
    key: job.key,
    profile: job.profile,
    platform: job.platform,
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({
    companionJob: {
      id: data.job.id,
      key: job.key,
      platform: job.platform,
      profile: job.profile
    }
  });
  await setStorageState("downloadJob", nextJob);
  chrome.alarms.create(COMPANION_POLL_ALARM, { delayInMinutes: 0.04, periodInMinutes: 0.05 });
  return { ok: true, jobId: data.job.id };
}

async function pollActiveCompanionJob() {
  const stored = await chrome.storage.local.get(["companionJob", "downloadJob"]);
  const active = stored.companionJob;
  if (!active?.id) {
    await chrome.alarms.clear(COMPANION_POLL_ALARM);
    return;
  }

  try {
    const res = await fetch(`${COMPANION_BASE_URL}/jobs/${encodeURIComponent(active.id)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok || !data?.job) throw new Error(data?.error || "Companion sem resposta");

    const merged = {
      ...(stored.downloadJob || {}),
      ...data.job,
      companionMode: true,
      key: active.key,
      platform: active.platform,
      profile: active.profile,
      updatedAt: Date.now()
    };
    await setStorageState("downloadJob", merged);

    if (["complete", "error"].includes(data.job.status)) {
      if (Array.isArray(data.job.completedShortcodes) && data.job.completedShortcodes.length) {
        await recordDownloadedShortcodes(active.key, data.job.completedShortcodes);
      }
      await chrome.storage.local.remove("companionJob");
      await chrome.alarms.clear(COMPANION_POLL_ALARM);
    }
  } catch (err) {
    await setStorageState("downloadJob", {
      ...(stored.downloadJob || {}),
      companionMode: true,
      status: "error",
      stage: "Conexão perdida com o Companion",
      error: err.message,
      updatedAt: Date.now()
    });
    await chrome.storage.local.remove("companionJob");
    await chrome.alarms.clear(COMPANION_POLL_ALARM);
  }
}

async function handleStartDownload(message) {
  if (!Array.isArray(message.reels) || !message.reels.length) {
    throw new Error("Selecione pelo menos um vídeo para baixar.");
  }

  const platform = String(message.platform || "instagram");
  const profile = String(message.profile || "perfil");
  const key = String(message.key || Core.makeContextKey(platform, profile));
  let reels = message.reels.slice(0, 500);
  const isDemo = reels.some((r) => r.demo);

  const job = {
    id: crypto.randomUUID(),
    status: "running",
    platform,
    key,
    profile,
    total: reels.length,
    completed: 0,
    failed: 0,
    percent: 2,
    stage: "Preparando fila de download...",
    failures: [],
    saveAs: message.saveAs === true,
    archiveMode: message.archiveMode === "batches" ? "batches" : "single",
    batchSize: Math.min(500, Math.max(1, Number(message.batchSize) || 50)),
    buildVersion: "1.0.0",
    updatedAt: Date.now()
  };

  await setStorageState("downloadJob", job);

  // Resolve URLs diretas e métricas na aba antes de enviar para o Companion ou Offscreen
  if (!isDemo && Number(message.tabId) && reels.some((r) => !r.videoUrl)) {
    try {
      const resolved = await chrome.tabs.sendMessage(Number(message.tabId), {
        type: "ROBIN_RESOLVE_MEDIA",
        profile,
        reels
      });
      if (resolved?.ok && Array.isArray(resolved.reels)) {
        reels = resolved.reels;
      }
    } catch (_) {}
  }

  // Se o Companion estiver ativo e não for modo demo, usa o Companion para TikTok/YouTube
  // (e também pode usar no Instagram caso o vídeo não tenha URL direta liberada)
  const companionHealth = !isDemo ? await checkCompanionStatus() : { ok: false };
  if (!isDemo && (["tiktok", "youtube"].includes(platform) || companionHealth.ok)) {
    if (companionHealth.ok || ["tiktok", "youtube"].includes(platform)) {
      return await startCompanionJob(job, reels, message.includeCsv !== false);
    }
  }

  await ensureOffscreenDocument();
  const offResp = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_START_DOWNLOAD",
    target: "offscreen",
    job,
    reels,
    includeCsv: message.includeCsv !== false,
    archiveMode: job.archiveMode,
    batchSize: job.batchSize
  });

  if (!offResp?.accepted) {
    throw new Error(offResp?.error || "O empacotador Offscreen não respondeu.");
  }
  return { ok: true, jobId: job.id };
}

async function handleCancelDownload(jobId) {
  const stored = await chrome.storage.local.get(["companionJob", "downloadJob"]);
  if (stored.companionJob?.id) {
    await fetch(`${COMPANION_BASE_URL}/jobs/${encodeURIComponent(stored.companionJob.id)}/cancel`, {
      method: "POST"
    }).catch(() => {});
    await chrome.storage.local.remove("companionJob");
    await chrome.alarms.clear(COMPANION_POLL_ALARM);
  }
  await chrome.runtime.sendMessage({ type: "OFFSCREEN_CANCEL_DOWNLOAD", target: "offscreen", jobId }).catch(() => {});
  await setStorageState("downloadJob", {
    ...(stored.downloadJob || {}),
    status: "error",
    stage: "Cancelado",
    error: "Download cancelado pelo usuário.",
    updatedAt: Date.now()
  });
  return { ok: true };
}

async function handleDeliverOffscreenFile(message) {
  try {
    const downloadId = await chrome.downloads.download({
      url: message.objectUrl,
      filename: message.filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    if (Array.isArray(message.shortcodes) && message.shortcodes.length && message.job?.key) {
      await recordDownloadedShortcodes(message.job.key, message.shortcodes);
    }
    return { ok: true, downloadId };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    chrome.runtime.sendMessage({
      type: "OFFSCREEN_REVOKE_URL",
      target: "offscreen",
      objectUrl: message.objectUrl
    }).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COMPANION_POLL_ALARM) {
    pollActiveCompanionJob().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message?.type) return;

    switch (message.type) {
      case "CHECK_AUTH_STATUS": {
        try {
          const verification = await globalThis.RobinAuth.verifyLicenseWithServer();
          sendResponse(verification);
        } catch (err) {
          sendResponse({ ok: false, authorized: false, error: err.message });
        }
        return;
      }

      case "START_ANALYSIS": {
        try {
          await assertActiveSubscription();
          const res = await handleStartAnalysis(message);
          sendResponse(res);
        } catch (err) {
          clearAnalysisWatchdog();
          await setStorageState("analysisJob", {
            status: "error",
            platform: message.platform,
            key: message.key,
            profile: message.profile,
            error: err.message,
            errorCode: err.code,
            updatedAt: Date.now()
          });
          sendResponse({ ok: false, error: err.message, code: err.code, checkoutUrl: err.checkoutUrl });
        }
        return;
      }

      case "ANALYSIS_PROGRESS": {
        if (sender.tab) {
          const ctx = Core.detectPlatformContext(sender.tab.url || "");
          const targetPlatform = message.progress?.platform || ctx?.platform || "instagram";
          const targetProfile = message.progress?.profile || ctx?.profile || "";
          const targetKey = message.progress?.key || Core.makeContextKey(targetPlatform, targetProfile);

          resetAnalysisWatchdog(sender.tab.id, targetKey, targetProfile, targetPlatform);

          await setStorageState("analysisJob", {
            ...message.progress,
            platform: targetPlatform,
            key: targetKey,
            profile: targetProfile,
            status: "running",
            tabId: sender.tab.id,
            updatedAt: Date.now()
          });
        }
        sendResponse({ ok: true });
        return;
      }

      case "ANALYSIS_COMPLETE": {
        clearAnalysisWatchdog();
        if (sender.tab) {
          await handleAnalysisComplete(message, sender);
        }
        sendResponse({ ok: true });
        return;
      }

      case "ANALYSIS_ERROR": {
        clearAnalysisWatchdog();
        if (sender.tab) {
          const ctx = Core.detectPlatformContext(sender.tab.url || "");
          await setStorageState("analysisJob", {
            status: "error",
            platform: message.platform || ctx?.platform || "instagram",
            key: message.key || Core.makeContextKey(ctx?.platform || "instagram", message.profile),
            profile: message.profile,
            error: message.error,
            updatedAt: Date.now()
          });
        }
        sendResponse({ ok: true });
        return;
      }

      case "START_DOWNLOAD": {
        try {
          await assertActiveSubscription();
          const res = await handleStartDownload(message);
          sendResponse(res);
        } catch (err) {
          await setStorageState("downloadJob", {
            status: "error",
            error: err.message,
            errorCode: err.code,
            updatedAt: Date.now()
          });
          sendResponse({ ok: false, error: err.message, code: err.code, checkoutUrl: err.checkoutUrl });
        }
        return;
      }

      case "CANCEL_DOWNLOAD": {
        const res = await handleCancelDownload(message.jobId);
        sendResponse(res);
        return;
      }

      case "POLL_DOWNLOAD_JOB": {
        await pollActiveCompanionJob();
        const stored = await chrome.storage.local.get("downloadJob");
        sendResponse({ ok: true, job: stored.downloadJob || null });
        return;
      }

      case "COMPANION_HEALTH": {
        const status = await checkCompanionStatus();
        sendResponse(status);
        return;
      }

      case "RESOLVE_MANUAL_REELS": {
        try {
          await assertActiveSubscription();
        } catch (err) {
          sendResponse({ ok: false, error: err.message, code: err.code });
          return;
        }
        const tabId = Number(message.tabId || sender.tab?.id || 0);
        if (!tabId) {
          sendResponse({ ok: true, reels: message.reels || [] });
          return;
        }
        try {
          const resolved = await chrome.tabs.sendMessage(tabId, {
            type: "ROBIN_RESOLVE_MEDIA",
            profile: message.profile,
            reels: message.reels || []
          });
          sendResponse(resolved?.ok ? resolved : { ok: true, reels: message.reels || [] });
        } catch (_) {
          sendResponse({ ok: true, reels: message.reels || [] });
        }
        return;
      }

      case "SAVE_MANUAL_SELECTION": {
        try {
          await assertActiveSubscription();
        } catch (err) {
          sendResponse({ ok: false, error: err.message, code: err.code });
          return;
        }
        const platform = String(message.platform || "instagram");
        const profile = String(message.profile || "selecao");
        const key = String(message.key || Core.makeContextKey(platform, profile));
        const reels = Array.isArray(message.reels) ? message.reels.slice(0, 500) : [];
        await setStorageState("manualSelection", {
          platform,
          key,
          profile,
          reels,
          createdAt: Date.now()
        });
        sendResponse({ ok: true, count: reels.length });
        return;
      }

      case "OFFSCREEN_PROGRESS": {
        await setStorageState("downloadJob", message.job);
        sendResponse({ ok: true });
        return;
      }

      case "OFFSCREEN_FILE_READY": {
        const res = await handleDeliverOffscreenFile(message);
        sendResponse(res);
        return;
      }

      case "OFFSCREEN_COMPLETE": {
        await setStorageState("downloadJob", message.job);
        sendResponse({ ok: true });
        return;
      }
    }
  })().catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
