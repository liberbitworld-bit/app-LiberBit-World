// ============================================================
// LiberBit World — Chat Attachments v1.0 (chat-attachments.js)
//
// Adjuntar imágenes en los mensajes de chat (comunidad, DMs
// cifrados E2E, debates de gobernanza).
//
// Cómo funciona:
//   1. Usuario pulsa 📎 → se abre selector de archivos.
//   2. La imagen se sube vía LBW_Media (multi-proveedor con
//      fallback: nostr.build → void.cat → nostrimg.com).
//   3. La URL resultante se inserta en el textarea del chat.
//   4. Al enviar, el mensaje viaja por Nostr como cualquier
//      otro (cifrado para DMs vía NIP-04/NIP-44).
//   5. Al renderizar, el módulo detecta URLs de imagen en el
//      contenido y las muestra inline como <img>.
//
// 100% compatible con otros clientes Nostr: el formato es
// simplemente "texto + URL + texto", igual que Damus, Amethyst,
// Iris, 0xchat, etc. Esto garantiza interoperabilidad.
//
// Dependencias: LBW_Media (nostr-media.js)
// ============================================================

const LBW_ChatAttach = (() => {
    'use strict';

    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB (igual que LBW_Media)
    const ACCEPTED  = 'image/jpeg,image/png,image/webp,image/gif,image/avif';

    // ── Detección de URLs de imagen ──────────────────────────
    // Cubre extensiones estándar + dominios conocidos de hosts
    // Nostr-friendly que a veces sirven sin extensión.
    const IMG_EXT_RE  = /^https?:\/\/[^\s<>"'`]+?\.(?:jpe?g|png|gif|webp|avif|bmp|svg)(?:\?[^\s<>"'`]*)?$/i;
    const IMG_HOST_RE = /^https?:\/\/(?:image\.nostr\.build|i\.nostr\.build|media\.nostr\.build|void\.cat\/d|nostrimg\.com\/i)\/[^\s<>"'`]+$/i;

    function isImageUrl(url) {
        if (!url) return false;
        return IMG_EXT_RE.test(url) || IMG_HOST_RE.test(url);
    }

    // ── Escape HTML ──────────────────────────────────────────
    // [M-6] La versión anterior usaba textContent + innerHTML que NO escapa
    // `"`. Como `esc(url)` se interpola en `href="..."` e `img src="..."`,
    // un URL con comillas (raro pero posible si URL_RE relaja) rompía el
    // atributo. Delegamos en LBW.escapeHtml (canonical, escapa todo).
    const esc = LBW.escapeHtml;

    // ── Render: convierte texto plano a HTML con <img> inline ─
    // Devuelve un string HTML seguro listo para innerHTML.
    // Reglas:
    //   - Texto normal → escapado, \n → <br>
    //   - URL de imagen → <a><img></a> (clic = abre original)
    //   - URL normal → <a> clicable
    //   - Puntuación final pegada a una URL (".", ",", etc.)
    //     se separa para no romper la URL.
    function renderContent(rawText) {
        if (!rawText) return '';

        const URL_RE = /(https?:\/\/[^\s<>"'`]+)/gi;
        const parts = [];
        let lastIndex = 0;
        let m;
        URL_RE.lastIndex = 0;

        while ((m = URL_RE.exec(rawText)) !== null) {
            let url = m[0];
            let trailing = '';
            // Quitar puntuación final pegada (frecuente: "mira esto https://x/y.jpg.")
            const trailMatch = url.match(/[.,;:!?)\]]+$/);
            if (trailMatch) {
                trailing = trailMatch[0];
                url = url.slice(0, -trailing.length);
            }
            if (m.index > lastIndex) {
                parts.push({ type: 'text', value: rawText.slice(lastIndex, m.index) });
            }
            parts.push({ type: 'url', value: url });
            if (trailing) parts.push({ type: 'text', value: trailing });
            lastIndex = m.index + m[0].length;
        }
        if (lastIndex < rawText.length) {
            parts.push({ type: 'text', value: rawText.slice(lastIndex) });
        }

        let html = '';
        for (const p of parts) {
            if (p.type === 'text') {
                html += esc(p.value).replace(/\n/g, '<br>');
            } else {
                const safe = esc(p.value);
                if (isImageUrl(p.value)) {
                    html += `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="lbw-chat-img-link">`
                          + `<img src="${safe}" alt="imagen adjunta" class="lbw-chat-img" loading="lazy" `
                          +      `onerror="this.style.display='none'; this.parentNode.classList.add('lbw-chat-img-broken');">`
                          + `<span class="lbw-chat-img-fallback">🖼️ Imagen no disponible</span>`
                          + `</a>`;
                } else {
                    html += `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="lbw-chat-link">${safe}</a>`;
                }
            }
        }
        return html;
    }

    // ── Inyectar CSS una sola vez ─────────────────────────────
    let _cssInjected = false;
    function ensureCss() {
        if (_cssInjected) return;
        _cssInjected = true;
        const style = document.createElement('style');
        style.id = 'lbw-chat-attach-css';
        style.textContent = `
            .lbw-chat-img-link {
                display: block;
                margin: 0.45rem 0;
                max-width: 280px;
                border-radius: 10px;
                overflow: hidden;
                border: 1px solid var(--color-border, rgba(229,185,92,0.2));
                background: rgba(0,0,0,0.25);
                text-decoration: none;
            }
            .lbw-chat-img {
                display: block;
                width: 100%;
                max-height: 320px;
                object-fit: cover;
                cursor: zoom-in;
                transition: opacity 0.2s;
            }
            .lbw-chat-img:hover { opacity: 0.92; }
            .lbw-chat-img-fallback {
                display: none;
                padding: 0.5rem 0.75rem;
                color: var(--color-text-secondary, #aaa);
                font-size: 0.75rem;
            }
            .lbw-chat-img-broken .lbw-chat-img-fallback {
                display: block;
            }
            .lbw-chat-link {
                color: var(--color-gold, #e5b95c);
                text-decoration: underline;
                word-break: break-all;
            }
            .lbw-chat-attach-progress {
                position: fixed;
                left: 50%;
                bottom: 5.5rem;
                transform: translateX(-50%);
                background: rgba(13,23,30,0.96);
                color: var(--color-gold, #e5b95c);
                padding: 0.65rem 1.1rem;
                border-radius: 10px;
                font-size: 0.8rem;
                border: 1px solid rgba(229,185,92,0.3);
                z-index: 9999;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                font-family: var(--font-mono, monospace);
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    // ── Mostrar/ocultar mensaje de progreso ───────────────────
    function showProgress(text) {
        ensureCss();
        let el = document.getElementById('lbw-chat-attach-progress');
        if (!el) {
            el = document.createElement('div');
            el.id = 'lbw-chat-attach-progress';
            el.className = 'lbw-chat-attach-progress';
            document.body.appendChild(el);
        }
        el.textContent = '📤 ' + text;
        el.style.display = 'block';
    }
    function hideProgress() {
        const el = document.getElementById('lbw-chat-attach-progress');
        if (el) el.style.display = 'none';
    }

    // ── Acción principal: el usuario pulsa 📎 ─────────────────
    // textareaId: 'newPostContent' | 'dmContent' | 'debateInput'
    function attach(textareaId) {
        if (typeof LBW_Media === 'undefined' || !LBW_Media.uploadImage) {
            alert('❌ Módulo de medios no disponible. Recarga la página.');
            return;
        }
        const ta = document.getElementById(textareaId);
        if (!ta) {
            console.warn('[ChatAttach] Textarea no encontrado:', textareaId);
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = ACCEPTED;
        input.style.display = 'none';

        input.onchange = async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;

            // Validación cliente
            if (!file.type.startsWith('image/')) {
                alert('❌ Solo se pueden adjuntar imágenes.');
                return;
            }
            if (file.size > MAX_BYTES) {
                alert('❌ Imagen demasiado grande. Máximo 5 MB.');
                return;
            }

            try {
                showProgress('Subiendo imagen...');
                const result = await LBW_Media.uploadImage(file, {
                    onProgress: (msg) => showProgress(msg)
                });

                if (!result || !result.primaryUrl) {
                    throw new Error('La subida no devolvió URL.');
                }

                // Insertar URL en el textarea (al final, separando con espacio si hace falta)
                const current = ta.value;
                const sep = (current && !/[\s\n]$/.test(current)) ? ' ' : '';
                ta.value = current + sep + result.primaryUrl + ' ';
                ta.focus();
                // Mover cursor al final
                ta.selectionStart = ta.selectionEnd = ta.value.length;
                // Disparar input para auto-resize y otros listeners
                ta.dispatchEvent(new Event('input', { bubbles: true }));

                showProgress('✅ Imagen lista — pulsa enviar');
                setTimeout(hideProgress, 1800);

                console.log('[ChatAttach] ✅ Imagen subida:', result.primaryUrl);
            } catch (err) {
                console.error('[ChatAttach] Error:', err);
                hideProgress();
                alert('❌ Error subiendo imagen: ' + (err.message || err));
            } finally {
                input.value = '';
            }
        };

        document.body.appendChild(input);
        input.click();
        // Limpieza diferida
        setTimeout(() => { try { input.remove(); } catch (e) {} }, 60000);
    }

    // ── Inicialización ────────────────────────────────────────
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', ensureCss);
        } else {
            ensureCss();
        }
    }

    // ── API Pública ───────────────────────────────────────────
    return {
        attach,
        renderContent,
        isImageUrl
    };
})();

if (typeof window !== 'undefined') {
    window.LBW_ChatAttach = LBW_ChatAttach;
}
