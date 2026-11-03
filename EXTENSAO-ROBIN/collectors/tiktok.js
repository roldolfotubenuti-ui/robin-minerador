"use strict";

(() => {
  if (globalThis.__ROBIN_TIKTOK_COLLECTOR_LOADED__) return;
  globalThis.__ROBIN_TIKTOK_COLLECTOR_LOADED__ = true;

  const Core = globalThis.RobinCore || globalThis.JDarkCore;
  let isScanning = false;

  function reportProgress(profile, count, limit, stage, percent) {
    chrome.runtime.sendMessage({
      type: "ANALYSIS_PROGRESS",
      progress: {
        platform: "tiktok",
        key: Core.makeContextKey("tiktok", profile),
        profile,
        count,
        limit,
        stage,
        percent
      }
    }).catch(() => {});
  }

  function mergeTikTokItem(map, item) {
    if (!item?.shortcode) return;
    const prev = map.get(item.shortcode);
    if (!prev) {
      map.set(item.shortcode, item);
      return;
    }
    map.set(item.shortcode, {
      ...prev,
      ...item,
      views: Math.max(prev.views || 0, item.views || 0),
      likes: Math.max(prev.likes || 0, item.likes || 0),
      comments: Math.max(prev.comments || 0, item.comments || 0),
      shares: Math.max(prev.shares || 0, item.shares || 0),
      thumbnail: item.thumbnail || prev.thumbnail || "",
      videoUrl: item.videoUrl || prev.videoUrl || "",
      caption: item.caption || prev.caption || ""
    });
  }

  function parseTikTokJsonTree(root, profile, map) {
    Core.walkObjectTree(root, (node) => {
      const id = String(node?.id || node?.aweme_id || "").trim();
      if (!/^\d{8,30}$/.test(id) || (!node.stats && !node.statistics && !node.video)) return;

      const authorHandle = String(
        node.author?.uniqueId || node.author?.unique_id || profile || ""
      ).toLowerCase();
      if (profile && authorHandle && authorHandle !== profile.toLowerCase()) return;

      const stats = node.stats || node.statistics || {};
      const video = node.video || {};
      const playAddr = video.playAddr || video.downloadAddr || "";
      const videoUrl = typeof playAddr === "string"
        ? playAddr
        : (playAddr?.UrlList?.[0] || playAddr?.url_list?.[0] || video.bitrateInfo?.[0]?.PlayAddr?.UrlList?.[0] || "");

      mergeTikTokItem(map, {
        shortcode: id,
        permalink: `https://www.tiktok.com/@${authorHandle || profile}/video/${id}`,
        index: map.size,
        platform: "tiktok",
        views: Number(stats.playCount ?? stats.play_count ?? 0) || 0,
        likes: Number(stats.diggCount ?? stats.digg_count ?? 0) || 0,
        comments: Number(stats.commentCount ?? stats.comment_count ?? 0) || 0,
        shares: Number(stats.shareCount ?? stats.share_count ?? 0) || 0,
        timestamp: Number(node.createTime ?? node.create_time ?? 0) || 0,
        thumbnail: String(video.cover || video.dynamicCover || video.originCover || ""),
        videoUrl: String(videoUrl || ""),
        caption: String(node.desc || node.contents?.[0]?.desc || "")
      });
    });
  }

  function extractFromHydrationScripts(profile, map) {
    const scripts = document.querySelectorAll(
      'script#__UNIVERSAL_DATA_FOR_REHYDRATION__, script#SIGI_STATE, script[type="application/json"]'
    );
    for (const s of scripts) {
      try {
        const root = JSON.parse(s.textContent || "{}");
        parseTikTokJsonTree(root, profile, map);
      } catch (_) {}
    }
  }

  function extractVisibleGrid(profile, map) {
    const anchors = document.querySelectorAll('a[href*="/video/"]');
    for (const anchor of anchors) {
      try {
        const u = new URL(anchor.href, location.href);
        const match = decodeURIComponent(u.pathname).match(/\/@([^/]+)\/video\/(\d{8,30})/);
        if (!match || (profile && match[1].toLowerCase() !== profile.toLowerCase())) continue;

        const img = anchor.querySelector("img");
        const vid = anchor.querySelector("video");
        const viewsText = (anchor.innerText || "").split(/\n+/).map((l) => l.trim()).find((l) => /^[\d.,]+\s*(?:mil|mi|bi|[kmb])?$/i.test(l)) || "";

        mergeTikTokItem(map, {
          shortcode: match[2],
          permalink: `https://www.tiktok.com/@${match[1]}/video/${match[2]}`,
          index: map.size,
          platform: "tiktok",
          views: Core.parseCompactNumber(viewsText),
          likes: 0,
          comments: 0,
          shares: 0,
          timestamp: 0,
          thumbnail: img?.currentSrc || img?.src || vid?.poster || "",
          videoUrl: vid?.currentSrc || vid?.src || "",
          caption: img?.alt || anchor.getAttribute("aria-label") || ""
        });
      } catch (_) {}
    }
  }

  async function resolveTikTokDetails(profile, reels) {
    const output = reels.slice();
    let cursor = 0;

    async function worker() {
      while (cursor < output.length) {
        const idx = cursor++;
        const item = output[idx];
        if (item.videoUrl && item.likes > 0) continue;
        try {
          const res = await fetch(item.permalink, {
            credentials: "include",
            cache: "no-store",
            headers: { Accept: "text/html" }
          });
          if (!res.ok) continue;
          const html = await res.text();
          const match = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i);
          if (!match) continue;
          const tempMap = new Map();
          parseTikTokJsonTree(JSON.parse(match[1]), profile, tempMap);
          const detail = tempMap.get(String(item.shortcode));
          if (detail) {
            output[idx] = {
              ...item,
              ...detail,
              views: Math.max(item.views || 0, detail.views || 0),
              likes: Math.max(item.likes || 0, detail.likes || 0),
              comments: Math.max(item.comments || 0, detail.comments || 0),
              shares: Math.max(item.shares || 0, detail.shares || 0),
              thumbnail: detail.thumbnail || item.thumbnail || "",
              videoUrl: detail.videoUrl || item.videoUrl || "",
              caption: detail.caption || item.caption || ""
            };
          }
        } catch (_) {}
      }
    }

    await Promise.all(Array.from({ length: Math.min(3, output.length) }, worker));
    return output;
  }

  async function scanTikTokProfile({ profile, limit = 50, skipShortcodes = [], sort = "viral", scope = "all", filters = {} }) {
    const map = new Map();
    const skipSet = new Set((skipShortcodes || []).map(String));
    const maxWanted = scope === "all" ? 2000 : Math.min(5000, Math.max(1, Number(scope) || 500));

    reportProgress(profile, 0, limit, "Lendo estado inicial do perfil TikTok...", 12);
    extractFromHydrationScripts(profile, map);
    extractVisibleGrid(profile, map);

    if (map.size < Math.min(limit, maxWanted)) {
      const initialY = window.scrollY;
      let stagnant = 0;
      try {
        for (let step = 0; step < 45; step += 1) {
          const before = map.size;
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
          await new Promise((r) => setTimeout(r, 650));
          extractVisibleGrid(profile, map);
          if (map.size === before) {
            stagnant += 1;
            if (stagnant >= 5) break;
          } else {
            stagnant = 0;
          }
          reportProgress(profile, Math.min(map.size, limit), limit, `Carregando grade do TikTok · ${map.size} vídeos`, Math.min(88, 20 + step * 2));
          if (map.size >= maxWanted) break;
        }
      } finally {
        window.scrollTo({ top: initialY, behavior: "auto" });
      }
    }

    const catalog = Array.from(map.values()).slice(0, maxWanted);
    if (!catalog.length) {
      throw new Error("Não foi possível localizar vídeos na grade deste perfil do TikTok.");
    }

    const skippedCount = catalog.filter((i) => skipSet.has(i.shortcode)).length;
    const eligible = catalog.filter((i) => !skipSet.has(i.shortcode));
    const qualified = eligible.filter((i) => Core.matchesFilters(i, filters));
    const ranked = Core.rankItems(qualified, sort).slice(0, limit);

    await chrome.runtime.sendMessage({
      type: "ANALYSIS_COMPLETE",
      platform: "tiktok",
      key: Core.makeContextKey("tiktok", profile),
      profile,
      reels: ranked,
      limit,
      sort,
      scope,
      filters: Core.normalizeFilterCriteria(filters),
      skippedCount,
      qualifiedCount: qualified.length,
      catalogCount: catalog.length,
      catalogComplete: true
    });
  }

  function findSimilarTikTokCreators(profile) {
    const found = new Map();
    for (const anchor of document.querySelectorAll('a[href^="/@"], a[href*="tiktok.com/@"]')) {
      const ctx = Core.detectPlatformContext(anchor.href);
      if (!ctx || ctx.platform !== "tiktok" || !ctx.profile || ctx.profile === profile || found.has(ctx.profile)) continue;
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
          await scanTikTokProfile(message);
        } catch (err) {
          await chrome.runtime.sendMessage({
            type: "ANALYSIS_ERROR",
            platform: "tiktok",
            key: Core.makeContextKey("tiktok", message.profile),
            profile: message.profile,
            error: err.message
          }).catch(() => {});
        } finally {
          isScanning = false;
        }
        return;
      }

      if (["ROBIN_RESOLVE_MEDIA", "JDARK_RESOLVE_MEDIA"].includes(message?.type)) {
        const resolved = await resolveTikTokDetails(String(message.profile || ""), (message.reels || []).slice(0, 500));
        sendResponse({ ok: true, reels: resolved });
        return;
      }

      if (["ROBIN_SIMILAR_PROFILES", "JDARK_SIMILAR_PROFILES"].includes(message?.type)) {
        sendResponse({ ok: true, profiles: findSimilarTikTokCreators(String(message.profile || "")) });
      }
    })().catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  });
})();
