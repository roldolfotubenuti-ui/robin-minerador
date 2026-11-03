"use strict";

(() => {
  if (globalThis.__ROBIN_YOUTUBE_COLLECTOR_LOADED__) return;
  globalThis.__ROBIN_YOUTUBE_COLLECTOR_LOADED__ = true;

  const Core = globalThis.RobinCore || globalThis.JDarkCore;
  let isScanning = false;

  function reportProgress(profile, count, limit, stage, percent) {
    chrome.runtime.sendMessage({
      type: "ANALYSIS_PROGRESS",
      progress: {
        platform: "youtube",
        key: Core.makeContextKey("youtube", profile),
        profile,
        count,
        limit,
        stage,
        percent
      }
    }).catch(() => {});
  }

  function mergeShort(map, item) {
    if (!item?.shortcode) return;
    const prev = map.get(item.shortcode);
    map.set(item.shortcode, prev ? {
      ...prev,
      ...item,
      views: Math.max(prev.views || 0, item.views || 0),
      thumbnail: item.thumbnail || prev.thumbnail || "",
      caption: item.caption || prev.caption || ""
    } : item);
  }

  function collectVisibleShortsFromDom(map) {
    const cards = document.querySelectorAll(
      "ytd-rich-item-renderer, ytm-shorts-lockup-view-model-v2, ytd-grid-video-renderer"
    );
    for (const card of cards) {
      const anchor = card.querySelector('a[href^="/shorts/"], a[href*="youtube.com/shorts/"]');
      const match = anchor?.href?.match(/\/shorts\/([A-Za-z0-9_-]{6,20})/);
      if (!match) continue;
      const id = match[1];
      const img = card.querySelector("img");
      const title = anchor.getAttribute("title") || img?.alt || card.querySelector("[title]")?.getAttribute("title") || "";
      const views = Core.parseCompactNumber(card.innerText || "");

      mergeShort(map, {
        shortcode: id,
        permalink: `https://www.youtube.com/shorts/${id}`,
        index: map.size,
        platform: "youtube",
        views,
        likes: 0,
        comments: 0,
        shares: 0,
        timestamp: 0,
        thumbnail: img?.currentSrc || img?.src || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        videoUrl: "",
        caption: title || `Short ${id}`
      });
    }
  }

  async function scanYouTubeShorts({ profile, limit = 50, skipShortcodes = [], sort = "views", scope = "all", filters = {} }) {
    const map = new Map();
    const skipSet = new Set((skipShortcodes || []).map(String));
    const maxWanted = scope === "all" ? 2000 : Math.min(5000, Math.max(1, Number(scope) || 500));

    reportProgress(profile, 0, limit, "Lendo grade de Shorts do canal...", 15);
    collectVisibleShortsFromDom(map);

    if (map.size < Math.min(limit, maxWanted)) {
      const startY = window.scrollY;
      let stagnant = 0;
      try {
        for (let step = 0; step < 40; step += 1) {
          const prev = map.size;
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
          await new Promise((r) => setTimeout(r, 650));
          collectVisibleShortsFromDom(map);
          if (map.size === prev) {
            stagnant += 1;
            if (stagnant >= 5) break;
          } else {
            stagnant = 0;
          }
          reportProgress(profile, Math.min(map.size, limit), limit, `Mapeando Shorts · ${map.size} encontrados`, Math.min(90, 20 + step * 2));
          if (map.size >= maxWanted) break;
        }
      } finally {
        window.scrollTo({ top: startY, behavior: "auto" });
      }
    }

    const catalog = Array.from(map.values()).slice(0, maxWanted);
    if (!catalog.length) {
      throw new Error("Nenhum Short encontrado. Abra a aba 'Shorts' do canal no YouTube e tente novamente.");
    }

    const effectiveFilters = { ...filters, minLikes: 0, minComments: 0 };
    const skippedCount = catalog.filter((i) => skipSet.has(i.shortcode)).length;
    const eligible = catalog.filter((i) => !skipSet.has(i.shortcode));
    const qualified = eligible.filter((i) => Core.matchesFilters(i, effectiveFilters));
    const ranked = Core.rankItems(qualified, sort).slice(0, limit);

    await chrome.runtime.sendMessage({
      type: "ANALYSIS_COMPLETE",
      platform: "youtube",
      key: Core.makeContextKey("youtube", profile),
      profile,
      reels: ranked,
      limit,
      sort,
      scope,
      filters: Core.normalizeFilterCriteria(effectiveFilters),
      skippedCount,
      qualifiedCount: qualified.length,
      catalogCount: catalog.length,
      catalogComplete: true
    });
  }

  function findSimilarYouTubeChannels(profile) {
    const found = new Map();
    for (const anchor of document.querySelectorAll('a[href^="/@"], a[href*="youtube.com/@"]')) {
      const ctx = Core.detectPlatformContext(anchor.href);
      if (!ctx || ctx.platform !== "youtube" || !ctx.profile || ctx.profile === profile || found.has(ctx.profile)) continue;
      const img = anchor.querySelector("img");
      found.set(ctx.profile, {
        username: ctx.profile,
        fullName: (anchor.innerText || "").trim().split("\n")[0] || ctx.profile,
        picture: img?.currentSrc || img?.src || ""
      });
      if (found.size >= 12) break;
    }
    return Array.from(found.values());
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (["ROBIN_DETECT_CONTEXT", "JDARK_DETECT_CONTEXT"].includes(message?.type)) {
        const ctx = Core.detectPlatformContext(location.href);
        sendResponse({ ...(ctx || {}), url: location.href, version: "1.0.0" });
        return;
      }

      if (["ROBIN_ANALYZE_PROFILE", "JDARK_ANALYZE_PROFILE"].includes(message?.type)) {
        if (isScanning) {
          sendResponse({ started: false, error: "Já existe uma análise em andamento." });
          return;
        }
        isScanning = true;
        sendResponse({ started: true });
        try {
          await scanYouTubeShorts(message);
        } catch (err) {
          await chrome.runtime.sendMessage({
            type: "ANALYSIS_ERROR",
            platform: "youtube",
            key: Core.makeContextKey("youtube", message.profile),
            profile: message.profile,
            error: err.message
          }).catch(() => {});
        } finally {
          isScanning = false;
        }
        return;
      }

      if (["ROBIN_RESOLVE_MEDIA", "JDARK_RESOLVE_MEDIA"].includes(message?.type)) {
        sendResponse({ ok: true, reels: message.reels || [] });
        return;
      }

      if (["ROBIN_SIMILAR_PROFILES", "JDARK_SIMILAR_PROFILES"].includes(message?.type)) {
        sendResponse({ ok: true, profiles: findSimilarYouTubeChannels(String(message.profile || "")) });
      }
    })().catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  });
})();
