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

  const Core = globalThis.JDarkCore;
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

  let currentAuthMode = "signin"; // "signin" | "signup" | "recovery"

  function setAuthMode(mode) {
    currentAuthMode = mode;
    const titleEl = $("#auth-title");
    const subtitleEl = $("#auth-subtitle");
    const passField = $("#auth-password-field");
    const optionsRow = $("#auth-options-row");
    const submitBtn = $("#btn-login");
    const footerText = $("#auth-footer-text");
    const tabLogin = $("#tab-auth-login");
    const tabSignup = $("#tab-auth-signup");
    const alertEl = $("#auth-alert");
    if (alertEl) alertEl.classList.add("hidden");

    if (tabLogin && tabSignup) {
      tabLogin.classList.toggle("active", mode === "signin");
      tabSignup.classList.toggle("active", mode === "signup");
    }

    if (mode === "signin") {
      if (titleEl) titleEl.textContent = "WELCOME BACK";
      if (subtitleEl) subtitleEl.textContent = "Enter your email and password to access your account";
      if (passField) passField.classList.remove("hidden");
      if (optionsRow) optionsRow.classList.remove("hidden");
      $("#auth-recovery-container")?.classList.add("hidden");
      if (submitBtn) {
        submitBtn.classList.remove("hidden");
        submitBtn.textContent = "Sign In";
      }
      if (footerText) {
        footerText.innerHTML = `Don't have an account? <a href="#" id="link-toggle-signup">Sign up</a>`;
        $("#link-toggle-signup")?.addEventListener("click", (e) => {
          e.preventDefault();
          setAuthMode("signup");
        });
      }
    } else if (mode === "signup") {
      if (titleEl) titleEl.textContent = "CREATE ACCOUNT";
      if (subtitleEl) subtitleEl.textContent = "Register with the email used in your Cakto subscription";
      if (passField) passField.classList.remove("hidden");
      if (optionsRow) optionsRow.classList.add("hidden");
      $("#auth-recovery-container")?.classList.add("hidden");
      if (submitBtn) {
        submitBtn.classList.remove("hidden");
        submitBtn.textContent = "Create Account";
      }
      if (footerText) {
        footerText.innerHTML = `Already have an account? <a href="#" id="link-toggle-signin">Sign in</a>`;
        $("#link-toggle-signin")?.addEventListener("click", (e) => {
          e.preventDefault();
          setAuthMode("signin");
        });
      }
    } else if (mode === "recovery") {
      if (titleEl) titleEl.textContent = "RESET PASSWORD";
      if (subtitleEl) subtitleEl.textContent = "Enter your email to receive a recovery code (OTP)";
      if (passField) passField.classList.add("hidden");
      if (optionsRow) optionsRow.classList.add("hidden");
      $("#auth-recovery-container")?.classList.remove("hidden");
      $("#auth-otp-field")?.classList.add("hidden");
      $("#auth-new-password-field")?.classList.add("hidden");
      if (submitBtn) submitBtn.classList.add("hidden"); // Oculto até enviar o código

      if (footerText) {
        footerText.innerHTML = `Remembered your password? <a href="#" id="link-toggle-back-signin">Back to Sign in</a>`;
        $("#link-toggle-back-signin")?.addEventListener("click", (e) => {
          e.preventDefault();
          setAuthMode("signin");
        });
      }
    }
  }

  function updateAuthUI(licenseData) {
    const authScreen = $("#auth-screen");
    const appShell = $("#app-shell");
    const emailDisplay = $("#account-email-display");
    const statusBadge = $("#account-status-badge");

    if (licenseData?.authorized) {
      authScreen.classList.add("hidden");
      appShell.classList.remove("hidden");
      if (emailDisplay) emailDisplay.textContent = licenseData.email || "assinante@robinpro.com";
      if (statusBadge) {
        if (licenseData.status === "canceled") {
          statusBadge.textContent = "CANCELADA (ACESSO ATÉ VENCIMENTO)";
          statusBadge.className = "ready-pill account-active-pill";
        } else {
          statusBadge.textContent = "PAGAMENTO ATIVO (CAKTO)";
          statusBadge.className = "ready-pill account-active-pill";
        }
      }
    } else {
      authScreen.classList.remove("hidden");
      appShell.classList.add("hidden");
    }
  }

  function showAuthError404() {
    const errorView = $("#auth-error-view");
    const mainCard = $("#auth-main-card");
    if (!errorView) return;
    if (mainCard) mainCard.classList.add("hidden");
    errorView.classList.remove("hidden");
  }

  function hideAuthError404() {
    const errorView = $("#auth-error-view");
    const mainCard = $("#auth-main-card");
    if (errorView) errorView.classList.add("hidden");
    if (mainCard) mainCard.classList.remove("hidden");
  }

  function showAuthAlert(msg, type = "error") {
    const alertEl = $("#auth-alert");
    if (!alertEl) return;
    alertEl.textContent = msg;
    alertEl.className = `auth-alert ${type}`;
    alertEl.classList.remove("hidden");
  }

  async function handleRequestOtp() {
    const email = $("#auth-email")?.value;
    const btn = $("#btn-request-otp");
    if (!email) {
      showAuthAlert("Informe seu e-mail para receber o código.", "error");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Enviando código...";
    }

    try {
      await globalThis.RobinAuth.resetPassword(email);
      showAuthAlert("Código OTP enviado para seu e-mail! Insira o código de 6 dígitos e sua nova senha abaixo.", "info");
      $("#auth-otp-field")?.classList.remove("hidden");
      $("#auth-new-password-field")?.classList.remove("hidden");
      const submitBtn = $("#btn-login");
      if (submitBtn) {
        submitBtn.classList.remove("hidden");
        submitBtn.textContent = "Confirmar e Redefinir Senha";
      }
      if (btn) btn.textContent = "Reenviar Código";
    } catch (err) {
      showAuthAlert(err.message || "Erro ao solicitar código de recuperação.", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleAuthSubmit() {
    const email = $("#auth-email")?.value;
    const password = $("#auth-password")?.value;
    const btn = $("#btn-login");
    const originalText = btn ? btn.textContent : "Submit";

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Carregando...";
    }
    const alertEl = $("#auth-alert");
    if (alertEl) alertEl.classList.add("hidden");

    try {
      if (currentAuthMode === "signin") {
        await globalThis.RobinAuth.signIn(email, password);
        const verification = await globalThis.RobinAuth.verifyLicenseWithServer();

        if (verification && verification.authorized) {
          hideAuthError404();
          updateAuthUI({ ...verification, email });
          showToast("Acesso liberado! Assinatura Cakto confirmada.");
        } else {
          showAuthError404();
        }
      } else if (currentAuthMode === "signup") {
        const result = await globalThis.RobinAuth.signUp(email, password);
        showAuthAlert(result.message, "success");
        $("#auth-password").value = "";
        setAuthMode("signin");
      } else if (currentAuthMode === "recovery") {
        const otpCode = $("#auth-otp-code")?.value;
        const newPassword = $("#auth-new-password")?.value;
        const result = await globalThis.RobinAuth.verifyOtpAndResetPassword(email, otpCode, newPassword);
        showAuthAlert(result.message, "success");
        setTimeout(() => setAuthMode("signin"), 3000);
      }
    } catch (err) {
      showAuthAlert(err.message || "Erro durante a autenticação.", "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }


  async function handleLogout() {
    try {
      await globalThis.RobinAuth.signOut();
    } catch (_) {}
    $("#auth-password").value = "";
    hideAuthError404();
    updateAuthUI(null);
    showToast("Você saiu da conta.");
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

  async function detectActiveTabContext() {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) state.tabId = activeTab.id;

    if (state.settings.demoMode) {
      state.platform = state.platform || "instagram";
      state.profile = state.profile || "criador_demo";
      state.key = Core.makeContextKey(state.platform, state.profile);
      $("#detected-platform-label").textContent = `${Core.PLATFORM_NAMES[state.platform]} (DEMO)`;
      $("#detected-profile-title").textContent = `@${state.profile}`;
      $("#detected-hint").textContent = "Modo demonstração ativo — clique em Minerar Perfil para testar todo o fluxo.";
      $("#ready-badge").textContent = "PRONTO (DEMO)";
      return;
    }

    const parsed = activeTab?.url ? Core.detectPlatformContext(activeTab.url) : null;
    if (parsed) {
      state.platform = parsed.platform;
      state.profile = parsed.profile || "";
      state.key = parsed.key;
    } else if (state.profile) {
      state.key = Core.makeContextKey(state.platform, state.profile);
    }

    if (state.profile) {
      $("#detected-platform-label").textContent = Core.PLATFORM_NAMES[state.platform] || "PLATAFORMA";
      $("#detected-profile-title").textContent = `@${state.profile}`;
      $("#detected-hint").textContent = `Pronto para minerar ${Core.ITEM_NOUNS[state.platform] || "vídeos"} públicos de @${state.profile}.`;
      $("#ready-badge").textContent = "PERFIL PRONTO";
    } else {
      $("#detected-platform-label").textContent = "AGUARDANDO PÁGINA COMPATÍVEL";
      $("#detected-profile-title").textContent = "Nenhum perfil detectado";
      $("#detected-hint").textContent = "Abra um perfil no Instagram, TikTok ou a aba Shorts de um canal no YouTube (ou ative o Modo Demo).";
      $("#ready-badge").textContent = "ABRA UM PERFIL";
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

      const thumbHtml = reel.thumbnail
        ? `<img src="${reel.thumbnail}" alt="${reel.shortcode}" loading="lazy" />`
        : `<div style="height:100%;display:grid;place-items:center;color:#a855f7;font-weight:800;">J-DARK · ${reel.shortcode}</div>`;

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

  async function triggerAnalysis() {
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

    if (state.settings.demoMode) {
      const demoItems = Core.createDemoDataset(state.profile || "criador_demo", state.platform);
      const filtered = demoItems.filter((item) => Core.matchesFilters(item, filters));
      const ranked = Core.rankItems(filtered, sort).slice(0, limit);
      state.key = Core.makeContextKey(state.platform, state.profile || "criador_demo");
      state.profiles[state.key] = {
        key: state.key,
        platform: state.platform,
        profile: state.profile || "criador_demo",
        reels: ranked,
        catalogCount: demoItems.length,
        skippedCount: 0,
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({ profiles: state.profiles });
      loadSavedProfile(state.key);
      renderHistoryList();
      return;
    }

    if (!state.profile || !state.tabId) {
      showToast("Abra um perfil público no navegador ou ative o Modo Demo.", true);
      return;
    }

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
    }
  }

  async function triggerManualSelection() {
    if (!state.tabId || !state.profile) {
      showToast("Abra um perfil no Instagram, TikTok ou YouTube para usar a seleção manual.", true);
      return;
    }
    try {
      await chrome.tabs.sendMessage(state.tabId, {
        type: "JDARK_START_MANUAL_SELECTION",
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

    renderDownloadDialog({
      status: "running",
      total: chosen.length,
      completed: 0,
      percent: 3,
      stage: "Iniciando empacotamento J-Dark..."
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
        type: "JDARK_SIMILAR_PROFILES",
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

    $("#demo-pill").addEventListener("click", async () => {
      await updateSettings({ demoMode: !state.settings.demoMode });
      await detectActiveTabContext();
    });

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
    $("#setting-demo-mode").addEventListener("change", async (e) => {
      await updateSettings({ demoMode: e.target.checked });
      await detectActiveTabContext();
    });

    // Eventos de Autenticação / Licença Cakto
    $("#auth-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      handleAuthSubmit();
    });

    $("#tab-auth-login")?.addEventListener("click", () => setAuthMode("signin"));
    $("#tab-auth-signup")?.addEventListener("click", () => setAuthMode("signup"));
    $("#link-toggle-signup")?.addEventListener("click", (e) => {
      e.preventDefault();
      setAuthMode("signup");
    });

    $("#auth-forgot-password")?.addEventListener("click", (e) => {
      e.preventDefault();
      setAuthMode("recovery");
    });

    $("#btn-request-otp")?.addEventListener("click", handleRequestOtp);

    $("#btn-error-retry")?.addEventListener("click", () => {

      hideAuthError404();
      $("#auth-email")?.focus();
    });

    $("#btn-logout")?.addEventListener("click", handleLogout);

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
      if (job.status === "running" && job.key === state.key) {
        showMinerSubView("view-progress");
        $("#analysis-stage-title").textContent = job.stage || "Minerando perfil...";
        $("#analysis-progress-fill").style.width = `${Math.min(100, Math.max(5, Number(job.percent) || 10))}%`;
        $("#analysis-count-label").textContent = `${job.count || 0} / ${job.limit || 50} vídeos`;
        $("#analysis-percent-label").textContent = `${Math.round(Number(job.percent) || 10)}%`;
      } else if (job.status === "complete" && job.key === state.key) {
        const stored = await chrome.storage.local.get("profiles");
        state.profiles = stored.profiles || {};
        loadSavedProfile(job.key);
        renderHistoryList();
      } else if (job.status === "error" && (!job.key || job.key === state.key)) {
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

    // Verificação de Licença Zero-Trust no servidor
    try {
      const storedTokens = await globalThis.RobinAuth.getStoredTokens();
      if (storedTokens?.refreshToken || storedTokens?.session) {
        const verification = await globalThis.RobinAuth.verifyLicenseWithServer();
        if (verification && verification.authorized) {
          updateAuthUI({ ...verification, email: storedTokens.user?.email });
        } else {
          updateAuthUI(null);
          if (verification && !verification.authorized && verification.code === "NO_ACTIVE_LICENSE") {
            showAuthError404();
          }
        }
      } else {
        updateAuthUI(null);
      }
    } catch (_) {
      updateAuthUI(null);
    }

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
