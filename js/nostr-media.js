// ============================================================
// LiberBit World — Nostr MediaService v2.0 (nostr-media.js)
//
// Multi-provider image upload with:
//   - SHA-256 integrity hash (pre-upload, reutilizado por los providers)
//   - Blossom BUD-01 (kind 24242) + NIP-96/NIP-98 (kind 27235) firma Nostr
//   - Multiple providers with automatic fallback
//   - Returns { urls, primaryUrl, sha256, mime, size, fileName, providers }
//   - Client-side render helper con fallback chain
//
// Providers (en orden):
//   1. blossom.primal.net      (BUD-01, principal)
//   2. blossom.band            (BUD-01)
//   3. cdn.satellite.earth     (BUD-01)
//   4. nostr.download          (BUD-01)
//   5. nostr.build             (NIP-96 + NIP-98 auth)
//
// Todos los providers requieren firma Nostr. Se usa LBW_Nostr.signEvent()
// (requiere parche mínimo en nostr.js exponiéndolo en el API pública).
//
// API pública: SIN CAMBIOS respecto a v1.0 — los consumidores
// (chat-attachments, nostr-stalls, nostr-bridge) siguen funcionando igual.
//
// Dependencias: LBW_Nostr (signEvent), crypto.subtle (nativo)
// ============================================================

const LBW_Media = (() => {
    'use strict';

    // ── Helpers de firma Nostr ───────────────────────────────

    /**
     * Firma un evento usando el signer expuesto por LBW_Nostr.
     * Fallback a window.nostr (NIP-07) si LBW_Nostr aún no expone signEvent.
     */
    async function signNostrEvent(unsignedEvent) {
        if (window.LBW_Nostr && typeof window.LBW_Nostr.signEvent === 'function') {
            return await window.LBW_Nostr.signEvent(unsignedEvent);
        }
        if (window.nostr && typeof window.nostr.signEvent === 'function') {
            return await window.nostr.signEvent(unsignedEvent);
        }
        throw new Error('No hay signer Nostr disponible. Actualiza js/nostr.js para exponer signEvent.');
    }

    function b64EncodeJson(obj) {
        return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
    }

    // ── Blossom BUD-01 upload (kind 24242) ───────────────────
    // PUT <server>/upload con body = bytes crudos
    // Header Authorization: Nostr <base64(signed_event)>
    // Spec: https://github.com/hzrd149/blossom/blob/master/buds/01.md
    async function blossomUpload(server, file, buffer, sha256) {
        const now = Math.floor(Date.now() / 1000);
        const signed = await signNostrEvent({
            kind: 24242,
            created_at: now,
            content: `Upload ${file.name || 'file'}`,
            tags: [
                ['t', 'upload'],
                ['x', sha256],
                ['expiration', String(now + 300)]
            ]
        });

        const resp = await fetch(server.replace(/\/+$/, '') + '/upload', {
            method: 'PUT',
            headers: {
                'Authorization': 'Nostr ' + b64EncodeJson(signed),
                'Content-Type': file.type || 'application/octet-stream'
            },
            body: buffer
        });

        if (!resp.ok) {
            const reason = resp.headers.get('x-reason') || resp.statusText || '';
            throw new Error(`HTTP ${resp.status} ${reason}`.trim());
        }
        const data = await resp.json();
        if (!data.url) throw new Error('Respuesta sin url');
        return data.url;
    }

    // ── NIP-96 + NIP-98 upload (kind 27235) ──────────────────
    // POST multipart con Authorization firmada
    async function nip96Upload(endpoint, file, sha256) {
        const now = Math.floor(Date.now() / 1000);
        const signed = await signNostrEvent({
            kind: 27235,
            created_at: now,
            content: '',
            tags: [
                ['u', endpoint],
                ['method', 'POST'],
                ['payload', sha256]
            ]
        });

        const fd = new FormData();
        fd.append('file', file);

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Authorization': 'Nostr ' + b64EncodeJson(signed) },
            body: fd
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (data.status && data.status !== 'success') {
            throw new Error(data.message || 'NIP-96 status != success');
        }
        const tags = data.nip94_event && data.nip94_event.tags;
        if (Array.isArray(tags)) {
            const urlTag = tags.find(t => t[0] === 'url');
            if (urlTag && urlTag[1]) return urlTag[1];
        }
        if (data.data && data.data.url) return data.data.url;
        throw new Error('Respuesta NIP-96 sin URL');
    }

    // ── Provider Registry ────────────────────────────────────
    // upload(file, buffer, sha256) → URL pública
    const PROVIDERS = [
        {
            name: 'blossom.primal.net',
            kind: 'blossom',
            upload: (file, buffer, sha256) =>
                blossomUpload('https://blossom.primal.net', file, buffer, sha256)
        },
        {
            name: 'blossom.band',
            kind: 'blossom',
            upload: (file, buffer, sha256) =>
                blossomUpload('https://blossom.band', file, buffer, sha256)
        },
        {
            name: 'cdn.satellite.earth',
            kind: 'blossom',
            upload: (file, buffer, sha256) =>
                blossomUpload('https://cdn.satellite.earth', file, buffer, sha256)
        },
        {
            name: 'nostr.download',
            kind: 'blossom',
            upload: (file, buffer, sha256) =>
                blossomUpload('https://nostr.download', file, buffer, sha256)
        },
        {
            name: 'nostr.build',
            kind: 'nip96',
            upload: (file, buffer, sha256) =>
                nip96Upload('https://nostr.build/api/v2/nip96/upload', file, sha256)
        }
    ];

    // ── SHA-256 Hash ─────────────────────────────────────────
    async function computeSHA256(file) {
        try {
            const buffer = await file.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn('[Media] SHA-256 computation failed:', e);
            return null;
        }
    }

    // Helper: calcular sha256 y devolver también el buffer (reutilizable)
    async function _hashAndBuffer(file) {
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return { buffer, sha256 };
    }

    // ── Multi-Provider Upload ────────────────────────────────
    async function uploadImage(file, options = {}) {
        const { maxProviders = 2, onProgress = null } = options;

        if (!file) throw new Error('No se proporcionó archivo.');
        if (!file.type.startsWith('image/')) throw new Error('El archivo no es una imagen.');
        if (file.size > 5 * 1024 * 1024) throw new Error('Imagen demasiado grande (máx 5MB).');

        if (onProgress) onProgress('Calculando integridad...');
        const { buffer, sha256 } = await _hashAndBuffer(file);

        const result = {
            urls: [],
            primaryUrl: null,
            sha256,
            mime: file.type,
            size: file.size,
            fileName: file.name,
            providers: []
        };

        const errors = [];

        for (let i = 0; i < PROVIDERS.length && result.urls.length < maxProviders; i++) {
            const provider = PROVIDERS[i];

            if (onProgress) onProgress(`Subiendo a ${provider.name}...`);
            console.log(`[Media] 📤 Intentando ${provider.name} (${provider.kind})...`);

            try {
                const url = await provider.upload(file, buffer, sha256);
                result.urls.push(url);
                result.providers.push(provider.name);
                console.log(`[Media] ✅ ${provider.name}: ${url}`);
                if (!result.primaryUrl) result.primaryUrl = url;
            } catch (e) {
                console.warn(`[Media] ❌ ${provider.name} falló:`, e.message);
                errors.push(`${provider.name}: ${e.message}`);
            }
        }

        if (result.urls.length === 0) {
            console.error('[Media] Todos los providers fallaron:\n' + errors.join('\n'));
            throw new Error('Todos los proveedores de imagen fallaron. Inténtalo más tarde.');
        }

        if (onProgress) onProgress('¡Subida completada!');
        console.log(`[Media] 📸 Upload completo: ${result.urls.length} URLs, SHA-256: ${sha256?.substring(0, 12)}...`);

        return result;
    }

    // ── Build Nostr Event Tags for Media ─────────────────────
    function buildImageTags(mediaResult) {
        if (!mediaResult || mediaResult.urls.length === 0) return [];
        const tags = [];
        tags.push(['image', mediaResult.primaryUrl]);
        for (let i = 1; i < mediaResult.urls.length; i++) {
            tags.push(['thumb', mediaResult.urls[i]]);
        }
        if (mediaResult.sha256) {
            tags.push(['x', mediaResult.sha256]);
            tags.push(['sha256', mediaResult.sha256]);
        }
        if (mediaResult.mime) tags.push(['m', mediaResult.mime]);
        if (mediaResult.size) tags.push(['size', String(mediaResult.size)]);
        return tags;
    }

    // ── Render Helper: Image with Fallback Chain ─────────────
    function createFallbackImage(urls, options = {}) {
        const {
            alt = 'Imagen',
            style = 'width:100%; max-height:300px; object-fit:cover; border-radius:12px;',
            className = '',
            placeholder = null
        } = options;

        if (!urls || urls.length === 0) {
            if (placeholder) return placeholder;
            return null;
        }

        const img = document.createElement('img');
        img.alt = alt;
        img.style.cssText = style;
        if (className) img.className = className;

        let currentIndex = 0;
        img.src = urls[currentIndex];

        img.onerror = () => {
            currentIndex++;
            if (currentIndex < urls.length) {
                console.log(`[Media] 🔄 Fallback a URL #${currentIndex + 1}: ${urls[currentIndex].substring(0, 40)}...`);
                img.src = urls[currentIndex];
            } else {
                img.style.display = 'none';
                console.warn(`[Media] ❌ Todas las URLs de imagen fallaron`);
            }
        };

        return img;
    }

    // ── Extract URLs from event tags ─────────────────────────
    function extractMediaFromTags(tags) {
        const urls = [];
        let sha256 = null;
        let mime = null;
        let size = null;

        (tags || []).forEach(t => {
            if ((t[0] === 'image' || t[0] === 'thumb') && t[1]) {
                if (!urls.includes(t[1])) urls.push(t[1]);
            }
            if ((t[0] === 'x' || t[0] === 'sha256') && t[1]) sha256 = t[1];
            if (t[0] === 'm' && t[1]) mime = t[1];
            if (t[0] === 'size' && t[1]) size = parseInt(t[1], 10) || null;
        });

        return { urls, sha256, mime, size };
    }

    // ── Verify Image Integrity ───────────────────────────────
    async function verifyImageIntegrity(url, expectedSHA256) {
        if (!expectedSHA256) return { verified: false, reason: 'No hash to compare' };
        try {
            const resp = await fetch(url);
            if (!resp.ok) return { verified: false, reason: `HTTP ${resp.status}` };
            const buffer = await resp.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const actualHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            const match = actualHash === expectedSHA256;
            return {
                verified: match,
                expected: expectedSHA256,
                actual: actualHash,
                reason: match ? 'OK' : 'Hash mismatch'
            };
        } catch (e) {
            return { verified: false, reason: e.message };
        }
    }

    // ── Public API (sin cambios respecto a v1.0) ─────────────
    return {
        uploadImage,
        computeSHA256,
        buildImageTags,
        extractMediaFromTags,
        createFallbackImage,
        verifyImageIntegrity,
        PROVIDERS
    };
})();

window.LBW_Media = LBW_Media;
