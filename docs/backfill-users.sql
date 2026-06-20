-- ============================================================
-- LiberBit World — Backfill: registrar en `users` a todo pubkey con
-- méritos que aún no tenga fila.
-- Versión: autoreg-1
-- Fecha:   2026-06-17
-- ============================================================
--
-- Propósito: hasta el deploy autoreg-1, solo los usuarios que creaban
-- cuenta nueva via "Crear identidad" quedaban registrados en `users`.
-- Quien entraba con nsec/extensión/bunker existente quedaba fuera del
-- dashboard ("ID Registradas") aunque sí emitiera o recibiera méritos
-- (estos se registran aparte en lbwm_user_merits).
--
-- Este script cierra el gap: detecta todos los pubkeys de
-- lbwm_user_merits que no tienen fila en users y los registra como
-- Amigo. El name queda como el npub (placeholder); cuando el usuario
-- vuelva a entrar a la app, _ensureUserInSupabase actualizará el name
-- con el real desde su perfil Nostr (ver fix complementario en
-- nostr-bridge.js autoreg-2).
--
-- Idempotente: el LEFT JOIN + WHERE u.id IS NULL hace que sea seguro
-- re-ejecutar; solo inserta los que aún faltan.
--
-- Cómo ejecutar:
--   1. https://supabase.com/dashboard → tu proyecto wyrwoxizjlamxdiuxaxd
--   2. SQL Editor → New query
--   3. Pegar TODO este archivo (incluido el SELECT diagnóstico de abajo)
--   4. Run (Ctrl+Enter)
--   5. Verás un INSERT con N filas y un SELECT mostrando los totales
-- ============================================================

-- Paso 1: Diagnóstico previo
SELECT
    'lbwm_user_merits'   AS source,
    COUNT(*)             AS rows
FROM lbwm_user_merits
UNION ALL
SELECT
    'users (pre-backfill)',
    COUNT(*)
FROM users
UNION ALL
SELECT
    'missing (a insertar)',
    COUNT(*)
FROM lbwm_user_merits m
LEFT JOIN users u ON u.public_key = m.npub
WHERE u.id IS NULL
  AND m.npub IS NOT NULL
  AND m.npub != '';

-- Paso 2: Backfill — inserta una fila users por cada pubkey con méritos
-- que aún no esté registrado. Usa el npub como nombre placeholder; se
-- actualizará cuando el usuario entre.
-- NOTA: la columna users.id es de tipo `uuid` en este Supabase,
-- así que NO cast a text. gen_random_uuid() devuelve uuid nativo.
INSERT INTO users (id, public_key, name, citizenship_type, registration_date)
SELECT
    gen_random_uuid()                                       AS id,
    m.npub                                                  AS public_key,
    COALESCE(NULLIF(m.npub, ''), substring(m.pubkey, 1, 16)) AS name,
    'Amigo'                                                 AS citizenship_type,
    NOW()                                                   AS registration_date
FROM lbwm_user_merits m
LEFT JOIN users u ON u.public_key = m.npub
WHERE u.id IS NULL
  AND m.npub IS NOT NULL
  AND m.npub != '';

-- Paso 3: Diagnóstico final
SELECT
    'users (post-backfill)' AS source,
    COUNT(*)                AS rows
FROM users;
