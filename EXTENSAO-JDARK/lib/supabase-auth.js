"use strict";

/**
 * Cliente de Autenticação Supabase e Verificação Zero-Trust para Robin - Minerador
 * Opera nativamente no Manifest V3 (Service Worker e Popup) sem bibliotecas externas pesadas.
 * NÃO contém credenciais privilegiadas (service_role ou webhook secret).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RobinAuth = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  const CONFIG = {
    SUPABASE_URL: "https://xezgrgblmjxsyluaqdjo.supabase.co",
    // Chave pública anônima (safe for client)
    ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhlemdyZ2JsbWp4c3lsdWFxZGpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4MTI0OTEsImV4cCI6MjEwODM4ODQ5MX0.feaYTflE1M7-PKrGFSuPFPxGqRhBaqtMopydQlgp7-Y",
    CHECKOUT_URL: "https://pay.cakto.com.br/qw6ns6o_1234667",
    STORAGE_KEYS: {
      SESSION_TOKEN: "robin_session_jwt",
      REFRESH_TOKEN: "_robin_rt",
      USER_INFO: "robin_user_info",
    }
  };

  /**
   * Helper para salvar tokens com isolamento
   * Access Token em chrome.storage.session (memória volátil) quando disponível
   * Refresh Token em chrome.storage.local para persistência entre reinicializações
   */
  async function storeTokens(sessionData) {
    if (!sessionData) return;

    const { access_token, refresh_token, expires_at, user } = sessionData;

    // 1. Armazena Access Token e Expiração em session storage (quando suportado)
    const sessionPayload = {
      accessToken: access_token,
      expiresAt: expires_at ? expires_at * 1000 : (Date.now() + 3600 * 1000),
      user: {
        id: user?.id,
        email: user?.email,
        emailConfirmedAt: user?.email_confirmed_at,
      }
    };

    if (chrome?.storage?.session) {
      await chrome.storage.session.set({ [CONFIG.STORAGE_KEYS.SESSION_TOKEN]: sessionPayload });
    } else {
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.SESSION_TOKEN]: sessionPayload });
    }

    // 2. Armazena Refresh Token restrito em chrome.storage.local
    if (refresh_token) {
      await chrome.storage.local.set({
        [CONFIG.STORAGE_KEYS.REFRESH_TOKEN]: refresh_token,
        [CONFIG.STORAGE_KEYS.USER_INFO]: sessionPayload.user,
      });
    }
  }

  async function clearStoredTokens() {
    if (chrome?.storage?.session) {
      await chrome.storage.session.remove([CONFIG.STORAGE_KEYS.SESSION_TOKEN]);
    }
    await chrome.storage.local.remove([
      CONFIG.STORAGE_KEYS.SESSION_TOKEN,
      CONFIG.STORAGE_KEYS.REFRESH_TOKEN,
      CONFIG.STORAGE_KEYS.USER_INFO,
      "authSession" // Limpa qualquer mock legada
    ]);
  }

  async function getStoredTokens() {
    let session = null;
    if (chrome?.storage?.session) {
      const res = await chrome.storage.session.get([CONFIG.STORAGE_KEYS.SESSION_TOKEN]);
      session = res[CONFIG.STORAGE_KEYS.SESSION_TOKEN] || null;
    }
    if (!session) {
      const res = await chrome.storage.local.get([CONFIG.STORAGE_KEYS.SESSION_TOKEN]);
      session = res[CONFIG.STORAGE_KEYS.SESSION_TOKEN] || null;
    }

    const localData = await chrome.storage.local.get([
      CONFIG.STORAGE_KEYS.REFRESH_TOKEN,
      CONFIG.STORAGE_KEYS.USER_INFO
    ]);

    return {
      session,
      refreshToken: localData[CONFIG.STORAGE_KEYS.REFRESH_TOKEN] || null,
      user: localData[CONFIG.STORAGE_KEYS.USER_INFO] || session?.user || null
    };
  }

  /**
   * Cadastro de nova conta com Supabase Auth
   */
  async function signUp(email, password) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanPass = String(password || "").trim();

    if (!cleanEmail || !cleanPass) {
      throw new Error("E-mail e senha são obrigatórios.");
    }

    if (cleanPass.length < 6) {
      throw new Error("A senha deve ter pelo menos 6 caracteres.");
    }

    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: {
        "apikey": CONFIG.ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: cleanEmail,
        password: cleanPass
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data.error_description || data.msg || data.message || "Erro ao criar conta.";
      throw new Error(msg);
    }

    // Se o Supabase exigir confirmação de e-mail (email_confirmed_at nulo)
    const isConfirmed = Boolean(data.user?.email_confirmed_at);

    return {
      ok: true,
      user: data.user,
      emailConfirmed: isConfirmed,
      requiresEmailConfirmation: !isConfirmed,
      message: isConfirmed
        ? "Conta criada com sucesso!"
        : "Conta criada! Enviamos um link de confirmação para seu e-mail. Confirme antes de fazer login."
    };
  }

  /**
   * Login com E-mail e Senha no Supabase Auth
   */
  async function signIn(email, password) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanPass = String(password || "").trim();

    if (!cleanEmail || !cleanPass) {
      throw new Error("Informe seu e-mail e senha.");
    }

    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "apikey": CONFIG.ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: cleanEmail,
        password: cleanPass
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errorMsg = data.error_description || data.msg || data.message || "E-mail ou senha incorretos.";
      throw new Error(errorMsg);
    }

    // Validação estrita de confirmação de e-mail
    if (!data.user?.email_confirmed_at) {
      // Desconecta se o e-mail não tiver sido confirmado
      throw new Error("E-mail não confirmado. Verifique sua caixa de entrada e confirme seu e-mail antes de acessar.");
    }

    await storeTokens(data);

    return {
      ok: true,
      user: data.user,
      accessToken: data.access_token,
      refreshToken: data.refresh_token
    };
  }

  /**
   * Renovação de Sessão via refresh_token
   */
  async function refreshSession(refreshToken) {
    if (!refreshToken) throw new Error("Sessão expirada. Faça login novamente.");

    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "apikey": CONFIG.ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        refresh_token: refreshToken
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      await clearStoredTokens();
      throw new Error("Não foi possível renovar sua sessão. Faça login novamente.");
    }

    await storeTokens(data);

    return {
      accessToken: data.access_token,
      user: data.user
    };
  }

  /**
   * Obtém token JWT válido garantido, executando refresh transparente se necessário
   */
  async function getValidToken() {
    const { session, refreshToken } = await getStoredTokens();

    if (!session && !refreshToken) {
      return null;
    }

    const now = Date.now();
    // Se o token ainda é válido com margem de segurança de 60 segundos
    if (session?.accessToken && session.expiresAt && (session.expiresAt - now > 60000)) {
      return session.accessToken;
    }

    // Token vencido ou próximo do vencimento -> tenta refresh
    if (refreshToken) {
      try {
        const refreshed = await refreshSession(refreshToken);
        return refreshed.accessToken;
      } catch (_) {
        return null;
      }
    }

    return null;
  }

  /**
   * Recuperação de Senha
   */
  async function resetPassword(email) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail) throw new Error("Informe o e-mail cadastrado para recuperar a senha.");

    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/recover`, {
      method: "POST",
      headers: {
        "apikey": CONFIG.ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: cleanEmail
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data.error_description || data.msg || data.message || "Erro ao solicitar redefinição de senha.";
      throw new Error(msg);
    }

    return {
      ok: true,
      message: "Instruções para redefinir sua senha foram enviadas para o seu e-mail."
    };
  }

  /**
   * Atualização de Senha após recuperação ou pelo usuário autenticado
   */
  async function updateUserPassword(newPassword) {
    const cleanPass = String(newPassword || "").trim();
    if (!cleanPass || cleanPass.length < 6) {
      throw new Error("A nova senha deve ter no mínimo 6 caracteres.");
    }

    const token = await getValidToken();
    if (!token) {
      throw new Error("Sessão não encontrada ou expirada. Use o link de recuperação para definir uma nova senha.");
    }

    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "apikey": CONFIG.ANON_KEY,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        password: cleanPass
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error_description || data.msg || data.message || "Erro ao atualizar senha.";
      throw new Error(msg);
    }

    return {
      ok: true,
      message: "Senha atualizada com sucesso!"
    };
  }

  /**
   * Verifica o código OTP de recuperação recebido por e-mail e define nova senha
   */
  async function verifyOtpAndResetPassword(email, otpCode, newPassword) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanToken = String(otpCode || "").trim();
    const cleanPass = String(newPassword || "").trim();

    if (!cleanEmail || !cleanToken) {
      throw new Error("E-mail e código OTP são obrigatórios.");
    }
    if (!cleanPass || cleanPass.length < 6) {
      throw new Error("A nova senha deve ter no mínimo 6 caracteres.");
    }

    // 1. Verifica o código OTP no Supabase Auth
    const verifyRes = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: {
        "apikey": CONFIG.ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "recovery",
        email: cleanEmail,
        token: cleanToken
      })
    });

    const verifyData = await verifyRes.json().catch(() => ({}));

    if (!verifyRes.ok) {
      const msg = verifyData.error_description || verifyData.msg || verifyData.message || "Código OTP inválido ou expirado.";
      throw new Error(msg);
    }

    const sessionJwt = verifyData.access_token;
    if (!sessionJwt) {
      throw new Error("Falha ao validar sessão de recuperação.");
    }

    // 2. Atualiza a senha usando o token da sessão de recuperação
    const updateRes = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "apikey": CONFIG.ANON_KEY,
        "Authorization": `Bearer ${sessionJwt}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        password: cleanPass
      })
    });

    const updateData = await updateRes.json().catch(() => ({}));

    if (!updateRes.ok) {
      const msg = updateData.error_description || updateData.msg || updateData.message || "Erro ao definir nova senha.";
      throw new Error(msg);
    }

    // 3. Limpa a sessão temporária para exigir login com a nova senha
    await clearStoredTokens();

    return {
      ok: true,
      message: "Senha redefinida com sucesso! Entre agora com sua nova senha."
    };
  }



  /**
   * Logout Efetivo
   */
  async function signOut() {
    try {
      const token = await getValidToken();
      if (token) {
        await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/logout`, {
          method: "POST",
          headers: {
            "apikey": CONFIG.ANON_KEY,
            "Authorization": `Bearer ${token}`
          }
        });
      }
    } catch (_) {}
    await clearStoredTokens();
    return { ok: true };
  }

  /**
   * VERIFICAÇÃO ZERO-TRUST DA LICENÇA
   * Consulta a Edge Function verify-license no backend.
   * NUNCA confia em valores locais do cliente.
   */
  async function verifyLicenseWithServer() {
    const token = await getValidToken();
    if (!token) {
      return {
        ok: false,
        authorized: false,
        code: "AUTH_REQUIRED",
        error: "Usuário não autenticado."
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/verify-license`, {
        method: "POST",
        headers: {
          "apikey": CONFIG.ANON_KEY,
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        signal: controller.signal
      });

      clearTimeout(timer);

      const data = await res.json().catch(() => ({}));

      if (!res.ok && res.status === 401) {
        return {
          ok: false,
          authorized: false,
          code: "INVALID_TOKEN",
          error: "Sessão expirada. Faça login novamente."
        };
      }

      return data;
    } catch (err) {
      return {
        ok: false,
        authorized: false,
        code: "NETWORK_ERROR",
        error: "Não foi possível validar sua licença com o servidor. Verifique sua conexão com a internet."
      };
    }
  }

  return {
    CONFIG,
    signUp,
    signIn,
    signOut,
    resetPassword,
    updateUserPassword,
    verifyOtpAndResetPassword,
    getValidToken,
    getStoredTokens,
    verifyLicenseWithServer,
  };
});


