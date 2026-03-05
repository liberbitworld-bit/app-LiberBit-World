# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LiberBit World is a decentralized governance ecosystem built on Nostr protocol + Bitcoin Lightning Network. It's a **static Single-Page Application** (no build step, no bundler) deployed on **Vercel**. All persistence is via Nostr events signed cryptographically and stored on relay networks. The primary language is Spanish.

## Development

- **No build/test/lint commands** — this is a vanilla HTML/CSS/JS project with CDN dependencies (nostr-tools, Tailwind CSS, DaisyUI, Supabase client)
- **Local development:** serve `index.html` with any static file server (e.g., `npx serve .` or VS Code Live Server)
- **Deployment:** push to `main` branch; Vercel deploys automatically
- The `api/` directory contains Vercel serverless functions (LNURL proxy for Lightning payments)

## Architecture

### Script Load Order (critical — breaks if reordered)

```
nostr-store.js    → IndexedDB cache (no dependencies)
nostr-media.js    → Multi-provider image upload (no dependencies)
nostr.js          → Core: SimplePool, crypto, relay routing, NIPs (depends on nostr-tools CDN)
nostr-sync.js     → SyncEngine: cache-first + incremental sync (depends on store + nostr)
nostr-dm.js       → DM abstraction NIP-04/44 (depends on nostr core)
nostr-governance.js → Proposals + votes (depends on nostr core)
nostr-merits.js   → LBWM merit system (depends on nostr core)
nostr-bridge.js   → UI <-> Nostr bridge: login, feeds, lifecycle (depends on ALL above)
ui.js             → Navigation, sections, badges (depends on bridge)
profile.js        → Profile and citizenship (depends on bridge)
wallet.js         → Lightning wallet WebLN + Blink (depends on bridge)
verification.js   → Identity verification (depends on bridge)
```

### Two JS Layers

**Nostr modules** (`LBW_*`) use the revealing module pattern (IIFE returning public API), exposed on `window`:

- `LBW_Nostr` — core relay pool, event publish/subscribe, NIP crypto
- `LBW_Store` — IndexedDB with stores: events, profiles, cursors, replaceables, relayLists
- `LBW_SyncEngine` — cache-first hydration then incremental relay sync
- `LBW_NostrBridge` — orchestrates login/logout lifecycle, feature subscriptions
- `LBW_Governance` — proposals (kind 31000) and votes (kind 31001)
- `LBW_Merits` — LBWM merit tracking (kinds 31002-31005)
- `LBW_DM` — encrypted direct messages (NIP-04/44)

**UI scripts** are plain functions on `window` (no module wrapper): `auth.js`, `chat.js`, `posts.js`, `lightning.js`, `notifications.js`, `marketplace.js`, `merits.js`, `governance.js`. These handle DOM rendering and user interactions, calling into `LBW_*` modules for data.

### Relay Routing

Events route to different relays by `kind` for privacy:
- **Private relays only** (`wss://relay.liberbitworld.org`): DMs (kind 4), governance (31000-31006)
- **Private + public** (`relay.damus.io`, `nos.lol`, etc.): metadata (kind 0), chat (kind 1), marketplace (kind 30402)
- Privacy Strict Mode sends zero events to public relays

### Key Patterns

- **Cache-first:** IndexedDB hydrates UI instantly, then SyncEngine fetches only new events from relays
- **config.js** is actually a Supabase proxy client — rewrites `supabaseClient.from()` calls as POST requests to the Vercel API proxy so credentials never reach the browser
- **index.html** is a monolithic SPA (~2600+ lines) containing all HTML sections
- Custom Nostr event kinds 31000-31006 are LiberBit-specific (governance, merits, config)
- **auth.js** is very large (~300 lines of code + embedded base64 logo image); expect token-limit issues when reading it — use offset/limit
- **avatar-fix.js** is a monkey-patch loaded after `nostr-bridge.js` that injects avatar images into the UI

### Vercel Serverless Functions

- `api/lnurlp/callback.js` — LNURL-pay callback proxy to Alby
- `api/well-known/lnurlp/aportaciones.js` — LNURL-pay well-known endpoint
- `vercel.json` rewrites `/.well-known/lnurlp/aportaciones` to the serverless function
