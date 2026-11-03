"use strict";

(() => {
  if (globalThis.__ROBIN_IG_COLLECTOR_LOADED__) return;
  globalThis.__ROBIN_IG_COLLECTOR_LOADED__ = true;

  const Core = globalThis.RobinCore || globalThis.JDarkCore;
  const IG_WEB_APP_ID = "936619743392459";
  let isScanning = false;

  function readCsrfCookie() {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function buildIgHeaders() {
    const headers = {
      Accept: "*/*",
      "X-IG-App-ID": IG_WEB_APP_ID,
      "X-ASBD-ID": "129477",
      "X-Requested-With": "XMLHttpRequest"
    };
    const token = readCsrfCookie();
    if (token) headers["X-CSRFToken"] = token;
    return headers;
  }

  async function requestIgJson(endpointPath, timeoutMs = 16000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(endpointPath, location.origin);
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        headers: buildIgHeaders(),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Instagram retornou HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function parseIgNode(rawNode, index = 0) {
    const node = rawNode?.media_or_ad || rawNode?.media || rawNode?.node || rawNode;
    if (!node || typeof node !== "object") return null;

    const shortcode = String(node.code || node.shortcode || "").trim();
    const isVideo = Boolean(
      node.is_video ||
      Number(node.media_type) === 2 ||
      node.product_type === "clips" ||
      node.video_url ||
      (Array.isArray(node.video_versions) && node.video_versions.length > 0)
    );
    if (!shortcode || !isVideo) return null;

    const candidates = node.image_versions2?.candidates || [];
    const thumbnail = String(
      node.display_url ||
      node.thumbnail_src ||
      node.thumbnail_url ||
      candidates[0]?.url ||
      ""
    );
    const videoUrl = String(
      node.video_url ||
      node.video_versions?.[0]?.url ||
      ""
    );
    const caption = String(
      node.caption?.text ||
      node.edge_media_to_caption?.edges?.[0]?.node?.text ||
      node.accessibility_caption ||
      ""
    );

    return {
      shortcode,
      permalink: `https://www.instagram.com/reel/${shortcode}/`,
      index,
      platform: "instagram",
      views: Math.max(
        0,
        Number(node.play_count ?? node.view_count ?? node.video_play_count ?? node.video_view_count ?? 0) || 0
      ),
      likes: Math.max(
        0,
        Number(node.like_count ?? node.edge_media_preview_like?.count ?? node.edge_liked_by?.count ?? 0) || 0
      ),
      comments: Math.max(
        0,
        Number(node.comment_count ?? node.edge_media_to_comment?.count ?? node.edge_media_to_parent_comment?.count ?? 0) || 0
      ),
      shares: Math.max(0, Number(node.reshare_count ?? 0) || 0),
      timestamp: Number(node.taken_at ?? node.taken_at_timestamp ?? 0) || 0,
      thumbnail,
      videoUrl,
      caption
    };
  }

  function upsertReel(map, candidate) {
    if (!candidate?.shortcode) return;
    const existing = map.get(candidate.shortcode);
    if (!existing) {
      map.set(candidate.shortcode, candidate);
      return;
    }
    map.set(candidate.shortcode, {
      ...existing,
      ...candidate,
      index: Math.min(existing.index ?? candidate.index, candidate.index ?? 0),
      views: Math.max(existing.views || 0, candidate.views || 0),
      likes: Math.max(existing.likes || 0, candidate.likes || 0),
      comments: Math.max(existing.comments || 0, candidate.comments || 0),
      timestamp: candidate.timestamp || existing.timestamp || 0,
      thumbnail: candidate.thumbnail || existing.thumbnail || "",
      videoUrl: candidate.videoUrl || existing.videoUrl || "",
      caption: candidate.caption || existing.caption || ""
    });
  }

  function collectVisibleDomReels(map) {
    const links = document.querySelectorAll('main a[href*="/reel/"], main a[href*="/reels/"]');
    for (const anchor of links) {
      const codeMatch = anchor.href.match(/\/(?:reel|reels)\/([A-Za-z0-9_-]+)/);
      if (!codeMatch) continue;
      const shortcode = codeMatch[1];
      const img = anchor.querySelector("img");
      const textMetric = Core.parseCompactNumber(anchor.innerText || anchor.getAttribute("aria-label") || "");
      upsertReel(map, {
        shortcode,
        permalink: `https://www.instagram.com/reel/${shortcode}/`,
        index: map.size,
        platform: "instagram",
        views: textMetric,
        likes: 0,
        comments: 0,
        timestamp: 0,
        thumbnail: img?.currentSrc || img?.src || "",
        videoUrl: "",
        caption: img?.alt || ""
      });
    }
  }

  async function resolveIndividualReel(shortcode) {
    const mediaId = Core.shortcodeToInstagramMediaId(shortcode);
    const routes = [
      mediaId ? `/api/v1/media/${encodeURIComponent(mediaId)}/info/` : "",
      mediaId ? `/api/v1/clips/item/?clips_media_id=${encodeURIComponent(mediaId)}` : "",
      `/api/v1/media/shortcode/${encodeURIComponent(shortcode)}/info/`
    ].filter(Boolean);

    for (const route of routes) {
      try {
        const data = await requestIgJson(route, 15000);
        const item = data?.items?.[0] || data?.item || data?.media || data?.clips?.[0] || data?.data?.xdt_shortcode_media;
        const parsed = parseIgNode(item);
        if (parsed) return parsed;
      } catch (_) {}
    }
    return null;
  }

  async function enrichReelDetails(reelsList) {
    const output = reelsList.slice();
    let cursor = 0;

    async function runWorker() {
      while (cursor < output.length) {
        const idx = cursor++;
        const current = output[idx];
        if (current.videoUrl && current.views > 0 && current.likes > 0) continue;
        const detail = await resolveIndividualReel(current.shortcode);
        if (detail) {
          output[idx] = {
            ...current,
            ...detail,
            views: Math.max(current.views || 0, detail.views || 0),
            likes: Math.max(current.likes || 0, detail.likes || 0),
            comments: Math.max(current.comments || 0, detail.comments || 0),
            thumbnail: detail.thumbnail || current.thumbnail || "",
            videoUrl: detail.videoUrl || current.videoUrl || "",
            caption: detail.caption || current.caption || ""
          };
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(4, output.length) }, runWorker));
    return output;
  }

  function sendScanProgress(profile, count, limit, stage, percent) {
    chrome.runtime.sendMessage({
      type: "ANALYSIS_PROGRESS",
      progress: {
        platform: "instagram",
        key: Core.makeContextKey("instagram", profile),
        profile,
        count,
        limit,
        stage,
        percent
      }
    }).catch(() => {});
  }

  async function executeProfileScan({ profile, limit = 50, skipShortcodes = [], sort = "viral", scope = "all", filters = {} }) {
    const map = new Map();
    const skipSet = new Set((skipShortcodes || []).map(String));
    const maxWanted = scope === "all" ? 2000 : Math.min(5000, Math.max(1, Number(scope) || 500));

    sendScanProgress(profile, 0, limit, "Consultando dados públicos do perfil no Instagram...", 10);

    let userId = "";
    try {
      const profilePayload = await requestIgJson(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(profile)}`);
      const userObj = profilePayload?.data?.user || profilePayload?.user;
      if (userObj) {
        userId = String(userObj.id || userObj.pk || "");
        const initialEdges = [
          ...(userObj.edge_felix_video_timeline?.edges || []),
          ...(userObj.edge_owner_to_timeline_media?.edges || [])
        ];
        for (const edge of initialEdges) {
          const parsed = parseIgNode(edge, map.size);
          if (parsed) upsertReel(map, parsed);
        }
      }
    } catch (_) {}

    // Paginação pela rota dedicada de Clips/Reels
    if (userId && map.size < maxWanted) {
      let maxId = "";
      let page = 0;
      const visitedCursors = new Set();

      while (map.size < maxWanted && page < 80) {
        page += 1;
        const params = new URLSearchParams({
          target_user_id: userId,
          page_size: "50",
          include_feed_video: "true"
        });
        if (maxId) params.set("max_id", maxId);

        try {
          const clipsData = await requestIgJson(`/api/v1/clips/user/?${params}`);
          const items = clipsData?.items || clipsData?.clips || [];
          for (const entry of items) {
            const parsed = parseIgNode(entry, map.size);
            if (parsed) upsertReel(map, parsed);
          }

          const approvedCount = Array.from(map.values()).filter(
            (r) => !skipSet.has(r.shortcode) && Core.matchesFilters(r, filters)
          ).length;

          sendScanProgress(
            profile,
            Math.min(approvedCount, limit),
            limit,
            `Mapeando Reels do perfil · ${map.size} coletados`,
            Math.min(82, 20 + page * 4)
          );

          if (approvedCount >= limit) break;

          const paging = clipsData?.paging_info || {};
          const nextCursor = String(paging.max_id || "");
          if (!nextCursor || paging.more_available === false || visitedCursors.has(nextCursor)) break;
          visitedCursors.add(nextCursor);
          maxId = nextCursor;
        } catch (_) {
          break;
        }
      }
    }

    // Fallback: coleta da grade renderizada no DOM com rolagem controlada
    collectVisibleDomReels(map);
    if (map.size < Math.min(limit, maxWanted)) {
      const startScrollY = window.scrollY;
      let stagnantRounds = 0;
      try {
        for (let step = 0; step < 30; step += 1) {
          const prevCount = map.size;
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
          await new Promise((r) => setTimeout(r, 650));
          collectVisibleDomReels(map);
          if (map.size === prevCount) {
            stagnantRounds += 1;
            if (stagnantRounds >= 4) break;
          } else {
            stagnantRounds = 0;
          }
          sendScanProgress(profile, Math.min(map.size, limit), limit, `Lendo grade da página · ${map.size} Reels`, 86);
        }
      } finally {
        window.scrollTo({ top: startScrollY, behavior: "auto" });
      }
    }

    const allCatalog = Core.rankItems(Array.from(map.values()), "recent").slice(0, maxWanted);
    if (!allCatalog.length) {
      throw new Error("Nenhum Reel encontrado neste perfil. Verifique se o perfil está aberto e possui Reels públicos.");
    }

    sendScanProgress(profile, Math.min(allCatalog.length, limit), limit, "Enriquecendo métricas e links de vídeo...", 92);
    const enrichedCatalog = await enrichReelDetails(allCatalog.slice(0, Math.min(120, allCatalog.length)));
    const enrichedMap = new Map(allCatalog.map((r) => [r.shortcode, r]));
    for (const item of enrichedCatalog) enrichedMap.set(item.shortcode, item);

    const finalScoped = Array.from(enrichedMap.values());
    const skippedCount = finalScoped.filter((r) => skipSet.has(r.shortcode)).length;
    const eligible = finalScoped.filter((r) => !skipSet.has(r.shortcode));
    const qualified = eligible.filter((r) => Core.matchesFilters(r, filters));
    const selectedReels = Core.rankItems(qualified, sort).slice(0, limit);

    await chrome.runtime.sendMessage({
      type: "ANALYSIS_COMPLETE",
      platform: "instagram",
      key: Core.makeContextKey("instagram", profile),
      profile,
      reels: selectedReels,
      limit,
      sort,
      scope,
      filters: Core.normalizeFilterCriteria(filters),
      skippedCount,
      qualifiedCount: qualified.length,
      catalogCount: finalScoped.length,
      catalogComplete: true
    });
  }

  async function findSimilarInstagramProfiles(profile) {
    const data = await requestIgJson(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(profile)}`);
    const user = data?.data?.user || data?.user || {};
    const edges = [
      ...(user.edge_related_profiles?.edges || []),
      ...(user.edge_chaining?.edges || [])
    ];
    const results = [];
    const seen = new Set([profile.toLowerCase()]);

    for (const entry of edges) {
      const node = entry?.node || entry;
      const username = String(node?.username || "").toLowerCase();
      if (!username || seen.has(username)) continue;
      seen.add(username);
      results.push({
        username,
        fullName: String(node.full_name || username),
        picture: String(node.profile_pic_url || ""),
        verified: Boolean(node.is_verified)
      });
      if (results.length >= 12) break;
    }
    return results;
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
          sendResponse({ started: false, error: "Uma análise já está em execução nesta aba." });
          return;
        }
        isScanning = true;
        sendResponse({ started: true });
        try {
          await executeProfileScan(message);
        } catch (err) {
          await chrome.runtime.sendMessage({
            type: "ANALYSIS_ERROR",
            platform: "instagram",
            key: Core.makeContextKey("instagram", message.profile),
            profile: message.profile,
            error: err.message
          }).catch(() => {});
        } finally {
          isScanning = false;
        }
        return;
      }

      if (["ROBIN_RESOLVE_MEDIA", "JDARK_RESOLVE_MEDIA"].includes(message?.type)) {
        const resolved = await enrichReelDetails((message.reels || []).slice(0, 500));
        sendResponse({ ok: true, reels: resolved });
        return;
      }

      if (["ROBIN_SIMILAR_PROFILES", "JDARK_SIMILAR_PROFILES"].includes(message?.type)) {
        const profiles = await findSimilarInstagramProfiles(String(message.profile || ""));
        sendResponse({ ok: true, profiles });
      }
    })().catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  });
})();
