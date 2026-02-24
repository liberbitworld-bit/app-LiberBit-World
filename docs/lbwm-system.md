# Sistema de Méritos LBWM — LiberBit World Merits

## Filosofía

El sistema LBWM reconoce valor de forma justa y transparente. Cada contribución al ecosistema genera méritos que determinan el nivel de ciudadanía y el peso en gobernanza.

**Decisión clave: Cálculo lineal, no logarítmico.**

Un sistema logarítmico subsidiaría a los contribuyentes pequeños penalizando a los grandes. Esto contradice el principio de reconocimiento justo: si alguien aporta 10× más valor, recibe 10× más méritos. Las protecciones anti-plutocráticas se implementan a nivel estructural (bloques de voto, caps por categoría), no distorsionando la medición de valor.

---

## Cálculo de Méritos

```
merit_points = contribution_amount × factor
```

- **amount:** Valor numérico de la contribución (sats, horas, unidades)
- **factor:** Multiplicador entre 1.0 y 2.0

| Factor | Significado |
|--------|------------|
| 1.0 | Contribución estándar |
| 1.5 | Alto impacto / contribución financiada |
| 2.0 | Infraestructura crítica / respuesta de emergencia |

---

## Categorías

| Categoría | Emoji | Descripción | Cap por periodo (30 días) | Auto-calculado |
|-----------|-------|-------------|--------------------------|---------------|
| Participación | 💬 | Posts, chat, reacciones | 100 | Sí |
| Profesional | 💼 | Servicios profesionales aportados | 500 | No |
| Gobernanza | 🏛️ | Propuestas creadas, votos emitidos | 200 | Sí |
| Infraestructura | 🔧 | Nodos, relays, desarrollo técnico | 500 | No |
| Comunidad | 🤝 | Onboarding, mentoring, eventos | 300 | No |
| Financiera | ⚡ | Contribuciones económicas | Sin límite | No |

**Categorías auto-calculadas** derivan méritos de la actividad on-chain (posts = kind 1, votos = kind 31001).

**Categorías manuales** requieren envío de contribución con descripción y evidencia.

---

## Eventos Nostr

### Kind 31003 — Contribución

Publicada por el contribuyente. Registra una contribución al ecosistema.

```
kind: 31003
tags:
  ['d', 'contrib-{pubkey8}-{timestamp}']    ← d-tag único
  ['p', '{pubkey}']                          ← beneficiario
  ['amount', '150']                          ← valor numérico
  ['merit-points', '225']                    ← méritos calculados
  ['category', 'professional']               ← categoría
  ['type', 'professional']                   ← tipo de contribución
  ['funded', 'true']                         ← ¿financiada?
  ['factor', '1.5']                          ← multiplicador aplicado
  ['t', 'lbw-merits']
  ['t', 'lbw-contrib']
content: JSON {
  description: "Diseño del sistema de votación",
  amount: 150,
  currency: "hours",
  meritPoints: 225,
  factor: 1.5,
  evidence: ["https://github.com/..."],
  timestamp: 1709000000
}
relays: SOLO privados
```

### Kind 31002 — Merit Award

Publicada por un Governor. Otorga méritos directamente a un usuario.

```
kind: 31002
tags:
  ['d', 'merit-{recipient8}-{timestamp}']
  ['p', '{recipient_pubkey}']
  ['amount', '50']
  ['category', 'community']
  ['reason', 'Organización del meetup mensual']
  ['awarded-by', '{governor_pubkey}']
  ['t', 'lbw-merits']
content: JSON { reason, amount, awardedBy, timestamp }
relays: SOLO privados
```

### Kind 31005 — Snapshot

Publicada periódicamente por Governors. Captura consenso del leaderboard.

```
kind: 31005
tags:
  ['d', 'snapshot-{timestamp}']
  ['t', 'lbw-merits']
  ['t', 'lbw-snapshot']
content: JSON {
  leaderboard: [
    { pubkey, npub, total, byCategory: {...}, level: {...} },
    ...
  ],
  timestamp: 1709000000,
  totalParticipants: 47,
  totalMerits: 28500
}
relays: SOLO privados
```

Los snapshots están firmados por el Governor que los publica. Cualquier participante puede verificar la firma.

---

## Niveles de Ciudadanía

Determinados por méritos acumulados totales:

| Nivel | Méritos mínimos | Emoji | Derechos |
|-------|-----------------|-------|----------|
| E-Residency | 0 | 🌐 | Chat, marketplace, perfil básico |
| Ciudadano | 100 | 🏛️ | Voto en referéndums, contribuciones |
| Ciudadano Activo | 500 | ⭐ | Voto en presupuestos, propuestas |
| Ciudadano Senior | 1,000 | 🏅 | Crear propuestas, roles de liderazgo |
| Governor | 5,000 | 👑 | Voto en bloque Governors (51% floor), award merits, snapshots |

---

## Protecciones Anti-Plutocráticas

El sistema usa protecciones **estructurales**, no distorsión de cálculo:

1. **Caps por categoría por periodo:** Límite de méritos por categoría cada 30 días
2. **3 bloques de voto:** Governors (51% floor), Citizenship (proporcional), Community (igualitario)
3. **Ciudadano Senior mínimo:** 1,000+ méritos para acceder a roles de liderazgo
4. **Transparencia total:** Todos los eventos son verificables criptográficamente
5. **Snapshots firmados:** Consenso periódico verificable por cualquiera

---

## Taproot Assets (futuro)

Los LBWM se emitirán como Taproot Assets sobre la red Bitcoin:

- Cada mérito = 1 LBWM token on-chain
- Transferibles entre usuarios (con restricciones de gobernanza)
- Verificación de balance sin revelar identidad
- Stake de 100 LBWM para verificación de identidad
- Slashing: confiscación de stake por comportamiento fraudulento
