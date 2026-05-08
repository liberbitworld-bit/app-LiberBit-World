# Seguridad y Privacidad — LiberBit World

## Gestión de Claves

### Tu clave privada NUNCA sale de tu dispositivo

| Método de login | Almacenamiento | Persistencia | Nivel de seguridad |
|----------------|---------------|-------------|-------------------|
| Extensión NIP-07 (Alby, nos2x) | Extensión del browser | Permanente | ✅ Más alto |
| Importar nsec / Crear identidad | `lbw_ncryptsec` cifrado con contraseña (NIP-49) | Permanente, requiere contraseña en cada apertura | ✅ Alto |

**Extensión NIP-07 (recomendado):** La clave privada vive en la extensión. La app solo pide firmas — nunca ve la clave.

**nsec import / Crear identidad:** La clave se cifra con tu contraseña usando NIP-49 (scrypt + XChaCha20-Poly1305) y se guarda como `ncryptsec1...` en `localStorage`. La nsec en claro nunca se persiste. Cada apertura del navegador requiere introducir la contraseña para descifrarla en memoria.

> Ver [Cifrado de la clave privada con NIP-49](#cifrado-de-la-clave-privada-con-nip-49) más abajo para detalles del modelo de seguridad y migración.

---

## Cifrado de Mensajes Directos

### NIP-44 (preferido)

- Algoritmo: XChaCha20-Poly1305 con padding
- Forward secrecy parcial via conversation keys
- Se usa automáticamente cuando disponible (extensión o nostr-tools)

### NIP-04 (fallback)

- Algoritmo: AES-256-CBC
- Se usa solo cuando NIP-44 no está disponible
- Funcional pero menos seguro que NIP-44

**Detección automática:** La app intenta NIP-44 primero. Si falla, cae a NIP-04. El badge de cifrado en la UI muestra qué protocolo está activo.

**DMs NO se cachean en texto plano.** IndexedDB solo almacena los eventos cifrados para tracking de cursors. El descifrado ocurre en memoria al renderizar.

---

## Validación de Eventos

Cada evento recibido de un relay pasa 6 checks:

### 1. Validación estructural
Verifica que el evento tiene todos los campos requeridos (id, pubkey, created_at, kind, tags, content, sig) con tipos correctos.

### 2. Verificación de firma
Verifica la firma Schnorr (secp256k1) del evento contra la pubkey del autor. Eventos con firma inválida se descartan silenciosamente.

### 3. Timestamp clamping
Rechaza eventos con `created_at` fuera de rango:
- Máximo pasado: 1 año
- Máximo futuro: 10 minutos

Esto previene ataques de "cursor-bricking" donde un evento con timestamp en el futuro lejano avanza el cursor de sincronización más allá de todos los eventos reales.

### 4. Rate limit por relay
Máximo 500 eventos por segundo por relay (`MAX_EVENTS_PER_RELAY_PER_SEC` en `js/nostr.js`). Protege contra relays que envían floods de eventos. El cap se eligió alto para no descartar eventos durante bursts iniciales de hidratación de feeds; se puede endurecer (50–100/s) cuando se confirme que la hidratación cabe debajo.

### 5. Rate limit por pubkey
Máximo 500 eventos por segundo por autor (`MAX_EVENTS_PER_PUBKEY_PER_SEC`). Mismo razonamiento que el cap por relay. Endurecible a 10–30/s para ser efectivo contra spam de un solo usuario.

### 6. Content size
Máximo 64 KB por evento. Previene eventos gigantes que consuman memoria.

---

## Integridad de Media

Las imágenes subidas al marketplace llevan hash SHA-256:

1. **Pre-upload:** Se calcula `crypto.subtle.digest('SHA-256', file)` antes de subir
2. **Tags NIP-94:** Se incluyen tags `['x', sha256]` y `['sha256', sha256]` en el evento
3. **Verificación:** Cualquier cliente puede descargar la imagen y comparar el hash
4. **Multi-provider:** Se sube a 2+ providers (nostr.build, void.cat, nostrimg.com) para redundancia
5. **Fallback chain:** Si una URL falla, la imagen intenta la siguiente automáticamente

---

## Validación de URLs de Relay

Todas las URLs de relay pasan validación antes de conexión:

- Debe empezar con `wss://` o `ws://`
- Máximo 256 caracteres
- No puede contener `javascript:`, `data:`, `blob:` (anti-XSS)
- Debe ser URL válida (`new URL(url)` no lanza error)

---

## Routing Privado

Los eventos sensibles NUNCA se envían a relays públicos:

| Datos | Relays | Razón |
|-------|--------|-------|
| DMs cifrados (kind 4) | Solo privados | Privacidad de comunicación |
| Propuestas (kind 31000) | Solo privados | Governance interna |
| Votos (kind 31001) | Solo privados | Secreto de voto |
| Méritos (kind 31002-31003) | Solo privados | Datos económicos internos |
| Snapshots (kind 31005) | Solo privados | Estado del ecosistema |
| Config/Verif (kind 31006) | Solo privados | Datos de identidad |

Solo perfiles (kind 0), posts comunitarios (kind 1), reacciones (kind 7), marketplace (kind 30402) y relay lists (kind 10002) se publican en relays públicos para discoverability.

**[SEC-A7] Sin fallback silencioso a públicos**: si el relay privado está caído, los kinds privados (DMs, governance, merits, etc.) **NO** caen automáticamente a relays públicos. `publishEvent` los intenta sólo en `SYSTEM_PRIVATE_RELAYS` y reporta error si todos fallan. La auditoría del 2026-05-07 detectó que un fallback anterior los enviaba a públicos cuando el privado parpadeaba — auditado y eliminado. El comentario `"data is encrypted/signed anyway"` de ese fallback era engañoso: solo los DMs (NIP-04/44) están cifrados; governance y merits viajaban en claro y filtraban metadatos.

---

## Anti-Doble-Voto

La verificación criptográfica previene votos duplicados:

1. **Check local:** Map interno `_myVotes` por proposal d-tag
2. **Check relay:** Subscripción con filtro `{kinds:[31001], authors:[pubkey], #e:[proposalId], limit:1}`
3. **Timeout:** 3 segundos para check de relay (si timeout → permite, relay verificará)
4. **Firmado:** Cada voto está firmado con la clave del votante — imposible falsificar sin la clave

---

## Modelo de Amenazas

| Amenaza | Mitigación |
|---------|------------|
| Relay malicioso envía eventos falsos | Verificación de firma descarta automáticamente |
| Relay malicioso envía flood | Rate limiting per relay (50/s) |
| Usuario spamea | Rate limiting per pubkey (10/s) |
| Evento con timestamp futuro (cursor-bricking) | Timestamp clamping (max +10min) |
| Intercepción de DMs | Cifrado NIP-44/NIP-04 end-to-end |
| Pérdida de datos en relay | Multi-relay publish + IndexedDB cache local |
| XSS via relay URL | Validación estricta de URLs |
| Manipulación de méritos | Firmas verificables + snapshots por governors |
| Robo de clave privada en disco | NIP-49: la nsec se persiste cifrada con contraseña del usuario, no en claro |
| XSS / extensión maliciosa lee `localStorage` | Solo encuentra `ncryptsec1...` cifrado — necesita la contraseña para descifrarlo. NIP-07 elimina incluso este vector |

---

## Cifrado de la clave privada con NIP-49

Desde la versión que incorpora `lbw-passlock.js`, la clave privada (`nsec`) **nunca se almacena en claro** en el navegador. Se cifra con la contraseña del usuario siguiendo el estándar [NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md).

### Cómo funciona

| Paso | Algoritmo |
|------|-----------|
| Derivación de clave a partir de la contraseña | scrypt con `logn=16` (N=65536, r=8, p=1) |
| Cifrado autenticado | XChaCha20-Poly1305 (nonce de 24 bytes, tag de 16 bytes) |
| Salida | `ncryptsec1...` (bech32) en `localStorage.lbw_ncryptsec` |

El descifrado solo ocurre en memoria al desbloquear la sesión y al firmar eventos. Recargar la pestaña vuelve a pedir la contraseña.

### Qué garantiza NIP-49

- **Reposo cifrado**: si alguien lee tu `localStorage` (volcado del disco, malware con acceso a archivos del navegador, herramientas forenses) solo encuentra el `ncryptsec1...`. Sin la contraseña no es viable computacionalmente recuperar la nsec.
- **scrypt resiste fuerza bruta**: con `logn=16`, cada intento de contraseña requiere ~1-2 s de CPU intensiva. Una contraseña fuerte (≥12 caracteres aleatorios) es inviable de romper offline.
- **Cifrado autenticado (Poly1305)**: cualquier modificación del `ncryptsec` lo invalida, no se puede tamper con el cifrado para inyectar otra nsec.

### Qué **NO** garantiza NIP-49

- **Compromiso del navegador en tiempo real**: una vez introducida la contraseña, la nsec descifrada vive en memoria mientras la pestaña está abierta. JS malicioso (XSS, extensión hostil) que se ejecute *durante* la sesión puede leerla.
- **Contraseñas débiles**: una contraseña corta (`1234`, `password`) sigue siendo factible de romper por fuerza bruta. La app exige mínimo 8 caracteres pero no estima entropía.
- **Keylogger en el sistema operativo**: captura la contraseña al teclearla. NIP-49 protege el reposo, no la entrada.
- **Recuperación**: **no hay reset posible**. Si pierdes la contraseña, la nsec es irrecuperable. La app advierte de esto en cada flujo de creación de contraseña.

### Modelo de amenazas cubierto

| Amenaza | NIP-49 ayuda | Mitigación adicional |
|---------|--------------|----------------------|
| Volcado de `localStorage` (malware con acceso a archivos) | ✅ Sí | — |
| Herramientas forenses sobre el disco | ✅ Sí | — |
| Otra app maliciosa en el mismo navegador (sin acceso al origen) | ✅ Sí (sandboxing del browser ya separa, NIP-49 es defensa en profundidad) | — |
| XSS en LiberBit World | ⚠️ Solo en reposo — no protege durante sesión activa | Validación estricta de entradas, CSP estricto |
| Extensión hostil del navegador | ⚠️ Solo en reposo — no protege durante sesión activa | Usar NIP-07 con extensión auditada (Alby) |
| Phishing de la contraseña | ❌ No protege | Educación del usuario, dominio estable |
| Keylogger del sistema | ❌ No protege | Higiene del sistema operativo |

### Migración de usuarios existentes

Las cuentas creadas antes de NIP-49 tenían la nsec guardada en claro en `localStorage.lbw_nsec_persist` y dentro de `liberbit_keys.privateKey`. Al detectar este estado al cargar la app:

1. **Modal *"📋 Apunta tu clave privada"*** (obligatorio): muestra la nsec con click-para-revelar y botón Copiar. El usuario debe confirmar que la ha guardado en un sitio seguro (gestor de contraseñas, papel offline) antes de continuar. Como la app guardaba la nsec sola, muchos usuarios nunca llegaron a apuntarla — este paso evita que pierdan la cuenta si olvidan la contraseña.
2. **Modal *"🛡️ Crea una contraseña"***: el usuario crea una contraseña; la app cifra la nsec, guarda el `ncryptsec`, y borra todo rastro de la nsec en claro (`lbw_nsec_persist`, `lbw_nsec_session`, `liberbit_keys.privateKey`).

En cualquier paso el usuario puede elegir *"Cerrar sesión y usar NIP-07"* en su lugar, lo que hace logout completo y limpia todos los almacenes.

### Comparativa de modelos de gestión de claves

| Modelo | Dónde vive la nsec | UX | Recuperación |
|--------|-------------------|-----|--------------|
| nsec en claro (legacy, ya retirado) | `localStorage` en plano | Sin fricción | nsec es el respaldo |
| **NIP-49 (actual)** | `localStorage` cifrado con contraseña | Una contraseña por sesión | nsec es el respaldo (no la contraseña) |
| NIP-07 (Alby/nos2x) | Extensión del navegador | Pulsas "firmar" | nsec es el respaldo (la gestiona la extensión) |
| NIP-46 (bunker remoto, no implementado aún) | Otro dispositivo / servicio | Aprueba cada firma en el bunker | nsec vive solo en el bunker |

El **respaldo soberano siempre es la nsec original**. La contraseña de NIP-49 protege el almacenamiento en disco, no es otro factor recuperable.
