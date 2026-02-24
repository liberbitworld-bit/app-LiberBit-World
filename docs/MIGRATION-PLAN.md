# LiberBit World — Plan de Migración Nostr + Documentación GitHub

**Fecha:** 24 febrero 2026
**Versión:** 1.0
**Autor:** Auditoría técnica completa del repositorio `app-LiberBit-World`

---

## 1. AUDITORÍA: ESTADO ACTUAL

### 1.1 Arquitectura de Archivos

```
index.html (2,631 líneas) — SPA completa
├── CDN: Supabase JS v2, nostr-tools v2.7.2, Tailwind/DaisyUI
├── CSS: main.css (84K), landing.css (18K)
│
├── JS Legacy (Supabase):          JS Nostr (migrados):
│   ├── config.js (249)  ←proxy    ├── nostr.js (1,261) ✅
│   ├── auth.js (427)              ├── nostr-bridge.js (825) ✅
│   ├── ui.js (275)                ├── nostr-store.js (647) ✅
│   ├── posts.js (372)             ├── nostr-sync.js (390) ✅
│   ├── chat.js (476)              ├── nostr-media.js (305) ✅
│   ├── marketplace.js (398)       └── nostr-dm.js (151) ✅
│   ├── governance.js (473)
│   ├── merits.js (510)
│   ├── notifications.js (257)
│   ├── profile.js (608)
│   ├── lightning.js (271)
│   ├── wallet.js (337)
│   └── verification.js (442)
│
└── Backend: Vercel API proxy → Supabase
```

### 1.2 Mapa de Dependencias Supabase

**8 tablas** usadas vía proxy Vercel (`liberbit-api.vercel.app/api/db`):

| Tabla | Archivos que la usan | Operaciones | Nostr Kind equivalente |
|-------|---------------------|-------------|----------------------|
| `users` | auth, config, ui, posts, chat, merits, marketplace, profile, verification | CRUD completo | **kind 0** (metadata) |
| `posts` | posts, ui, merits, chat | insert, select, likes | **kind 1** (text note) ✅ migrado |
| `post_likes` | posts | insert, delete, select | **kind 7** (reaction) ✅ migrado |
| `direct_messages` | chat, lightning, notifications | insert, select | **kind 4** (DM) ✅ migrado |
| `offers` | marketplace, auth, ui, merits | CRUD completo | **kind 30402** (NIP-99) ✅ migrado |
| `proposals` | governance, notifications | insert, select, update | **kind 31000** (LBW custom) estructura ✅ |
| `votes` | governance | insert, select | **kind 31001** (LBW custom) estructura ✅ |
| `verification_requests` | verification | insert, update | **kind 31006** (LBW config) 🔲 pendiente |

**58 llamadas `supabaseClient`** distribuidas en 11 archivos.

### 1.3 Lo que YA funciona vía Nostr

| Feature | Módulo | NIPs | Estado |
|---------|--------|------|--------|
| Identidad (keypair) | nostr.js | NIP-01, NIP-19 | ✅ Completo |
| Login extensión | nostr.js | NIP-07 | ✅ Completo |
| Login nsec | nostr.js + bridge | NIP-19 | ✅ Completo |
| Relay management | nostr.js | NIP-65 | ✅ Completo |
| Privacy Strict mode | nostr.js + bridge | NIP-65 | ✅ Completo |
| Community chat | nostr.js + sync + bridge | NIP-01 (kind 1) | ✅ Completo |
| DMs cifrados | nostr.js + dm + bridge | NIP-04 + NIP-44 | ✅ Completo |
| Marketplace | nostr.js + sync + bridge | NIP-99 (kind 30402) | ✅ Completo |
| Media upload | nostr-media.js | NIP-94 (SHA-256) | ✅ Completo |
| Reactions | nostr.js | NIP-25 (kind 7) | ✅ Estructura |
| IndexedDB cache | nostr-store.js | — | ✅ Completo |
| Incremental sync | nostr-sync.js | — | ✅ Completo |
| Profile metadata | nostr.js | NIP-01 (kind 0) | ✅ Parcial |

### 1.4 Lo que TODAVÍA depende de Supabase

| Feature | Archivo(s) | Calls | Complejidad |
|---------|-----------|-------|-------------|
| **Auth/registro** | auth.js | 8 | 🟡 Media — crear identidad ya funciona en Nostr, pero auth.js sigue escribiendo en `users` |
| **Perfil completo** | profile.js | 7 | 🟡 Media — kind 0 ya cubre metadata, falta ciudadanía/avatar |
| **Gobernanza** | governance.js | 6 | 🔴 Alta — kinds 31000-31001 definidos pero UI no conectada |
| **Méritos LBWM** | merits.js | 6 | 🔴 Alta — kinds 31002-31003 definidos, sin implementación |
| **Posts/feed** | posts.js | 7 | 🟢 Baja — ya migrado via bridge, posts.js es legacy |
| **Chat privado** | chat.js | 6 | 🟢 Baja — ya migrado via bridge/dm, chat.js es legacy |
| **Marketplace** | marketplace.js | 5 | 🟢 Baja — ya migrado via bridge, marketplace.js es legacy |
| **Verificación** | verification.js | 5 | 🟡 Media — requiere diseño de kind custom |
| **Notificaciones** | notifications.js | 2 | 🟡 Media — derivable de subscriptions |
| **Lightning chat** | lightning.js | 3 | 🟢 Baja — duplica chat.js, eliminar |
| **UI/badges** | ui.js | 3 | 🟢 Baja — reapuntar a Nostr counts |
| **Config/counters** | config.js | 2 | 🟢 Baja — counters derivables de suscripciones |

---

## 2. PLAN DE MIGRACIÓN: 4 FASES

### Fase 1: LIMPIEZA — Eliminar código duplicado (1-2 días)

El repo tiene **código dual**: los archivos legacy (chat.js, posts.js, marketplace.js) hacen lo mismo que el bridge Nostr. Esto causa confusión y bugs.

**Acciones:**

1. **Eliminar `lightning.js`** — Duplica la funcionalidad de chat.js + wallet.js. Las 3 funciones útiles (copyLnAddress, selectSatsAmount, generateLnQR) mover a wallet.js.

2. **Neutralizar `posts.js`** — Las funciones `publishPost()` y `loadPosts()` ya las maneja `LBW_NostrBridge.publishCommunityPost()` y `startCommunityChat()`. Mantener solo funciones de UI puras (escapeHtml, timeAgo, showNotification).

3. **Neutralizar `chat.js`** — Los DMs los maneja `LBW_NostrBridge + LBW_DM`. Mantener solo `switchChatTab()`, `updateChatTabBadge()` y funciones de UI de sidebar.

4. **Neutralizar `marketplace.js`** — Las ofertas las maneja bridge. Mantener solo UI helpers (previewOfferImage, getCategoryEmoji, displayOffers template).

5. **Unificar `auth.js`** — Actualmente escribe en Supabase `users` al crear cuenta. Redirigir a:
   - `LBW_Nostr.createIdentity()` para keypair
   - `LBW_Nostr.updateProfile()` para kind 0
   - Eliminar escritura a tabla `users`

**Resultado:** Supabase calls pasan de 58 → ~25 (solo governance, merits, profile, verification).

### Fase 2: GOVERNANCE en Nostr (3-5 días)

La estructura ya existe en nostr.js (kinds 31000-31001). Falta conectar governance.js al bridge.

**Diseño de eventos:**

```
Kind 31000 — LBW_PROPOSAL (parameterized replaceable)
Tags:
  ['d', 'proposal-{timestamp}']     → d-tag único
  ['title', 'Título de propuesta']
  ['category', 'referendum|budget|election|amendment']
  ['status', 'active|closed|executed']
  ['expires', '{unix_timestamp}']
  ['t', 'lbw-governance']
  ['t', 'lbw-proposal']
  ['client', 'LiberBit World']
Content: JSON { description, options: ['A favor','En contra','Abstención'] }
Relays: SOLO privados (LiberBit infrastructure)
```

```
Kind 31001 — LBW_VOTE
Tags:
  ['e', '{proposal_event_id}']      → referencia a propuesta
  ['t', 'lbw-governance']
  ['t', 'lbw-vote']
  ['client', 'LiberBit World']
Content: "A favor" | "En contra" | "Abstención"
Relays: SOLO privados
```

**Acciones:**

1. **Crear `nostr-governance.js`** — Módulo dedicado (patrón LBW_DM):
   - `publishProposal(data)` → kind 31000
   - `publishVote(proposalId, option)` → kind 31001
   - `subscribeProposals(onProposal)` → filter kind 31000 + tag lbw-governance
   - `subscribeVotes(proposalId, onVote)` → filter kind 31001 + e-tag
   - `getProposalResults(proposalId)` → aggregate votes

2. **Añadir a nostr-sync.js** — `syncGovernance()` con cache + cursor, similar a `syncCommunityChat()`.

3. **Actualizar nostr-bridge.js** — Añadir handlers:
   - `startGovernance()` / `stopGovernance()`
   - `submitProposal()` → llama nostr-governance
   - `castVote()` → llama nostr-governance
   - `loadProposalDetail()` → subscribe votos

4. **Reescribir governance.js** — Eliminar todas las llamadas a `supabaseClient.from('proposals')` y `from('votes')`, reemplazar con calls al bridge.

5. **Anti-doble-voto** — Verificar via filtro `authors: [pubkey]` + `#e: [proposalId]` antes de publicar voto.

**Resultado:** Tablas `proposals` y `votes` eliminadas de Supabase.

### Fase 3: MERITS LBWM en Nostr (5-7 días)

El sistema más complejo. Kinds 31002-31003 definidos pero sin implementar.

**Diseño de eventos:**

```
Kind 31002 — LBW_MERIT (merit record)
Tags:
  ['d', 'merit-{pubkey_short}-{timestamp}']
  ['p', '{beneficiary_pubkey}']
  ['amount', '{merit_points}']
  ['category', 'participation|professional|governance|infrastructure|community']
  ['reason', 'Descripción breve']
  ['t', 'lbw-merits']
  ['client', 'LiberBit World']
Content: JSON { details, factor, breakdown }
Relays: SOLO privados
```

```
Kind 31003 — LBW_CONTRIB (contribution record)
Tags:
  ['d', 'contrib-{pubkey_short}-{timestamp}']
  ['p', '{contributor_pubkey}']
  ['amount', '{sats_or_value}']
  ['type', 'financial|professional|infrastructure']
  ['funded', 'true|false']
  ['factor', '{1.0-2.0}']
  ['t', 'lbw-contrib']
  ['client', 'LiberBit World']
Content: JSON { description, evidence_urls }
Relays: SOLO privados
```

```
Kind 31005 — LBW_SNAPSHOT (periodic merit snapshot)
Tags:
  ['d', 'snapshot-{timestamp}']
  ['t', 'lbw-merits']
Content: JSON { leaderboard: [{pubkey, total, breakdown}], timestamp }
Relays: SOLO privados
Publicado por: Governor nodes (firmas verificables)
```

**Acciones:**

1. **Crear `nostr-merits.js`** — Módulo dedicado:
   - `submitContribution(data)` → kind 31003
   - `awardMerit(pubkey, amount, category, reason)` → kind 31002
   - `subscribeMerits(onMerit)` → track de méritos
   - `calculateUserMerits(pubkey)` → aggregate desde eventos
   - `getLeaderboard()` → aggregate o último snapshot
   - `publishSnapshot(data)` → kind 31005 (solo governors)

2. **Cálculo de méritos** — Linear (no logarítmico), derivado de:
   - Contributions (kind 31003): factor × amount
   - Governance participation (count de kind 31001)
   - Community activity (count de kind 1 con tags lbw)
   - Infrastructure (kind 31003 type=infrastructure)

3. **Anti-plutocracy** — Structural protections:
   - Voting power = 3 bloques (Governors 51% floor, Citizenship, Community)
   - Minimum Ciudadano Senior (1000+ merits) para roles de liderazgo
   - Merit caps per category per period

4. **Reescribir merits.js** — Eliminar Supabase, conectar a nostr-merits.

**Resultado:** Tabla `users` pierde campos de merit tracking. Cálculos on-chain verificables.

### Fase 4: PROFILE + VERIFICATION + CLEANUP (3-5 días)

**4a. Profile completo en kind 0:**

El NIP-01 kind 0 ya soporta campos custom. Extender metadata:

```json
{
  "name": "Nombre",
  "display_name": "Display Name",
  "about": "Bio",
  "picture": "url_avatar",
  "banner": "url_banner",
  "lud16": "lightning@address.com",
  "nip05": "user@liberbit.world",
  "website": "https://...",
  
  "lbw_citizenship": "E-Residency|Ciudadano|Ciudadano Senior|Governor",
  "lbw_city": "Ciudad elegida",
  "lbw_joined": "2025-01-15T00:00:00Z",
  "lbw_verification": "none|invitation|video|stake",
  "lbw_merit_total": 1500
}
```

**Acciones profile.js:**
- `loadUserProfile()` → `LBW_Nostr.fetchUserProfile(pubkey)` + cache via LBW_Sync
- `saveCitizenship()` → `LBW_Nostr.updateProfile({lbw_citizenship, lbw_city})`
- `handleAvatarUpload()` → `LBW_Media.uploadImage()` + `updateProfile({picture: url})`
- Eliminar 7 calls a `supabaseClient.from('users')`

**4b. Verification en kind 31006:**

```
Kind 31006 — LBW_CONFIG (verification/config records)
Tags:
  ['d', 'verification-{pubkey_short}']
  ['p', '{user_pubkey}']
  ['type', 'invitation|video|stake']
  ['level', 'invited|real_identity']
  ['verified_by', '{verifier_pubkey}']
  ['t', 'lbw-verification']
Content: JSON { method_details, timestamp }
Relays: SOLO privados
```

**4c. Notificaciones derivadas:**

Eliminar polling a Supabase. Las notificaciones se derivan de:
- DMs entrantes → ya via `subscribeDirectMessages`
- Propuestas nuevas → via `subscribeProposals`
- Méritos recibidos → via `subscribeMerits` filtrando `#p: [myPubkey]`
- Votos en mis propuestas → via `subscribeVotes`

**4d. Eliminar proxy Vercel:**

Cuando las 4 fases estén completas:
- Eliminar `config.js` (SupabaseProxyQuery)
- Eliminar CDN Supabase JS del HTML
- Desactivar `liberbit-api.vercel.app`
- **0 dependencias de Supabase** — Full Nostr

---

## 3. ORDEN DE ARCHIVOS FINAL (Post-migración)

```
js/
├── nostr-store.js      → IndexedDB (cache local)
├── nostr-media.js      → Upload multi-provider
├── nostr.js            → Core Nostr (relay pool, events, crypto)
├── nostr-sync.js       → SyncEngine (cache-first + incremental)
├── nostr-dm.js         → DM abstraction (NIP-04/44 → futuro NIP-17)
├── nostr-governance.js → 🆕 Governance (proposals + votes)
├── nostr-merits.js     → 🆕 LBWM merit system
├── nostr-bridge.js     → Bridge: UI ↔ Nostr (login, feeds, lifecycle)
│
├── ui.js               → Navegación, secciones, badges (sin Supabase)
├── profile.js          → Profile display (conectado a kind 0)
├── wallet.js           → Lightning wallet (WebLN + Blink, sin cambios)
└── verification.js     → Verification display (conectado a kind 31006)
```

**Archivos eliminados:** config.js, auth.js, posts.js, chat.js, marketplace.js, lightning.js, notifications.js

**Load order en HTML:**
```html
<script src="js/nostr-store.js"></script>
<script src="js/nostr-media.js"></script>
<script src="js/nostr.js"></script>
<script src="js/nostr-sync.js"></script>
<script src="js/nostr-dm.js"></script>
<script src="js/nostr-governance.js"></script>
<script src="js/nostr-merits.js"></script>
<script src="js/nostr-bridge.js"></script>
<script src="js/ui.js"></script>
<script src="js/profile.js"></script>
<script src="js/wallet.js"></script>
<script src="js/verification.js"></script>
```

---

## 4. DOCUMENTACIÓN GITHUB — Estructura

### 4.1 README.md (raíz del repo)

```
# LiberBit World 🌐

> Ecosistema de gobernanza descentralizada sobre protocolo Nostr + Bitcoin Lightning

## ¿Qué es LiberBit World?

Red de comunidades soberanas con gobernanza transparente, identidad
descentralizada y economía basada en méritos (LBWM).

**Principio fundamental:** *LiberBit World propone, nunca impone.*

## Stack Tecnológico

- **Identidad:** Nostr keypairs (NIP-01, NIP-19)
- **Comunicación:** Nostr relays (NIP-01, NIP-04, NIP-44, NIP-65)
- **Marketplace:** NIP-99 (classified listings)
- **Méritos:** LBWM tokens (Taproot Assets on Bitcoin)
- **Pagos:** Lightning Network (WebLN + Blink)
- **Storage:** IndexedDB local + relay persistence
- **UI:** Tailwind CSS + DaisyUI

## NIPs Implementados

| NIP | Uso |
|-----|-----|
| NIP-01 | Eventos base, metadata (kind 0), notas (kind 1) |
| NIP-04 | DMs cifrados (fallback) |
| NIP-07 | Login con extensión (Alby, nos2x) |
| NIP-09 | Eliminación de eventos (kind 5) |
| NIP-19 | Encoding bech32 (npub, nsec) |
| NIP-25 | Reactions (kind 7) |
| NIP-44 | DMs cifrados (preferido) |
| NIP-65 | Relay list metadata (kind 10002) |
| NIP-94 | File metadata (SHA-256 integrity) |
| NIP-99 | Classified listings (kind 30402) |

## Kinds Custom LiberBit

| Kind | Uso | Relays |
|------|-----|--------|
| 31000 | Propuestas de gobernanza | Privados |
| 31001 | Votos | Privados |
| 31002 | Registros de méritos LBWM | Privados |
| 31003 | Contribuciones | Privados |
| 31004 | Delegaciones de voto | Privados |
| 31005 | Snapshots de méritos | Privados |
| 31006 | Configuración/verificación | Privados |

## Arquitectura

[diagrama de módulos — ver docs/architecture.md]

## Inicio Rápido

1. Abre https://app.liberbit.world
2. Crea identidad Nostr o conecta extensión (NIP-07)
3. Tu clave privada NUNCA sale de tu dispositivo
4. Explora: Chat, Marketplace, Gobernanza, Méritos

## Estructura del Proyecto

[árbol de archivos]

## Documentación

- [Arquitectura técnica](docs/architecture.md)
- [Sistema LBWM](docs/lbwm-system.md)
- [Gobernanza](docs/governance.md)
- [Niveles de ciudadanía](docs/citizenship.md)
- [Guía de relays](docs/relay-guide.md)
- [Seguridad y privacidad](docs/security.md)

## Licencia

[licencia elegida]
```

### 4.2 docs/architecture.md

Contenido:
- Diagrama de módulos JS con dependencias
- Flujo de datos: UI → Bridge → Nostr → Relays → IndexedDB
- Relay routing por event kind (privado vs público)
- Load order y dependencias entre módulos
- Cache-first pattern (SyncEngine)
- Privacy Strict mode

### 4.3 docs/lbwm-system.md

Contenido:
- Filosofía: reconocimiento justo de valor, anti-plutocracy
- Cálculo lineal (no logarítmico) — decisión y razones
- Categorías: participation, professional, governance, infrastructure, community
- Factor system para contribuciones financiadas
- Merit caps por categoría/periodo
- Taproot Assets architecture
- Event kinds: 31002 (merit), 31003 (contribution), 31005 (snapshot)
- Ciudadano Senior requirement (1000+ merits)

### 4.4 docs/governance.md

Contenido:
- Sistema de 3 bloques: Governors (51% floor), Citizenship, Community
- Tipos de propuesta: referendum, budget, election, amendment
- Ciclo de vida: draft → active → voting → closed → executed
- Anti-doble-voto (verificación cryptográfica)
- Event kinds: 31000 (proposal), 31001 (vote), 31004 (delegation)
- Quorum requirements
- "Propone, nunca impone" — decisiones locales

### 4.5 docs/citizenship.md

Contenido:
- Niveles: E-Residency → Ciudadano → Ciudadano Senior → Governor
- Requisitos de méritos por nivel
- Sistema de verificación: invitación, video, stake
- Derechos y responsabilidades por nivel
- LiberAtlas: ciudades y comunidades

### 4.6 docs/relay-guide.md

Contenido:
- Relays privados LiberBit (wss://relay.liberbit.world, relay2, relay3)
- Relays públicos (damus, nos.lol) — para discoverability
- NIP-65 user relay sovereignty
- Privacy Strict mode (sin relays públicos)
- Cómo añadir tu propio relay
- Shared relay computation para DMs

### 4.7 docs/security.md

Contenido:
- Clave privada: nunca sale del dispositivo
- NIP-44 vs NIP-04 encryption
- Rate limiting per relay + per pubkey
- Timestamp clamping (anti cursor-bricking)
- Event validation: validateEvent + verifyEvent
- Content size limits (64KB)
- SHA-256 media integrity
- Relay URL validation (anti-XSS)
- SessionStorage para nsec (tab-scoped, no localStorage)

---

## 5. CRONOGRAMA ESTIMADO

| Fase | Trabajo | Duración | Supabase calls eliminadas |
|------|---------|----------|--------------------------|
| **1. Limpieza** | Eliminar duplicados, unificar auth | 1-2 días | 58 → ~25 |
| **2. Governance** | nostr-governance.js + bridge + UI | 3-5 días | ~25 → ~15 |
| **3. Merits** | nostr-merits.js + cálculos + UI | 5-7 días | ~15 → ~5 |
| **4. Profile+Verif** | Kind 0 completo + verification + cleanup | 3-5 días | ~5 → **0** |
| **Docs** | README + 6 docs (en paralelo) | 3-4 días | — |

**Total estimado:** 12-19 días de desarrollo para **full Nostr, 0 Supabase**.

---

## 6. DECISIONES DE DISEÑO CLAVE

### 6.1 ¿Por qué kinds 31000-31006 y no kinds más bajos?

Los rangos 30000-39999 son **parameterized replaceable events** (NIP-33). Esto significa:
- Se pueden actualizar (mismo d-tag = reemplaza el anterior)
- Son buscables por d-tag
- Son estándar Nostr (cualquier relay los almacena)
- El rango 31000+ es "application-specific" — no colisiona con NIPs estándar

### 6.2 ¿Por qué relays privados para governance/merits?

- Governance y méritos son datos internos del ecosistema
- Publicar propuestas en relays públicos expone estrategia comunitaria
- Los votos en relays públicos serían manipulables por observadores
- Privacy by design: datos sensibles SOLO en infraestructura controlada
- Los usuarios pueden añadir sus propios relays vía NIP-65

### 6.3 ¿Por qué IndexedDB cache y no solo relays?

- **Instant UI:** Cache-first = la app se renderiza al instante desde IndexedDB
- **Offline tolerance:** El usuario ve datos aunque los relays estén caídos
- **Bandwidth:** Solo se piden eventos nuevos (cursor-based sync)
- **Relay independence:** Si un relay pierde datos, la app los tiene localmente

### 6.4 ¿Por qué eliminar Supabase completamente?

- **Single point of failure:** Vercel proxy + Supabase = 2 servicios centralizados
- **Coherencia filosófica:** "Soberanía" es incompatible con una base de datos controlada
- **Costo:** Relay infrastructure es más barato y escalable
- **Portabilidad:** Usuarios pueden llevar sus datos a cualquier relay

---

## 7. RIESGOS Y MITIGACIONES

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Relays privados caen | Sin governance/merits | 3 relays privados + IndexedDB cache |
| Merit manipulation | Unfair governance | Firmas verificables + snapshots por governors |
| NIP-44 no soportado | DMs inseguros | Fallback automático a NIP-04 |
| IndexedDB lleno | App lenta | Auto-prune (300 events max per kind) |
| Data loss en relay | Pérdida histórica | Multi-relay publish + local cache |
| Double-voting | Governance corrompida | Cryptographic check pre-vote |

---

*Este documento es la hoja de ruta completa. Cada fase puede ejecutarse independientemente y la app sigue funcionando en todo momento gracias al patrón de bridge que ya existe.*
