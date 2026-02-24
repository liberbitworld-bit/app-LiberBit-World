# Niveles de Ciudadanía — LiberBit World

## Progresión

La ciudadanía se determina por méritos LBWM acumulados. La progresión es lineal: más contribución = más derechos y responsabilidades.

```
🌐 E-Residency (0)  →  🏛️ Ciudadano (100)  →  ⭐ Activo (500)  →  🏅 Senior (1000)  →  👑 Governor (5000)
```

---

## Niveles

### 🌐 E-Residency (0 méritos)

Nivel de entrada. Cualquier persona que crea una identidad Nostr en LiberBit World.

**Derechos:**
- Chat comunitario (leer y escribir)
- Marketplace (publicar y buscar ofertas)
- Perfil básico con metadata Nostr
- DMs cifrados
- Wallet Lightning

**Limitaciones:**
- No puede votar en propuestas
- No puede crear propuestas
- No puede enviar contribuciones para méritos
- Limitado a operaciones básicas del ecosistema

---

### 🏛️ Ciudadano (100+ méritos)

Primer nivel de participación activa en la comunidad.

**Derechos adicionales:**
- Votar en referéndums (Bloque Community — 1 persona = 1 voto)
- Enviar contribuciones para méritos
- Acceso a notificaciones de gobernanza
- Participar en el bloque Community de votación

**Cómo llegar:**
- Participación activa en chat comunitario
- Publicar en marketplace
- Primeras contribuciones de cualquier categoría

---

### ⭐ Ciudadano Activo (500+ méritos)

Miembro establecido y activo del ecosistema.

**Derechos adicionales:**
- Votar en propuestas de presupuesto
- Votar en enmiendas
- Participar en elecciones
- Mayor peso en Bloque Citizenship (proporcional a méritos)

**Cómo llegar:**
- Contribuciones profesionales sostenidas
- Participación regular en gobernanza
- Combinación de múltiples categorías de mérito

---

### 🏅 Ciudadano Senior (1,000+ méritos)

Líder comunitario con acceso a responsabilidades de gobernanza.

**Derechos adicionales:**
- **Crear propuestas** de todos los tipos
- Roles de liderazgo en comunidades
- Participar en Bloque Citizenship con peso significativo
- Invitar nuevos miembros con verificación

**Importancia:**
Este es el nivel mínimo para acceder a funciones de liderazgo. La decisión de requerir 1,000+ méritos asegura que los roles de responsabilidad van a miembros dedicados, no a participantes casuales.

---

### 👑 Governor (5,000+ méritos)

Máximo nivel de participación y responsabilidad.

**Derechos adicionales:**
- Voto en Bloque Governors (51% floor del resultado)
- Otorgar méritos directamente (kind 31002)
- Publicar snapshots de leaderboard (kind 31005)
- Cerrar propuestas
- Configurar parámetros de la comunidad

**Responsabilidades:**
- Mantener la integridad del sistema de méritos
- Publicar snapshots periódicos verificables
- Moderar propuestas que violen principios fundamentales
- Representar los intereses a largo plazo del ecosistema

---

## Verificación de Identidad

Ortogonal a la ciudadanía (no requerida para méritos, pero aumenta confianza):

| Método | Nivel otorgado | Proceso |
|--------|---------------|---------|
| Invitación | Identidad Invitada | Código de un miembro verificado |
| Video | Identidad Real | Video de 30-60s revisado por 3 verificados |
| Stake LBWM | Identidad Real | Bloqueo de 100 LBWM (slashing si fraude) |

La verificación se registra en kind 31006 y se refleja en el perfil (kind 0, campo `lbw_verification`).

---

## LiberAtlas — Ciudades

Los ciudadanos pueden elegir una ciudad dentro de LiberBit World. Las ciudades son comunidades temáticas o geográficas con gobernanza local.

Cada ciudad puede:
- Adaptar las reglas de gobernanza globales
- Establecer requisitos adicionales de entrada
- Crear propuestas locales
- Mantener su propio leaderboard de méritos

La elección de ciudad se registra en el perfil Nostr (kind 0, campo `lbw_city`).
