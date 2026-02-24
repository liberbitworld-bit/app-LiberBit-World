# Seguridad y Privacidad — LiberBit World

## Gestión de Claves

### Tu clave privada NUNCA sale de tu dispositivo

| Método de login | Almacenamiento | Persistencia | Nivel de seguridad |
|----------------|---------------|-------------|-------------------|
| Extensión NIP-07 (Alby, nos2x) | Extensión del browser | Permanente | ✅ Más alto |
| Importar nsec | sessionStorage | Solo tab actual | ⚠️ Medio |
| Crear identidad | sessionStorage | Solo tab actual | ⚠️ Medio (guardar nsec!) |

**Extensión NIP-07 (recomendado):** La clave privada vive en la extensión. La app solo pide firmas — nunca ve la clave.

**nsec import:** La clave se almacena en `sessionStorage` (no `localStorage`), lo que significa que se borra automáticamente al cerrar la pestaña del navegador.

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
Máximo 50 eventos por segundo por relay. Protege contra relays que envían floods de eventos.

### 5. Rate limit por pubkey
Máximo 10 eventos por segundo por autor. Protege contra spam de un solo usuario.

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
| Robo de clave privada | sessionStorage (tab-scoped) + recomendación NIP-07 |
