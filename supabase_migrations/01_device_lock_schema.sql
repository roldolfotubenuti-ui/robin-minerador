-- ============================================================================
-- ROBIN MINERADOR — SISTEMA DE LICENÇA POR COMPUTADOR (1 E-MAIL = 1 PC)
-- Migração Transacional para Supabase / PostgreSQL (Zero-Downtime & Zero-Trust)
-- ============================================================================

-- Garante disponibilidade das extensões necessárias
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;

-- 1. TABELA DE DISPOSITIVOS VINCULADOS
CREATE TABLE IF NOT EXISTS public.app_user_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    public_key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active', -- 'active' ou 'blocked'
    device_name TEXT DEFAULT 'Windows PC',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_app_user_devices_user UNIQUE (user_id)
);

-- Índices para buscas ultrarrápidas
CREATE INDEX IF NOT EXISTS idx_app_user_devices_user ON public.app_user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_app_user_devices_device ON public.app_user_devices(device_id);

-- RLS (Row Level Security) - Arquitetura Zero-Trust
-- Bloqueia 100% do acesso direto de clientes via PostgREST na tabela.
-- Todo acesso é intermediado exclusivamente pelas RPCs SECURITY DEFINER.
ALTER TABLE public.app_user_devices ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'app_user_devices' AND policyname = 'deny_direct_client_access'
    ) THEN
        CREATE POLICY deny_direct_client_access ON public.app_user_devices
            FOR ALL USING (false);
    END IF;
END $$;

-- 1.1 TABELA DE DESAFIOS DE DISPOSITIVO (NONCES DE USO ÚNICO GERADOS PELO BACKEND)
CREATE TABLE IF NOT EXISTS public.app_device_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    server_nonce TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_device_challenges_nonce ON public.app_device_challenges(server_nonce);

ALTER TABLE public.app_device_challenges ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'app_device_challenges' AND policyname = 'deny_direct_client_challenges'
    ) THEN
        CREATE POLICY deny_direct_client_challenges ON public.app_device_challenges
            FOR ALL USING (false);
    END IF;
END $$;

-- Elimina quaisquer sobrecargas legadas de 2 parâmetros para impedir contorno do Device Lock
DROP FUNCTION IF EXISTS public.app_login(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.app_check_session(UUID, TEXT);
DROP FUNCTION IF EXISTS public.app_check_session(TEXT, TEXT);

-- 2. EMISSÃO DE DESAFIO CRIPTOGRÁFICO DE DISPOSITIVO PELO BACKEND (NONCE VINCULADO AO USUÁRIO E PC)
CREATE OR REPLACE FUNCTION public.app_create_device_challenge(
    p_email TEXT,
    p_device_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user RECORD;
    v_nonce TEXT;
    v_expires TIMESTAMPTZ;
    v_ts BIGINT;
    v_payload TEXT;
BEGIN
    SELECT * INTO v_user
    FROM public.app_users
    WHERE lower(email) = lower(trim(p_email));

    IF NOT FOUND OR v_user.status != 'active' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conta inválida ou inativa.');
    END IF;

    v_nonce := encode(gen_random_bytes(24), 'hex');
    v_expires := now() + interval '5 minutes';
    v_ts := extract(epoch from now())::BIGINT * 1000;
    v_payload := lower(trim(p_email)) || ':' || trim(p_device_id) || ':' || v_nonce || ':' || v_ts::TEXT;

    INSERT INTO public.app_device_challenges (user_id, device_id, server_nonce, expires_at)
    VALUES (v_user.id, trim(p_device_id), v_nonce, v_expires);

    RETURN jsonb_build_object(
        'ok', true,
        'serverNonce', v_nonce,
        'timestamp', v_ts,
        'payload', v_payload
    );
END;
$$;

REVOKE ALL ON FUNCTION public.app_create_device_challenge(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_create_device_challenge(TEXT, TEXT) TO anon, authenticated, service_role;

-- 3. ATUALIZAÇÃO DA FUNÇÃO RPC app_login
-- Regra Estrita: 1 CONTA = 1 E-MAIL = 1 PC (Aplica-se a TODOS os usuários, inclusive Administradores)
CREATE OR REPLACE FUNCTION public.app_login(
    p_email TEXT,
    p_password TEXT,
    p_device_id TEXT DEFAULT NULL,
    p_public_key TEXT DEFAULT NULL,
    p_signature TEXT DEFAULT NULL,
    p_client_nonce TEXT DEFAULT NULL,
    p_timestamp BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user RECORD;
    v_device RECORD;
    v_bound_device RECORD;
    v_new_token TEXT;
BEGIN
    -- 1. Busca usuário por e-mail com bloqueio de linha para consistência atômica
    SELECT * INTO v_user
    FROM public.app_users
    WHERE lower(email) = lower(trim(p_email))
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'E-mail ou senha incorretos.');
    END IF;

    -- 2. Valida hash de senha com crypt (preserva 100% dos hashes existentes)
    IF v_user.password_hash IS NULL OR v_user.password_hash != crypt(p_password, v_user.password_hash) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'E-mail ou senha incorretos.');
    END IF;

    -- 3. Verifica se a conta está ativa
    IF v_user.status != 'active' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'USER_INACTIVE', 'error', 'Sua conta está inativa ou bloqueada. Entre em contato com o suporte.');
    END IF;

    -- 4. Verifica validade da assinatura (exceto admin vitalício)
    IF v_user.role != 'admin' AND v_user.expires_at IS NOT NULL AND v_user.expires_at < now() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'USER_EXPIRED', 'error', 'Sua assinatura expirou. Renove seu plano para continuar minerando.');
    END IF;

    -- 5. REGRA OBRIGATÓRIA: 1 CONTA = 1 E-MAIL = 1 COMPUTADOR
    -- Aplica-se a usuários comuns E contas administrativas para impedir compartilhamento de acessos
    IF p_device_id IS NULL OR trim(p_device_id) = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'code', 'DEVICE_REQUIRED',
            'error', 'O Robin Companion precisa estar em execução no Windows para identificar este computador.'
        );
    END IF;

    -- Consulta dispositivo vinculado com bloqueio atômico
    SELECT * INTO v_device
    FROM public.app_user_devices
    WHERE user_id = v_user.id
    FOR UPDATE;

    IF FOUND THEN
        -- Se já possui dispositivo vinculado, verifica se é exatamente o mesmo computador
        IF v_device.device_id != p_device_id THEN
            RETURN jsonb_build_object(
                'ok', false,
                'code', 'DEVICE_MISMATCH',
                'error', 'Este e-mail já está vinculado a outro computador. Cada assinatura do Robin Minerador permite a utilização em apenas um PC. Entre em contato com o suporte caso precise de assistência.'
            );
        END IF;

        IF v_device.status != 'active' THEN
            RETURN jsonb_build_object(
                'ok', false,
                'code', 'DEVICE_BLOCKED',
                'error', 'O dispositivo vinculado a esta conta foi bloqueado pelo suporte.'
            );
        END IF;

        -- Atualiza timestamp de último acesso do computador
        UPDATE public.app_user_devices
        SET last_seen_at = now(),
            updated_at = now()
        WHERE user_id = v_user.id;
    ELSE
        -- PRIMEIRO LOGIN: Vinculação atômica do primeiro computador
        INSERT INTO public.app_user_devices (
            user_id,
            device_id,
            public_key,
            status,
            created_at,
            last_seen_at,
            updated_at
        )
        VALUES (
            v_user.id,
            p_device_id,
            coalesce(p_public_key, ''),
            'active',
            now(),
            now(),
            now()
        )
        ON CONFLICT (user_id) DO NOTHING;

        -- Se houve condição de corrida simultânea, confere se o vencedor gravado é este computador
        SELECT * INTO v_bound_device
        FROM public.app_user_devices
        WHERE user_id = v_user.id;

        IF v_bound_device.device_id != p_device_id THEN
            RETURN jsonb_build_object(
                'ok', false,
                'code', 'DEVICE_MISMATCH',
                'error', 'Este e-mail já está vinculado a outro computador. Cada assinatura do Robin Minerador permite a utilização em apenas um PC. Entre em contato com o suporte caso precise de assistência.'
            );
        END IF;
    END IF;

    -- 6. Geração de novo token de sessão criptográfico
    v_new_token := encode(gen_random_bytes(32), 'hex');

    UPDATE public.app_users
    SET session_token = v_new_token,
        updated_at = now()
    WHERE id = v_user.id;

    -- 7. Retorno com dados da sessão e dispositivo
    RETURN jsonb_build_object(
        'ok', true,
        'token', v_new_token,
        'user', jsonb_build_object(
            'id', v_user.id,
            'email', v_user.email,
            'role', v_user.role,
            'status', v_user.status,
            'expires_at', v_user.expires_at,
            'max_downloads_per_day', v_user.max_downloads_per_day,
            'max_scrapes_per_day', v_user.max_scrapes_per_day
        ),
        'deviceId', p_device_id
    );
END;
$$;

-- 3. ATUALIZAÇÃO DA FUNÇÃO RPC app_check_session
CREATE OR REPLACE FUNCTION public.app_check_session(
    p_user_id UUID,
    p_session_token TEXT,
    p_device_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user RECORD;
    v_device RECORD;
BEGIN
    SELECT * INTO v_user
    FROM public.app_users
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Usuário não encontrado.');
    END IF;

    IF v_user.session_token IS NULL OR v_user.session_token != p_session_token THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Sessão expirada ou iniciada em outro local.');
    END IF;

    IF v_user.status != 'active' THEN
        RETURN jsonb_build_object('valid', false, 'status', 'inactive', 'error', 'Conta inativada pelo administrador.');
    END IF;

    IF v_user.role != 'admin' AND v_user.expires_at IS NOT NULL AND v_user.expires_at < now() THEN
        RETURN jsonb_build_object('valid', false, 'status', 'expired', 'error', 'Assinatura expirada.');
    END IF;

    -- Validação obrigatória do dispositivo autorizado
    -- Impede contorno por versões antigas da extensão ou requisições manuais sem p_device_id
    IF p_device_id IS NULL OR trim(p_device_id) = '' THEN
        RETURN jsonb_build_object(
            'valid', false,
            'code', 'DEVICE_REQUIRED',
            'error', 'Identificação do computador não informada. O Robin Companion precisa estar em execução no Windows.'
        );
    END IF;

    SELECT * INTO v_device
    FROM public.app_user_devices
    WHERE user_id = v_user.id;

    IF FOUND THEN
        IF v_device.device_id != p_device_id THEN
            RETURN jsonb_build_object(
                'valid', false,
                'code', 'DEVICE_MISMATCH',
                'error', 'Este e-mail já está vinculado a outro computador. Cada assinatura do Robin Minerador permite a utilização em apenas um PC. Entre em contato com o suporte caso precise de assistência.'
            );
        END IF;

        IF v_device.status != 'active' THEN
            RETURN jsonb_build_object(
                'valid', false,
                'code', 'DEVICE_BLOCKED',
                'error', 'Computador bloqueado pelo suporte.'
            );
        END IF;

        -- Atualiza batimento cardíaco do dispositivo
        UPDATE public.app_user_devices
        SET last_seen_at = now()
        WHERE user_id = v_user.id;
    ELSE
        -- Migração transparente para contas existentes com sessão salva (apenas com device_id comprovado)
        INSERT INTO public.app_user_devices (user_id, device_id, status, created_at, last_seen_at)
        VALUES (v_user.id, p_device_id, 'active', now(), now())
        ON CONFLICT (user_id) DO NOTHING;
    END IF;

    RETURN jsonb_build_object(
        'valid', true,
        'user', jsonb_build_object(
            'id', v_user.id,
            'email', v_user.email,
            'role', v_user.role,
            'status', v_user.status,
            'expires_at', v_user.expires_at,
            'max_downloads_per_day', v_user.max_downloads_per_day,
            'max_scrapes_per_day', v_user.max_scrapes_per_day
        )
    );
END;
$$;

-- 4. AUTORIZAÇÃO CRIPTOGRÁFICA DE DOWNLOAD (TICKET HMAC-SHA256)
-- Emite ticket assinado exigido pelo Companion Windows para liberar downloads de mídia
CREATE OR REPLACE FUNCTION public.app_authorize_download(
    p_user_id UUID,
    p_session_token TEXT,
    p_device_id TEXT,
    p_video_count INT DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user RECORD;
    v_device RECORD;
    v_ticket_expires BIGINT;
    v_payload TEXT;
    v_signature TEXT;
    v_secret TEXT := 'robin_download_vault_hmac_secret_2026';
BEGIN
    SELECT * INTO v_user
    FROM public.app_users
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Usuário não encontrado.');
    END IF;

    IF v_user.session_token IS NULL OR v_user.session_token != p_session_token THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SESSION', 'error', 'Sessão inválida.');
    END IF;

    IF v_user.status != 'active' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'USER_INACTIVE', 'error', 'Conta inativa.');
    END IF;

    IF v_user.role != 'admin' AND v_user.expires_at IS NOT NULL AND v_user.expires_at < now() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'USER_EXPIRED', 'error', 'Assinatura expirada.');
    END IF;

    -- Valida se o dispositivo informado está vinculado e ativo para este usuário
    SELECT * INTO v_device
    FROM public.app_user_devices
    WHERE user_id = v_user.id;

    IF NOT FOUND OR v_device.device_id != p_device_id OR v_device.status != 'active' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_MISMATCH', 'error', 'Dispositivo não autorizado neste computador.');
    END IF;

    -- Ticket criptográfico válido por 10 minutos (600 segundos)
    v_ticket_expires := extract(epoch from (now() + interval '10 minutes'))::BIGINT;
    v_payload := v_user.id::TEXT || ':' || p_device_id || ':' || v_ticket_expires::TEXT || ':' || coalesce(p_video_count, 1)::TEXT;
    v_signature := encode(hmac(v_payload::bytea, v_secret::bytea, 'sha256'), 'hex');

    RETURN jsonb_build_object(
        'ok', true,
        'ticket', v_signature,
        'expiresAt', v_ticket_expires,
        'userId', v_user.id,
        'deviceId', p_device_id,
        'sessionToken', p_session_token
    );
END;
$$;

-- 5. PROCEDIMENTO ADMINISTRATIVO EXCLUSIVO: DESVINCULAR DISPOSITIVO DE USUÁRIO
CREATE OR REPLACE FUNCTION public.app_admin_reset_user_device(
    p_admin_id UUID,
    p_session_token TEXT,
    p_target_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_admin RECORD;
    v_target RECORD;
    v_deleted_device TEXT;
BEGIN
    SELECT * INTO v_admin
    FROM public.app_users
    WHERE id = p_admin_id AND session_token = p_session_token;

    IF NOT FOUND OR v_admin.role != 'admin' OR v_admin.status != 'active' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Acesso negado. Apenas administradores master ativos podem executar esta ação.');
    END IF;

    SELECT * INTO v_target
    FROM public.app_users
    WHERE id = p_target_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Usuário não encontrado.');
    END IF;

    DELETE FROM public.app_user_devices
    WHERE user_id = p_target_user_id
    RETURNING device_id INTO v_deleted_device;

    UPDATE public.app_users
    SET session_token = NULL,
        updated_at = now()
    WHERE id = p_target_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Dispositivo desvinculado com sucesso. O cliente poderá vincular seu novo computador no próximo login.',
        'userId', p_target_user_id,
        'previousDeviceId', v_deleted_device
    );
END;
$$;

-- 6. PROCEDIMENTO DE EMERGÊNCIA DO PROPRIETÁRIO DO SISTEMA (Via Supabase SQL Editor)
-- Permite que o proprietário do SaaS desvincule qualquer PC diretamente via painel SQL
CREATE OR REPLACE FUNCTION public.app_owner_reset_device(p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user RECORD;
    v_deleted_device TEXT;
BEGIN
    SELECT * INTO v_user
    FROM public.app_users
    WHERE lower(email) = lower(trim(p_email));

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Usuário não encontrado.');
    END IF;

    DELETE FROM public.app_user_devices
    WHERE user_id = v_user.id
    RETURNING device_id INTO v_deleted_device;

    UPDATE public.app_users
    SET session_token = NULL,
        updated_at = now()
    WHERE id = v_user.id;

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Dispositivo desvinculado com sucesso pelo proprietário. O usuário/admin poderá vincular um novo PC no próximo login.',
        'email', v_user.email,
        'previousDeviceId', v_deleted_device
    );
END;
$$;

-- 7. ATUALIZAÇÃO DA FUNÇÃO app_admin_list_users COM DADOS DO DISPOSITIVO VINCULADO
CREATE OR REPLACE FUNCTION public.app_admin_list_users(
    p_admin_id UUID,
    p_session_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_admin RECORD;
    v_users JSONB;
BEGIN
    SELECT * INTO v_admin
    FROM public.app_users
    WHERE id = p_admin_id AND session_token = p_session_token;

    IF NOT FOUND OR v_admin.role != 'admin' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Acesso negado.');
    END IF;

    SELECT jsonb_agg(
        jsonb_build_object(
            'id', u.id,
            'email', u.email,
            'role', u.role,
            'status', u.status,
            'expires_at', u.expires_at,
            'max_downloads_per_day', u.max_downloads_per_day,
            'max_scrapes_per_day', u.max_scrapes_per_day,
            'created_at', u.created_at,
            'bound_device_id', d.device_id,
            'bound_device_status', d.status,
            'bound_device_created_at', d.created_at,
            'bound_device_last_seen', d.last_seen_at
        ) ORDER BY u.created_at DESC
    ) INTO v_users
    FROM public.app_users u
    LEFT JOIN public.app_user_devices d ON d.user_id = u.id;

    RETURN jsonb_build_object(
        'ok', true,
        'users', coalesce(v_users, '[]'::jsonb)
    );
END;
$$;

-- 8. PERMISSÕES EXPLÍCITAS DE EXECUÇÃO DAS RPCS
REVOKE ALL ON FUNCTION public.app_login(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_login(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.app_check_session(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_check_session(UUID, TEXT, TEXT) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.app_authorize_download(UUID, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_authorize_download(UUID, TEXT, TEXT, INT) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.app_admin_reset_user_device(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_admin_reset_user_device(UUID, TEXT, UUID) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.app_admin_list_users(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_admin_list_users(UUID, TEXT) TO anon, authenticated, service_role;

-- A função app_owner_reset_device não recebe grant para anon/authenticated:
-- Ela só pode ser executada por superuser/service_role através do Supabase SQL Editor.
REVOKE ALL ON FUNCTION public.app_owner_reset_device(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_owner_reset_device(TEXT) TO postgres, service_role;
