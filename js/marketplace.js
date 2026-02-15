// ========== MARKETPLACE FUNCTIONS ==========

function previewOfferImage(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file size (2MB max)
    if (file.size > 2 * 1024 * 1024) {
        showNotification('Imagen muy grande. Máximo 2MB', 'error');
        event.target.value = '';
        return;
    }

    // Validate file type
    if (!file.type.startsWith('image/')) {
        showNotification('Por favor selecciona una imagen válida', 'error');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        currentOfferImage = e.target.result;
        document.getElementById('previewImg').src = currentOfferImage;
        document.getElementById('imagePreview').style.display = 'block';
    };
    reader.readAsDataURL(file);
}

function removeOfferImage() {
    currentOfferImage = null;
    document.getElementById('offerImage').value = '';
    document.getElementById('imagePreview').style.display = 'none';
    document.getElementById('previewImg').src = '';
}

function showNewOfferForm() {
    editingOfferId = null;
    document.getElementById('offerFormTitle').textContent = 'Nueva Oferta';
    document.getElementById('publishOfferBtn').textContent = 'Publicar Oferta';
    document.getElementById('newOfferForm').style.display = 'block';
    document.getElementById('newOfferForm').scrollIntoView({ behavior: 'smooth' });
}

function cancelOfferForm() {
    editingOfferId = null;
    document.getElementById('newOfferForm').style.display = 'none';
    document.getElementById('offerFormTitle').textContent = 'Nueva Oferta';
    document.getElementById('publishOfferBtn').textContent = 'Publicar Oferta';
    // Clear form
    document.getElementById('offerTitle').value = '';
    document.getElementById('offerDescription').value = '';
    document.getElementById('offerPrice').value = '';
    document.getElementById('offerEmoji').value = '';
    document.getElementById('offerCategory').value = 'servicios';
    removeOfferImage();
}

async function publishOffer() {
    const category = document.getElementById('offerCategory').value;
    const title = document.getElementById('offerTitle').value.trim();
    const description = document.getElementById('offerDescription').value.trim();
    const price = document.getElementById('offerPrice').value.trim();
    const emoji = document.getElementById('offerEmoji').value.trim();

    if (!title || !description) {
        showNotification('Complete título y descripción', 'error');
        return;
    }

    const pubKey = currentUser.pubkey || currentUser.publicKey;

    try {
        if (editingOfferId) {
            // EDIT MODE - Update existing offer
            const { data, error } = await supabaseClient
                .from('offers')
                .update({
                    category: category,
                    title: title,
                    description: description,
                    price: parseFloat(price) || 0,
                    currency: 'LBWM',
                    image_data: currentOfferImage
                })
                .eq('id', editingOfferId)
                .select()
                .single();

            if (error) {
                console.error('Error updating offer:', error);
                showNotification('Error al actualizar oferta: ' + error.message, 'error');
                return;
            }
            showNotification('¡Oferta actualizada! ✅');
        } else {
            // CREATE MODE - New offer
            const { data, error } = await supabaseClient
                .from('offers')
                .insert([{
                    id: generateUUID(),
                    author_public_key: pubKey,
                    author_name: currentUser.name,
                    title: title,
                    description: description,
                    category: category,
                    price: parseFloat(price) || 0,
                    currency: 'LBWM',
                    contact_info: currentUser.name,
                    image_data: currentOfferImage
                }])
                .select()
                .single();

            if (error) {
                console.error('Error publishing offer:', error);
                showNotification('Error al publicar oferta: ' + error.message, 'error');
                return;
            }
            showNotification('¡Oferta publicada! 🎉');
        }
        
        cancelOfferForm();
        await loadOffers();
    } catch (err) {
        console.error('Error:', err);
        showNotification('Error al procesar oferta', 'error');
    }
}

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

async function loadOffers() {
    try {
        // Load offers from Supabase
        const { data, error } = await supabaseClient
            .from('offers')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            if (!(error.message && error.message.includes('DataCloneError'))) {
                console.error('Error loading offers:', error.message || error);
            }
            allOffers = [];
        } else {
            // Get unique author public keys
            const authorKeys = [...new Set(data.map(o => o.author_public_key))];
            
            // Fetch avatars for all authors
            const { data: usersData } = await supabaseClient
                .from('users')
                .select('public_key, avatar_url')
                .in('public_key', authorKeys);
            
            // Create avatar map
            const avatarMap = {};
            if (usersData) {
                usersData.forEach(user => {
                    avatarMap[user.public_key] = user.avatar_url;
                });
            }
            
            allOffers = data.map(offer => ({
                id: offer.id,
                category: offer.category,
                title: offer.title,
                description: offer.description,
                price: offer.price || 'A negociar',
                emoji: getCategoryEmoji(offer.category),
                image: offer.image_data,
                author: offer.author_name,
                authorId: offer.author_public_key,
                avatar_url: avatarMap[offer.author_public_key] || null,
                created_at: new Date(offer.created_at).getTime()
            }));
        }

        displayOffers();
    } catch (err) {
        if (!(err.message && err.message.includes('DataCloneError'))) {
            console.error('Error loading offers:', err.message);
        }
        allOffers = [];
        displayOffers();
    }
}

function displayOffers() {
    const container = document.getElementById('offersGrid');
    
    let offersToShow = allOffers;
    if (currentFilter !== 'todos') {
        offersToShow = allOffers.filter(o => o.category === currentFilter);
    }

    if (offersToShow.length === 0) {
        container.innerHTML = `
            <div class="placeholder" style="grid-column: 1/-1;">
                <h3>🏪 ${currentFilter === 'todos' ? 'Marketplace Vacío' : 'No hay ofertas en esta categoría'}</h3>
                <p>${currentFilter === 'todos' ? 'Sé el primero en publicar' : 'Prueba con otra categoría'}</p>
            </div>
        `;
        return;
    }

    const currentUserPubKey = currentUser.pubkey || currentUser.publicKey;
    
    container.innerHTML = offersToShow.map(offer => {
        const isOwnOffer = offer.authorId === currentUserPubKey;
        const avatarHtml = offer.avatar_url 
            ? `<img src="${offer.avatar_url}" class="offer-author-avatar" alt="${offer.author}">`
            : `<div class="offer-author-avatar-placeholder">👤</div>`;
        
        return `
            <div class="offer-card" ${!isOwnOffer ? `onclick="showOfferDetail('${offer.id}')"` : ''} style="cursor: ${!isOwnOffer ? 'pointer' : 'default'};">
                ${isOwnOffer ? `
                    <div style="position: absolute; top: 0.5rem; right: 0.5rem; z-index: 10; display: flex; gap: 0.5rem;">
                        <button onclick="editOffer('${offer.id}'); event.stopPropagation();" style="background: var(--color-gold); color: var(--color-teal-dark); border: none; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-weight: bold; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">✏️</button>
                        <button onclick="deleteOffer('${offer.id}'); event.stopPropagation();" style="background: var(--color-error); color: white; border: none; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-weight: bold; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">🗑️</button>
                    </div>
                ` : ''}
                <div class="offer-icon-wrapper" ${isOwnOffer ? `onclick="showOfferDetail('${offer.id}')"` : ''}>
                    ${offer.image ? `<img src="${offer.image}" alt="${escapeHtml(offer.title)}">` : ''}
                    <div class="emoji-icon" style="${offer.image ? 'text-shadow: 0 0 10px rgba(0,0,0,0.8); background: rgba(0,0,0,0.3); padding: 0.5rem; border-radius: 50%;' : ''}">${offer.emoji}</div>
                </div>
                <div class="offer-content" ${isOwnOffer ? `onclick="showOfferDetail('${offer.id}')"` : ''}>
                    <div class="offer-category-badge ${offer.category}">
                        ${getCategoryLabel(offer.category)}
                    </div>
                    <div class="offer-title">${escapeHtml(offer.title)}</div>
                    <div class="offer-description">${escapeHtml(offer.description)}</div>
                    <div class="offer-footer">
                        <div class="offer-price">${offer.price === 0 || !offer.price ? 'A negociar' : offer.price + ' LBWM'}</div>
                        <div class="offer-author-info">
                            ${avatarHtml}
                            <span class="offer-author">Por ${escapeHtml(offer.author)}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function filterOffers(category) {
    currentFilter = category;
    
    // Update active button
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-filter="${category}"]`).classList.add('active');
    
    displayOffers();
}

function editOffer(offerId) {
    const offer = allOffers.find(o => o.id === offerId);
    const currentUserPubKey = currentUser.pubkey || currentUser.publicKey;
    
    if (!offer || offer.authorId !== currentUserPubKey) {
        showNotification('No puedes editar esta oferta', 'error');
        return;
    }

    // Set editing mode
    editingOfferId = offerId;
    
    // Fill form with offer data
    document.getElementById('offerCategory').value = offer.category;
    document.getElementById('offerTitle').value = offer.title;
    document.getElementById('offerDescription').value = offer.description;
    document.getElementById('offerPrice').value = offer.price === 'A negociar' || offer.price === 0 ? '' : offer.price;
    document.getElementById('offerEmoji').value = offer.emoji || '';
    
    // Load existing image if any
    if (offer.image) {
        currentOfferImage = offer.image;
        document.getElementById('previewImg').src = offer.image;
        document.getElementById('imagePreview').style.display = 'block';
    }
    
    // Update UI
    document.getElementById('offerFormTitle').textContent = 'Editar Oferta';
    document.getElementById('publishOfferBtn').textContent = 'Guardar Cambios';
    document.getElementById('newOfferForm').style.display = 'block';
    document.getElementById('newOfferForm').scrollIntoView({ behavior: 'smooth' });
}

async function deleteOffer(offerId) {
    const offer = allOffers.find(o => o.id === offerId);
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    
    if (!offer || offer.authorId !== pubKey) {
        showNotification('No puedes eliminar esta oferta', 'error');
        return;
    }

    if (confirm(`¿Eliminar la oferta "${offer.title}"?`)) {
        try {
            const { error } = await supabaseClient
                .from('offers')
                .delete()
                .eq('id', offerId);

            if (error) {
                console.error('Error deleting offer:', error);
                showNotification('Error al eliminar oferta: ' + error.message, 'error');
                return;
            }

            showNotification('Oferta eliminada 🗑️');
            await loadOffers();
        } catch (err) {
            console.error('Error:', err);
            showNotification('Error al eliminar oferta', 'error');
        }
    }
}

function showOfferDetail(offerId) {
    const offer = allOffers.find(o => o.id === offerId);
    if (!offer) return;

    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `
        <div class="modal-content" style="position: relative;">
            <button class="modal-close" onclick="this.closest('.modal').remove()">×</button>
            <div class="modal-header">
                ${offer.image ? `
                    <img src="${offer.image}" alt="${escapeHtml(offer.title)}" style="width: 100%; height: 250px; object-fit: cover; margin-bottom: 1rem; border-radius: 12px;">
                ` : `
                    <div class="modal-icon">${offer.emoji}</div>
                `}
                <div class="offer-category-badge ${offer.category}">${getCategoryLabel(offer.category)}</div>
            </div>
            <div class="modal-body">
                <h2 style="color: var(--color-gold); margin-bottom: 1rem;">${escapeHtml(offer.title)}</h2>
                <p style="color: var(--color-text-secondary); margin-bottom: 1.5rem; line-height: 1.6;">
                    ${escapeHtml(offer.description)}
                </p>
                <div style="background: var(--color-bg-dark); padding: 1.5rem; border-radius: 12px; margin-bottom: 1.5rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <div style="font-size: 0.8rem; color: var(--color-text-secondary); margin-bottom: 0.25rem;">Precio</div>
                            <div style="font-size: 1.5rem; font-weight: 700; color: var(--color-gold);">${escapeHtml(offer.price)}</div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 0.8rem; color: var(--color-text-secondary); margin-bottom: 0.25rem;">Publicado por</div>
                            <div style="font-size: 1rem; font-weight: 600; color: var(--color-text-primary);">${escapeHtml(offer.author)}</div>
                        </div>
                    </div>
                </div>
                <div style="background: rgba(229, 185, 92, 0.1); padding: 1.25rem; border-radius: 12px; border: 1px solid var(--color-gold);">
                    <div style="font-size: 0.85rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">📞 Contacto</div>
                    <div style="font-size: 0.9rem; color: var(--color-text-primary);">
                        Envía un mensaje privado a <strong>${escapeHtml(offer.author)}</strong> para más información.
                    </div>
                </div>
                <div style="margin-top: 1.5rem; text-align: center;">
                    <button class="btn btn-primary" onclick="this.closest('.modal').remove(); startDirectMessage('${offer.authorId}', '${escapeHtml(offer.author)}')">
                        💬 Enviar Mensaje Privado
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    
    // Close on background click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}

console.log('✅ LiberBit World Listo');

