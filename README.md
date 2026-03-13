# LiberBit World

**Plataforma descentralizada de gobernanza y comunidad para ciudades privadas soberanas.**

LiberBit World es una aplicación web construida sobre el protocolo Nostr y la red Bitcoin/Lightning, donde los ciudadanos se identifican, contribuyen y participan en la gobernanza de comunidades con economías basadas en Bitcoin.

> "Una red de ciudades libres, con identidad digital soberana, gobernanza por méritos y economía Bitcoin."

---

## ¿Qué es LiberBit World?

LiberBit World implementa el concepto de **network state**: comunidades privadas con reglas propias, economía interna en Bitcoin y un sistema de ciudadanía progresivo basado en méritos. La primera ciudad fundacional es **IberAtlas**, ubicada en la Península Ibérica.

La plataforma permite a sus ciudadanos:

- Autenticarse con identidad Nostr (sin usuarios ni contraseñas)
- Acumular méritos por contribuciones reales a la comunidad
- Progresar por niveles de ciudadanía (Visitante → Fundador)
- Crear y debatir propuestas de gobernanza
- Realizar aportaciones en Bitcoin vía Lightning Network

---

## Stack técnico

| Capa | Tecnología |
|------|-----------|
| Frontend | Vanilla JavaScript SPA |
| Identidad | Nostr (NIP-01, NIP-44, NIP-07) |
| Mensajería | NIP-44 (mensajes cifrados de extremo a extremo) |
| Relay | Relay Nostr privado |
| Base de datos | Supabase (caché e índices) |
| Pagos | Lightning Network (Lightning Address) |
| Despliegue | Vercel (vía GitHub) |

---

## Arquitectura

```
┌─────────────────────────────────────────┐
│           Cliente (Vanilla JS)          │
└────────────┬────────────────────────────┘
             │
     ┌───────┴────────┐
     │                │
┌────▼─────┐   ┌──────▼──────┐
│  Relay   │   │  Supabase   │
│  Nostr   │   │  (caché)    │
│  privado │   └─────────────┘
└──────────┘
```

Los eventos de identidad, méritos y gobernanza viven en Nostr. Supabase actúa como índice para consultas complejas.

---

## Sistema de ciudadanía

LiberBit World tiene 6 niveles de ciudadanía basados en méritos acumulados:

| Nivel | Méritos | Bloque de voto |
|-------|---------|----------------|
| 👋 Amigo | 0 | Comunidad |
| 🪪 E-Residency | 100+ | Comunidad |
| 🤝 Colaborador | 500+ | Comunidad |
| 🛂 Ciudadano Senior | 1.000+ | Ciudadanía |
| 🌍 Embajador | 2.000+ | Ciudadanía |
| 👑 Gobernador | 3.000+ | Gobernanza |

El sistema de votación está estructurado en 3 bloques: Gobernanza (51%), Ciudadanía (29%) y Comunidad (20%), con un cap máximo de 3.000 méritos de voto para Gobernadores.

Los méritos se acumulan en 4 categorías:

- **Económica Definitiva** (peso 1.0) — aportaciones económicas al ecosistema
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

LiberBit World nace de la convicción de que Bitcoin no es solo dinero: es la infraestructura para construir comunidades soberanas, con reglas propias, sin depender de Estados ni corporaciones. El protocolo Nostr aporta la identidad descentralizada que completa ese ecosistema.

Este proyecto está dirigido a quienes creen que la tecnología puede devolver la soberanía individual y colectiva a las personas.

---

## Licencia

MIT — consulta el archivo [LICENSE](./LICENSE) para más detalles.

---

## Contacto y comunidad

- Web: [liberbitworld.org](https://liberbitworld.org)
- Nostr: búscanos en el relay `relay.liberbitworld.org`
- Marketing: [liberbitworld.com](https://liberbitworld.com)
