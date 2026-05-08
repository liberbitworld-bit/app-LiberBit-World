# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LiberBit World is a decentralized governance ecosystem built on Nostr protocol + Bitcoin Lightning Network. It's a **static Single-Page Application** (no build step, no bundler) deployed on **Vercel**. All persistence is via Nostr events signed cryptographically and stored on relay networks. The primary language is Spanish.

## Development

- **No build/test/lint commands** — vanilla HTML/CSS/JS with CDN dependencies (nostr-tools, Tailwind CSS, DaisyUI, Supabase client, Leaflet, qrcodejs).
- **Local development:** serve `index.html` with any static file server (e.g., `npx serve .`). Note: in local the Supabase proxy at `/api/db` will return 404 — that's expected, the proxy only exists in the Vercel deployment.
- **Deployment:** push to `main` branch; Vercel deploys automatically.
- The `api/` directory contains Vercel serverless functions (LNURL proxy for Lightning payments).

### Cache busting

The service worker (`/sw.js`) uses cache-first for JS. **Every script change must bump its `?v=` query param in `index.html`** so the SW pulls the fresh version. When making large refactors, also bump `CACHE_NAME` in `/sw.js` so existing SWs invalidate everything on the next activate.

## Architecture

### Script Load Order (`index.html`)

The HTML loads ~37 scripts in two blocks. The order matters for some dependencies but most modules are exposed on `window` and only resolved at `DOMContentLoaded`. Critical pinned positions:

```
escape-utils.js     → first, defines LBW.escapeHtml/safeUrl used by all UI
lbw-passlock.js     → before auth.js: NIP-49 cifrado de la nsec con contraseña;
                      expone LBW_Passlock y window.LBW_persistKeys
config.js           → Supabase proxy client (NOT cache; rewrites .from() calls
                      to the Vercel /api/db proxy so credentials never reach
                      the browser). Also installs prod console.log silencer.
auth.js             → bech32 encoding, session persistence
ui.js, posts.js, marketplace.js, p2p-exchange.js,
notifications.js, chat.js, lightning.js, governance.js,
profile.js, nwc.js, wallet.js   → UI handlers (plain functions on window)

nostr-store.js      → IndexedDB cache (no deps)
nostr-media.js      → Multi-provider image upload (no deps)
chat-attachments.js → image attach helpers
nostr.js            → Core: SimplePool, crypto, relay routing, NIPs (depends on nostr-tools CDN)
nostr-dm.js         → DM abstraction NIP-04/44
nostr-sync.js       → SyncEngine: cache-first + incremental sync
nostr-governance.js → Proposals + votes
nostr-delegations.js, delegations-ui.js
nostr-merits.js     → LBWM merit system
merits.js
supabase-merits-sync.js, supabase-governance-sync.js
nostr-reviews.js    → NIP-85 reviews
nostr-marketplace-pay.js
nostr-stalls.js     → NIP-15 stalls
nostr-bridge.js     → UI <-> Nostr bridge: login, feeds, lifecycle
debate.js, avatar-fix.js, missions.js, map.js, city-prompt.js
```

### Two JS Layers

**LBW_\* modules** — IIFE returning public API, exposed on `window`:

- `LBW_Passlock` — NIP-49 cifrado de la nsec con contraseña; cache de contraseña en memoria; helpers para cifrar otros 32-byte secrets (NWC).
- `LBW_Nostr` — core relay pool, event publish/subscribe, NIP crypto.
- `LBW_Store` — IndexedDB with stores: events, profiles, cursors, replaceables, relayLists.
- `LBW_Sync` — cache-first hydration then incremental relay sync.
- `LBW_Media` — multi-provider image upload + fallback URLs.
- `LBW_DM` — encrypted direct messages (NIP-04/44).
- `LBW_Governance` — proposals (kind 31000) and votes (kind 31001).
- `LBW_Merits` — LBWM merit tracking (kinds 31002-31005); SEC-22 valida emisor.
- `LBW_Delegations` — voting delegation (NIP-26-style).
- `LBW_Reviews` — NIP-85 reviews.
- `LBW_MarketPay` — Lightning marketplace payment flow.
- `LBW_Stalls` — NIP-15 marketplace stalls/products.
- `LBW_NWC` — NIP-47 wallet connect (URI cifrado con NIP-49 vía LBW_Passlock).
- `LBW_NostrBridge` — orchestrates login/logout lifecycle, feature subscriptions, DM rendering with optimistic UI.
- `LBW_Debate`, `LBW_Missions`.

**UI scripts** are plain functions on `window` (no module wrapper): `auth.js`, `chat.js`, `posts.js`, `lightning.js`, `notifications.js`, `marketplace.js`, `merits.js`, `governance.js`. These handle DOM rendering and user interactions, calling into `LBW_*` modules for data.

### Key Identity & Crypto

- **NIP-07 (extension)**: most secure, nsec stays in Alby/nos2x.
- **NIP-49 (passlock)**: nsec cifrada en `localStorage.lbw_ncryptsec` con scrypt+XChaCha20-Poly1305 bajo una contraseña del usuario. La nsec descifrada solo vive en memoria. `LBW_Passlock.unlockWithPasswordPrompt` la abre al cargar la app. La contraseña queda cacheada en `_cachedPassword` (closure) durante la sesión para reusar con NWC.
- **Migración legacy**: si la app detecta una nsec en claro guardada por una versión anterior, dispara modal obligatorio `migrate-backup` (muestra la nsec con copy + obliga a confirmar haberla guardado) antes de cifrarla. Ver `js/lbw-passlock.js`.
- **NIP-46 (bunker remoto)**: pendiente de implementación, ver memoria del proyecto.

### Relay Routing

Eventos se enrutan según `kind` para privacidad — implementado en `nostr.js:_getRelaysForKind`:

| Kinds | Routing |
|-------|---------|
| **PRIVATE_KINDS**: DMs (4), governance (31000-31006) | **Solo private relays** (`wss://relay.liberbitworld.org`). [SEC-A7] sin fallback público — si los privados están caídos, error explícito. Ver `docs/security.md`. |
| **PUBLIC_KINDS**: metadata (0), chat (1), reactions (7), marketplace (30402), reviews (1985), stalls (30017/30018), relay-list (10002) | Private + public (`relay.damus.io`, `nos.lol`, `purplepag.es`). |
| **Privacy Strict mode** (`LBW_Nostr.setPrivacyStrict(true)`) | Cero eventos a públicos. Toggle en perfil. |

### Key Patterns

- **Cache-first sync**: IndexedDB hydrates UI instantly via `LBW_Sync.syncedSubscribe`, then SyncEngine fetches only new events (since=cursor) from relays.
- **Custom Nostr kinds 31000-31006**: LiberBit-specific (proposals, votes, merits, contributions, delegations, snapshots, config). 31010-31012 para results/execution.
- **`config.js` is a Supabase proxy** — rewrites `supabaseClient.from(...)` calls as POST requests to `https://liberbit-api.vercel.app/api/db` so credentials never reach the browser. Tiene timeout de 5s y silencia `console.log` en producción (reactivable con `localStorage.lbw_debug=1` o `?debug=1`).
- **`index.html` is a monolithic SPA** (~3700 lines) with all sections inline. Scripts inline al final cablan eventos y handlers iniciales.
- **`auth.js`** has a base64-encoded logo in the file (~108KB total in 314 lines of code). Read with offset/limit to avoid token issues.
- **`avatar-fix.js`** is a monkey-patch loaded after `nostr-bridge.js` that injects avatar images into chat messages.

### Vercel Serverless Functions

- `api/lnurlp/callback.js` — LNURL-pay callback proxy to coinos.io.
- `api/lnurlp/resolve.js` — SSRF-locked LNURLP resolver for marketplace payments.
- `api/well-known/lnurlp/aportaciones.js` — LNURL-pay well-known endpoint.
- `vercel.json` rewrites + headers: CSP report-only, X-Frame-Options DENY, etc.

### CI/CD note

- The repo evolved historically with "Add files via upload" zip uploads via the GitHub UI. PRs with proper history (commits + squash merges) are the modern flow since 2026-05.
- Vercel auto-deploys `main` and creates preview URLs per PR. Preview URLs are protected by Vercel Deployment Protection — pasar `?x-vercel-protection-bypass=<token>&x-vercel-set-bypass-cookie=true` para acceso externo (token en Settings → Deployment Protection).

## Security audit reference

`docs/security.md` documenta el modelo de amenazas. Auditoría 2026-05-07 cerró 1 Critical y 8 High; los Mediums se atacan en PRs incrementales etiquetados `M-N`.
