# Gobernanza — LiberBit World

## Principio

*"LiberBit World propone, nunca impone."*

Toda participación en gobernanza es voluntaria. Las decisiones son vinculantes solo para quienes optan por participar en la comunidad. Cada comunidad local puede adaptar o rechazar decisiones globales.

---

## Sistema de 3 Bloques

El poder de voto se distribuye en tres bloques para evitar que ningún grupo domine:

### Bloque 1: Governors (51% floor)

- **Peso:** Mínimo 51% del resultado final
- **Quiénes:** Ciudadanos con 5,000+ méritos LBWM
- **Función:** Piso protector, no techo — garantiza que decisiones tengan respaldo de los más comprometidos
- **Voto:** Cada Governor tiene 1 voto en este bloque

### Bloque 2: Citizenship (proporcional)

- **Peso:** Variable (parte del 49% restante)
- **Quiénes:** Ciudadanos Senior (1,000+ méritos)
- **Función:** Representación proporcional al mérito acumulado
- **Voto:** Peso proporcional a méritos

### Bloque 3: Community (igualitario)

- **Peso:** Variable (parte del 49% restante)
- **Quiénes:** Todos los ciudadanos (100+ méritos)
- **Función:** Voz igualitaria — 1 persona = 1 voto independiente de méritos
- **Voto:** 1 persona = 1 voto

**Nota:** Los porcentajes exactos del Bloque 2 y 3 son configurables por comunidad. El 51% floor de Governors es el único parámetro fijo del sistema.

---

## Tipos de Propuesta

| Tipo | Emoji | Duración | Descripción |
|------|-------|----------|-------------|
| Referéndum | 🗳️ | 7 días | Consulta vinculante a toda la comunidad |
| Presupuesto | 💰 | 5 días | Asignación o modificación presupuestaria |
| Elección | 👥 | 7 días | Elección de representantes o gobernadores |
| Enmienda | 📜 | 14 días | Modificación de reglas o constitución |
| General | 📋 | 7 días | Propuesta abierta |
| Emergencia | 🚨 | 24 horas | Acción urgente con periodo reducido |

---

## Ciclo de Vida de una Propuesta

```
1. CREACIÓN     → Ciudadano Senior publica kind 31000
2. ACTIVA       → Periodo de votación abierto
3. VOTACIÓN     → Ciudadanos emiten kind 31001 (1 voto por persona)
4. EXPIRADA     → Timestamp alcanzado, no más votos
5. CERRADA      → Autor o Governor cierra (republica con status=closed)
6. EJECUTADA    → Resultado implementado por la comunidad
```

### Estados

- **active:** Aceptando votos
- **expired:** Periodo terminado (auto-detectado por timestamp)
- **closed:** Cerrada manualmente por el autor
- **executed:** Decisión implementada

---

## Opciones de Voto

Cada tipo de propuesta tiene opciones por defecto:

| Tipo | Opciones por defecto |
|------|---------------------|
| Referéndum | A favor, En contra, Abstención |
| Presupuesto | Aprobar, Rechazar, Aplazar |
| Elección | (nombres de candidatos) |
| Enmienda | A favor, En contra, Abstención |
| General | A favor, En contra, Abstención |
| Emergencia | Aprobar acción, Rechazar |

El creador puede personalizar las opciones al crear la propuesta.

---

## Anti-Doble-Voto

La verificación es criptográfica:

1. **Check local:** ¿Existe ya un voto mío en el estado interno?
2. **Check relay:** Subscripción con filtro `authors: [mi_pubkey] + #e: [proposal_id]`
3. Si alguno encuentra un voto existente → **rechazado**

Cada voto es un evento Nostr firmado con la clave del votante. Es imposible falsificar un voto sin la clave privada.

---

## Eventos Nostr

### Kind 31000 — Propuesta

```
kind: 31000 (parameterized replaceable)
tags:
  ['d', 'proposal-{author8}-{timestamp}']
  ['title', 'Título de la propuesta']
  ['category', 'referendum']
  ['status', 'active']
  ['expires', '1709600000']
  ['created', '1709000000']
  ['t', 'lbw-governance']
  ['t', 'lbw-proposal']
  ['t', 'lbw-referendum']
content: JSON {
  description: "Texto completo de la propuesta...",
  options: ["A favor", "En contra", "Abstención"],
  quorum: 10  // mínimo de votos para validez (opcional)
}
relays: SOLO privados
```

Al ser replaceable (NIP-33), el autor puede actualizar el status republicando con el mismo d-tag.

### Kind 31001 — Voto

```
kind: 31001
tags:
  ['e', '{proposal_event_id}']
  ['d-tag', '{proposal_d_tag}']
  ['t', 'lbw-governance']
  ['t', 'lbw-vote']
content: "A favor"  // la opción elegida como texto plano
relays: SOLO privados
```

---

## Delegación de Voto (futuro)

Kind 31004 permitirá delegar tu voto en otro ciudadano:

```
kind: 31004
tags:
  ['p', '{delegate_pubkey}']      ← a quién delegas
  ['category', 'referendum']       ← solo para esta categoría
  ['expires', '1709600000']        ← delegación temporal
content: ""
```

La delegación es revocable publicando un nuevo kind 31004 sin tag `p`.

---

## Privacidad

Todos los eventos de gobernanza se publican **exclusivamente** en relays privados de LiberBit. Esto evita:

- Observadores externos influyan en votaciones
- Análisis de patrones de voto por terceros
- Manipulación de propuestas por actores maliciosos

Los votos son pseudónimos (vinculados a npub, no a identidad real) pero verificables criptográficamente.

**Excepción:** desde `nip72-1` el evento `kind:34550` (community NIP-72 que se emite al admitirse una propuesta) sí se publica también en relays públicos. Es la única excepción de toda la gobernanza, y es deliberada: el sentido del community es que clientes Nostr externos descubran nuestras propuestas como hilo de debate federable. Las propuestas (`kind:31000`), votos (`kind:31001`), resultados (`kind:31010`) y ejecuciones (`kind:31011/31012`) siguen exclusivamente en privados. Privacy Strict mode mantiene también el `kind:34550` en privados.

---

## Admission Gate Génesis + NIP-72 communities (desde `nip72-1`)

Introducido para que cualquier ciudadano pueda **proponer** sin convertir el chat público en ruido descontrolado y manteniendo control de qué llega al canal abierto.

### Modelo de dos fases

```
┌──────────────────┐         ┌──────────────────┐         ┌────────────────────┐
│  CREACIÓN libre  │  ───>   │  PENDING gate    │  ───>   │  ACTIVA + debate   │
│  (cualquiera)    │ admission│  Génesis votan  │ ≥2 + >50%│  pública (NIP-72)  │
└──────────────────┘         └──────────────────┘  sí     └────────────────────┘
                                                              │
                                                              ↓
                                                     ┌────────────────────┐
                                                     │  Resultado, exec…  │
                                                     │  (flujo existente) │
                                                     └────────────────────┘
```

**Fase 1 — Admisión Génesis (cerrada):**

1. Cualquiera publica un `kind:31000` con `status: pending_admission` y tag `['admission_required', 'true']`.
2. Solo Génesis (≥3000 méritos LBWM, bloque Gobernanza) pueden votar admisión vía `kind:31001` con tag `['vote_type', 'admission']` y content `yes`/`no`.
3. Umbrales: **≥2 Génesis** votantes (quórum) y **>50% sí** (mayoría simple).
4. Voto temático y debate público están **bloqueados** mientras esté pendiente.

**Fase 2 — Debate público + voto temático:**

1. Cuando se cruza el umbral, la propuesta cambia a `status: active`.
2. Se emite automáticamente un `kind:34550` (NIP-72 community) con `d=lbw-prp-NNN` apuntando al evento de propuesta vía tags estándar `['e', proposal.id, '', 'root']` y `['a', '31000:<pubkey>:<dTag>', '', 'root']`.
3. Mensajes de debate (`kind:1`) incluyen `['a', '34550:<creator>:<community-d>', '', 'root']` para que clientes NIP-72 externos los enlacen al hilo.
4. A partir de aquí, flujo de votación temática y resultado idéntico al pre-`nip72-1`.

### Estados nuevos

| Estado | Significado |
|--------|-------------|
| `pending_admission` | Propuesta esperando votos Génesis para ser admitida |
| `admission_rejected` | Mayoría Génesis votó no — propuesta no entra al canal público |
| `active` | Admitida (o legacy sin gate) — votación temática y debate abiertos |

### Backward compatibility

Las propuestas creadas antes de `nip72-1` no tienen el tag `admission_required` y se tratan como ya admitidas. Cero migración, cero rotura.

### Trade-offs documentados

**(1) Reutilización de `kind:31001` para votos de admisión.** Distinguimos vía tag `['vote_type', 'admission']` en lugar de un kind nuevo. Pro: no inflar el espacio de kinds. Contra: un cliente externo que filtre `kind:31001` por proposalEventId sin leer `vote_type` mezclará el conteo (verá votos extra que en realidad son de admisión). Quien quiera contar votos LBW desde fuera tiene que respetar el tag.

**(2) `kind:1` como mensaje de debate, no `kind:1111`.** NIP-72 original aceptaba `kind:1` con `a`-tag, y propaga mejor a todos los clientes. NIP-72 más moderno usa `kind:1111` (top-level community post) para distinguir hilos top-level de replies. Hemos elegido `kind:1` por compatibilidad amplia; perdemos la distinción top-level/reply en algunos clientes nuevos.

**(3) Sin moderación NIP-72 real.** Usamos `kind:34550` como **primitiva de descubrimiento y agrupación**, no como mecanismo de moderación de contenido. **No emitimos `kind:4550` (approvals)** ni filtramos posts del debate. Política LBW: una vez admitida una propuesta, libre expresión en su debate.

**(4) Quorum=2 Génesis con headcount actual pequeño.** El umbral mínimo es ajustado dado el censo Génesis actual; ambos Génesis deben votar igual para admitir. Funciona como bootstrap, pero asume crecimiento del censo. Si no crece, el gate se vuelve sello del fundador.

**(5) Sin timeout de admisión.** Una propuesta puede quedarse `pending_admission` indefinidamente si los Génesis no votan o si hay empate. No hay caducidad automática (todavía). TODO: `admission_expires` configurable (¿7d? ¿30d?).

### Community paraguas `lbw-community` (desde `nip72-3`)

Adicional al kind:34550 per-PRP, existe un **community paraguas** único que agrupa todo el ecosistema. Su `d`-tag es `lbw-community`, no se asocia a ninguna PRP concreta, y sirve como punto de entrada en clientes Nostr externos (Coracle, Habla, satellite.earth) para descubrir LiberBit World como una unidad federada.

```
kind: 34550
tags:
  ['d', 'lbw-community']
  ['name', 'LiberBit World']
  ['description', 'Polis paralela sobre Nostr y Bitcoin Lightning...']
  ['image', 'https://www.liberbitworld.org/icons/icon-512.png']
  ['p', '<genesis_1>', '', 'moderator']
  ['p', '<genesis_2>', '', 'moderator']
  ['t', 'lbw-governance']
  ['t', 'lbw-community']
relays: privados + públicos
```

**Política de emisión manual.** Solo el fundador (o un Génesis autorizado) emite este evento desde su cuenta. Re-emisiones desde el MISMO pubkey sobreescriben el anterior (NIP-33 replaceable por kind+pubkey+d); re-emisiones desde otros pubkeys crearían communities paralelos. Clientes externos seguirán al primero que descubran. UI: botón "🏛️ Publicar / Actualizar paraguas" en la sección de gobernanza, visible solo a Génesis. Sin actualización automática — el operador decide cuándo refrescar la lista de moderadores (p.ej. tras un cambio de censo Génesis).

**Vínculo per-PRP → paraguas.** Cuando se admite una propuesta y se emite su `kind:34550` per-PRP, se incluye un tag `['a', '34550:<umbrella-creator>:lbw-community', '', 'parent']`. NIP-72 no formaliza sub-communities, pero el `a`-tag con marker `parent` es suficiente para que clientes externos entiendan que esa propuesta pertenece a LBW. Si la paraguas aún no se ha descubierto en relays cuando se emite la per-PRP, simplemente se omite el `a` tag — sin error.

### Pendientes

- **Estado "community archivada"** post-ejecución: cuando una propuesta llega a `executed`, el `kind:34550` sigue activo. Falta marcador `status: archived` o equivalente.
- **`admission_expires`**: timeout para cerrar propuestas pendientes sin admitir (alta prioridad cuando crezca el censo Génesis).

---

## Eventos Nostr (referencia rápida tras `nip72-1`)

### Kind 31000 — Propuesta (replaceable)

```
kind: 31000
tags:
  ['d', 'proposal-{author8}-{timestamp}']
  ['title', 'Título']
  ['category', 'referendum']
  ['status', 'pending_admission' | 'active' | 'expired' | ...]
  ['expires', '...']
  ['created', '...']
  ['proposal_number', '5']
  ['admission_required', 'true']      ← nuevo en nip72-1
  ['t', 'lbw-governance'],
  ['t', 'lbw-proposal'],
  ['t', 'lbw-{category}'],
content: JSON {description, options, ...}
relays: SOLO privados
```

### Kind 31001 — Voto (admisión Génesis o voto temático)

Admisión:
```
kind: 31001
tags:
  ['e', '{proposal_id}']
  ['d', '{proposal_d_tag}']
  ['vote_type', 'admission']          ← clave
  ['t', 'lbw-governance']
  ['t', 'lbw-admission']
content: 'yes' | 'no'
relays: SOLO privados
```

Voto temático (sin cambios):
```
kind: 31001
tags:
  ['e', '{proposal_id}']
  ['d', '{proposal_d_tag}']
  ['t', 'lbw-governance']
  ['t', 'lbw-vote']
content: 'A favor' | ...
relays: SOLO privados
```

### Kind 34550 — Community NIP-72 (nuevo en `nip72-1`)

```
kind: 34550
tags:
  ['d', 'lbw-prp-NNN']
  ['name', 'PRP-NNN — <título>']
  ['description', '...']
  ['p', '<author_pubkey>', '', 'moderator']
  ['e', '<proposal_event_id>', '', 'root']
  ['a', '31000:<author_pubkey>:<proposal_d>', '', 'root']
  ['t', 'lbw-governance']
  ['t', 'lbw-debate']
  ['t', 'lbw-prp-NNN']
content: ''
relays: privados + públicos (salvo Privacy Strict)
```
