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
