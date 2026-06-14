-- ============================================================
-- LiberBit World — Migración: añadir columnas profession a users
-- Versión: profession-1
-- Fecha:   2026-06
-- ============================================================
--
-- ⚠️ REQUERIDO antes de desplegar `profession-1` en producción.
-- Sin esta migración, la sección "Editar Ciudadanía" del perfil
-- mostrará "Error al actualizar perfil" porque el upsert intentará
-- escribir columnas que no existen.
--
-- Cómo ejecutar:
--   1. Abre el dashboard Supabase del proyecto: https://wyrwoxizjlamxdiuxaxd.supabase.co
--   2. SQL Editor → New query
--   3. Pega este bloque completo
--   4. Run (Ctrl+Enter)
--
-- Comportamiento:
--   - ADD COLUMN IF NOT EXISTS → idempotente, seguro re-ejecutar.
--   - Las filas existentes quedan con NULL en ambas columnas (interpretado
--     como "sin profesión" por la app).
--   - profession es un code de la taxonomía LBW_Professions (ver
--     js/lbw-professions.js); profession_specialty es texto libre.
--
-- Rollback (si hace falta revertir):
--   ALTER TABLE users DROP COLUMN IF EXISTS profession;
--   ALTER TABLE users DROP COLUMN IF EXISTS profession_specialty;
-- ============================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS profession           TEXT,
    ADD COLUMN IF NOT EXISTS profession_specialty TEXT;

-- Índice opcional sobre profession para acelerar los filtros del mapa
-- (loadCitizensByCity hace SELECT city, profession y agrupa client-side;
-- el índice ayuda cuando el censo crezca).
CREATE INDEX IF NOT EXISTS users_profession_idx ON users (profession);
