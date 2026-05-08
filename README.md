# LiberBit World

**La red soberana de quienes no están dispuestos a ceder.**

LiberBit World es una comunidad digital y física para personas que defienden su libertad, su privacidad, su propiedad y su derecho a la libre expresión — sin censuras, sin intermediarios, sin permisos.

> *"La libertad no se pide, se construye."*

---

## ¿Qué es LiberBit World?

LiberBit World es la capa digital del ecosistema LiberBit: una red soberana que conecta a libertarios, anarcocapitalistas, minarquistas y cualquier persona que entienda que la soberanía individual no es negociable.

La plataforma ofrece infraestructura descentralizada para organizarse, comunicarse y actuar — sin depender de corporaciones, Estados ni intermediarios:

- **Identidad soberana** — sin usuarios ni contraseñas, sin rastreo, sin datos cedidos
- **Comunicación cifrada** — mensajes de extremo a extremo que nadie puede leer ni censurar
- **Gobernanza real** — propuestas, debate y votaciones con peso basado en contribución
- **Economía libre** — transacciones directas en Bitcoin vía Lightning, sin bancos
- **Libre expresión** — sin shadowban, sin moderación política, sin censura

La capa física del ecosistema es **LiberBit City**: una red de ciudades soberanas en desarrollo, con **LiberAtlas** como proyecto fundacional en la Península Ibérica.

---

## Los cinco pilares

| Pilar | Descripción |
|-------|-------------|
| 🔓 **Libertad** | Nadie te dice qué puedes pensar, decir o hacer |
| 🔒 **Privacidad** | Tus datos, tus comunicaciones, tu identidad son tuyas |
| 🏠 **Propiedad** | Lo que es tuyo no puede ser confiscado ni inflado |
| 🗣️ **Libre Expresión** | Sin censura, sin shadowban, sin moderación política |
| 🛡️ **Seguridad** | Sin depender del Estado ni de terceros |

---

## Stack técnico

| Capa | Tecnología |
|------|-----------|
| Frontend | Vanilla JavaScript SPA (sin build, sin bundler) |
| Identidad | Nostr — NIP-01 (firmas), NIP-07 (extensión), NIP-19 (npub/nsec), NIP-49 (cifrado de la nsec con contraseña), NIP-65 (relay list) |
| Mensajería | NIP-44 (XChaCha20-Poly1305) preferido, NIP-04 (AES-256-CBC) fallback |
| Marketplace | NIP-15 (stalls/products), NIP-99 (classified listings), NIP-85 (reviews) |
| Wallet | Lightning Address + WebLN, NIP-47 (Nostr Wallet Connect) |
| P2P exchange | NIP-69 (agregador de órdenes Mostro/lnp2pbot/RoboSats) |
| Relays | Privados (`wss://relay.liberbitworld.org`) para gobernanza/DMs/méritos; públicos (damus, nos.lol, etc.) para perfiles, chat comunitario y marketplace |
| Backend | Supabase (vía proxy en serverless function — credenciales nunca llegan al navegador) para índices de búsqueda y métricas; Nostr es la fuente de verdad |
| Pagos | Lightning Network (LNURL-pay, NWC para wallets externos) |
| Despliegue | Vercel (vía GitHub, auto-deploy en push a `main`) |

---

## Arquitectura

```
┌──────────────────────────────────────────────────────┐
│              Cliente (Vanilla JS SPA)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐  │
│  │  UI      │ │  LBW_*   │ │  LBW_Passlock        │  │
│  │  scripts │ │  modules │ │  (NIP-49 nsec cifr.) │  │
│  └────┬─────┘ └─────┬────┘ └──────────────────────┘  │
└───────┼─────────────┼────────────────────────────────┘
        │             │
        │             ├─────► Relays Nostr (privados + públicos por kind)
        │             │             ↑ identidad, gobernanza, méritos, DMs
        │             │
        │             └─────► Vercel /api/* (serverless)
        │                           ├─► Supabase (índices, búsqueda)
        │                           └─► coinos.io / Alby (LNURL proxy)
        │
        └────────────────► Wallets Lightning (WebLN, NWC bunker, LNURL)
```

- **Nostr es la fuente de verdad** para identidad, propuestas, votos, méritos y mensajes cifrados.
- **Supabase** se usa solo como índice secundario para búsquedas complejas (autocomplete por nombre, filtros), accedido vía proxy para que las credenciales nunca lleguen al cliente.
- **Las claves privadas** (nsec, NWC secret) viven cifradas con contraseña (NIP-49) en `localStorage` o en una extensión NIP-07 — nunca en plaintext.

---

## Sistema de ciudadanía

LiberBit World tiene 6 niveles de ciudadanía basados en méritos acumulados:

| Nivel | Méritos | Bloque de voto |
|-------|---------|----------------|
| 👋 Amigo | 0 | Comunidad |
| 🪪 E-Residency | 100+ | Comunidad |
| 🤝 Colaborador | 500+ | Comunidad |
| 🛂 Ciudadano Senior | 1.000+ | Ciudadanía |
| 🌍 Custodio | 2.000+ | Ciudadanía |
| 👑 Génesis | 3.000+ | Gobernanza |

El sistema de votación está estructurado en 3 bloques: Gobernanza (51%), Ciudadanía (29%) y Comunidad (20%).

Los méritos se acumulan en 4 categorías:

- **Económica** (peso 1.0) — aportaciones económicas al ecosistema
- **Productiva** (peso 1.0) — contribuciones de trabajo y producción
- **Responsabilidad** (peso 1.2) — requiere 1.000+ méritos en otras categorías
- **Financiada** (peso 0.6) — actividad financiada por la comunidad

---

## Tipos de propuestas de gobernanza

- `PRP-XXX` — Propuestas de política general
- Propuestas económicas
- Propuestas de infraestructura

---

## Cómo levantar el entorno local

### Requisitos

- Navegador moderno con extensión Nostr (ej. [Alby](https://getalby.com) o [nos2x](https://github.com/fiatjaf/nos2x))
- Cuenta en [Supabase](https://supabase.com) (plan gratuito suficiente)
- Node.js (opcional, solo para herramientas de desarrollo)

### Instalación

```bash
git clone https://github.com/liberbitworld-bit/app-LiberBit-World.git
cd app-LiberBit-World
```

Copia el archivo de variables de entorno:

```bash
cp .env.example .env
```

Rellena `.env` con tus credenciales:

```
SUPABASE_URL=tu_url_de_supabase
SUPABASE_ANON_KEY=tu_anon_key
NOSTR_RELAY=wss://tu_relay
```

Al ser una SPA en Vanilla JS, puedes abrirla directamente en el navegador o usar un servidor estático:

```bash
npx serve .
```

---

## Cómo contribuir

1. Haz fork del repositorio
2. Crea una rama: `git checkout -b feature/mi-mejora`
3. Haz tus cambios y commitea: `git commit -m "feat: descripción"`
4. Abre un Pull Request describiendo qué hace y por qué

### Convenciones de commits

Usamos [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` nueva funcionalidad
- `fix:` corrección de bug
- `docs:` cambios en documentación
- `refactor:` mejora de código sin cambio de comportamiento
- `chore:` tareas de mantenimiento

### Áreas donde puedes contribuir

- Mejoras de UI/UX
- Optimización de consultas Nostr
- Tests
- Documentación
- Nuevas integraciones Lightning

---

## Filosofía del proyecto

LiberBit nace de la convicción de que la soberanía individual no se negocia — ni se delega. Ni al Estado, ni a las corporaciones, ni a ningún intermediario.

La tecnología descentralizada (Bitcoin, Nostr, Lightning) es la infraestructura que hace posible lo que antes era imposible: comunidades con identidad propia, economía interna libre y gobernanza real, sin depender de nadie externo.

LiberBit World propone, nunca impone.

---

## Licencia

MIT — consulta el archivo [LICENSE](./LICENSE) para más detalles.

---

## Contacto y comunidad

- Web: [liberbitworld.org](https://liberbitworld.org)
- Telegram: [t.me/LiberBitWorld](https://t.me/LiberBitWorld)
- Nostr: búscanos en el relay `relay.liberbitworld.org`
- Marketing: [liberbitworld.com](https://liberbitworld.com)
