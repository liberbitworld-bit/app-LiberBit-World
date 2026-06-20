-- ============================================================
-- LiberBit World — Treasury Snapshots
-- Versión: treasury-1
-- Fecha:   2026-06-20
-- ============================================================
--
-- Tabla donde el GitHub Action `treasury-sync` guarda
-- snapshots del balance + movimientos de la wallet de tesorería
-- Liberbitworld@coinos.io cada 15 min.
--
-- Por qué un worker externo: coinos exige NIP-98 (firma Nostr)
-- para /api/me y /api/payments. Lo intentamos firmar en Vercel
-- serverless pero @noble/* crashea el lambda con 502 silencioso
-- sin log. GitHub Actions Node sí carga @noble sin problemas.
--
-- La transparency (frontend) lee el snapshot MÁS RECIENTE de
-- aquí. La columna fetched_at va decreciendo (cogemos el primero
-- con ORDER BY fetched_at DESC LIMIT 1).
--
-- Mantenemos histórico para auditar la evolución del saldo a lo
-- largo del tiempo (futura gráfica). Borrado/retención no
-- implementado — se hará si la tabla crece demasiado.
--
-- Cómo ejecutar:
--   1. https://supabase.com/dashboard → tu proyecto wyrwoxizjlamxdiuxaxd
--   2. SQL Editor → New query
--   3. Pegar TODO este archivo
--   4. Run (Ctrl+Enter)
-- ============================================================

CREATE TABLE IF NOT EXISTS treasury_snapshots (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT        NOT NULL,
    balance       BIGINT      NOT NULL DEFAULT 0,    -- sats
    total_in      BIGINT      NOT NULL DEFAULT 0,    -- sats recibidos acumulados
    total_out     BIGINT      NOT NULL DEFAULT 0,    -- sats gastados acumulados
    tx_count      INTEGER     NOT NULL DEFAULT 0,
    movements     JSONB       NOT NULL DEFAULT '[]'::jsonb,
                  -- array de {id, ts, amount, memo, type, hash, confirmed}
                  -- cap a 500 movs por snapshot (el worker lo limita)
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_treasury_fetched_at
    ON treasury_snapshots (fetched_at DESC);

-- RLS: lectura pública (todo el mundo puede ver la tesorería —
-- es transparencia), escritura solo con service role (el worker).
ALTER TABLE treasury_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read treasury snapshots" ON treasury_snapshots;
CREATE POLICY "Public read treasury snapshots"
    ON treasury_snapshots
    FOR SELECT
    USING (true);

-- Diagnóstico
SELECT
    'treasury_snapshots' AS source,
    COUNT(*)             AS rows
FROM treasury_snapshots;
