# LiberBit World 🌐

> Ecosistema de gobernanza descentralizada sobre protocolo Nostr + Bitcoin Lightning Network

**Principio fundamental:** *LiberBit World propone, nunca impone.*

---

## ¿Qué es LiberBit World?

Red de comunidades soberanas donde cada individuo mantiene su soberanía mientras participa en gobernanza colectiva transparente. El ecosistema conecta identidad descentralizada, economía basada en méritos (LBWM) y comunicación cifrada — todo sin servidores centralizados.

### Pilares

- **Soberanía individual** — Tu identidad y tus datos son tuyos. Tu clave privada nunca sale de tu dispositivo.
- **Gobernanza transparente** — Propuestas y votos verificables criptográficamente. Sistema de 3 bloques con protecciones anti-plutocráticas.
- **Méritos lineales (LBWM)** — Reconocimiento justo de valor. Sin escalas logarítmicas que penalicen a los mayores contribuyentes.
- **Autonomía local** — Cada comunidad se autogobierna. Interoperabilidad global sin coerción externa.
- **Propiedad privada + contratos voluntarios** — Toda participación es voluntaria.

---

## Stack Tecnológico

| Capa | Tecnología | Función |
|------|-----------|---------|
| Identidad | Nostr keypairs | Generación local, bech32 (npub/nsec), NIP-07 extensions |
| Comunicación | Nostr relays | Chat comunitario, DMs cifrados, metadata de perfil |
| Marketplace | NIP-99 | Clasificados descentralizados con imágenes verificadas |
| Gobernanza | Kinds 31000-31006 | Propuestas, votos, delegaciones — solo relays privados |
| Méritos | LBWM (Taproot Assets) | Tracking de contribuciones, leaderboard, ciudadanía |
| Pagos | Lightning Network | WebLN + Blink wallet integration |
| Cache | IndexedDB | Offline-first, instant UI, incremental sync |
| UI | Tailwind CSS + DaisyUI | Single-page application responsive |

---

## NIPs Implementados

| NIP | Nombre | Uso en LiberBit |
|-----|--------|----------------|
| 01 | Basic Protocol | Eventos, metadata (kind 0), notas comunitarias (kind 1) |
| 04 | Encrypted DMs | DMs cifrados (fallback cuando NIP-44 no disponible) |
| 07 | Browser Extension | Login con Alby, nos2x, Flamingo |
| 09 | Event Deletion | Eliminación de ofertas y posts (kind 5) |
| 19 | bech32 Encoding | Formato npub1.../nsec1... para claves |
| 25 | Reactions | Likes y zaps en posts comunitarios (kind 7) |
| 33 | Parameterized Replaceable | Propuestas actualizables, marketplace listings |
| 44 | Encrypted DMs v2 | Cifrado preferido para DMs (forward secrecy) |
| 65 | Relay List Metadata | Soberanía de relays por usuario (kind 10002) |
| 94 | File Metadata | SHA-256 integrity para imágenes subidas |
| 99 | Classified Listings | Marketplace descentralizado (kind 30402) |

### Kinds Custom LiberBit (rango 31000-31006)

| Kind | Nombre | Uso | Relays |
|------|--------|-----|--------|
| 31000 | `LBW_PROPOSAL` | Propuestas de gobernanza | 🔒 Privados |
| 31001 | `LBW_VOTE` | Votos en propuestas | 🔒 Privados |
| 31002 | `LBW_MERIT` | Registros de méritos LBWM | 🔒 Privados |
| 31003 | `LBW_CONTRIB` | Contribuciones al ecosistema | 🔒 Privados |
| 31004 | `LBW_DELEGATE` | Delegaciones de poder de voto | 🔒 Privados |
| 31005 | `LBW_SNAPSHOT` | Snapshots de leaderboard | 🔒 Privados |
| 31006 | `LBW_CONFIG` | Configuración y verificación | 🔒 Privados |

---

## Arquitectura

```
┌──────────────────────────────────────────────────────────────┐
│                        index.html (SPA)                       │
│                     Tailwind CSS + DaisyUI                    │
├──────────────────────────────────────────────────────────────┤
│                      nostr-bridge.js                          │
│         UI ↔ Nostr bridge: login, feeds, lifecycle            │
├────────────┬────────────┬─────────────┬──────────────────────┤
│  nostr-    │  nostr-    │  nostr-     │  ui.js               │
│  governance│  merits.js │  dm.js      │  profile.js          │
│  .js       │  LBWM      │  Abstraction│  wallet.js           │
│  Proposals │  Merit sys │  NIP-04/44  │  verification.js     │
│  + Votes   │  + Contribs│  → NIP-17   │                      │
├────────────┴────────────┴─────────────┴──────────────────────┤
│                       nostr-sync.js                           │
│            Cache-first + incremental relay sync               │
├──────────────────────────────────────────────────────────────┤
│                        nostr.js (core)                        │
│    SimplePool · Event publish/subscribe · NIP-44/04 crypto    │
│    Relay routing by kind · Rate limiting · Validation         │
├──────────────────────────────────────────────────────────────┤
│            nostr-store.js          │     nostr-media.js       │
│         IndexedDB (local cache)    │  Multi-provider upload   │
│  events·profiles·cursors·relays    │  SHA-256 · fallback URLs │
├────────────────────────────────────┴─────────────────────────┤
│                     Nostr Relays (WebSocket)                  │
│  🔒 relay.liberbit.world (×3)  │  🌐 relay.damus.io, nos.lol │
│     Governance · DMs · Merits   │     Discovery · Profiles     │
└──────────────────────────────────────────────────────────────┘
```

### Flujo de datos

```
User Action → Bridge → Nostr Module → Sign Event → Relay Pool → Private/Public Relays
                                                         ↓
                                              IndexedDB Cache ← SyncEngine ← Relay Events
                                                         ↓
                                                    UI Update
```

---

## Estructura del Proyecto

```
app-LiberBit-World/
├── index.html              ← SPA principal (2,600+ líneas)
├── css/
│   ├── main.css            ← Estilos de la aplicación
│   └── landing.css         ← Estilos de landing page
├── js/
│   ├── nostr-store.js      ← IndexedDB: eventos, perfiles, cursors, relay lists
│   ├── nostr-media.js      ← Upload multi-provider + SHA-256 integrity
│   ├── nostr.js            ← Core: SimplePool, crypto, relay routing, NIPs
│   ├── nostr-sync.js       ← SyncEngine: cache-first + incremental sync
│   ├── nostr-dm.js         ← DM abstraction (NIP-04/44 → futuro NIP-17)
│   ├── nostr-governance.js ← Propuestas + votos descentralizados
│   ├── nostr-merits.js     ← Sistema LBWM de méritos
│   ├── nostr-bridge.js     ← Bridge: UI ↔ Nostr (login, feeds, lifecycle)
│   ├── ui.js               ← Navegación, secciones, badges
│   ├── profile.js          ← Perfil y ciudadanía
│   ├── wallet.js           ← Lightning wallet (WebLN + Blink)
│   └── verification.js     ← Sistema de verificación de identidad
├── docs/
│   ├── architecture.md     ← Arquitectura técnica detallada
│   ├── lbwm-system.md      ← Sistema de méritos LBWM
│   ├── governance.md       ← Modelo de gobernanza
│   ├── citizenship.md      ← Niveles de ciudadanía
│   ├── relay-guide.md      ← Guía de relays y privacidad
│   └── security.md         ← Seguridad y criptografía
├── robots.txt
└── sitemap.xml
```

---

## Inicio Rápido

1. **Abre** la aplicación en tu navegador
2. **Crea identidad** — genera un par de claves Nostr (o conecta extensión NIP-07)
3. **Guarda tu nsec** — tu clave privada es tu identidad, no se puede recuperar
4. **Explora** — Chat, Marketplace, Gobernanza, Méritos, Wallet

### Login con extensión (recomendado)

Instala [Alby](https://getalby.com) o [nos2x](https://github.com/nicolgit/nos2x) → la app detecta automáticamente tu extensión Nostr.

### Login con clave privada

Importa tu nsec1... existente. La clave se almacena solo en sessionStorage (se borra al cerrar pestaña).

---

## Documentación

| Documento | Contenido |
|-----------|-----------|
| [Arquitectura Técnica](docs/architecture.md) | Módulos, flujo de datos, relay routing, cache pattern |
| [Sistema LBWM](docs/lbwm-system.md) | Méritos lineales, categorías, anti-plutocracy, Taproot Assets |
| [Gobernanza](docs/governance.md) | 3 bloques de voto, propuestas, ciclo de vida, quorum |
| [Ciudadanía](docs/citizenship.md) | Niveles, requisitos, derechos, verificación |
| [Guía de Relays](docs/relay-guide.md) | Privados vs públicos, NIP-65, Privacy Strict |
| [Seguridad](docs/security.md) | Cifrado, validación, rate limiting, privacidad |

---

## Principios de Diseño

- **Soberanía > Conveniencia** — Preferimos complejidad técnica a dependencia de terceros
- **Propone, nunca impone** — Toda regla es opt-in a nivel de comunidad
- **Lineal > Logarítmico** — Subsidiar a unos penalizando a otros contradice el reconocimiento justo
- **Privacy by default** — Governance y méritos SOLO en relays privados
- **Cache-first** — La app funciona aunque los relays estén caídos
- **Verificable** — Cada evento está firmado criptográficamente

---

## Contribuir

LiberBit World es un proyecto abierto. Si quieres contribuir:

1. Fork el repositorio
2. Crea tu branch (`git checkout -b feature/mi-feature`)
3. Commit (`git commit -m 'Añadir mi feature'`)
4. Push (`git push origin feature/mi-feature`)
5. Abre un Pull Request

Las contribuciones generan méritos LBWM en la categoría correspondiente.

---

## Contacto

- **Relays:** wss://relay.liberbit.world
- **Nostr:** Busca el tag `#liberbit` en cualquier cliente Nostr
- **Web:** [liberbit.world](https://liberbit.world)

---

*"La soberanía individual es el fundamento de la libertad colectiva."*
