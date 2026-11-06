// Supabase Edge Function: authorize-download
// Emite ticket criptográfico assinado com RSA-2048 para autorização de download no Robin Companion.
// A chave privada RSA fica armazenada com segurança nos Segredos do Supabase (RSA_PRIVATE_KEY).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import crypto from "node:crypto";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-robin-client",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const rsaPrivateKeyPem = Deno.env.get("RSA_PRIVATE_KEY") ?? "";

    if (!rsaPrivateKeyPem) {
      return new Response(
        JSON.stringify({ ok: false, error: "Chave RSA do backend não configurada nos segredos." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { userId, sessionToken, deviceId, videoCount } = await req.json();

    if (!userId || !sessionToken || !deviceId) {
      return new Response(
        JSON.stringify({ ok: false, error: "Parâmetros incompletos para autorização." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Validar usuário e sessão
    const { data: user, error: userErr } = await supabase
      .from("app_users")
      .select("id, status, role, expires_at, session_token")
      .eq("id", userId)
      .single();

    if (userErr || !user) {
      return new Response(
        JSON.stringify({ ok: false, code: "USER_NOT_FOUND", error: "Usuário não encontrado." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (user.session_token !== sessionToken) {
      return new Response(
        JSON.stringify({ ok: false, code: "INVALID_SESSION", error: "Sessão inválida ou expirada." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (user.status !== "active") {
      return new Response(
        JSON.stringify({ ok: false, code: "USER_INACTIVE", error: "Conta inativa." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (user.role !== "admin" && user.expires_at && new Date(user.expires_at).getTime() < Date.now()) {
      return new Response(
        JSON.stringify({ ok: false, code: "USER_EXPIRED", error: "Assinatura mensal expirada." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Validar vínculo de dispositivo (1 E-MAIL = 1 PC)
    const { data: dev, error: devErr } = await supabase
      .from("app_user_devices")
      .select("device_id, status")
      .eq("user_id", userId)
      .single();

    if (devErr || !dev || dev.device_id !== deviceId || dev.status !== "active") {
      return new Response(
        JSON.stringify({
          ok: false,
          code: "DEVICE_MISMATCH",
          error: "Este computador não está autorizado para esta conta. Cada assinatura permite apenas 1 PC."
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Gerar ticket assinado com RSA-2048 (SHA-256 / PKCS#1 v1.5)
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutos
    const count = parseInt(videoCount, 10) || 1;
    const payload = `${userId}:${deviceId}:${expiresAt}:${count}`;

    const signer = crypto.createSign("SHA256");
    signer.update(payload);
    signer.end();
    const signatureBase64 = signer.sign(rsaPrivateKeyPem, "base64");

    return new Response(
      JSON.stringify({
        ok: true,
        ticket: signatureBase64,
        expiresAt: expiresAt,
        userId: userId,
        deviceId: deviceId,
        sessionToken: sessionToken
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message || "Erro interno na autorização." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

