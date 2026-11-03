"use strict";

(() => {
  if (globalThis.__ROBIN_OVERLAY_LOADED__) return;
  globalThis.__ROBIN_OVERLAY_LOADED__ = true;

  const Core = globalThis.RobinCore || globalThis.JDarkCore;
  const MAX_MANUAL_ITEMS = 500;
  let dashboardHost = null;
  let manualHost = null;
  let manualObserver = null;
  let activeContext = null;
  let statusNotice = "Clique sobre os vídeos na página para selecioná-los.";
  const selectedMap = new Map();

  function closeDashboardModal() {
    dashboardHost?.remove();
    dashboardHost = null;
  }

  function openDashboardModal(contextOverride) {
    closeDashboardModal();
    const ctx = contextOverride || Core.detectPlatformContext(location.href);
    if (!ctx) return;

    dashboardHost = document.createElement("div");
    dashboardHost.id = "robin-dashboard-host";
    dashboardHost.style.cssText = "position:fixed;inset:0;z-index:2147483646;";
    const shadow = dashboardHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .backdrop {
          position: absolute;
          inset: 0;
          background: rgba(15, 23, 42, 0.6);
          backdrop-filter: blur(8px);
          display: grid;
          place-items: center;
          padding: 16px;
        }
        .window {
          position: relative;
          width: min(1080px, 98vw);
          height: auto;
          max-height: 95vh;
          border-radius: 26px;
          border: none;
          background: transparent;
          box-shadow: none;
          overflow: visible;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        iframe {
          width: 100%;
          height: 100%;
          min-height: min(720px, 94vh);
          border: 0;
          display: block;
          background: transparent;
        }
        .close-btn {
          position: absolute;
          top: -12px;
          right: -12px;
          z-index: 999;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: 2px solid #ffffff;
          background: #0f172a;
          color: #ffffff;
          font: 700 18px/1 system-ui, sans-serif;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(0,0,0,0.35);
          display: grid;
          place-items: center;
          transition: transform 0.15s ease, background 0.15s ease;
        }
        .close-btn:hover {
          transform: scale(1.08);
          background: #000000;
        }
        .close-btn:active {
          transform: scale(0.95);
        }
      </style>
      <div class="backdrop">
        <div class="window">
          <button class="close-btn" title="Fechar Robin">×</button>
          <iframe title="Robin Painel"></iframe>
        </div>
      </div>
    `;

    const iframe = shadow.querySelector("iframe");
    iframe.src = chrome.runtime.getURL(
      `popup.html?embedded=1&platform=${encodeURIComponent(ctx.platform)}&profile=${encodeURIComponent(ctx.profile || "")}&t=${Date.now()}`
    );

    shadow.querySelector(".close-btn").addEventListener("click", closeDashboardModal);
    shadow.querySelector(".backdrop").addEventListener("click", (e) => {
      if (e.target.classList.contains("backdrop")) closeDashboardModal();
    });
    document.documentElement.appendChild(dashboardHost);
  }

  function cardSelectorForPlatform(platform) {
    if (platform === "tiktok") return 'a[href*="/video/"]';
    if (platform === "youtube") return 'a[href*="/shorts/"]';
    return 'a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]';
  }

  function extractItemFromAnchor(anchor) {
    try {
      const platform = activeContext?.platform || "instagram";
      const u = new URL(anchor.href, location.href);
      let shortcode = "";
      let permalink = "";

      if (platform === "instagram") {
        const m = u.pathname.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/i);
        if (!m) return null;
        shortcode = m[2];
        permalink = `https://www.instagram.com/${m[1].toLowerCase() === "p" ? "p" : "reel"}/${shortcode}/`;
      } else if (platform === "tiktok") {
        const m = decodeURIComponent(u.pathname).match(/\/@[^/]+\/video\/(\d{8,30})/);
        if (!m) return null;
        shortcode = m[1];
        permalink = `${u.origin}${u.pathname}`;
      } else {
        const m = u.pathname.match(/\/shorts\/([A-Za-z0-9_-]{6,20})/);
        if (!m) return null;
        shortcode = m[1];
        permalink = `https://www.youtube.com/shorts/${shortcode}`;
      }

      const img = anchor.querySelector("img");
      const vid = anchor.querySelector("video");
      const cardContainer = anchor.closest("ytd-rich-item-renderer, ytm-shorts-lockup-view-model-v2") || anchor;

      return {
        shortcode,
        permalink,
        platform,
        thumbnail: img?.currentSrc || img?.src || vid?.poster || "",
        videoUrl: platform === "tiktok" ? (vid?.currentSrc || vid?.src || "") : "",
        caption: anchor.getAttribute("title") || img?.alt || anchor.getAttribute("aria-label") || `${shortcode}`,
        views: Core.parseCompactNumber(cardContainer.innerText || ""),
        likes: 0,
        comments: 0,
        timestamp: 0,
        selectedManually: true
      };
    } catch (_) {
      return null;
    }
  }

  function setAnchorHighlight(anchor, isSelected) {
    if (isSelected) {
      if (!anchor.hasAttribute("data-robin-orig-style")) {
        anchor.setAttribute("data-robin-orig-style", anchor.getAttribute("style") ?? "__EMPTY__");
      }
      anchor.setAttribute("data-robin-selected", "true");
      anchor.style.setProperty("position", "relative", "important");
      anchor.style.setProperty("outline", "4px solid #111111", "important");
      anchor.style.setProperty("outline-offset", "-4px", "important");
      anchor.style.setProperty("box-shadow", "0 0 0 4px #ffd84d", "important");
      anchor.style.setProperty("border-radius", "14px", "important");

      if (!anchor.querySelector(":scope > [data-robin-check]")) {
        const badge = document.createElement("span");
        badge.setAttribute("data-robin-check", "true");
        badge.style.cssText = "position:absolute!important;inset:0!important;z-index:2147483000!important;display:flex!important;align-items:flex-start!important;justify-content:flex-end!important;padding:12px!important;background:rgba(255,216,77,0.18)!important;pointer-events:none!important;";
        badge.innerHTML = '<b style="display:grid!important;place-items:center!important;width:32px!important;height:32px!important;border-radius:50%!important;background:#ffd84d!important;color:#111111!important;border:2.5px solid #111111!important;font:900 18px/1 system-ui!important;box-shadow:3px 3px 0px #111111!important;">✓</b>';
        anchor.appendChild(badge);
      }
    } else {
      anchor.querySelectorAll(":scope > [data-robin-check]").forEach((el) => el.remove());
      const orig = anchor.getAttribute("data-robin-orig-style");
      if (orig === "__EMPTY__") anchor.removeAttribute("style");
      else if (orig !== null) anchor.setAttribute("style", orig);
      anchor.removeAttribute("data-robin-orig-style");
      anchor.removeAttribute("data-robin-selected");
    }
  }

  async function syncSelectedCardsBatch() {
    if (!manualHost || !activeContext) return;
    const elements = Array.from(document.querySelectorAll(cardSelectorForPlatform(activeContext.platform)));
    const BATCH = 24;
    for (let i = 0; i < elements.length; i += BATCH) {
      await new Promise((resolve) => requestAnimationFrame(() => {
        for (const anchor of elements.slice(i, i + BATCH)) {
          const item = extractItemFromAnchor(anchor);
          if (item && selectedMap.has(item.shortcode)) {
            setAnchorHighlight(anchor, true);
          }
        }
        resolve();
      }));
    }
  }

  function refreshManualToolbar() {
    const root = manualHost?.shadowRoot;
    if (!root) return;
    root.querySelector(".count").textContent = String(selectedMap.size);
    root.querySelector(".notice").textContent = statusNotice;
    root.querySelector(".confirm-btn").disabled = selectedMap.size === 0;
  }

  function locateAnchorFromEvent(event) {
    if (!activeContext) return null;
    const sel = cardSelectorForPlatform(activeContext.platform);
    for (const node of (typeof event.composedPath === "function" ? event.composedPath() : [])) {
      if (node?.matches?.(sel)) return node;
    }
    return event.target?.closest?.(sel) || null;
  }

  function onManualClickSuppressed(event) {
    if (!manualHost || !locateAnchorFromEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onManualPointerDown(event) {
    if (!manualHost || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = locateAnchorFromEvent(event);
    const item = anchor ? extractItemFromAnchor(anchor) : null;
    if (!item) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (selectedMap.has(item.shortcode)) {
      selectedMap.delete(item.shortcode);
      setAnchorHighlight(anchor, false);
      statusNotice = `Vídeo ${item.shortcode} removido da seleção.`;
    } else if (selectedMap.size >= MAX_MANUAL_ITEMS) {
      statusNotice = "Limite máximo de 500 vídeos atingido.";
    } else {
      selectedMap.set(item.shortcode, item);
      setAnchorHighlight(anchor, true);
      statusNotice = `Vídeo ${item.shortcode} adicionado (${selectedMap.size} selecionados).`;
    }
    refreshManualToolbar();
  }

  function stopManualMode() {
    window.removeEventListener("pointerdown", onManualPointerDown, true);
    window.removeEventListener("click", onManualClickSuppressed, true);
    window.removeEventListener("auxclick", onManualClickSuppressed, true);
    manualObserver?.disconnect();
    manualObserver = null;
    document.querySelectorAll("[data-robin-selected]").forEach((a) => setAnchorHighlight(a, false));
    manualHost?.remove();
    manualHost = null;
    selectedMap.clear();
    closeDashboardModal();
  }

  async function commitManualSelection() {
    if (!selectedMap.size || !activeContext) return;
    const btn = manualHost.shadowRoot.querySelector(".confirm-btn");
    btn.disabled = true;
    btn.textContent = "CARREGANDO DADOS...";
    try {
      const rawItems = Array.from(selectedMap.values());
      const resolved = await chrome.runtime.sendMessage({
        type: "RESOLVE_MANUAL_REELS",
        platform: activeContext.platform,
        key: activeContext.key,
        profile: activeContext.profile,
        reels: rawItems
      });
      const finalItems = resolved?.ok && Array.isArray(resolved.reels) ? resolved.reels : rawItems;
      await chrome.runtime.sendMessage({
        type: "SAVE_MANUAL_SELECTION",
        platform: activeContext.platform,
        key: activeContext.key,
        profile: activeContext.profile,
        reels: finalItems
      });
      stopManualMode();
    } catch (err) {
      statusNotice = err.message || "Falha ao salvar seleção.";
      btn.disabled = false;
      btn.textContent = "USAR SELECIONADOS";
      refreshManualToolbar();
    }
  }

  function startManualMode(contextOverride) {
    closeDashboardModal();
    if (manualHost) stopManualMode();
    activeContext = contextOverride || Core.detectPlatformContext(location.href);
    if (!activeContext) return;

    statusNotice = `Clique nas capas dos ${Core.ITEM_NOUNS[activeContext.platform] || "vídeos"} para selecionar.`;
    manualHost = document.createElement("div");
    manualHost.id = "robin-manual-bar";
    manualHost.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;";
    const shadow = manualHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .toolbar {
          min-width: min(720px, calc(100vw - 32px));
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 14px 20px;
          border-radius: 20px;
          border: 3px solid #111111;
          background: #ffffff;
          box-shadow: 6px 6px 0px #111111;
          color: #111111;
          font-family: "Plus Jakarta Sans", "Outfit", Segoe UI, system-ui, sans-serif;
        }
        .badge {
          width: 42px;
          height: 42px;
          border-radius: 12px;
          display: grid;
          place-items: center;
          background: #ffd84d;
          border: 2.5px solid #111111;
          box-shadow: 2.5px 2.5px 0px #111111;
          font-weight: 900;
          font-size: 20px;
          color: #111111;
          transform: rotate(-3deg);
        }
        .info { flex: 1; min-width: 0; }
        .title { font-size: 13.5px; font-weight: 900; letter-spacing: 0.02em; color: #111111; }
        .notice { margin-top: 3px; font-size: 11.5px; font-weight: 600; color: #525252; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .counter { font-size: 12px; font-weight: 800; color: #525252; }
        .count { font-size: 22px; font-weight: 900; color: #111111; margin-right: 4px; }
        button {
          height: 40px;
          padding: 0 18px;
          border-radius: 12px;
          font-family: inherit;
          font-size: 12px;
          font-weight: 900;
          letter-spacing: 0.03em;
          cursor: pointer;
          border: 2.5px solid #111111;
          transition: transform 0.1s ease, box-shadow 0.1s ease;
        }
        .cancel-btn {
          background: #f3e8ff;
          color: #111111;
          box-shadow: 3px 3px 0px #111111;
        }
        .cancel-btn:hover {
          transform: translate(-1px, -1px);
          box-shadow: 4px 4px 0px #111111;
        }
        .cancel-btn:active {
          transform: translate(2px, 2px);
          box-shadow: 1px 1px 0px #111111;
        }
        .confirm-btn {
          background: #ffd84d;
          color: #111111;
          box-shadow: 3px 3px 0px #111111;
        }
        .confirm-btn:hover:not(:disabled) {
          transform: translate(-1px, -1px);
          box-shadow: 4px 4px 0px #111111;
          background: #ffe066;
        }
        .confirm-btn:active:not(:disabled) {
          transform: translate(2px, 2px);
          box-shadow: 1px 1px 0px #111111;
        }
        .confirm-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
          box-shadow: 1px 1px 0px #111111;
        }
      </style>
      <div class="toolbar">
        <div class="badge">J</div>
        <div class="info">
          <div class="title">SELEÇÃO MANUAL ROBIN · ${Core.PLATFORM_NAMES[activeContext.platform].toUpperCase()}</div>
          <div class="notice"></div>
        </div>
        <div class="counter"><strong class="count">0</strong>/ 500</div>
        <button class="cancel-btn">CANCELAR</button>
        <button class="confirm-btn" disabled>USAR SELECIONADOS</button>
      </div>
    `;

    shadow.querySelector(".cancel-btn").addEventListener("click", () => stopManualMode());
    shadow.querySelector(".confirm-btn").addEventListener("click", commitManualSelection);
    document.documentElement.appendChild(manualHost);

    window.addEventListener("pointerdown", onManualPointerDown, { capture: true, passive: false });
    window.addEventListener("click", onManualClickSuppressed, true);
    window.addEventListener("auxclick", onManualClickSuppressed, true);

    manualObserver = new MutationObserver(() => {
      syncSelectedCardsBatch().catch(() => {});
    });
    manualObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    refreshManualToolbar();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (["ROBIN_TOGGLE_OVERLAY", "JDARK_TOGGLE_OVERLAY"].includes(message?.type)) {
      if (manualHost) stopManualMode();
      if (dashboardHost) closeDashboardModal();
      else openDashboardModal(message.context);
      sendResponse({ ok: true, version: "1.0.0" });
      return false;
    }
    if (["ROBIN_START_MANUAL_SELECTION", "JDARK_START_MANUAL_SELECTION"].includes(message?.type)) {
      startManualMode(message.context);
      sendResponse({ ok: true, version: "1.0.0" });
      return false;
    }
    return false;
  });
})();
