"use strict";

/**
 * Cliente de Autenticação Supabase e Gestão de Usuários para Robin - Minerador
 * Arquitetura Zero-Trust com RPCs protegidas e hash bcrypt no banco de dados.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RobinAuth = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  // Cofre Criptografado de Credenciais (URL e Anon Key protegidas contra leitura direta)
  const _VAULT = {
    u: "Oh58VqncomkbaVS8gcErEWZVqqysM2JCOYieuEFxRjqjk9kzEz5Tkw==",
    k: "NxNCTrih7i8kcWqbts0OT1JIjLqcOEUHI7i55iZpQxKUsvJ5WHVJtuvLYi9ni5DXyyQuSbOGkupbBgmo7a/7YkkOgdKw/zJIXramp9YQeVa5hvX4HkdpieXmYwRBdJa57H8mCX/OgZU5Pk9h+c3IGBdyF/3s8AEtd1LLybw/ZHiB3f2RQkVW1IPN5DkBd7i4p8MLMw2ShcPDBklcyqOV0y1sEIj5k9JVfRfzzvIjJ1FRmZ7ABTxXEuuN4j8+XSajrvxZGCx2k5L3eiQsZo/+xQ=="
  };

  function _unpack(b64) {
    try {
      const binary = atob(b64);
      const len = binary.length;
      const key = "ROBIN_SECURE_VAULT_v1_9a8f27c3e1b4";
      const keyLen = key.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i) ^ key.charCodeAt(i % keyLen) ^ ((i * 37) & 0xff);
      }
      return new TextDecoder().decode(bytes);
    } catch (_) {
      return "";
    }
  }

  const CONFIG = {
    SUPABASE_URL: _unpack(_VAULT.u),
    ANON_KEY: _unpack(_VAULT.k),
    STORAGE_KEYS: {
      SESSION_TOKEN: "robin_session_token",
      USER_INFO: "robin_user_info",
      REMEMBER_EMAIL: "robin_remember_email",
      DEVICE_ID: "robin_device_id"
    }
  };

  const COMPANION_URL = "http://127.0.0.1:17832";

  /**
   * Obtém identidade persistente do computador e assinatura criptográfica via Robin Companion
   */
  async function getDeviceProof(email = "") {
    try {
      const idRes = await fetch(`${COMPANION_URL}/device/identity`, {
        cache: "no-store",
        headers: { "X-Robin-Client": "robin-extension-v2" }
      });
      const idData = await idRes.json().catch(() => ({}));
      if (!idData?.ok || !idData?.deviceId) {
        return { ok: false, error: "O Robin Companion precisa estar em execução no Windows para identificar este computador." };
      }

      // 2. Desafio vinculado de uso único gerado pelo Backend
      let challengePayload = null;
      let nonce = null;
      let timestamp = Date.now();
      const cleanEmail = (email && email.includes("@")) ? email.trim().toLowerCase() : null;

      if (cleanEmail) {
        try {
          const chRes = await callRpc("app_create_device_challenge", {
            p_email: cleanEmail,
            p_device_id: idData.deviceId
          });
          if (chRes?.ok && chRes?.payload) {
            challengePayload = chRes.payload;
            nonce = chRes.serverNonce;
            timestamp = chRes.timestamp;
          }
        } catch (_) {}
      }

      if (!challengePayload) {
        const clientNonce = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
        nonce = clientNonce;
        challengePayload = `${cleanEmail || "device-auth@robin.local"}:${idData.deviceId}:${clientNonce}:${timestamp}`;
      }

      const signRes = await fetch(`${COMPANION_URL}/device/sign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Robin-Client": "robin-extension-v2"
        },
        body: JSON.stringify({ payload: challengePayload })
      });
      const signData = await signRes.json().catch(() => ({}));
      if (!signData?.ok || !signData?.signature) {
        return { ok: false, error: "Falha na comprovação criptográfica do computador." };
      }

      return {
        ok: true,
        deviceId: idData.deviceId,
        publicKey: idData.publicKey,
        signature: signData.signature,
        nonce: nonce,
        timestamp
      };
    } catch (_) {
      return {
        ok: false,
        error: "O Robin Companion precisa estar em execução no Windows para identificar este computador."
      };
    }
  }

  /**
   * Atualiza as credenciais do Supabase em tempo de execução ou persistidas
   */
  async function initConfig() {
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        const stored = await chrome.storage.local.get(["custom_supabase_url", "custom_supabase_key"]);
        if (stored.custom_supabase_url) CONFIG.SUPABASE_URL = stored.custom_supabase_url;
        if (stored.custom_supabase_key) CONFIG.ANON_KEY = stored.custom_supabase_key;
      }
    } catch (_) {}
  }
  initConfig();

  async function callRpc(rpcName, params = {}) {
    await initConfig();
    const url = `${CONFIG.SUPABASE_URL}/rest/v1/rpc/${rpcName}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "apikey": CONFIG.ANON_KEY,
        "Authorization": `Bearer ${CONFIG.ANON_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params)
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errorMsg = data?.message || data?.error || data?.hint || `Falha na requisição (${res.status})`;
      throw new Error(errorMsg);
    }

    return data;
  }

  async function storeSession(user, token, deviceId = null) {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    const payload = {
      [CONFIG.STORAGE_KEYS.SESSION_TOKEN]: token,
      [CONFIG.STORAGE_KEYS.USER_INFO]: user
    };
    if (deviceId) payload[CONFIG.STORAGE_KEYS.DEVICE_ID] = deviceId;
    await chrome.storage.local.set(payload);
  }

  async function clearStoredSession() {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    await chrome.storage.local.remove([
      CONFIG.STORAGE_KEYS.SESSION_TOKEN,
      CONFIG.STORAGE_KEYS.USER_INFO,
      CONFIG.STORAGE_KEYS.DEVICE_ID,
      "authSession"
    ]);
  }

  async function getStoredSession() {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return { user: null, token: null, deviceId: null };
    const data = await chrome.storage.local.get([
      CONFIG.STORAGE_KEYS.SESSION_TOKEN,
      CONFIG.STORAGE_KEYS.USER_INFO,
      CONFIG.STORAGE_KEYS.DEVICE_ID
    ]);
    return {
      token: data[CONFIG.STORAGE_KEYS.SESSION_TOKEN] || null,
      user: data[CONFIG.STORAGE_KEYS.USER_INFO] || null,
      deviceId: data[CONFIG.STORAGE_KEYS.DEVICE_ID] || null
    };
  }

  /**
   * Login Seguro com E-mail e Senha (Vinculação 1 Conta = 1 Computador)
   */
  async function signIn(email, password) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanPass = String(password || "").trim();

    if (!cleanEmail || !cleanPass) {
      throw new Error("Informe seu e-mail e senha.");
    }

    // 1. Consulta identidade criptográfica persistente do computador via Robin Companion
    const proof = await getDeviceProof(cleanEmail);

    // 2. Chamada atômica ao Supabase com comprovação do dispositivo
    const res = await callRpc("app_login", {
      p_email: cleanEmail,
      p_password: cleanPass,
      p_device_id: proof.ok ? proof.deviceId : null,
      p_public_key: proof.ok ? proof.publicKey : null,
      p_signature: proof.ok ? proof.signature : null,
      p_client_nonce: proof.ok ? proof.nonce : null,
      p_timestamp: proof.ok ? proof.timestamp : null
    });

    if (!res || !res.ok) {
      if (res?.code === "DEVICE_MISMATCH") {
        throw new Error("Este e-mail já está vinculado a outro computador. Cada assinatura do Robin Minerador permite a utilização em apenas um PC. Entre em contato com o suporte caso precise de assistência.");
      }
      if (res?.code === "DEVICE_REQUIRED") {
        throw new Error(res.error || "O Robin Companion precisa estar em execução no Windows para identificar este computador.");
      }
      throw new Error(res?.error || "E-mail ou senha incorretos.");
    }

    await storeSession(res.user, res.token, proof?.deviceId || res.deviceId);

    return {
      ok: true,
      user: res.user,
      token: res.token,
      deviceId: proof?.deviceId || res.deviceId
    };
  }

  /**
   * Verificação Contínua de Sessão e Status Ativo no Dispositivo Vinculado
   * Se o usuário foi inativado, expirou ou o token foi levado para outro PC, desloga imediatamente.
   */
  async function checkSession() {
    const { user, token } = await getStoredSession();
    if (!user || !token) {
      return { ok: false, authorized: false, code: "AUTH_REQUIRED", error: "Usuário não autenticado." };
    }

    try {
      const proof = await getDeviceProof(user.email);

      const res = await callRpc("app_check_session", {
        p_user_id: user.id,
        p_session_token: token,
        p_device_id: proof.ok ? proof.deviceId : null
      });

      if (!res || !res.valid) {
        await clearStoredSession();
        return {
          ok: false,
          authorized: false,
          code: res?.code || (res?.status === "inactive" ? "USER_INACTIVE" : "INVALID_SESSION"),
          error: res?.code === "DEVICE_MISMATCH"
            ? "Este e-mail já está vinculado a outro computador. Cada assinatura do Robin Minerador permite a utilização em apenas um PC. Entre em contato com o suporte caso precise de assistência."
            : (res?.error || "Sessão inválida ou conta inativada.")
        };
      }

      // Atualiza dados locais (como novos limites ou role)
      if (res.user) {
        await storeSession(res.user, token, proof?.deviceId);
      }

      return {
        ok: true,
        authorized: true,
        user: res.user || user,
        email: (res.user || user).email,
        role: (res.user || user).role,
        status: (res.user || user).status,
        expiresAt: (res.user || user).expires_at,
        deviceId: proof?.deviceId,
        limits: {
          maxDownloads: (res.user || user).max_downloads_per_day,
          maxScrapes: (res.user || user).max_scrapes_per_day
        }
      };
    } catch (err) {
      // Se for erro de rede temporário, preserva dados locais sem deslogar indevidamente
      if (err.message && err.message.includes("Failed to fetch")) {
        return {
          ok: true,
          authorized: true,
          user: user,
          email: user.email,
          role: user.role,
          offline: true
        };
      }
      return {
        ok: false,
        authorized: false,
        code: "VALIDATION_ERROR",
        error: err.message
      };
    }
  }

  /**
   * Compatibilidade com rotas de checagem do background
   */
  async function verifyLicenseWithServer() {
    return await checkSession();
  }

  /**
   * Logout Seguro (Invalida no banco e limpa storage local)
   */
  async function signOut() {
    try {
      const { user, token } = await getStoredSession();
      if (user?.id && token) {
        await callRpc("app_logout", {
          p_user_id: user.id,
          p_session_token: token
        });
      }
    } catch (_) {}
    await clearStoredSession();
    return { ok: true };
  }

  /* ==========================================================================
     MÉTODOS DE ADMINISTRAÇÃO (ACESSO EXCLUSIVO PARA ADMINS)
     ========================================================================== */

  async function ensureAdminSession() {
    const { user, token } = await getStoredSession();
    if (!user || !token || user.role !== "admin") {
      throw new Error("Acesso negado. Apenas administradores podem executar esta ação.");
    }
    return { adminId: user.id, token };
  }

  /**
   * Listar todos os usuários cadastrados
   */
  async function adminListUsers() {
    const { adminId, token } = await ensureAdminSession();
    const res = await callRpc("app_admin_list_users", {
      p_admin_id: adminId,
      p_session_token: token
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || "Erro ao listar usuários.");
    }
    return res.users || [];
  }

  /**
   * Cadastrar novo usuário pelo Admin
   */
  async function adminCreateUser(email, password, role = "user", maxDownloads = 50, maxScrapes = 100, daysActive = 30) {
    const { adminId, token } = await ensureAdminSession();
    const res = await callRpc("app_admin_create_user", {
      p_admin_id: adminId,
      p_session_token: token,
      p_email: email,
      p_password: password,
      p_role: role,
      p_max_downloads: parseInt(maxDownloads, 10) || 0,
      p_max_scrapes: parseInt(maxScrapes, 10) || 0,
      p_days_active: parseInt(daysActive, 10) || 30
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || "Erro ao cadastrar usuário.");
    }
    return res;
  }

  /**
   * Inativar ou Ativar Usuário
   */
  async function adminToggleUserStatus(targetUserId, newStatus) {
    const { adminId, token } = await ensureAdminSession();
    const res = await callRpc("app_admin_toggle_status", {
      p_admin_id: adminId,
      p_session_token: token,
      p_target_user_id: targetUserId,
      p_new_status: newStatus
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || "Erro ao alterar status do usuário.");
    }
    return res;
  }

  /**
   * Atualizar dados e limites de um usuário
   */
  async function adminUpdateUser(targetUserId, newEmail, newPassword, role, maxDownloads, maxScrapes) {
    const { adminId, token } = await ensureAdminSession();
    const res = await callRpc("app_admin_update_user", {
      p_admin_id: adminId,
      p_session_token: token,
      p_target_user_id: targetUserId,
      p_new_email: newEmail || null,
      p_new_password: newPassword || null,
      p_role: role || null,
      p_max_downloads: maxDownloads !== undefined && maxDownloads !== "" ? parseInt(maxDownloads, 10) : null,
      p_max_scrapes: maxScrapes !== undefined && maxScrapes !== "" ? parseInt(maxScrapes, 10) : null
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || "Erro ao atualizar usuário.");
    }
    return res;
  }

  /**
   * Excluir Usuário
   */
  async function adminDeleteUser(targetUserId) {
    const { adminId, token } = await ensureAdminSession();
    const res = await callRpc("app_admin_delete_user", {
      p_admin_id: adminId,
      p_session_token: token,
      p_target_user_id: targetUserId
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || "Erro ao excluir usuário.");
    }
    return res;
  }

  /**
   * Adicionar dias (+30 dias de renovação)
   */
  async function adminAddDays(targetUserId, days = 30) {
    const { adminId, token } = await ensureAdminSession();
    const res = await callRpc("app_admin_add_days", {
      p_admin_id: adminId,
      p_session_token: token,
      p_target_user_id: targetUserId,
      p_days: parseInt(days, 10) || 30
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || "Erro ao renovar assinatura.");
    }
    return res;
  }

  /**
   * Salva configurações customizadas do Supabase
   */
  /**
   * Desvincular computador de um assinante (Procedimento Administrativo Exclusivo para Troca de PC)
   */
  async function adminResetUserDevice(targetUserId) {
    const { adminId, token } = await ensureAdminSession();
    const res = await callRpc("app_admin_reset_user_device", {
      p_admin_id: adminId,
      p_session_token: token,
      p_target_user_id: targetUserId
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || "Erro ao desvincular computador.");
    }
    return res;
  }

  
  /**
   * Emite ticket criptográfico de download assinado pelo Supabase
   * Vincula usuário, dispositivo, sessão e assinatura ativa.
   */
  async function authorizeDownloadJob(videoCount = 1) {
    const { user, token, deviceId } = await getStoredSession();
    if (!user || !token) {
      throw new Error("Faça login no Robin Minerador para baixar vídeos.");
    }

    const proof = await getDeviceProof(user.email);
    const activeDeviceId = proof.ok ? proof.deviceId : deviceId;

    if (!activeDeviceId) {
      throw new Error("O Robin Companion precisa estar em execução no Windows para identificar este computador.");
    }

    let res = null;
    try {
      const fnUrl = `${CONFIG.SUPABASE_URL}/functions/v1/authorize-download`;
      const fnResp = await fetch(fnUrl, {
        method: "POST",
        headers: {
          "apikey": CONFIG.ANON_KEY,
          "Authorization": `Bearer ${CONFIG.ANON_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          userId: user.id,
          sessionToken: token,
          deviceId: activeDeviceId,
          videoCount: parseInt(videoCount, 10) || 1
        })
      });
      if (fnResp.ok) {
        res = await fnResp.json();
      }
    } catch (_) {}

    if (!res) {
      res = await callRpc("app_authorize_download", {
        p_user_id: user.id,
        p_session_token: token,
        p_device_id: activeDeviceId,
        p_video_count: parseInt(videoCount, 10) || 1
      });
    }

    if (!res || !res.ok) {
      if (res?.code === "DEVICE_MISMATCH") {
        throw new Error("Este computador não está autorizado para esta assinatura. Cada conta funciona em apenas 1 PC.");
      }
      if (res?.code === "USER_EXPIRED") {
        throw new Error("Sua assinatura mensal expirou. Renove seu plano para baixar vídeos.");
      }
      throw new Error(res?.error || "Autorização de download recusada pelo servidor.");
    }

    return {
      ok: true,
      ticket: res.ticket,
      expiresAt: res.expiresAt,
      userId: user.id,
      deviceId: activeDeviceId,
      sessionToken: token
    };
  }

  async function setSupabaseConfig(url, anonKey) {
    if (url) CONFIG.SUPABASE_URL = url.trim().replace(/\/+$/, "");
    if (anonKey) CONFIG.ANON_KEY = anonKey.trim();
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      await chrome.storage.local.set({
        custom_supabase_url: CONFIG.SUPABASE_URL,
        custom_supabase_key: CONFIG.ANON_KEY
      });
    }
  }

  return {
    CONFIG,
    signIn,
    signOut,
    checkSession,
    verifyLicenseWithServer,
    getStoredSession,
    setSupabaseConfig,
    // Métodos Admin
    adminListUsers,
    adminCreateUser,
    adminToggleUserStatus,
    adminUpdateUser,
    adminDeleteUser,
    adminAddDays,
    adminResetUserDevice,
    getDeviceProof,
    authorizeDownloadJob
  };
});
