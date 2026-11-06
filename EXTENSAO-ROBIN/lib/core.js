"use strict";

(() => {
  if (globalThis.RobinCore) return;

  const PLATFORM_NAMES = {
    instagram: "Instagram",
    tiktok: "TikTok",
    youtube: "YouTube Shorts"
  };

  const ITEM_NOUNS = {
    instagram: "Reels",
    tiktok: "vídeos",
    youtube: "Shorts"
  };

  const IG_RESERVED_PATHS = new Set([
    "accounts", "about", "Challenge", "challenge", "direct", "directory",
    "explore", "graphql", "legal", "p", "privacy", "reel", "reels",
    "session", "settings", "stories", "tv", "web"
  ]);

  function sanitizeSlug(rawValue, fallback = "item") {
    const clean = String(rawValue || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 72);
    return clean || fallback;
  }

  function makeContextKey(platform, profile) {
    return `${String(platform || "instagram").toLowerCase()}::${String(profile || "").toLowerCase()}`;
  }

  function parseCompactNumber(rawInput) {
    if (typeof rawInput === "number") {
      return Number.isFinite(rawInput) ? Math.max(0, Math.round(rawInput)) : 0;
    }
    const text = String(rawInput || "")
      .replace(/\u00a0/g, " ")
      .trim()
      .toLowerCase();
    if (!text) return 0;

    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(mil|mi|bi|b|m|k)?/i);
    if (!match) return 0;

    let numericPart = match[1];
    const suffix = (match[2] || "").toLowerCase();

    if (suffix) {
      numericPart = numericPart.replace(",", ".");
    } else if (numericPart.includes(",") && numericPart.includes(".")) {
      numericPart = numericPart.replace(/\./g, "").replace(",", ".");
    } else if (/^\d{1,3}(?:\.\d{3})+$/.test(numericPart)) {
      numericPart = numericPart.replace(/\./g, "");
    } else if (/^\d{1,3}(?:,\d{3})+$/.test(numericPart)) {
      numericPart = numericPart.replace(/,/g, "");
    } else {
      numericPart = numericPart.replace(",", ".");
    }

    const baseValue = Number(numericPart);
    if (!Number.isFinite(baseValue)) return 0;

    const scaleMap = {
      k: 1e3,
      mil: 1e3,
      m: 1e6,
      mi: 1e6,
      b: 1e9,
      bi: 1e9
    };
    const multiplier = scaleMap[suffix] || 1;
    return Math.max(0, Math.round(baseValue * multiplier));
  }

  function formatCompactNumber(value) {
    const num = Number(value) || 0;
    if (num >= 1e9) return `${(num / 1e9).toFixed(1).replace(".", ",")}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(1).replace(".", ",")}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(num >= 1e5 ? 0 : 1).replace(".", ",")}K`;
    return num.toLocaleString("pt-BR");
  }

  function formatShortDate(unixSeconds, fallbackText = "") {
    const ts = Number(unixSeconds) || 0;
    if (!ts) return fallbackText || "Recente";
    const millis = ts > 1e12 ? ts : ts * 1000;
    return new Date(millis).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
  }

  function computeViralScore(item) {
    const views = Math.max(0, Number(item?.views) || 0);
    const likes = Math.max(0, Number(item?.likes) || 0);
    const comments = Math.max(0, Number(item?.comments) || 0);

    const reachComponent = Math.min(55, Math.max(0, Math.log10(views + 1) - 3) * 13.75);
    const engagementComponent = views > 0
      ? Math.min(27, (likes / views) * 540) + Math.min(18, (comments / views) * 9000)
      : 0;

    return Math.min(100, Math.max(1, Math.round(reachComponent + engagementComponent)));
  }

  function normalizeFilterCriteria(rawFilters = {}) {
    return {
      minViews: parseCompactNumber(rawFilters.minViews),
      minLikes: parseCompactNumber(rawFilters.minLikes),
      minComments: parseCompactNumber(rawFilters.minComments)
    };
  }

  function matchesFilters(item, rawFilters = {}) {
    const f = normalizeFilterCriteria(rawFilters);
    if ((Number(item?.views) || 0) < f.minViews) return false;
    if ((Number(item?.likes) || 0) < f.minLikes) return false;
    if ((Number(item?.comments) || 0) < f.minComments) return false;
    return true;
  }

  function rankItems(items = [], sortMode = "viral") {
    return items.slice().sort((a, b) => {
      if (sortMode === "views") {
        return (b.views || 0) - (a.views || 0) || computeViralScore(b) - computeViralScore(a);
      }
      if (sortMode === "likes") {
        return (b.likes || 0) - (a.likes || 0) || (b.views || 0) - (a.views || 0);
      }
      if (sortMode === "comments") {
        return (b.comments || 0) - (a.comments || 0) || (b.views || 0) - (a.views || 0);
      }
      if (sortMode === "recent") {
        return (b.timestamp || 0) - (a.timestamp || 0) || (a.index ?? 0) - (b.index ?? 0);
      }
      return computeViralScore(b) - computeViralScore(a) || (b.views || 0) - (a.views || 0);
    });
  }

  function detectPlatformContext(urlString) {
    try {
      const parsed = new URL(urlString);
      const host = parsed.hostname.toLowerCase();
      const parts = parsed.pathname.split("/").filter(Boolean);

      if (host.endsWith("instagram.com")) {
        const first = parts[0] || "";
        const second = parts[1] || "";
        const isAllowedSubtab = !second || ["reels", "reel", "tagged", "channel"].includes(second.toLowerCase());
        const profile = first && !IG_RESERVED_PATHS.has(first) && isAllowedSubtab && /^[A-Za-z0-9._]{1,30}$/.test(first)
          ? first.toLowerCase()
          : "";
        return {
          platform: "instagram",
          profile,
          key: makeContextKey("instagram", profile),
          url: parsed.href
        };
      }

      if (host.endsWith("tiktok.com")) {
        const handleSegment = parts.find((p) => p.startsWith("@")) || "";
        let decoded = handleSegment.slice(1);
        try { decoded = decodeURIComponent(decoded); } catch (_) {}
        const profile = /^[A-Za-z0-9._-]{1,64}$/.test(decoded) ? decoded.toLowerCase() : "";
        return {
          platform: "tiktok",
          profile,
          key: makeContextKey("tiktok", profile),
          url: parsed.href
        };
      }

      if (host.endsWith("youtube.com")) {
        let profile = "";
        if (parts[0]?.startsWith("@")) {
          profile = decodeURIComponent(parts[0].slice(1)).toLowerCase();
        } else if (["channel", "c", "user"].includes(parts[0]) && parts[1]) {
          profile = decodeURIComponent(parts[1]).toLowerCase();
        }
        const isShortsTab = parts.includes("shorts") || parsed.pathname.startsWith("/shorts/");
        return {
          platform: "youtube",
          profile,
          isShortsTab,
          key: makeContextKey("youtube", profile),
          url: parsed.href
        };
      }
    } catch (_) {}
    return null;
  }

  function shortcodeToInstagramMediaId(shortcode) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const clean = String(shortcode || "").trim();
    if (!clean || !/^[A-Za-z0-9_-]+$/.test(clean)) return "";
    let id = 0n;
    for (const ch of clean) {
      const idx = alphabet.indexOf(ch);
      if (idx < 0) return "";
      id = id * 64n + BigInt(idx);
    }
    return id > 0n ? id.toString() : "";
  }

  function isValidMediaUrl(urlString, platform = "instagram") {
    try {
      const u = new URL(urlString);
      if (u.protocol !== "https:") return false;
      const h = u.hostname.toLowerCase();
      if (platform === "instagram") {
        return h.endsWith(".cdninstagram.com") || h.endsWith(".fbcdn.net") || h.endsWith(".fbsbx.net") || h.endsWith(".instagram.com");
      }
      if (platform === "tiktok") {
        return h.endsWith(".tiktok.com") || h.endsWith(".tiktokcdn.com") || h.endsWith(".tiktokcdn-us.com") || h.endsWith(".tiktokcdn-eu.com") || h.endsWith(".tiktokv.com") || h.endsWith(".byteoversea.com") || h.endsWith(".ibytedtos.com");
      }
      if (platform === "youtube") {
        return h.endsWith(".googlevideo.com") || h.endsWith(".youtube.com");
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function walkObjectTree(root, visitor, seen = new WeakSet(), depth = 0) {
    if (!root || typeof root !== "object" || seen.has(root) || depth > 24) return;
    seen.add(root);
    visitor(root);
    if (Array.isArray(root)) {
      for (const item of root) walkObjectTree(item, visitor, seen, depth + 1);
    } else {
      for (const val of Object.values(root)) walkObjectTree(val, visitor, seen, depth + 1);
    }
  }

  function generateMetricsCsv(profile, items, platform = "instagram") {
    const esc = (val) => `"${String(val ?? "").replace(/"/g, '""')}"`;
    const columns = [
      "plataforma", "perfil", "codigo", "url", "score_viral",
      "visualizacoes", "curtidas", "comentarios", "compartilhamentos",
      "publicado_em", "legenda", "processado_em"
    ];
    const nowIso = new Date().toISOString();
    const rows = items.map((item) => [
      platform,
      profile,
      item.shortcode,
      item.permalink || `https://www.instagram.com/reel/${item.shortcode}/`,
      computeViralScore(item),
      item.views || 0,
      item.likes || 0,
      item.comments || 0,
      item.shares || 0,
      item.timestamp ? new Date((item.timestamp > 1e12 ? item.timestamp : item.timestamp * 1000)).toISOString() : (item.publishedText || ""),
      String(item.caption || "").replace(/\s+/g, " ").trim(),
      nowIso
    ].map(esc).join(","));

    return `\uFEFF${columns.join(",")}\r\n${rows.join("\r\n")}\r\n`;
  }

  // Tabela CRC32 e Construtor PKZIP nativo em memória
  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function computeCrc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  class RobinZipArchive {
    constructor() {
      this.files = [];
      this.encoder = new TextEncoder();
    }

    addFile(relativePath, contentBytes) {
      const data = contentBytes instanceof Uint8Array
        ? contentBytes
        : new Uint8Array(contentBytes);
      const nameBytes = this.encoder.encode(relativePath);
      this.files.push({
        nameBytes,
        data,
        crc: computeCrc32(data)
      });
    }

    toBlob() {
      const blobParts = [];
      const centralDirParts = [];
      let currentOffset = 0;

      for (const entry of this.files) {
        const localHeader = new Uint8Array(30 + entry.nameBytes.length);
        const lv = new DataView(localHeader.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true); // UTF-8 flag
        lv.setUint16(8, 0, true);      // Store method
        lv.setUint16(10, 0, true);
        lv.setUint16(12, 0x21, true);
        lv.setUint32(14, entry.crc, true);
        lv.setUint32(18, entry.data.length, true);
        lv.setUint32(22, entry.data.length, true);
        lv.setUint16(26, entry.nameBytes.length, true);
        lv.setUint16(28, 0, true);
        localHeader.set(entry.nameBytes, 30);

        const centralHeader = new Uint8Array(46 + entry.nameBytes.length);
        const cv = new DataView(centralHeader.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0x21, true);
        cv.setUint32(16, entry.crc, true);
        cv.setUint32(20, entry.data.length, true);
        cv.setUint32(24, entry.data.length, true);
        cv.setUint16(28, entry.nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, currentOffset, true);
        centralHeader.set(entry.nameBytes, 46);

        blobParts.push(localHeader, entry.data);
        centralDirParts.push(centralHeader);
        currentOffset += localHeader.length + entry.data.length;
      }

      const centralDirSize = centralDirParts.reduce((acc, part) => acc + part.length, 0);
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, this.files.length, true);
      ev.setUint16(10, this.files.length, true);
      ev.setUint32(12, centralDirSize, true);
      ev.setUint32(16, currentOffset, true);

      return new Blob([...blobParts, ...centralDirParts, eocd], { type: "application/zip" });
    }
  }

  function createDemoDataset(profile = "criador_demo", platform = "instagram") {
    const sampleItems = [
      { id: "JDk901A", views: 4850000, likes: 392000, comments: 6420, daysAgo: 2, caption: "Estrutura de gancho nos primeiros 2 segundos que retenha 85% do público #viral #crescimento" },
      { id: "JDk902B", views: 3120000, likes: 245000, comments: 4100, daysAgo: 5, caption: "3 padrões de edição dinâmica para vídeos curtos de alta retenção #reels #tiktok" },
      { id: "JDk903C", views: 2400000, likes: 198000, comments: 2890, daysAgo: 8, caption: "Como transformar um corte simples em um vídeo de 2 milhões de views" },
      { id: "JDk904D", views: 1650000, likes: 112000, comments: 1750, daysAgo: 12, caption: "Análise de ritmo visual e legendas magnéticas passo a passo" },
      { id: "JDk905E", views: 940000, likes: 68000, comments: 920, daysAgo: 16, caption: "Bastidores da produção de conteúdo dark automatizada" },
      { id: "JDk906F", views: 620000, likes: 41000, comments: 540, daysAgo: 21, caption: "Checklist antes de publicar qualquer Short ou Reel em 2026" }
    ];

    return sampleItems.map((entry, idx) => {
      const permalink = platform === "tiktok"
        ? `https://www.tiktok.com/@${profile}/video/740000000000000000${idx + 1}`
        : platform === "youtube"
          ? `https://www.youtube.com/shorts/${entry.id}`
          : `https://www.instagram.com/reel/${entry.id}/`;
      return {
        shortcode: entry.id,
        permalink,
        index: idx,
        platform,
        views: entry.views,
        likes: entry.likes,
        comments: entry.comments,
        shares: Math.round(entry.likes * 0.14),
        timestamp: Math.floor((Date.now() - entry.daysAgo * 86400000) / 1000),
        thumbnail: `assets/demo_thumb_${idx + 1}.jpg`,
        videoUrl: "",
        caption: `${entry.caption} (@${profile})`,
        demo: true
      };
    });
  }

  globalThis.JDarkCore = {
    PLATFORM_NAMES,
    ITEM_NOUNS,
    sanitizeSlug,
    makeContextKey,
    parseCompactNumber,
    formatCompactNumber,
    formatShortDate,
    computeViralScore,
    normalizeFilterCriteria,
    matchesFilters,
    rankItems,
    detectPlatformContext,
    shortcodeToInstagramMediaId,
    isValidMediaUrl,
    walkObjectTree,
    generateMetricsCsv,
    RobinZipArchive,
    JDarkZipArchive: RobinZipArchive,
    createDemoDataset
  };
})();
