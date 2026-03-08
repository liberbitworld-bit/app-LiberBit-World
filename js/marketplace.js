// ========== MARKETPLACE — Pure Nostr (NIP-99 / kind 30402) ==========

function getCategoryEmoji(category) {
    const emojis = {
        'servicios': '💼',
        'productos': '🛍️',
        'trabajos': '💻',
        'alquileres': '🏠'
    };
    return emojis[category] || '📦';
}

function getCategoryLabel(category) {
    const labels = {
        'servicios': 'Servicios',
        'productos': 'Productos',
        'trabajos': 'Trabajos',
        'alquileres': 'Alquileres'
    };
    return labels[category] || category;
}

function previewOfferImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        showNotification('Imagen muy grande. Máximo 5MB', 'error');
        event.target.value = '';
        return;
    }
    if (!file.type.startsWith('image/')) {
        showNotification('Por favor selecciona una imagen válida', 'error');
        event.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        const previewImg = document.getElementById('previewImg');
        const imagePreview = document.getElementById('imagePreview');
        if (previewImg) previewImg.src = e.target.result;
        if (imagePreview) imagePreview.style.display = 'block';
    };
    reader.readAsDataURL(file);
}

function removeOfferImage() {
    const offerImage = document.getElementById('offerImage');
    const imagePreview = document.getElementById('imagePreview');
    const previewImg = document.getElementById('previewImg');
    if (offerImage) offerImage.value = '';
    if (imagePreview) imagePreview.style.display = 'none';
    if (previewImg) previewImg.src = '';
}

function showNewOfferForm() {
    const form = document.getElementById('newOfferForm');
    const title = document.getElementById('offerFormTitle');
    const btn = document.getElementById('publishOfferBtn');
    if (title) title.textContent = 'Nueva Oferta';
    if (btn) btn.textContent = '📡 Publicar en Nostr';
    if (form) {
        form.style.display = 'block';
        form.scrollIntoView({ behavior: 'smooth' });
    }
}

function cancelOfferForm() {
    const form = document.getElementById('newOfferForm');
    if (form) form.style.display = 'none';
    ['offerTitle', 'offerDescription', 'offerPrice', 'offerEmoji'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const catSelect = document.getElementById('offerCategory');
    if (catSelect) catSelect.value = 'servicios';
    removeOfferImage();
}

function filterOffers(category) {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector('[data-filter="' + category + '"]');
    if (activeBtn) activeBtn.classList.add('active');

    if (category === 'misiones') {
        // Show only mission cards
        document.querySelectorAll('.offer-card').forEach(c => {
            c.style.display = c.classList.contains('mission-card') ? '' : 'none';
        });
        // Inject if none yet
        const grid = document.getElementById('offersGrid');
        if (grid && !grid.querySelector('.mission-card') && typeof LBW_Missions !== 'undefined') {
            LBW_Missions.renderMissionCards();
        }
        return;
    }

    if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.filterMarketplace) {
        LBW_NostrBridge.filterMarketplace(category);
    }
    // Mission cards: show only when 'todos', hide for specific categories
    document.querySelectorAll('.mission-card').forEach(c => {
        c.style.display = (category === 'todos') ? '' : 'none';
    });
}

function loadOffers() {
    if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.refreshMarketplace) {
        LBW_NostrBridge.refreshMarketplace();
    }
}

function displayOffers() {
    loadOffers();
}

console.log('✅ Marketplace (Nostr mode) listo');
