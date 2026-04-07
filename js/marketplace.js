// ========== MARKETPLACE — Phase 1 — Pure Nostr (NIP-99 / kind 30402) ==========

// ── Subcategorías por categoría ───────────────────────────
const SUBCATEGORIES = {
    'servicios':  ['General', 'Programación', 'Diseño', 'Consultoría', 'Marketing', 'Legal', 'Educación', 'Otros'],
    'productos':  ['General', 'Electrónica', 'Ropa', 'Hogar', 'Arte', 'Alimentación', 'Libros', 'Otros'],
    'trabajos':   ['General', 'Remoto', 'Presencial', 'Media jornada', 'Por proyecto', 'Becas', 'Otros'],
    'alquileres': ['General', 'Habitación', 'Piso/Casa', 'Local comercial', 'Terreno', 'Parking', 'Otros']
};

function getCategoryEmoji(category) {
    const emojis = { 'servicios': '💼', 'productos': '🛍️', 'trabajos': '💻', 'alquileres': '🏠' };
    return emojis[category] || '📦';
}

function getCategoryLabel(category) {
    const labels = { 'servicios': 'Servicios', 'productos': 'Productos', 'trabajos': 'Trabajos', 'alquileres': 'Alquileres' };
    return labels[category] || category;
}

// ── Subcategorías ─────────────────────────────────────────
function updateSubcategories() {
    const cat = document.getElementById('offerCategory')?.value || 'servicios';
    const subSelect = document.getElementById('offerSubcategory');
    if (!subSelect) return;
    const subs = SUBCATEGORIES[cat] || ['General', 'Otros'];
    subSelect.innerHTML = subs.map(s =>
        `<option value="${s.toLowerCase().replace(/[^a-z0-9]/g, '-')}">${s}</option>`
    ).join('');
}

// ── Preview imágenes múltiples ────────────────────────────
function previewOfferImages(event) {
    const MAX_FILES = 5;
    const MAX_SIZE  = 5 * 1024 * 1024;
    const files = Array.from(event.target.files || []);

    if (files.length > MAX_FILES) {
        showNotification(`Máximo ${MAX_FILES} imágenes. Se usarán las primeras ${MAX_FILES}.`, 'warning');
    }

    const valid = files.slice(0, MAX_FILES).filter(f => {
        if (!f.type.startsWith('image/')) {
            showNotification(`«${f.name}» no es una imagen válida.`, 'error');
            return false;
        }
        if (f.size > MAX_SIZE) {
            showNotification(`«${f.name}» supera los 5MB y se ha omitido.`, 'error');
            return false;
        }
        return true;
    });

    const preview = document.getElementById('imagesPreview');
    if (!preview) return;
    preview.innerHTML = '';
    preview.style.display = valid.length > 0 ? 'grid' : 'none';

    valid.forEach((file, i) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'position:relative;';

            const img = document.createElement('img');
            img.src = e.target.result;
            img.style.cssText = 'width:100%;height:80px;object-fit:cover;border-radius:8px;border:2px solid var(--color-border);display:block;';
            wrapper.appendChild(img);

            if (i === 0) {
                const badge = document.createElement('span');
                badge.textContent = 'Principal';
                badge.style.cssText = 'position:absolute;bottom:2px;left:2px;background:var(--color-gold);color:#000;font-size:0.6rem;padding:1px 5px;border-radius:4px;font-weight:700;pointer-events:none;';
                wrapper.appendChild(badge);
            }
            preview.appendChild(wrapper);
        };
        reader.readAsDataURL(file);
    });
}

function removeOfferImages() {
    const input = document.getElementById('offerImages');
    if (input) input.value = '';
    const preview = document.getElementById('imagesPreview');
    if (preview) { preview.innerHTML = ''; preview.style.display = 'none'; }
}

// Compatibilidad con código antiguo
function removeOfferImage() { removeOfferImages(); }

// ── Mostrar / cancelar formulario ─────────────────────────
function showNewOfferForm() {
    const form  = document.getElementById('newOfferForm');
    const title = document.getElementById('offerFormTitle');
    const btn   = document.getElementById('publishOfferBtn');
    if (title) title.textContent = 'Nueva Oferta';
    if (btn)   btn.textContent   = '📡 Publicar en Nostr';
    updateSubcategories();
    if (form) {
        form.style.display = 'block';
        form.scrollIntoView({ behavior: 'smooth' });
    }
}

function cancelOfferForm() {
    const form = document.getElementById('newOfferForm');
    if (form) form.style.display = 'none';

    ['offerTitle', 'offerDescription', 'offerPriceAmount', 'offerEmoji'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    const catSelect = document.getElementById('offerCategory');
    if (catSelect) { catSelect.value = 'servicios'; updateSubcategories(); }

    const currSelect = document.getElementById('offerPriceCurrency');
    if (currSelect) currSelect.value = 'sats';

    const freqSelect = document.getElementById('offerPriceFreq');
    if (freqSelect) freqSelect.value = '';

    const statusSelect = document.getElementById('offerStatus');
    if (statusSelect) statusSelect.value = 'active';

    const durSelect = document.getElementById('offerDuration');
    if (durSelect) durSelect.value = '0';

    removeOfferImages();
}

// ── Filtros de categoría ──────────────────────────────────
function filterOffers(category) {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector('[data-filter="' + category + '"]');
    if (activeBtn) activeBtn.classList.add('active');

    if (category === 'misiones') {
        document.querySelectorAll('.offer-card').forEach(c => {
            c.style.display = c.classList.contains('mission-card') ? '' : 'none';
        });
        const grid = document.getElementById('offersGrid');
        if (grid && !grid.querySelector('.mission-card') && typeof LBW_Missions !== 'undefined') {
            LBW_Missions.renderMissionCards();
        }
        return;
    }

    if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.filterMarketplace) {
        LBW_NostrBridge.filterMarketplace(category);
    }
    document.querySelectorAll('.mission-card').forEach(c => {
        c.style.display = (category === 'todos') ? '' : 'none';
    });

    // Reaplicar búsqueda si hay texto activo
    const searchVal = document.getElementById('marketSearch')?.value || '';
    if (searchVal) filterOffersBySearch(searchVal);
}

// ── Búsqueda por texto libre ──────────────────────────────
function filterOffersBySearch(query) {
    const q = (query || '').toLowerCase().trim();
    const activeCat = document.querySelector('.filter-btn.active')?.dataset?.filter || 'todos';

    document.querySelectorAll('.offer-card:not(.mission-card)').forEach(card => {
        // Filtro de categoría primero
        const catMatch = activeCat === 'todos' || card.dataset.category === activeCat;
        if (!catMatch) { card.style.display = 'none'; return; }

        // Sin búsqueda → mostrar todo
        if (!q) { card.style.display = ''; return; }

        const title = (card.dataset.title || '').toLowerCase();
        const desc  = (card.dataset.desc  || '').toLowerCase();
        const cat   = (card.dataset.category || '').toLowerCase();
        const tags  = (card.dataset.tags  || '').toLowerCase();

        card.style.display = (title.includes(q) || desc.includes(q) || cat.includes(q) || tags.includes(q))
            ? '' : 'none';
    });
}

// ── Carga ─────────────────────────────────────────────────
function loadOffers() {
    if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.refreshMarketplace) {
        LBW_NostrBridge.refreshMarketplace();
    }
}

function displayOffers() { loadOffers(); }

// ── Phase 3: NIP-15 Stalls + P2P Exchange — Tab switcher ─────────────────
function switchMarketTab(tab) {
    document.querySelectorAll('.market-tab-btn').forEach(btn => {
        const isActive = btn.dataset.marketTab === tab;
        btn.classList.toggle('active', isActive);
        // Update visual style
        btn.style.background = isActive ? 'rgba(229,185,92,0.15)' : 'transparent';
        btn.style.borderColor = isActive ? 'var(--color-gold)' : 'var(--color-border)';
        btn.style.color = isActive ? 'var(--color-gold)' : 'var(--color-text-secondary)';
        btn.style.fontWeight = isActive ? '600' : '400';
    });

    const searchBar  = document.getElementById('marketSearchBar');
    const filterBar  = document.getElementById('marketFilterBar');
    const offerBtn   = document.getElementById('newOfferBtn');
    const stallBtn   = document.getElementById('newStallBtn');
    const offersGrid = document.getElementById('offersGrid');
    const stallsGrid = document.getElementById('stallsGrid');
    const p2pView    = document.getElementById('p2pExchangeView');
    const newOfferForm = document.getElementById('newOfferForm');

    if (tab === 'tiendas') {
        if (typeof LBW_Stalls !== 'undefined') LBW_Stalls.showStallsView();
        if (searchBar) searchBar.style.display = 'none';
        if (filterBar) filterBar.style.display = 'none';
        if (offerBtn)  offerBtn.style.display = 'none';
        if (stallBtn)  stallBtn.style.display = '';
        if (offersGrid) offersGrid.style.display = 'none';
        if (p2pView)   p2pView.style.display = 'none';
        if (newOfferForm) newOfferForm.style.display = 'none';
        // Stop P2P subscription when leaving tab
        if (typeof LBW_P2P !== 'undefined') LBW_P2P.stop();
    } else if (tab === 'p2p') {
        // Hide marketplace elements
        if (searchBar) searchBar.style.display = 'none';
        if (filterBar) filterBar.style.display = 'none';
        if (offerBtn)  offerBtn.style.display = 'none';
        if (stallBtn)  stallBtn.style.display = 'none';
        if (offersGrid) offersGrid.style.display = 'none';
        if (stallsGrid) stallsGrid.style.display = 'none';
        if (newOfferForm) newOfferForm.style.display = 'none';
        // Show P2P view and start subscription
        if (p2pView) p2pView.style.display = 'block';
        if (typeof LBW_P2P !== 'undefined') LBW_P2P.start();
    } else {
        // tab === 'anuncios' (default)
        if (typeof LBW_Stalls !== 'undefined') LBW_Stalls.showOffersView();
        if (searchBar) searchBar.style.display = '';
        if (filterBar) filterBar.style.display = '';
        if (offerBtn)  offerBtn.style.display = '';
        if (stallBtn)  stallBtn.style.display = 'none';
        if (offersGrid) offersGrid.style.display = '';
        if (p2pView)   p2pView.style.display = 'none';
        // Stop P2P subscription when leaving tab
        if (typeof LBW_P2P !== 'undefined') LBW_P2P.stop();
    }
}

function openCreateStall() {
    if (!window.LBW_Nostr || !LBW_Nostr.isLoggedIn()) {
        showNotification('Debes iniciar sesion para crear una tienda', 'warning');
        return;
    }
    if (typeof LBW_Stalls !== 'undefined') LBW_Stalls.showCreateStallForm();
}

console.log('Marketplace Phase 1 + Phase 3 (NIP-15 Stalls) + P2P Exchange (NIP-69) listo');
