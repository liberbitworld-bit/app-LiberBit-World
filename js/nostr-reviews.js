// ========== REVIEWS — NIP-85 (kind:1985) ==========
// LBW_Reviews: sistema de reseñas post-transacción del Marketplace
// Spec: https://github.com/nostr-protocol/nips/blob/master/85.md
// Depende de: LBW_Nostr, LBW_Merits (nostr-merits.js), supabaseClient

(function () {
    'use strict';

    // ── Constantes ────────────────────────────────────────────
    const KIND_REVIEW    = 1985;
    const LABEL_NS       = 'lbw/marketplace/review';
    const STARS_EMOJI    = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];
    const POSITIVE_THRESHOLD = 4; // 4-5★ cuenta como positiva para el bonus LBWM
    const BONUS_REVIEWS_NEEDED = 5; // reseñas positivas para +10 LBWM

    // ── Escape HTML ───────────────────────────────────────────
    // SEC-27: Unified with LBW.escapeHtml (canonical in escape-utils.js)
    const _esc = (typeof LBW !== 'undefined' && LBW.escapeHtml) ? LBW.escapeHtml : function (str) {
        return String(str || '')
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    };

    // ── Publicar reseña (kind:1985, NIP-85) ──────────────────
    // reviewedPubkey: pubkey del que se reseña (hex)
    // listing: objeto del marketplace
    // rating: 1-5
    // comment: texto libre
    // role: 'buyer' | 'seller'
    async function publishReview({ reviewedPubkey, listing, rating, comment, role }) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido');
        if (!reviewedPubkey)         throw new Error('Destinatario requerido');
        if (rating < 1 || rating > 5) throw new Error('Rating debe ser 1-5');

        const authorPubkey = LBW_Nostr.getPubkey();
        if (authorPubkey === reviewedPubkey) throw new Error('No puedes reseñarte a ti mismo');

        // Deduplicación: una reseña por par author+listing
        const dedupeKey = `lbw_review_${listing.id || listing.dTag}_${authorPubkey.substring(0, 16)}`;
        if (localStorage.getItem(dedupeKey)) {
            throw new Error('Ya has dejado una reseña para esta transacción');
        }

        const nowSecs = Math.floor(Date.now() / 1000);
        const dTag    = `review-${listing.id || listing.dTag}-${authorPubkey.substring(0, 8)}-${nowSecs}`;

        // NIP-85: content es el comentario, tags estructurados
        const tags = [
            ['d',    dTag],
            ['p',    reviewedPubkey],
            // NIP-85: label namespace + value
            ['L',    LABEL_NS],
            ['l',    String(rating), LABEL_NS],
            // Referencia al listing
            ['e',    listing.id || listing.dTag || '', '', 'mention'],
            // Metadatos LiberBit
            ['rating',  String(rating)],
            ['role',    role],                           // 'buyer' o 'seller'
            ['listing-title', listing.title || ''],
            ['t',    'lbw-review'],
            ['t',    'lbw-marketplace'],
            ['t',    'liberbit'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind:    KIND_REVIEW,
            content: comment || '',
            tags
        });

        // Marcar como ya reseñado
        localStorage.setItem(dedupeKey, nowSecs.toString());

        console.log(`[Reviews] ✅ Reseña publicada: ${rating}★ → ${reviewedPubkey.substring(0, 12)}`);

        // Intentar bonus LBWM por 5 reseñas positivas
        if (rating >= POSITIVE_THRESHOLD) {
            await _checkAndAwardReviewBonus(reviewedPubkey);
        }

        return result;
    }

    // ── Bonus LBWM por 5 reseñas positivas ───────────────────
    async function _checkAndAwardReviewBonus(sellerPubkey) {
        if (typeof LBW_Merits === 'undefined') return;

        try {
            const reviews = await getReviewsForUser(sellerPubkey);
            const positiveCount = reviews.filter(r => r.rating >= POSITIVE_THRESHOLD).length;

            // Milestones: 5, 10, 20 reseñas positivas
            // [SEC-A3] Igual que el primer-venta, los bonus de milestone via
            // kind 31002 firmado por el reviewer son rechazados por SEC-22.
            // awardMarketplaceMerit ahora es no-op público; mantenemos la
            // llamada y el dedupe local hasta el rediseño.
            const milestones = [5, 10, 20];
            for (const milestone of milestones) {
                if (positiveCount === milestone) {
                    const dedupeKey = `lbw_review_bonus_${sellerPubkey.substring(0, 16)}_${milestone}`;
                    if (!localStorage.getItem(dedupeKey)) {
                        await LBW_Merits.awardMarketplaceMerit(
                            sellerPubkey,
                            { id: `review-bonus-${milestone}`, dTag: `review-bonus-${milestone}`, title: `${milestone} reseñas positivas` },
                            `review-bonus-${milestone}`
                        );
                        localStorage.setItem(dedupeKey, Date.now().toString());
                        console.log(`[Reviews] 🏅 Bonus LBWM (deferred): ${milestone} reseñas positivas → ${sellerPubkey.substring(0, 12)}`);
                    }
                }
            }
        } catch (e) {
            console.warn('[Reviews] Bonus check error:', e.message);
        }
    }

    // ── Fetch reseñas de un usuario ───────────────────────────
    // Devuelve array de { rating, comment, authorPubkey, listingTitle, role, created_at }
    async function getReviewsForUser(pubkey) {
        return new Promise(resolve => {
            const reviews = [];
            const timeout = setTimeout(() => resolve(reviews), 6000);

            const sub = LBW_Nostr.subscribe(
                {
                    kinds: [KIND_REVIEW],
                    '#p': [pubkey],
                    '#t': ['lbw-review'],
                    limit: 50
                },
                event => {
                    try {
                        const ratingTag = event.tags.find(t => t[0] === 'rating');
                        const roleTag   = event.tags.find(t => t[0] === 'role');
                        const titleTag  = event.tags.find(t => t[0] === 'listing-title');
                        const rating    = ratingTag ? parseInt(ratingTag[1]) : 0;
                        if (rating >= 1 && rating <= 5) {
                            reviews.push({
                                id:           event.id,
                                rating,
                                comment:      event.content || '',
                                authorPubkey: event.pubkey,
                                listingTitle: titleTag ? titleTag[1] : '',
                                role:         roleTag ? roleTag[1] : '',
                                created_at:   event.created_at
                            });
                        }
                    } catch (e) {}
                },
                () => {
                    clearTimeout(timeout);
                    resolve(reviews);
                }
            );

            // Resolver tras un tiempo razonable aunque no llegue EOSE
            setTimeout(() => {
                try { LBW_Nostr.unsubscribe(sub); } catch(e) {}
                clearTimeout(timeout);
                resolve(reviews);
            }, 5000);
        });
    }

    // ── Calcular puntuación media ─────────────────────────────
    function calcScore(reviews) {
        if (!reviews || reviews.length === 0) return { avg: 0, total: 0, positive: 0 };
        const sum      = reviews.reduce((acc, r) => acc + r.rating, 0);
        const positive = reviews.filter(r => r.rating >= POSITIVE_THRESHOLD).length;
        return {
            avg:      parseFloat((sum / reviews.length).toFixed(1)),
            total:    reviews.length,
            positive
        };
    }

    // ── Comprobar si ya reseñé esta transacción ───────────────
    function hasReviewed(listing, authorPubkey) {
        const dedupeKey = `lbw_review_${listing.id || listing.dTag}_${(authorPubkey || '').substring(0, 16)}`;
        return !!localStorage.getItem(dedupeKey);
    }

    // ── Renderizar estrellas ──────────────────────────────────
    function renderStars(rating, size) {
        size = size || '1rem';
        const full  = Math.round(rating);
        const empty = 5 - full;
        return `<span style="font-size:${size};line-height:1;">${'★'.repeat(full)}<span style="opacity:0.3;">${'★'.repeat(empty)}</span></span>`;
    }

    // ── Modal de reseña ───────────────────────────────────────
    function _removeReviewModal() {
        document.getElementById('lbwReviewModal')?.remove();
    }

    function showReviewModal({ listing, reviewedPubkey, reviewedName, role }) {
        _removeReviewModal();

        const modal = document.createElement('div');
        modal.id = 'lbwReviewModal';
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-content" style="position:relative;max-width:440px;">
                <button class="modal-close" onclick="document.getElementById('lbwReviewModal').remove()">×</button>
                <div class="modal-header">
                    <h3 style="color:var(--color-gold);margin-bottom:0.25rem;">⭐ Dejar reseña</h3>
                    <p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0;">
                        ${role === 'buyer' ? 'Reseña al vendedor' : 'Reseña al comprador'}: <strong>${_esc(reviewedName)}</strong>
                    </p>
                    <p style="color:var(--color-text-secondary);font-size:0.8rem;margin:0.25rem 0 0;">
                        Transacción: ${_esc(listing.title)}
                    </p>
                </div>
                <div class="modal-body">
                    <!-- Selector de estrellas -->
                    <div style="margin-bottom:1.25rem;">
                        <label style="display:block;color:var(--color-gold);font-size:0.9rem;margin-bottom:0.6rem;">Puntuación *</label>
                        <div id="lbwStarSelector" style="display:flex;gap:0.4rem;">
                            ${[1,2,3,4,5].map(n => `
                                <button type="button"
                                    data-star="${n}"
                                    data-lbw-action="reviewSelectStar"
                                    style="font-size:2rem;background:none;border:none;cursor:pointer;opacity:0.3;padding:0;line-height:1;transition:opacity 0.15s;">★</button>
                            `).join('')}
                        </div>
                        <div id="lbwStarLabel" style="font-size:0.8rem;color:var(--color-text-secondary);margin-top:0.3rem;min-height:1.2em;"></div>
                    </div>

                    <!-- Comentario -->
                    <div style="margin-bottom:1.25rem;">
                        <label style="display:block;color:var(--color-gold);font-size:0.9rem;margin-bottom:0.5rem;">Comentario (opcional)</label>
                        <textarea id="lbwReviewComment"
                            placeholder="Describe tu experiencia con esta transacción..."
                            maxlength="300"
                            style="width:100%;min-height:80px;padding:0.75rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-family:var(--font-display);resize:vertical;box-sizing:border-box;"></textarea>
                        <div style="text-align:right;font-size:0.7rem;color:var(--color-text-secondary);margin-top:0.2rem;">
                            <span id="lbwReviewCharCount">0</span>/300
                        </div>
                    </div>

                    <!-- Botones -->
                    <div style="display:flex;gap:0.75rem;">
                        <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('lbwReviewModal').remove()">
                            Ahora no
                        </button>
                        <button class="btn btn-primary" style="flex:1;" id="lbwReviewSubmitBtn"
                            onclick="LBW_Reviews._submitReview()">
                            ✅ Publicar reseña
                        </button>
                    </div>

                    <p style="font-size:0.7rem;color:var(--color-text-secondary);text-align:center;margin-top:0.75rem;">
                        La reseña se publica en la red Nostr y es permanente
                    </p>
                </div>
            </div>`;

        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) _removeReviewModal(); });

        // Contador de caracteres
        const textarea = document.getElementById('lbwReviewComment');
        const counter  = document.getElementById('lbwReviewCharCount');
        if (textarea && counter) {
            textarea.addEventListener('input', () => {
                counter.textContent = textarea.value.length;
            });
        }

        // Guardar contexto para el submit
        modal._context = { listing, reviewedPubkey, reviewedName, role };
        modal._selectedRating = 0;
    }

    // ── Selección de estrella (interacción UI) ────────────────
    function _selectStar(n) {
        const modal = document.getElementById('lbwReviewModal');
        if (!modal) return;
        modal._selectedRating = n;

        const labels = ['', 'Muy mala', 'Mala', 'Regular', 'Buena', 'Excelente'];
        const label  = document.getElementById('lbwStarLabel');
        if (label) label.textContent = labels[n] || '';

        document.querySelectorAll('#lbwStarSelector button').forEach(btn => {
            btn.style.opacity = parseInt(btn.dataset.star) <= n ? '1' : '0.25';
            btn.style.color   = parseInt(btn.dataset.star) <= n ? 'var(--color-gold)' : 'inherit';
        });
    }

    // ── Submit de reseña ──────────────────────────────────────
    async function _submitReview() {
        const modal = document.getElementById('lbwReviewModal');
        if (!modal) return;

        const { listing, reviewedPubkey, role } = modal._context;
        const rating  = modal._selectedRating;
        const comment = document.getElementById('lbwReviewComment')?.value?.trim() || '';

        if (!rating) {
            showNotification('Selecciona una puntuación', 'error');
            return;
        }

        const btn = document.getElementById('lbwReviewSubmitBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Publicando...'; }

        try {
            await publishReview({ reviewedPubkey, listing, rating, comment, role });
            _removeReviewModal();
            showNotification(`✅ Reseña publicada: ${STARS_EMOJI[rating]}`, 'success');
        } catch (e) {
            showNotification('❌ ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.textContent = '✅ Publicar reseña'; }
        }
    }

    // ── Render bloque de reseñas (para el modal de detalle) ───
    async function renderReviewsBlock(pubkey, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = '<div style="color:var(--color-text-secondary);font-size:0.8rem;text-align:center;padding:0.5rem;">Cargando reseñas...</div>';

        const reviews = await getReviewsForUser(pubkey);
        const score   = calcScore(reviews);

        if (reviews.length === 0) {
            container.innerHTML = '<div style="color:var(--color-text-secondary);font-size:0.8rem;text-align:center;padding:0.5rem;">Sin reseñas aún</div>';
            return;
        }

        // Ordenar: más recientes primero
        reviews.sort((a, b) => b.created_at - a.created_at);

        const reviewsHtml = reviews.slice(0, 5).map(r => `
            <div style="padding:0.6rem 0;border-bottom:1px solid var(--color-border);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.2rem;">
                    ${renderStars(r.rating, '0.85rem')}
                    <span style="font-size:0.7rem;color:var(--color-text-secondary);">
                        ${new Date(r.created_at * 1000).toLocaleDateString('es-ES')}
                    </span>
                </div>
                ${r.comment ? `<p style="font-size:0.8rem;color:var(--color-text-secondary);margin:0;line-height:1.4;">${_esc(r.comment)}</p>` : ''}
                ${r.listingTitle ? `<p style="font-size:0.7rem;color:var(--color-text-secondary);margin:0.2rem 0 0;opacity:0.7;">📦 ${_esc(r.listingTitle)}</p>` : ''}
            </div>
        `).join('');

        container.innerHTML = `
            <!-- Resumen -->
            <div style="display:flex;align-items:center;gap:1rem;padding:0.75rem;background:var(--color-bg-dark);border-radius:10px;margin-bottom:0.75rem;">
                <div style="text-align:center;">
                    <div style="font-size:2rem;font-weight:800;color:var(--color-gold);line-height:1;">${score.avg}</div>
                    <div style="margin-top:0.1rem;">${renderStars(score.avg, '0.9rem')}</div>
                </div>
                <div>
                    <div style="font-size:0.8rem;color:var(--color-text-primary);">${score.total} reseña${score.total !== 1 ? 's' : ''}</div>
                    <div style="font-size:0.75rem;color:#4CAF50;">👍 ${score.positive} positiva${score.positive !== 1 ? 's' : ''}</div>
                </div>
            </div>
            <!-- Lista -->
            <div>${reviewsHtml}</div>
            ${reviews.length > 5 ? `<div style="font-size:0.75rem;color:var(--color-text-secondary);text-align:center;margin-top:0.4rem;">+${reviews.length - 5} más</div>` : ''}
        `;
    }

    // ── Badge de puntuación (para las cards del marketplace) ──
    // Devuelve HTML de un badge pequeño con la puntuación media
    async function getScoreBadgeHtml(pubkey) {
        try {
            const reviews = await getReviewsForUser(pubkey);
            if (reviews.length === 0) return '';
            const score = calcScore(reviews);
            return `<span style="font-size:0.65rem;background:rgba(229,185,92,0.15);color:var(--color-gold);padding:0.15rem 0.5rem;border-radius:20px;border:1px solid rgba(229,185,92,0.3);">★ ${score.avg} (${score.total})</span>`;
        } catch (e) {
            return '';
        }
    }

    // ── Badge de ciudadanía (nivel/tier del vendedor) ─────────
    // Devuelve HTML de un badge con el nivel de ciudadanía del usuario
    function getCitizenshipBadgeHtml(pubkey) {
        try {
            if (typeof LBW_Merits === 'undefined') return '';
            const userData = LBW_Merits.getUserMerits(pubkey);
            if (!userData) return '';
            const level = userData.level || LBW_Merits.getCitizenshipLevel(userData.total || 0);
            if (!level) return '';
            // Solo mostrar nivel si tiene al menos E-Residency (>=100 meritos)
            if ((userData.total || 0) < 100) return '';
            const color = level.color || '#8BC34A';
            return `<span title="${level.name} · ${userData.total} LBWM" style="font-size:0.65rem;background:${color}18;color:${color};padding:0.15rem 0.5rem;border-radius:20px;border:1px solid ${color}60;cursor:default;">${level.emoji} ${level.name}</span>`;
        } catch (e) {
            return '';
        }
    }

    // ── API pública ───────────────────────────────────────────
    window.LBW_Reviews = {
        publishReview,
        getReviewsForUser,
        calcScore,
        hasReviewed,
        renderStars,
        renderReviewsBlock,
        getScoreBadgeHtml,
        getCitizenshipBadgeHtml,
        showReviewModal,
        // Internos expuestos para los onclick del modal
        _selectStar,
        _submitReview
    };

    console.log('✅ LBW_Reviews (NIP-85) listo');
})();

// ═══════════════════════════════════════════════════════════════════
// SEC-11/12: Event delegation for review star selection.
// ═══════════════════════════════════════════════════════════════════
(function installReviewsEventDelegation() {
    if (window.__lbwReviewsListenerInstalled) return;
    window.__lbwReviewsListenerInstalled = true;

    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-lbw-action]') : null;
        if (!el) return;
        if (el.dataset.lbwAction !== 'reviewSelectStar') return;
        try {
            var n = parseInt(el.dataset.star, 10);
            if (!isNaN(n) && n >= 1 && n <= 5) LBW_Reviews._selectStar(n);
        } catch (err) {
            console.error('[Reviews delegation] Error', err);
        }
    });
})();
