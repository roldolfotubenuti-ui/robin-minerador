"use strict";

(() => {
  if (!globalThis.chrome?.storage?.local) {
    const memoryStore = {
      settings: { demoMode: true },
      profiles: {
        "instagram::criador_viral": {
          platform: "instagram",
          profile: "criador_viral",
          catalogCount: 120,
          reels: [
            { shortcode: "VIRAL_01", permalink: "https://instagram.com/reel/VIRAL_01", views: 3400000, likes: 420000, comments: 18500, shares: 92000, timestamp: Date.now() - 86400000, caption: "🔥 FAST TAPS, BIG WINS: O segredo viral revelado para crescer 10x mais rápido!" },
            { shortcode: "VIRAL_02", permalink: "https://instagram.com/reel/VIRAL_02", views: 1850000, likes: 215000, comments: 9200, shares: 45000, timestamp: Date.now() - 172800000, caption: "⚡ Estrutura de gancho irresistível nos primeiros 2 segundos de qualquer vídeo." },
            { shortcode: "VIRAL_03", permalink: "https://instagram.com/reel/VIRAL_03", views: 920000, likes: 110000, comments: 4600, shares: 21000, timestamp: Date.now() - 259200000, caption: "🎯 Mineração precisa de tendências com alta taxa de conversão e engajamento." }
          ]
        }
      }
    };
    globalThis.chrome = {
      runtime: {
        id: "mock-preview-id",
        getURL: (path) => path,
        sendMessage: async (msg) => {
          if (msg?.type === "GET_COMPANION_HEALTH") return { ok: true, status: "online", port: 17832 };
          if (msg?.type === "START_PROFILE_ANALYSIS") return { ok: true, scheduled: true };
          return { ok: true };
        },
        onMessage: { addListener: () => {} }
      },
      tabs: {
        query: async () => [{ id: 1, url: "https://www.instagram.com/criador_viral/" }]
      },
      storage: {
        local: {
          get: async (keys) => {
            if (Array.isArray(keys)) {
              const res = {};
              keys.forEach((k) => (res[k] = memoryStore[k]));
              return res;
            }
            if (typeof keys === "string") return { [keys]: memoryStore[keys] };
            return memoryStore;
          },
          set: async (obj) => Object.assign(memoryStore, obj),
          remove: async (key) => {
            if (Array.isArray(key)) key.forEach((k) => delete memoryStore[k]);
            else delete memoryStore[key];
          }
        },
        onChanged: { addListener: () => {} }
      }
    };
  }

  const Core = globalThis.RobinCore || globalThis.JDarkCore;
  const $ = (sel) => document.querySelector(sel);
  const urlParams = new URLSearchParams(location.search);
  const isEmbedded = urlParams.get("embedded") === "1";
  if (isEmbedded) {
    document.documentElement.classList.add("is-embedded");
    document.body.classList.add("is-embedded");
  }

  const state = {
    tabId: null,
    platform: urlParams.get("platform") || "instagram",
    profile: urlParams.get("profile") || "",
    key: "",
    reels: [],
    selected: new Set(),
    profiles: {},
    downloaded: {},
    activeDownloadJob: null,
    authSession: null,
    settings: {
      discoverySort: "viral",
      maxReels: 50,
      scanScope: "all",
      minViews: "0",
      minLikes: "0",
      minComments: "0",
      blockDuplicates: true,
      includeCsv: true,
      saveAs: false,
      archiveMode: "single",
      batchSize: 50,
      demoMode: false
    }
  };

  let allAdminUsers = [];
  let heartbeatTimer = null;

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[m]));
  }

  function startSessionHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      try {
        const { user, token } = await globalThis.RobinAuth.getStoredSession();
        if (!user || !token) return;
        const res = await globalThis.RobinAuth.checkSession();
        if (!res.authorized || res.code === "USER_INACTIVE" || res.code === "USER_EXPIRED") {
          stopSessionHeartbeat();
          await handleLogout();
          showAuthAlert(res.error || "Sua conta foi inativada ou expirou. Acesso bloqueado.", "error");
        }
      } catch (_) {}
    }, 20000);
  }

  function stopSessionHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function updateAuthUI(authData) {
    const authScreen = $("#auth-screen");
    const appShell = $("#app-shell");
    const emailDisplay = $("#account-email-display");
    const roleDisplay = $("#account-role-display");
    const limitsDisplay = $("#account-limits-display");
    const expiresDisplay = $("#account-expires-display");
    const statusBadge = $("#account-status-badge");
    const adminNavTab = $("#tab-nav-admin");

    if (authData?.authorized) {
      authScreen.classList.add("hidden");
      appShell.classList.remove("hidden");

      const user = authData.user || {};
      const email = authData.email || user.email || "usuario@robin.ia";
      const isAdmin = (authData.role || user.role) === "admin";

      if (emailDisplay) emailDisplay.textContent = email;
      if (roleDisplay) roleDisplay.textContent = `Perfil: ${isAdmin ? "Administrador Master" : "Usuário Comum"}`;
      if (statusBadge) {
        statusBadge.textContent = "CONTA ATIVA";
        statusBadge.className = "ready-pill account-active-pill";
      }

      if (limitsDisplay) {
        const dLimit = user.max_downloads_per_day === 0 ? "Ilimitados" : `${user.max_downloads_per_day || 50}/dia`;
        const sLimit = user.max_scrapes_per_day === 0 ? "Ilimitadas" : `${user.max_scrapes_per_day || 100}/dia`;
        limitsDisplay.textContent = `Downloads: ${dLimit} · Varreduras: ${sLimit}`;
      }

      if (expiresDisplay) {
        const exp = authData.expiresAt || user.expires_at;
        if (!exp || isAdmin) {
          expiresDisplay.textContent = "Assinatura: Acesso Vitalício / Master";
          expiresDisplay.className = "account-expires-text badge-exp-lifetime";
        } else {
          const expDate = new Date(exp);
          const diffDays = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          const dateStr = expDate.toLocaleDateString("pt-BR");
          if (diffDays <= 0) {
            expiresDisplay.textContent = `Assinatura: Expirada em ${dateStr}`;
            expiresDisplay.className = "account-expires-text badge-exp-expired";
          } else {
            expiresDisplay.textContent = `Assinatura: Vence em ${diffDays} dias (${dateStr})`;
            expiresDisplay.className = "account-expires-text badge-exp-active";
          }
        }
      }

      if (isAdmin) {
        adminNavTab?.classList.remove("hidden");
        loadAndRenderAdminUsers();
      } else {
        adminNavTab?.classList.add("hidden");
        const activeTab = document.querySelector(".nav-tab.active");
        if (activeTab?.dataset.tab === "admin") {
          switchTab("miner");
        }
      }

      startSessionHeartbeat();
    } else {
      stopSessionHeartbeat();
      authScreen.classList.remove("hidden");
      appShell.classList.add("hidden");
      adminNavTab?.classList.add("hidden");
    }
  }

  function showAuthAlert(msg, type = "error") {
    const alertEl = $("#auth-alert");
    if (!alertEl) return;
    alertEl.textContent = msg;
    alertEl.className = `auth-alert ${type}`;
    alertEl.classList.remove("hidden");
  }

  async function handleAuthSubmit() {
    const emailInput = $("#auth-email");
    const passInput = $("#auth-password");
    const rememberCheckbox = $("#auth-remember");
    const email = emailInput?.value;
    const password = passInput?.value;
    const btn = $("#btn-login");
    const originalText = btn ? btn.textContent : "Entrar";

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Autenticando...";
    }
    const alertEl = $("#auth-alert");
    if (alertEl) alertEl.classList.add("hidden");

    try {
      if (rememberCheckbox?.checked && email) {
        await chrome.storage.local.set({ robin_remember_email: email });
      } else {
        await chrome.storage.local.remove("robin_remember_email");
      }

      await globalThis.RobinAuth.signIn(email, password);
      const check = await globalThis.RobinAuth.checkSession();

      if (check && check.authorized) {
        updateAuthUI(check);
        showToast("Login realizado com sucesso! Bem-vindo(a).");
      } else if (check?.code === "USER_INACTIVE" || check?.code === "USER_EXPIRED") {
        showAuthAlert(check?.error || "Esta conta foi inativada ou expirou. Contate o administrador.", "error");
      } else {
        showAuthAlert(check?.error || "E-mail ou senha incorretos.", "error");
      }
    } catch (err) {
      showAuthAlert(err.message || "Erro durante o login.", "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }

  async function handleLogout() {
    stopSessionHeartbeat();
    try {
      await globalThis.RobinAuth.signOut();
    } catch (_) {}
    if ($("#auth-password")) $("#auth-password").value = "";
    updateAuthUI(null);
    showToast("Você saiu da conta.");
  }

  /* ==========================================================================
     Painel de Administração Master
     ========================================================================== */

  function switchAdminSubtab(subtabId) {
    document.querySelectorAll(".admin-subtab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.subtab === subtabId);
    });
    document.querySelectorAll(".admin-subtab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `admin-subtab-${subtabId}`);
    });
    if (subtabId === "users-list") {
      loadAndRenderAdminUsers();
    }
  }

  async function loadAndRenderAdminUsers() {
    const tbody = $("#admin-users-tbody");
    const countEl = $("#admin-user-count");
    if (!tbody) return;
    try {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 18px; color: var(--text-muted);">Consultando banco de dados...</td></tr>`;
      allAdminUsers = await globalThis.RobinAuth.adminListUsers();
      if (countEl) countEl.textContent = String(allAdminUsers.length);
      renderFilteredAdminUsers();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 18px; color: #ef4444;">Erro ao carregar usuários: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function renderFilteredAdminUsers() {
    const tbody = $("#admin-users-tbody");
    if (!tbody) return;
    const search = String($("#admin-search-users")?.value || "").toLowerCase().trim();
    const filtered = allAdminUsers.filter((u) => !search || u.email.toLowerCase().includes(search));

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 18px; color: var(--text-muted);">Nenhum usuário cadastrado encontrado.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((u) => {
      const isActive = u.status === "active";
      const isAdmin = u.role === "admin";
      const downloadsText = u.max_downloads_per_day === 0 ? "Ilimitado" : `${u.max_downloads_per_day}/dia`;
      const scrapesText = u.max_scrapes_per_day === 0 ? "Ilimitado" : `${u.max_scrapes_per_day}/dia`;

      let validityHtml = "";
      if (!u.expires_at || u.days_left === -1) {
        validityHtml = '<span class="badge-exp-lifetime">Vitalício</span>';
      } else {
        const d = new Date(u.expires_at);
        const dateStr = d.toLocaleDateString("pt-BR");
        if (u.days_left === 0 || d < new Date()) {
          validityHtml = `<span class="badge-exp-expired">Expirado (${dateStr})</span>`;
        } else {
          validityHtml = `<span class="badge-exp-active">${u.days_left} dias (${dateStr})`;
        }
      }

      return `
        <tr>
          <td><strong>${escapeHtml(u.email)}</strong></td>
          <td><span class="badge-role-${u.role}">${isAdmin ? "Master" : "Comum"}</span></td>
          <td><span class="badge-status-${u.status}">${isActive ? "Ativo" : "Inativo"}</span></td>
          <td>${validityHtml}</td>
          <td><small>Downloads: ${downloadsText} · Varreduras: ${scrapesText}</small></td>
          <td style="text-align: right; white-space: nowrap;">
            ${!isAdmin ? `<button type="button" class="btn-table-action btn-table-add-days" data-user-action="add-days" data-id="${u.id}" data-email="${escapeHtml(u.email)}" title="Adicionar +30 dias de assinatura">+30 Dias</button>` : ""}
            <button type="button" class="btn-table-action ${isActive ? "btn-table-toggle-deactivate" : "btn-table-toggle-activate"}" data-user-action="toggle-status" data-id="${u.id}" data-current="${u.status}">
              ${isActive ? "Inativar" : "Ativar"}
            </button>
            <button type="button" class="btn-table-action btn-table-edit" data-user-action="edit" data-id="${u.id}">
              Editar
            </button>
            <button type="button" class="btn-table-action btn-table-delete" data-user-action="delete" data-id="${u.id}" data-email="${escapeHtml(u.email)}">
              Excluir
            </button>
          </td>
        </tr>
      `;
    }).join("");
  }

  // Fallback for <dialog closedby="any"> on browsers without native closedBy support
  function attachDialogLightDismissFallback(dialogEl) {
    if (!dialogEl || "closedBy" in HTMLDialogElement.prototype) return;
    dialogEl.addEventListener("click", (event) => {
      if (event.target !== dialogEl) return;
      const rect = dialogEl.getBoundingClientRect();
      const insideContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!insideContent) dialogEl.close();
    });
  }

  function showToast(text, isError = false) {
    const el = $("#toast-banner");
    el.textContent = text;
    el.classList.toggle("error", isError);
    el.classList.remove("hidden");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.add("hidden"), 3400);
  }

  async function updateSettings(patch) {
    Object.assign(state.settings, patch);
    await chrome.storage.local.set({ settings: state.settings });
    syncControlsWithState();
  }

  function isAlreadyDownloaded(item) {
    return Boolean(state.settings.blockDuplicates && state.downloaded[state.key]?.[item.shortcode]);
  }

  function switchTab(tabName) {
    document.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `tab-${tabName}`);
    });
  }

  function showMinerSubView(subViewId) {
    for (const id of ["view-intro", "view-progress", "view-results"]) {
      $(`#${id}`).classList.toggle("hidden", id !== subViewId);
    }
  }

  function syncControlsWithState() {
    $("#demo-pill").textContent = `MODO DEMO: ${state.settings.demoMode ? "ON" : "OFF"}`;
    $("#demo-pill").classList.toggle("active", state.settings.demoMode);

    $("#discovery-sort").value = state.settings.discoverySort;
    $("#results-sort-select").value = state.settings.discoverySort;
    $("#discovery-limit").value = String(state.settings.maxReels);

    const isAllScope = state.settings.scanScope === "all";
    $("#discovery-scope-mode").value = isAllScope ? "all" : "custom";
    $("#scope-count-wrap").classList.toggle("hidden", isAllScope);
    if (!isAllScope) $("#discovery-scope-count").value = String(state.settings.scanScope);

    $("#filter-min-views").value = state.settings.minViews || "0";
    $("#filter-min-likes").value = state.settings.minLikes || "0";
    $("#filter-min-comments").value = state.settings.minComments || "0";

    $("#setting-block-duplicates").checked = state.settings.blockDuplicates !== false;
    $("#setting-include-csv").checked = state.settings.includeCsv !== false;
    $("#setting-save-as").checked = state.settings.saveAs === true;
    $("#setting-demo-mode").checked = state.settings.demoMode === true;

    $("#archive-mode-select").value = state.settings.archiveMode === "batches" ? "batches" : "single";
    $("#batch-size-input").value = String(state.settings.batchSize || 50);
    $("#batch-size-input").classList.toggle("hidden", state.settings.archiveMode !== "batches");
  }

  async function refreshCompanionBadge() {
    try {
      const health = await chrome.runtime.sendMessage({ type: "COMPANION_HEALTH" });
      const pill = $("#companion-pill");
      if (health?.ok) {
        pill.textContent = "Companion: Online";
        pill.classList.add("online");
      } else {
        pill.textContent = "Modo Navegador";
        pill.classList.remove("online");
      }
    } catch (_) {}
  }

  let isTogglingDemo = false;
  async function toggleDemoMode(forcedVal) {
    if (isTogglingDemo) return;
    isTogglingDemo = true;
    const demoPill = $("#demo-pill");
    const demoCheckbox = $("#setting-demo-mode");

    if (demoPill) {
      demoPill.style.pointerEvents = "none";
      demoPill.style.opacity = "0.7";
    }
    if (demoCheckbox) {
      demoCheckbox.disabled = true;
    }

    try {
      const nextVal = typeof forcedVal === "boolean" ? forcedVal : !state.settings.demoMode;
      await updateSettings({ demoMode: nextVal });
      await detectActiveTabContext();
    } finally {
      isTogglingDemo = false;
      if (demoPill) {
        demoPill.style.pointerEvents = "auto";
        demoPill.style.opacity = "1";
      }
      if (demoCheckbox) {
        demoCheckbox.disabled = false;
      }
    }
  }

  let isDetectingContext = false;
  async function detectActiveTabContext() {
    if (isDetectingContext) return;
    isDetectingContext = true;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) state.tabId = activeTab.id;

      // 1. MODO DEMO ATIVO: Estado determinístico e isolado
      if (state.settings.demoMode) {
        state.platform = "instagram";
        state.profile = "criador_demo";
        state.key = "instagram::criador_demo";
        $("#detected-platform-label").textContent = "INSTAGRAM (DEMO)";
        $("#detected-profile-title").textContent = "@criador_demo";
        $("#detected-hint").textContent = "Modo demonstração ativo — clique em Minerar Perfil para testar todo o fluxo.";
        $("#ready-badge").textContent = "PRONTO (DEMO)";
        return;
      }

      // 2. MODO DEMO DESATIVADO: Consulta a aba real ativa
      const parsed = activeTab?.url ? Core.detectPlatformContext(activeTab.url) : null;
      if (parsed && parsed.profile && parsed.profile !== "criador_demo") {
        state.platform = parsed.platform;
        state.profile = parsed.profile;
        state.key = parsed.key;
        $("#detected-platform-label").textContent = Core.PLATFORM_NAMES[state.platform] || "PLATAFORMA";
        $("#detected-profile-title").textContent = `@${state.profile}`;
        $("#detected-hint").textContent = `Pronto para minerar ${Core.ITEM_NOUNS[state.platform] || "vídeos"} públicos de @${state.profile}.`;
        $("#ready-badge").textContent = "PERFIL PRONTO";
      } else {
        // Limpar profile e key antigos quando não houver perfil compatível. Nunca reutilizar criador_demo!
        state.platform = "";
        state.profile = "";
        state.key = "";
        $("#detected-platform-label").textContent = "AGUARDANDO PÁGINA COMPATÍVEL";
        $("#detected-profile-title").textContent = "Nenhum perfil detectado";
        $("#detected-hint").textContent = "Abra um perfil no Instagram, TikTok ou a aba Shorts de um canal no YouTube (ou ative o Modo Demo).";
        $("#ready-badge").textContent = "ABRA UM PERFIL";
      }
    } finally {
      isDetectingContext = false;
    }
  }

  function renderResultsGrid() {
    showMinerSubView("view-results");
    const record = state.profiles[state.key] || {};
    const avgScore = state.reels.length
      ? Math.round(state.reels.reduce((s, r) => s + Core.computeViralScore(r), 0) / state.reels.length)
      : 0;

    $("#stat-approved").textContent = String(state.reels.length);
    $("#stat-catalog").textContent = String(record.catalogCount || state.reels.length);
    $("#stat-skipped").textContent = String(record.skippedCount || 0);
    $("#stat-avg-score").textContent = `${avgScore}/100`;

    const grid = $("#reels-grid");
    grid.innerHTML = "";

    state.reels.forEach((reel, index) => {
      const score = Core.computeViralScore(reel);
      const isSelected = state.selected.has(reel.shortcode);
      const card = document.createElement("article");
      card.className = `reel-card${isSelected ? " selected" : ""}${index >= 12 ? " deferred-card" : ""}`;

      const thumbSrc = reel.demo
        ? (reel.thumbnail || `assets/demo_thumb_${(index % 6) + 1}.jpg`)
        : (reel.thumbnail || "");

      const thumbHtml = thumbSrc
        ? `<img src="${thumbSrc}" alt="${reel.shortcode}" loading="lazy" />`
        : `<div style="height:100%;display:grid;place-items:center;color:#a855f7;font-weight:800;">ROBIN · ${reel.shortcode}</div>`;

      card.innerHTML = `
        <div class="reel-thumb-wrap">
          ${thumbHtml}
          <span class="reel-score-badge">🔥 SCORE ${score}</span>
          <input type="checkbox" class="reel-select-check" ${isSelected ? "checked" : ""} aria-label="Selecionar vídeo ${reel.shortcode}" />
        </div>
        <div class="reel-body">
          <div class="reel-metrics">
            <span>👁️ ${Core.formatCompactNumber(reel.views)}</span>
            <span>❤️ ${Core.formatCompactNumber(reel.likes)}</span>
            <span>💬 ${Core.formatCompactNumber(reel.comments)}</span>
          </div>
          <p class="reel-caption">${reel.caption || "Sem legenda disponível"}</p>
          <div class="reel-foot">
            <span>${Core.formatShortDate(reel.timestamp)}</span>
            <a href="${reel.permalink}" target="_blank" rel="noopener noreferrer">${reel.shortcode} ↗</a>
          </div>
        </div>
      `;

      const toggleCardSelection = () => {
        if (state.selected.has(reel.shortcode)) state.selected.delete(reel.shortcode);
        else state.selected.add(reel.shortcode);
        renderResultsGrid();
      };

      card.querySelector(".reel-thumb-wrap").addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT") return;
        toggleCardSelection();
      });
      card.querySelector(".reel-select-check").addEventListener("change", toggleCardSelection);

      grid.appendChild(card);
    });

    $("#selected-counter").textContent = `${state.selected.size} vídeo(s) selecionado(s)`;
    $("#select-all-checkbox").checked = state.reels.length > 0 && state.selected.size === state.reels.length;

    const isAllDemo = state.reels.length > 0 && state.reels.every((r) => r.demo);
    const dlBtn = $("#btn-download-selected");
    const dlSub = $("#selected-subtitle");
    if (dlBtn) {
      dlBtn.textContent = isAllDemo ? "📦 EXPORTAR PACOTE DEMO (CSV)" : "⬇️ BAIXAR SELECIONADOS";
    }
    if (dlSub) {
      dlSub.textContent = isAllDemo
        ? "Gerar pacote demonstrativo (ZIP com CSV e orientações)"
        : "Pronto para empacotar ZIP + CSV";
    }

    const panel = $(".app-left-panel");
    if (panel) panel.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function loadSavedProfile(key) {
    const record = state.profiles[key];
    if (!record) return;
    state.key = key;
    state.platform = record.platform || state.platform;
    state.profile = record.profile || state.profile;
    state.reels = Core.rankItems(record.reels || [], state.settings.discoverySort);
    state.selected = new Set(state.reels.filter((r) => !isAlreadyDownloaded(r)).map((r) => r.shortcode));
    renderResultsGrid();
  }

  function renderHistoryList() {
    const container = $("#history-list");
    container.innerHTML = "";
    const entries = Object.values(state.profiles || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (!entries.length) {
      container.innerHTML = `<p style="color:var(--text-muted);font-size:12px;">Nenhum perfil minerado ainda.</p>`;
      return;
    }

    for (const item of entries) {
      const row = document.createElement("div");
      row.className = "history-item";
      row.innerHTML = `
        <div>
          <strong>@${item.profile}</strong>
          <span style="color:var(--text-muted);font-size:11px;margin-left:8px;">${Core.PLATFORM_NAMES[item.platform] || item.platform}</span>
        </div>
        <span style="color:var(--accent-neon);font-weight:800;">${(item.reels || []).length} vídeos →</span>
      `;
      row.addEventListener("click", () => {
        switchTab("miner");
        loadSavedProfile(item.key);
      });
      container.appendChild(row);
    }
  }

  let isAnalyzing = false;

  function setAnalysisButtonState(analyzing) {
    const btn = $("#btn-start-analysis");
    if (!btn) return;
    btn.disabled = Boolean(analyzing);
    if (analyzing) {
      btn.dataset.prevHtml = btn.innerHTML;
      btn.innerHTML = `<span>⏳ MINERANDO...</span>`;
      btn.classList.add("disabled");
      btn.style.opacity = "0.75";
      btn.style.pointerEvents = "none";
    } else {
      if (btn.dataset.prevHtml) {
        btn.innerHTML = btn.dataset.prevHtml;
        delete btn.dataset.prevHtml;
      } else {
        btn.innerHTML = `⚡ MINERAR PERFIL AGORA`;
      }
      btn.classList.remove("disabled");
      btn.style.opacity = "1";
      btn.style.pointerEvents = "auto";
    }
  }

  async function triggerAnalysis() {
    if (isAnalyzing) return;

    // 1. MODO DEMO: Execução exclusivamente local, imediata e sem dependência de abas externas
    if (state.settings.demoMode) {
      isAnalyzing = true;
      setAnalysisButtonState(true);
      try {
        const limit = Math.min(500, Math.max(1, Number($("#discovery-limit").value) || 50));
        const sort = $("#discovery-sort").value || "viral";
        const scope = $("#discovery-scope-mode").value === "all"
          ? "all"
          : String(Math.min(5000, Math.max(1, Number($("#discovery-scope-count").value) || 300)));

        const filters = {
          minViews: $("#filter-min-views").value || "0",
          minLikes: $("#filter-min-likes").value || "0",
          minComments: $("#filter-min-comments").value || "0"
        };

        await updateSettings({
          discoverySort: sort,
          maxReels: limit,
          scanScope: scope,
          ...filters
        });

        const demoProfile = "criador_demo";
        const demoPlatform = "instagram";
        const demoKey = Core.makeContextKey(demoPlatform, demoProfile);
        state.platform = demoPlatform;
        state.profile = demoProfile;
        state.key = demoKey;

        const demoItems = Core.createDemoDataset(demoProfile, demoPlatform);
        const filtered = demoItems.filter((item) => Core.matchesFilters(item, filters));
        const ranked = Core.rankItems(filtered, sort).slice(0, limit);

        state.profiles[demoKey] = {
          key: demoKey,
          platform: demoPlatform,
          profile: demoProfile,
          reels: ranked,
          catalogCount: demoItems.length,
          skippedCount: 0,
          qualifiedCount: ranked.length,
          catalogComplete: true,
          updatedAt: Date.now()
        };

        await chrome.storage.local.set({ profiles: state.profiles });
        loadSavedProfile(demoKey);
        renderHistoryList();
        return;
      } finally {
        isAnalyzing = false;
        setAnalysisButtonState(false);
      }
    }

    // 2. MODO DEMO DESATIVADO: Validação estrita de perfil social real
    if (!state.profile || state.profile === "criador_demo" || !state.platform) {
      showToast("Abra um perfil público no Instagram, TikTok ou YouTube (ou ative o Modo Demo).", true);
      showMinerSubView("view-intro");
      return;
    }

    if (!state.tabId) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) state.tabId = activeTab.id;
    }

    if (!state.tabId) {
      showToast("Aba do perfil não identificada. Recarregue a página do perfil e tente novamente.", true);
      showMinerSubView("view-intro");
      return;
    }

    const limit = Math.min(500, Math.max(1, Number($("#discovery-limit").value) || 50));
    const sort = $("#discovery-sort").value || "viral";
    const scope = $("#discovery-scope-mode").value === "all"
      ? "all"
      : String(Math.min(5000, Math.max(1, Number($("#discovery-scope-count").value) || 300)));

    const filters = {
      minViews: $("#filter-min-views").value || "0",
      minLikes: $("#filter-min-likes").value || "0",
      minComments: $("#filter-min-comments").value || "0"
    };

    isAnalyzing = true;
    setAnalysisButtonState(true);

    try {
      await updateSettings({
        discoverySort: sort,
        maxReels: limit,
        scanScope: scope,
        ...filters
      });

      // Inicializa os indicadores de progresso dinamicamente
      $("#analysis-stage-title").textContent = "Iniciando varredura Robin...";
      $("#analysis-progress-fill").style.width = "5%";
      $("#analysis-count-label").textContent = `0 / ${limit} vídeos`;
      $("#analysis-percent-label").textContent = "5%";
      showMinerSubView("view-progress");

      const resp = await chrome.runtime.sendMessage({
        type: "START_ANALYSIS",
        tabId: state.tabId,
        platform: state.platform,
        key: state.key,
        profile: state.profile,
        limit,
        sort,
        scope,
        filters,
        blockDuplicates: state.settings.blockDuplicates
      });

      if (!resp?.ok) {
        showMinerSubView("view-intro");
        showToast(resp?.error || "Falha ao iniciar mineração.", true);
        isAnalyzing = false;
        setAnalysisButtonState(false);
      }
    } catch (err) {
      showMinerSubView("view-intro");
      showToast(err.message || "Erro de comunicação ao iniciar mineração.", true);
      isAnalyzing = false;
      setAnalysisButtonState(false);
    }
  }

  async function triggerManualSelection() {
    if (!state.tabId || !state.profile) {
      showToast("Abra um perfil no Instagram, TikTok ou YouTube para usar a seleção manual.", true);
      return;
    }
    try {
      await chrome.tabs.sendMessage(state.tabId, {
        type: "ROBIN_START_MANUAL_SELECTION",
        context: {
          platform: state.platform,
          profile: state.profile,
          key: state.key
        }
      });
      showToast("Seleção manual iniciada na página!");
    } catch (_) {
      showToast("Recarregue a aba do perfil e tente novamente.", true);
    }
  }

  function renderDownloadDialog(job) {
    if (!job) return;
    state.activeDownloadJob = job;
    const dlg = $("#download-dialog");
    if (!dlg.open) dlg.showModal();

    $("#download-stage-text").textContent = job.stage || "Processando...";
    $("#download-progress-fill").style.width = `${Math.min(100, Math.max(2, Number(job.percent) || 0))}%`;
    $("#download-counts-text").textContent = `${job.completed || 0} / ${job.total || 0} concluídos`;
    $("#download-percent-text").textContent = `${Math.round(Number(job.percent) || 0)}%`;

    const summaryEl = $("#download-result-summary");
    const closeBtn = $("#btn-close-download-dialog");

    if (job.status === "running") {
      summaryEl.textContent = "";
      closeBtn.textContent = "CANCELAR DOWNLOAD";
    } else if (job.status === "complete") {
      summaryEl.textContent = `✅ Concluído: ${job.completed || 0} vídeo(s) salvos em ${job.filenames?.length || 1} arquivo(s) ZIP.`;
      closeBtn.textContent = "FECHAR";
    } else if (job.status === "error") {
      summaryEl.textContent = `❌ Erro: ${job.error || "Falha durante o download."}`;
      closeBtn.textContent = "FECHAR";
    }
  }

  async function triggerDownloadSelected() {
    const chosen = state.reels.filter((r) => state.selected.has(r.shortcode));
    if (!chosen.length) {
      showToast("Selecione pelo menos um vídeo para baixar.", true);
      return;
    }

    const archiveMode = $("#archive-mode-select").value === "batches" ? "batches" : "single";
    const batchSize = Math.min(500, Math.max(1, Number($("#batch-size-input").value) || 50));
    await updateSettings({ archiveMode, batchSize });

    const isAllDemo = chosen.every((r) => r.demo);
    renderDownloadDialog({
      status: "running",
      total: chosen.length,
      completed: 0,
      percent: 3,
      stage: isAllDemo
        ? "Preparando exportação demonstrativa (CSV + orientações)..."
        : "Iniciando empacotamento Robin..."
    });

    const resp = await chrome.runtime.sendMessage({
      type: "START_DOWNLOAD",
      tabId: state.tabId,
      platform: state.platform,
      key: state.key,
      profile: state.profile || "criador_demo",
      reels: chosen,
      includeCsv: state.settings.includeCsv !== false,
      saveAs: false,
      archiveMode,
      batchSize
    });

    if (!resp?.ok) {
      renderDownloadDialog({
        status: "error",
        total: chosen.length,
        completed: 0,
        percent: 100,
        stage: "Falha ao iniciar",
        error: resp?.error || "Não foi possível iniciar o download."
      });
    }
  }

  async function openSimilarProfilesDialog() {
    const dlg = $("#similar-dialog");
    const listEl = $("#similar-profiles-list");
    listEl.innerHTML = `<p style="color:var(--text-muted);">Buscando criadores semelhantes...</p>`;
    dlg.showModal();

    if (state.settings.demoMode || !state.tabId) {
      listEl.innerHTML = ["criador_viral_br", "cortes_dark_oficial", "estrategia_reels", "shorts_accelerator"]
        .map((u) => `<a class="similar-card" href="https://www.instagram.com/${u}/" target="_blank" rel="noopener noreferrer">@${u} ↗</a>`)
        .join("");
      return;
    }

    try {
      const resp = await chrome.tabs.sendMessage(state.tabId, {
        type: "ROBIN_SIMILAR_PROFILES",
        profile: state.profile
      });
      const profiles = resp?.profiles || [];
      if (!profiles.length) {
        listEl.innerHTML = `<p style="color:var(--text-muted);">Nenhum perfil semelhante sugerido pela plataforma.</p>`;
        return;
      }
      listEl.innerHTML = profiles.map((p) => {
        const href = state.platform === "tiktok"
          ? `https://www.tiktok.com/@${p.username}`
          : state.platform === "youtube"
            ? `https://www.youtube.com/@${p.username}/shorts`
            : `https://www.instagram.com/${p.username}/`;
        return `<a class="similar-card" href="${href}" target="_blank" rel="noopener noreferrer">@${p.username} ↗</a>`;
      }).join("");
    } catch (_) {
      listEl.innerHTML = `<p style="color:var(--text-muted);">Não foi possível consultar perfis semelhantes nesta aba.</p>`;
    }
  }

  function wireEvents() {
    attachDialogLightDismissFallback($("#download-dialog"));
    attachDialogLightDismissFallback($("#similar-dialog"));

    document.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    $("#demo-pill").addEventListener("click", () => toggleDemoMode());

    $("#discovery-scope-mode").addEventListener("change", (e) => {
      const custom = e.target.value === "custom";
      $("#scope-count-wrap").classList.toggle("hidden", !custom);
      updateSettings({ scanScope: custom ? String($("#discovery-scope-count").value || 300) : "all" });
    });

    $("#btn-start-analysis").addEventListener("click", triggerAnalysis);
    $("#btn-reanalyze").addEventListener("click", () => showMinerSubView("view-intro"));
    $("#btn-manual-select").addEventListener("click", triggerManualSelection);
    $("#btn-similar-profiles").addEventListener("click", openSimilarProfilesDialog);

    $("#results-sort-select").addEventListener("change", async (e) => {
      await updateSettings({ discoverySort: e.target.value });
      state.reels = Core.rankItems(state.reels, e.target.value);
      renderResultsGrid();
    });

    $("#select-all-checkbox").addEventListener("change", (e) => {
      if (e.target.checked) {
        state.reels.forEach((r) => state.selected.add(r.shortcode));
      } else {
        state.selected.clear();
      }
      renderResultsGrid();
    });

    document.querySelectorAll(".chip-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const topVal = btn.dataset.top;
        state.selected.clear();
        if (topVal !== "none") {
          const count = Number(topVal) || 10;
          state.reels.slice(0, count).forEach((r) => state.selected.add(r.shortcode));
        }
        renderResultsGrid();
      });
    });

    $("#archive-mode-select").addEventListener("change", (e) => {
      updateSettings({ archiveMode: e.target.value });
    });

    $("#btn-download-selected").addEventListener("click", triggerDownloadSelected);

    $("#btn-close-download-dialog").addEventListener("click", async () => {
      if (state.activeDownloadJob?.status === "running") {
        await chrome.runtime.sendMessage({
          type: "CANCEL_DOWNLOAD",
          jobId: state.activeDownloadJob.id
        }).catch(() => {});
        return;
      }
      $("#download-dialog").close();
    });

    $("#btn-close-similar-dialog").addEventListener("click", () => $("#similar-dialog").close());

    $("#btn-clear-history").addEventListener("click", async () => {
      state.profiles = {};
      state.downloaded = {};
      state.reels = [];
      state.selected.clear();
      await chrome.storage.local.set({ profiles: {}, downloaded: {} });
      renderHistoryList();
      showMinerSubView("view-intro");
      showToast("Histórico apagado com sucesso.");
    });

    $("#setting-block-duplicates").addEventListener("change", (e) => updateSettings({ blockDuplicates: e.target.checked }));
    $("#setting-include-csv").addEventListener("change", (e) => updateSettings({ includeCsv: e.target.checked }));
    $("#setting-save-as").addEventListener("change", (e) => updateSettings({ saveAs: e.target.checked }));
    $("#setting-demo-mode").addEventListener("change", (e) => toggleDemoMode(e.target.checked));

    // Eventos de Autenticação e Deslogar
    $("#auth-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      handleAuthSubmit();
    });

    $("#btn-header-logout")?.addEventListener("click", handleLogout);
    $("#btn-logout")?.addEventListener("click", handleLogout);

    // Eventos do Painel de Administração
    $("#btn-refresh-users")?.addEventListener("click", loadAndRenderAdminUsers);
    $("#admin-search-users")?.addEventListener("input", renderFilteredAdminUsers);

    document.querySelectorAll(".admin-subtab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchAdminSubtab(btn.dataset.subtab));
    });

    $("#admin-users-tbody")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-user-action]");
      if (!btn) return;
      const action = btn.dataset.userAction;
      const id = btn.dataset.id;

      if (action === "add-days") {
        const email = btn.dataset.email;
        if (!confirm(`Deseja adicionar +30 dias de assinatura para ${email}?`)) return;
        try {
          btn.disabled = true;
          const res = await globalThis.RobinAuth.adminAddDays(id, 30);
          showToast(res?.message || "Adicionados +30 dias com sucesso!");
          await loadAndRenderAdminUsers();
        } catch (err) {
          showToast(err.message, true);
        } finally {
          btn.disabled = false;
        }
        return;
      }

      if (action === "toggle-status") {
        const current = btn.dataset.current;
        const newStatus = current === "active" ? "inactive" : "active";
        if (newStatus === "inactive" && !confirm("Deseja realmente inativar este usuário? O acesso dele será bloqueado imediatamente.")) return;
        try {
          btn.disabled = true;
          await globalThis.RobinAuth.adminToggleUserStatus(id, newStatus);
          showToast(`Usuário ${newStatus === "active" ? "ativado" : "inativado"} com sucesso!`);
          await loadAndRenderAdminUsers();
        } catch (err) {
          showToast(err.message, true);
        } finally {
          btn.disabled = false;
        }
      } else if (action === "edit") {
        const user = allAdminUsers.find((u) => u.id === id);
        if (!user) return;
        $("#edit-user-id").value = user.id;
        $("#edit-user-email").value = user.email;
        $("#edit-user-password").value = "";
        $("#edit-user-role").value = user.role;
        $("#edit-user-downloads").value = user.max_downloads_per_day || 0;
        $("#edit-user-scrapes").value = user.max_scrapes_per_day || 0;
        const dialog = $("#edit-user-dialog");
        if (dialog?.showModal) dialog.showModal();
        else dialog.setAttribute("open", "");
      } else if (action === "delete") {
        const email = btn.dataset.email;
        if (!confirm(`Tem certeza que deseja excluir o usuário ${email}? Esta ação é irreversível.`)) return;
        try {
          btn.disabled = true;
          await globalThis.RobinAuth.adminDeleteUser(id);
          showToast("Usuário excluído com sucesso!");
          await loadAndRenderAdminUsers();
        } catch (err) {
          showToast(err.message, true);
        } finally {
          btn.disabled = false;
        }
      }
    });

    $("#form-create-user")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#create-user-email").value;
      const password = $("#create-user-password").value;
      const role = $("#create-user-role").value;
      const maxDownloads = $("#create-user-downloads").value;
      const maxScrapes = $("#create-user-scrapes").value;
      const daysActive = $("#create-user-days")?.value || 30;
      const submitBtn = $("#btn-submit-create-user");

      try {
        submitBtn.disabled = true;
        submitBtn.textContent = "Salvando...";
        await globalThis.RobinAuth.adminCreateUser(email, password, role, maxDownloads, maxScrapes, daysActive);
        showToast("Usuário cadastrado com sucesso!");
        $("#form-create-user").reset();
        switchAdminSubtab("users-list");
      } catch (err) {
        showToast(err.message, true);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Salvar e Criar Usuário";
      }
    });

    $("#form-edit-user")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = $("#edit-user-id").value;
      const email = $("#edit-user-email").value;
      const password = $("#edit-user-password").value;
      const role = $("#edit-user-role").value;
      const maxDownloads = $("#edit-user-downloads").value;
      const maxScrapes = $("#edit-user-scrapes").value;
      const submitBtn = $("#btn-save-edit-user");

      try {
        submitBtn.disabled = true;
        submitBtn.textContent = "Salvando...";
        await globalThis.RobinAuth.adminUpdateUser(id, email, password, role, maxDownloads, maxScrapes);
        showToast("Usuário atualizado com sucesso!");
        const dialog = $("#edit-user-dialog");
        if (dialog?.close) dialog.close();
        else dialog.removeAttribute("open");
        await loadAndRenderAdminUsers();
      } catch (err) {
        showToast(err.message, true);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Salvar Alterações";
      }
    });

    $("#btn-close-edit-dialog")?.addEventListener("click", () => {
      const dialog = $("#edit-user-dialog");
      if (dialog?.close) dialog.close();
      else dialog.removeAttribute("open");
    });

    $("#btn-save-supabase-cfg")?.addEventListener("click", async () => {
      const url = $("#cfg-supabase-url").value;
      const key = $("#cfg-supabase-key").value;
      if (!url || !key) {
        showToast("Informe a URL e a Anon Key.", true);
        return;
      }
      await globalThis.RobinAuth.setSupabaseConfig(url, key);
      showToast("Configurações do Supabase salvas!");
    });

    $("#btn-test-supabase-cfg")?.addEventListener("click", async () => {
      const testBtn = $("#btn-test-supabase-cfg");
      testBtn.disabled = true;
      testBtn.textContent = "Testando...";
      try {
        const url = $("#cfg-supabase-url").value || globalThis.RobinAuth.CONFIG.SUPABASE_URL;
        const key = $("#cfg-supabase-key").value || globalThis.RobinAuth.CONFIG.ANON_KEY;
        const res = await fetch(`${url}/rest/v1/`, {
          method: "GET",
          headers: { "apikey": key, "Authorization": `Bearer ${key}` }
        });
        if (res.ok) {
          showToast("Conexão com Supabase bem-sucedida!");
        } else {
          showToast(`Servidor respondeu com código ${res.status}`, true);
        }
      } catch (err) {
        showToast(`Erro ao conectar: ${err.message}`, true);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Testar Conexão";
      }
    });

    $("#btn-open-tab")?.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    });
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;

    if (changes.authSession) {
      state.authSession = changes.authSession.newValue || null;
      updateAuthUI(state.authSession);
    }

    if (changes.analysisJob?.newValue) {
      const job = changes.analysisJob.newValue;
      const isMatch = !job.key || job.key === state.key || (job.profile && job.profile.toLowerCase() === (state.profile || "").toLowerCase());

      if (job.status === "running" && isMatch) {
        isAnalyzing = true;
        setAnalysisButtonState(true);
        showMinerSubView("view-progress");
        $("#analysis-stage-title").textContent = job.stage || "Minerando perfil...";
        $("#analysis-progress-fill").style.width = `${Math.min(100, Math.max(5, Number(job.percent) || 5))}%`;
        $("#analysis-count-label").textContent = `${job.count || 0} / ${job.limit || 50} vídeos`;
        $("#analysis-percent-label").textContent = `${Math.round(Number(job.percent) || 5)}%`;
      } else if (job.status === "complete" && isMatch) {
        isAnalyzing = false;
        setAnalysisButtonState(false);
        const stored = await chrome.storage.local.get("profiles");
        state.profiles = stored.profiles || {};
        loadSavedProfile(job.key || state.key);
        renderHistoryList();
      } else if (job.status === "error" && isMatch) {
        isAnalyzing = false;
        setAnalysisButtonState(false);
        showMinerSubView("view-intro");
        showToast(job.error || "Erro durante a mineração.", true);
      }
    }

    if (changes.manualSelection?.newValue) {
      const manual = changes.manualSelection.newValue;
      if (manual.key === state.key && Array.isArray(manual.reels)) {
        state.reels = manual.reels;
        state.selected = new Set(manual.reels.map((r) => r.shortcode));
        renderResultsGrid();
      }
    }

    if (changes.downloadJob?.newValue) {
      renderDownloadDialog(changes.downloadJob.newValue);
    }
  });

  async function init() {
    wireEvents();
    const stored = await chrome.storage.local.get([
      "settings", "profiles", "downloaded", "analysisJob", "downloadJob", "manualSelection", "authSession"
    ]);
    Object.assign(state.settings, stored.settings || {});
    state.profiles = stored.profiles || {};
    state.downloaded = stored.downloaded || {};
    state.authSession = stored.authSession || null;

    // 0. Verificação de segurança de análise em andamento anterior
    if (stored.analysisJob?.status === "running") {
      const isStale = Date.now() - (stored.analysisJob.updatedAt || 0) > 75000;
      if (isStale) {
        await chrome.storage.local.set({
          analysisJob: { ...stored.analysisJob, status: "error", error: "Análise anterior expirou por inatividade." }
        });
        showMinerSubView("view-intro");
      } else {
        isAnalyzing = true;
        setAnalysisButtonState(true);
        showMinerSubView("view-progress");
        $("#analysis-stage-title").textContent = stored.analysisJob.stage || "Minerando perfil...";
        $("#analysis-progress-fill").style.width = `${Math.min(100, Math.max(5, Number(stored.analysisJob.percent) || 5))}%`;
        $("#analysis-count-label").textContent = `${stored.analysisJob.count || 0} / ${stored.analysisJob.limit || 50} vídeos`;
        $("#analysis-percent-label").textContent = `${Math.round(Number(stored.analysisJob.percent) || 5)}%`;
      }
    }

    // Carregar e-mail lembrado e credenciais configuradas
    try {
      const rem = await chrome.storage.local.get("robin_remember_email");
      if (rem?.robin_remember_email && $("#auth-email")) {
        $("#auth-email").value = rem.robin_remember_email;
      }
      if ($("#cfg-supabase-url")) $("#cfg-supabase-url").value = globalThis.RobinAuth.CONFIG.SUPABASE_URL;
      if ($("#cfg-supabase-key")) $("#cfg-supabase-key").value = globalThis.RobinAuth.CONFIG.ANON_KEY;
    } catch (_) {}

    // 1. Restauração instantânea de sessão salva (PERMANECE LOGADO AO FECHAR EXTENSÃO)
    try {
      const storedSession = await globalThis.RobinAuth.getStoredSession();
      if (storedSession?.user && storedSession?.token) {
        updateAuthUI({
          authorized: true,
          user: storedSession.user,
          email: storedSession.user.email,
          role: storedSession.user.role,
          status: storedSession.user.status,
          expiresAt: storedSession.user.expires_at,
          limits: {
            maxDownloads: storedSession.user.max_downloads_per_day,
            maxScrapes: storedSession.user.max_scrapes_per_day
          }
        });
      } else {
        updateAuthUI(null);
      }
    } catch (_) {
      updateAuthUI(null);
    }

    // 2. Validação transparente em segundo plano com o Supabase
    try {
      const storedSession = await globalThis.RobinAuth.getStoredSession();
      if (storedSession?.token) {
        const check = await globalThis.RobinAuth.checkSession();
        if (check && check.authorized) {
          updateAuthUI(check);
        } else if (check?.code === "USER_INACTIVE" || check?.code === "USER_EXPIRED") {
          await handleLogout();
          showAuthAlert(check.error || "Sua conta foi inativada ou sua assinatura mensal expirou.", "error");
        }
      }
    } catch (_) {}

    syncControlsWithState();
    await detectActiveTabContext();
    await refreshCompanionBadge();
    renderHistoryList();

    if (stored.manualSelection?.key === state.key && Date.now() - stored.manualSelection.createdAt < 600000) {
      state.reels = stored.manualSelection.reels || [];
      state.selected = new Set(state.reels.map((r) => r.shortcode));
      renderResultsGrid();
    } else if (state.profiles[state.key]) {
      loadSavedProfile(state.key);
    }
  }

  init().catch((err) => showToast(err.message, true));
})();
