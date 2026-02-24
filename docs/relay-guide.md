# Guía de Relays — LiberBit World

## Relays del Sistema

### 🔒 Relays Privados (infraestructura LiberBit)

| Relay | Función |
|-------|---------|
| `wss://relay.liberbit.world` | Principal — governance, DMs, merits |
| `wss://relay2.liberbit.world` | Redundancia |
| `wss://relay3.liberbit.world` | Redundancia |

Estos relays almacenan datos internos del ecosistema: propuestas, votos, méritos, DMs cifrados y configuración.

### 🌐 Relays Públicos (discovery)

| Relay | Función |
|-------|---------|
| `wss://relay.damus.io` | Discoverability de perfiles y posts |
| `wss://nos.lol` | Discoverability de perfiles y posts |

Se usan para que perfiles y posts comunitarios sean visibles en el ecosistema Nostr más amplio.

---

## Privacy Strict Mode

Al activar Privacy Strict:

- **NINGÚN** evento se envía a relays públicos
- Solo se conecta a relays privados de LiberBit + tus relays NIP-65
- Toggle en el header de la app o en configuración de perfil
- Se persiste en localStorage

Úsalo si quieres que tu actividad en LiberBit sea completamente invisible fuera del ecosistema.

---

## NIP-65: Soberanía de Relays

Puedes publicar tu propia lista de relays (kind 10002) para controlar dónde se almacenan tus datos.

### Modos por relay

- **Read:** Tus contactos deben enviar eventos aquí para que tú los veas
- **Write:** Aquí es donde publicas tus eventos
- **Both:** Lee y escribe

### Cómo configurar

1. Ve a **Perfil → Relays**
2. Añade tus relays preferidos con el modo deseado
3. Haz clic en **Publicar Relay List**
4. Tu kind 10002 se propaga y otros clientes lo respetan

### DMs con NIP-65

Cuando envías un DM, el sistema:
1. Obtiene los relays read del destinatario (NIP-65)
2. Calcula intersección: tus write ∩ sus read
3. Envía el DM a los relays compartidos
4. Si no hay intersección → fallback a tus write relays

---

## Ejecutar tu propio relay

Si quieres hosting propio:

1. Instala [strfry](https://github.com/hoytech/strfry) o [nostream](https://github.com/Cameri/nostream)
2. Configura WebSocket en puerto 443 con TLS
3. Añádelo a tu relay list (NIP-65) como read+write
4. Publica tu kind 10002 actualizado
5. LiberBit respetará automáticamente tu relay

---

## Status de Conexión

El header de la app muestra indicadores en tiempo real:

- 🟢 **Verde:** Relay conectado
- 🟡 **Amarillo:** Relay NIP-65 del usuario
- 🔵 **Azul:** Relay público conectado
- 🔴 **Rojo:** Relay desconectado o error
- ⚫ **Gris:** No configurado

Formato: `{privados}🔒 {nip65}👤 {públicos}🌐`
