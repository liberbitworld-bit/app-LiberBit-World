# Arquitectura Técnica — LiberBit World

## Visión General

LiberBit World es una Single-Page Application (SPA) que opera exclusivamente sobre el protocolo Nostr. No hay base de datos centralizada, no hay backend tradicional. Toda la persistencia se logra mediante eventos Nostr firmados criptográficamente y almacenados en una red de relays.

---

## Módulos y Dependencias

### Orden de carga (crítico)

```html
<!-- 1. IndexedDB cache (sin dependencias) -->
<script src="js/nostr-store.js"></script>

<!-- 2. Media upload (sin dependencias) -->
<script src="js/nostr-media.js"></script>

<!-- 3. Core Nostr (depende de nostr-tools CDN) -->
<script src="js/nostr.js"></script>

<!-- 4. SyncEngine (depende de store + nostr) -->
<script src="js/nostr-sync.js"></script>

<!-- 5. Feature modules (dependen de nostr core) -->
<script src="js/nostr-dm.js"></script>
<script src="js/nostr-governance.js"></script>
<script src="js/nostr-merits.js"></script>

<!-- 6. Bridge (depende de TODO lo anterior) -->
<script src="js/nostr-bridge.js"></script>

<!-- 7. UI modules (dependen de bridge) -->
<script src="js/ui.js"></script>
<script src="js/profile.js"></script>
<script src="js/wallet.js"></script>
<script src="js/verification.js"></script>
```

### Mapa de dependencias

```
nostr-tools (CDN)
    │
    └─→ nostr.js (core)
         │
         ├─→ nostr-store.js (IndexedDB)
         │        │
         │        └─→ nostr-sync.js (SyncEngine)
         │
         ├─→ nostr-media.js (upload)
         │
         ├─→ nostr-dm.js (DM abstraction)
         │
         ├─→ nostr-governance.js (proposals + votes)
         │
         ├─→ nostr-merits.js (LBWM system)
         │
         └─→ nostr-bridge.js (UI ↔ Nostr)
              │
              ├─→ ui.js
              ├─→ profile.js
              ├─→ wallet.js
              └─→ verification.js
```

---

## Relay Routing

Los eventos se enrutan a diferentes relays según su `kind`. Esto implementa "privacy by design":

### Relays privados (LiberBit infrastructure)
- `wss://relay.liberbit.world`
- `wss://relay2.liberbit.world`
- `wss://relay3.liberbit.world`

### Relays públicos (discovery)
- `wss://relay.damus.io`
- `wss://nos.lol`

### Routing por event kind

| Kind(s) | Destino | Razón |
|---------|---------|-------|
| 0 (metadata) | Privados + Públicos | Discoverability de perfiles |
| 1 (text note) | Privados + Públicos | Community chat visible |
| 4 (encrypted DM) | **Solo privados** | Privacidad de mensajes |
| 7 (reaction) | Privados + Públicos | Social engagement |
| 10002 (relay list) | Privados + Públicos | NIP-65 discoverability |
| 30402 (marketplace) | Privados + Públicos | Ofertas visibles |
| 31000-31006 (LBW) | **Solo privados** | Governance y merits internos |

### NIP-65 User Relay Sovereignty

Cuando un usuario publica su relay list (kind 10002), el sistema respeta sus preferencias:

1. **User write relays** reemplazan system defaults para publicar
2. **User read relays** se usan para subscripciones
3. **Shared relay computation** para DMs: intersección de write (mío) ∩ read (suyo)

### Privacy Strict Mode

Cuando activado:
- **CERO** eventos a relays públicos
- Solo relays privados de LiberBit + relays del usuario (NIP-65)
- Toggle persistido en localStorage

---

## Cache-First Pattern (SyncEngine)

El `nostr-sync.js` implementa un patrón de sincronización incremental:

```
1. HYDRATE: Cargar eventos desde IndexedDB → renderizar UI inmediatamente
2. CURSOR: Obtener último timestamp sincronizado
3. SUBSCRIBE: Suscribir a relays con `since = cursor`
4. PERSIST: Cada evento nuevo → guardar en IndexedDB + avanzar cursor
5. PRUNE: Después de EOSE, eliminar eventos viejos (max 300 por kind)
```

### Ventajas

- **Instant UI:** La app se renderiza en <100ms desde cache local
- **Bandwidth:** Solo se descargan eventos nuevos
- **Offline tolerance:** Funciona con datos cacheados si relays caen
- **Relay independence:** Si un relay pierde datos, el cliente los tiene

### IndexedDB Object Stores

| Store | Key | Índices | Uso |
|-------|-----|---------|-----|
| `events` | id | kind, pubkey, [kind,created_at], [pubkey,kind] | Todos los eventos |
| `profiles` | pubkey | — | Últimos kind 0 por usuario |
| `cursors` | key | — | Posición de sync por feed |
| `replaceables` | rkey | kind, pubkey | Estado canónico de replaceables (30000-39999) |
| `relayLists` | pubkey | — | NIP-65 relay preferences por usuario |

---

## Event Validation Pipeline

Cada evento recibido de un relay pasa por 6 checks:

1. **Structural validation** (`validateEvent`) — Schema correcto
2. **Signature verification** (`verifyEvent`) — Firma criptográfica válida
3. **Timestamp clamping** — Rechaza eventos >1 año pasado o >10min futuro
4. **Rate limit: relay** — Max 50 events/segundo por relay
5. **Rate limit: pubkey** — Max 10 events/segundo por autor
6. **Content size** — Max 64KB por evento

Anti cursor-bricking: un evento con `created_at = 2040` no avanza el cursor más allá de `now + 10min`.

---

## Profile Resolution

El bridge implementa resolución de nombres cache-first:

```
1. Check IndexedDB profiles (< 1 hora old) → return cached
2. Fetch kind 0 from relays → cache + return
3. If relay fails → return stale cache
4. Fallback → npub1xxx... (truncated)
```

Esto evita hacer fetch de perfil cada vez que se renderiza un mensaje.

---

## Feature Module Pattern

Los módulos de feature (governance, merits, DM) siguen un patrón consistente:

```javascript
const LBW_Feature = (() => {
    'use strict';

    // Constants (event kinds, categories)
    // Internal state (Maps, arrays)
    // Publish functions (create Nostr events)
    // Subscribe functions (listen for events)
    // Parse helpers (event → structured data)
    // Query functions (getters sobre state)
    // Reset function (cleanup on logout)

    return { /* public API */ };
})();

window.LBW_Feature = LBW_Feature;
```

El bridge (`nostr-bridge.js`) orquesta el lifecycle:
- Login → `startAllFeeds()` → subscribe cada feature
- Logout → `stopAllFeeds()` → unsubscribe + reset
- Section change → start/stop features según visibilidad

---

## Seguridad: Gestión de Claves

| Método | Storage | Persistencia | Riesgo |
|--------|---------|-------------|--------|
| NIP-07 (extensión) | Extensión del browser | Permanente | Bajo — clave en extensión |
| nsec import | sessionStorage | Tab-scoped | Medio — se borra al cerrar tab |
| Crear identidad | sessionStorage + nsec display | Tab-scoped | Alto si no se guarda nsec |

La clave privada **nunca** se envía a ningún servidor. Todo el firmado ocurre localmente.
