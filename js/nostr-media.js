// ============================================================
// LiberBit World — Nostr MediaService v1.0 (nostr-media.js)
//
// Multi-provider image upload with:
//   - SHA-256 integrity hash (pre-upload)
//   - Multiple providers with automatic fallback
//   - Returns { urls: [url1, url2, ...], sha256, mime, size }
//   - Client-side render helper with URL fallback chain
//   - NO base64 data-URL fallback (violates content size limits)
//
// Providers (in order):
//   1. nostr.build (primary, Nostr-native)
//   2. void.cat (secondary, Nostr-friendly)
//   3. nostrimg.com (tertiary)
//
// Dependencies: None (uses native crypto.subtle)
// ============================================================

const LBW_Media = (() => {
    'use strict';

    // ── Provider Registry ────────────────────────────────────
    const PROVIDERS = [
        {
            name: 'nostr.build',
            endpoint: 'https://nostr.build/api/v2/upload/files',
            upload: async (file) => {
                const fd = new FormData();
                fd.append('file', file);
                const resp = await fetch('https://nostr.build/api/v2/upload/files', {
                    method: 'POST',
                    body: fd
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                if (data.status === 'success' && data.data?.[0]?.url) {
                    return data.data[0].url;
                }
                throw new Error('No URL in response');
            }
        },
        {
            name: 'void.cat',
            endpoint: 'https://void.cat/upload',
            upload: async (file) => {
                const buffer = await file.arrayBuffer();
                const resp = await fetch('https://void.cat/upload', {
                    method: 'POST',
                    body: buffer,
                    headers: {
                        'Content-Type': file.type || 'application/octet-stream',
                        'V-Filename': file.name || 'image.jpg',
                        'V-Description': 'LiberBit World upload'
                    }
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                if (data.ok && data.file?.id) {
                    return `https://void.cat/d/${data.file.id}`;
                }
                throw new Error('No file ID in response');
            }
        },
        {
            name: 'nostrimg.com',
            endpoint: 'https://nostrimg.com/api/upload',
            upload: async (file) => {
                const fd = new FormData();
                fd.append('image', file);
                const resp = await fetch('https://nostrimg.com/api/upload', {
                    method: 'POST',
                    body: fd
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                if (data.data?.link) {
                    return data.data.link;
                }
                throw new Error('No link in response');
            }
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

    // ── Multi-Provider Upload ────────────────────────────────
    // Tries each provider in order. Attempts at least 2 providers
    // to get multiple URLs for redundancy.
    //
    // Returns: {
    //   urls: [url1, url2, ...],
    //   primaryUrl: url1,
    //   sha256: "hex...",
    //   mime: "image/jpeg",
    //   size: 12345
    // }

    async function uploadImage(file, options = {}) {
        const { maxProviders = 2, onProgress = null } = options;

        // Validate file
        if (!file) throw new Error('No se proporcionó archivo.');
        if (!file.type.startsWith('image/')) throw new Error('El archivo no es una imagen.');
        if (file.size > 5 * 1024 * 1024) throw new Error('Imagen demasiado grande (máx 5MB).');

        // Compute SHA-256 before uploading
        if (onProgress) onProgress('Calculando integridad...');
        const sha256 = await computeSHA256(file);

        const result = {
            urls: [],
            primaryUrl: null,
            sha256: sha256,
            mime: file.type,
            size: file.size,
            fileName: file.name,
            providers: []  // Which providers succeeded
        };

        // Try each provider
        for (let i = 0; i < PROVIDERS.length && result.urls.length < maxProviders; i++) {
            const provider = PROVIDERS[i];

            if (onProgress) onProgress(`Subiendo a ${provider.name}...`);
            console.log(`[Media] 📤 Intentando ${provider.name}...`);

            try {
                const url = await provider.upload(file);
                result.urls.push(url);
                result.providers.push(provider.name);
                console.log(`[Media] ✅ ${provider.name}: ${url}`);

                if (!result.primaryUrl) result.primaryUrl = url;
            } catch (e) {
                console.warn(`[Media] ❌ ${provider.name} falló:`, e.message);
                // Continue to next provider
            }
        }

        if (result.urls.length === 0) {
            throw new Error('Todos los proveedores de imagen fallaron. Inténtalo más tarde.');
        }

        if (onProgress) onProgress('¡Subida completada!');
        console.log(`[Media] 📸 Upload completo: ${result.urls.length} URLs, SHA-256: ${sha256?.substring(0, 12)}...`);

        return result;
    }

    // ── Build Nostr Event Tags for Media ─────────────────────
    // Creates the appropriate tags for a marketplace listing
    // with multiple image URLs and integrity hash.
    function buildImageTags(mediaResult) {
        if (!mediaResult || mediaResult.urls.length === 0) return [];

        const tags = [];

        // Primary image URL (first one)
        tags.push(['image', mediaResult.primaryUrl]);

        // Additional URLs as thumb/mirror
        for (let i = 1; i < mediaResult.urls.length; i++) {
            tags.push(['thumb', mediaResult.urls[i]]);
        }

        // Integrity hash
        if (mediaResult.sha256) {
            tags.push(['x', mediaResult.sha256]);    // NIP-94 file hash
            tags.push(['sha256', mediaResult.sha256]); // Explicit hash tag
        }

        // MIME type
        if (mediaResult.mime) {
            tags.push(['m', mediaResult.mime]);
        }

        // File size
        if (mediaResult.size) {
            tags.push(['size', String(mediaResult.size)]);
        }

        return tags;
    }

    // ── Render Helper: Image with Fallback Chain ─────────────
    // Creates an <img> element that tries each URL in sequence.
    // If url[0] fails, tries url[1], etc.
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

        // Set up fallback chain
        let currentIndex = 0;
        img.src = urls[currentIndex];

        img.onerror = () => {
            currentIndex++;
            if (currentIndex < urls.length) {
                console.log(`[Media] 🔄 Fallback a URL #${currentIndex + 1}: ${urls[currentIndex].substring(0, 40)}...`);
                img.src = urls[currentIndex];
            } else {
                // All URLs failed: show placeholder
                img.style.display = 'none';
                console.warn(`[Media] ❌ Todas las URLs de imagen fallaron`);
            }
        };

        return img;
    }

    // ── Extract URLs from event tags ─────────────────────────
    // Collects all image/thumb URLs + sha256 from an event's tags.
    function extractMediaFromTags(tags) {
        const urls = [];
        let sha256 = null;
        let mime = null;
        let size = null;

        (tags || []).forEach(t => {
            if ((t[0] === 'image' || t[0] === 'thumb') && t[1]) {
                // Avoid duplicates
                if (!urls.includes(t[1])) urls.push(t[1]);
            }
            if ((t[0] === 'x' || t[0] === 'sha256') && t[1]) sha256 = t[1];
            if (t[0] === 'm' && t[1]) mime = t[1];
            if (t[0] === 'size' && t[1]) size = parseInt(t[1], 10) || null;
        });

        return { urls, sha256, mime, size };
    }

    // ── Verify Image Integrity ───────────────────────────────
    // Downloads an image and compares its SHA-256 with the
    // expected hash from the event tags.
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

    // ── Public API ───────────────────────────────────────────
    return {
        // Upload
        uploadImage,
        computeSHA256,

        // Event tags
        buildImageTags,
        extractMediaFromTags,

        // Render
        createFallbackImage,

        // Integrity
        verifyImageIntegrity,

        // Config
        PROVIDERS
    };
})();

window.LBW_Media = LBW_Media;
