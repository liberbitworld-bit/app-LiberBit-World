let currentReplyTo = null; // { id, author, content }

// [bug 16] Safe JSON parse from localStorage. Returns fallback on null/corrupt data.
function _safeParseLS(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === undefined) return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null ? fallback : parsed;
    } catch (e) {
        console.warn(`[posts] localStorage[${key}] corrupt, using fallback:`, e.message);
        return fallback;
    }
}

// Reply mappings stored locally (postId -> { reply_to_id, reply_to_author, reply_to_content })
function getReplyMappings() {
    return _safeParseLS('liberbit_reply_mappings', {});
}

function saveReplyMapping(postId, replyData) {
    const mappings = getReplyMappings();
    mappings[postId] = replyData;
    localStorage.setItem('liberbit_reply_mappings', JSON.stringify(mappings));
}

async function publishPost() {
    const content = document.getElementById('newPostContent').value.trim();
    if (!content) {
        showNotification('Escribe algo', 'error');
        return;
    }

    try {
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        const postId = generateUUID();
        
        const postData = {
            id: postId,
            author_public_key: pubKey,
            author_name: currentUser.name,
            content: content
        };
        
        // Insert post into Supabase (without reply columns)
        const { data, error } = await supabaseClient
            .from('posts')
            .insert([postData])
            .select()
            .single();

        if (error) {
            console.error('Error publishing post:', error);
            showNotification('Error al publicar: ' + error.message, 'error');
            return;
        }
        
        // Save reply mapping locally if replying
        if (currentReplyTo) {
            saveReplyMapping(data.id || postId, {
                reply_to_id: currentReplyTo.id,
                reply_to_author: currentReplyTo.author,
                reply_to_content: currentReplyTo.content
            });
        }

        document.getElementById('newPostContent').value = '';
        cancelReply();
        showNotification('¡Publicado! ✨');
        await loadPosts();
    } catch (err) {
        console.error('Error:', err);
        showNotification('Error al publicar', 'error');
    }
}

async function loadPosts() {
    try {
        const currentUserPubKey = currentUser.pubkey || currentUser.publicKey;
        
        // Load posts from Supabase
        const { data, error } = await supabaseClient
            .from('posts')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            // Silent handling for DataCloneError (iframe limitation)
            if (error.message && error.message.includes('DataCloneError')) {
                console.log('Posts: iframe limitation, using cached data');
            } else {
                console.error('Error loading posts:', error.message || error);
            }
            allPosts = [];
        } else {
            // Get unique author public keys
            const authorKeys = [...new Set(data.map(p => p.author_public_key))];
            
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
            
            // Get all post IDs
            const postIds = data.map(p => p.id);
            
            // Fetch likes for all posts
            const { data: likesData } = await supabaseClient
                .from('post_likes')
                .select('post_id, user_public_key, user_name')
                .in('post_id', postIds);
            
            // Create likes map
            const likesMap = {};
            if (likesData) {
                likesData.forEach(like => {
                    if (!likesMap[like.post_id]) {
                        likesMap[like.post_id] = {
                            count: 0,
                            users: [],
                            likedByCurrentUser: false
                        };
                    }
                    likesMap[like.post_id].count++;
                    likesMap[like.post_id].users.push(like.user_name);
                    if (like.user_public_key === currentUserPubKey) {
                        likesMap[like.post_id].likedByCurrentUser = true;
                    }
                });
            }
            
            const replyMappings = getReplyMappings();
            
            allPosts = data.map(post => {
                const replyData = replyMappings[post.id] || {};
                return {
                    id: post.id,
                    author: post.author_name,
                    avatar_url: avatarMap[post.author_public_key] || null,
                    content: post.content,
                    created_at: new Date(post.created_at).getTime(),
                    likes: likesMap[post.id] || { count: 0, users: [], likedByCurrentUser: false },
                    reply_to_id: replyData.reply_to_id || null,
                    reply_to_author: replyData.reply_to_author || null,
                    reply_to_content: replyData.reply_to_content || null
                };
            });
        }

        // NOTE: Community chat is now rendered by LBW_NostrBridge._renderCommunityMessage()
        // loadPosts() only populates allPosts data (used by profile for post count)
        // It no longer renders to the DOM to avoid overwriting Nostr chat messages

    } catch (err) {
        if (!(err.message && err.message.includes('DataCloneError'))) {
            console.error('Error loading posts:', err.message);
        }
    }
}

function clearPost() {
    document.getElementById('newPostContent').value = '';
    cancelReply();
}

function replyToPost(postId, author, contentPreview) {
    currentReplyTo = { id: postId, author: author, content: contentPreview };
    document.getElementById('replyToAuthor').textContent = author;
    document.getElementById('replyToText').textContent = contentPreview;
    document.getElementById('replyPreview').style.display = 'flex';
    
    // Focus on textarea and scroll to compose
    const textarea = document.getElementById('newPostContent');
    textarea.focus();
    textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelReply() {
    currentReplyTo = null;
    document.getElementById('replyPreview').style.display = 'none';
    document.getElementById('replyToAuthor').textContent = '';
    document.getElementById('replyToText').textContent = '';
}

function scrollToPost(postId) {
    const postEl = document.getElementById('post-' + postId);
    if (postEl) {
        postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        postEl.style.transition = 'background 0.3s ease';
        postEl.style.background = 'rgba(229, 185, 92, 0.15)';
        setTimeout(() => { postEl.style.background = ''; }, 2000);
    }
}

// Toggle like on post
async function toggleLike(postId) {
    try {
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // Check if already liked
        const { data: existingLike } = await supabaseClient
            .from('post_likes')
            .select('id')
            .eq('post_id', postId)
            .eq('user_public_key', pubKey)
            .single();
        
        if (existingLike) {
            // Unlike - remove like
            const { error } = await supabaseClient
                .from('post_likes')
                .delete()
                .eq('post_id', postId)
                .eq('user_public_key', pubKey);
            
            if (error) throw error;
            
        } else {
            // Like - add like
            const { error } = await supabaseClient
                .from('post_likes')
                .insert({
                    id: generateUUID(),
                    post_id: postId,
                    user_public_key: pubKey,
                    user_name: currentUser.name
                });
            
            if (error) throw error;
        }
        
        // Reload posts to update like counts
        await loadPosts();
        
    } catch (err) {
        console.error('Error toggling like:', err);
        showNotification('Error al actualizar like', 'error');
    }
}

function logout() {
    if (confirm('¿Cerrar sesión? Asegúrate de tener tus claves guardadas.')) {
        // Limpiar estado de Nostr
        if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.logout) {
            try { LBW_Nostr.logout(); } catch(e) { console.warn('Error en Nostr logout:', e); }
        }
        
        // Limpiar estado de Governance
        if (typeof LBW_Governance !== 'undefined' && LBW_Governance.reset) {
            try { LBW_Governance.reset(); } catch(e) { console.warn('Error en Governance reset:', e); }
        }
        
        // Limpiar localStorage de sesión
        localStorage.removeItem('liberbit_keys');
        
        // Limpiar campos de input
        const privKeyInput = document.getElementById('existingPrivKey');
        if (privKeyInput) privKeyInput.value = '';
        const userNameInput = document.getElementById('userNameInput');
        if (userNameInput) userNameInput.value = '';
        
        currentUser = null;
        document.getElementById('userBadge').classList.add('hidden');
        document.getElementById('activeNodesCounterHeader').classList.add('hidden');
        document.getElementById('identitiesCounterHeader').classList.add('hidden');
        document.getElementById('relaysCounterHeader').classList.add('hidden');
        document.getElementById('citiesCounterHeader').classList.add('hidden');
        document.getElementById('activeCitiesCounterHeader').classList.add('hidden');
        // Stop active nodes counter interval
        if (activeNodesInterval) {
            clearInterval(activeNodesInterval);
            activeNodesInterval = null;
        }
        showSection('registrationSection');
        showNotification('Sesión cerrada');
    }
}

function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'Ahora';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
    return `${Math.floor(seconds / 86400)} días`;
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;')
        .replace(/\//g, '&#47;');
}

window.copyKey = function(id) {
    const text = document.getElementById(id).querySelector('span').textContent;
    navigator.clipboard.writeText(text).then(() => {
        showNotification('Copiado ✓');
    });
};

function copyNpubKey() {
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    navigator.clipboard.writeText(pubKey).then(() => {
        const btn = document.getElementById('copyNpubBtn');
        btn.textContent = '✅ Copiado';
        setTimeout(() => { btn.textContent = '📋 Copiar'; }, 2000);
        showNotification('Clave pública npub copiada ✓');
    });
}

function downloadKeys() {
    const content = `LiberBit World - Claves
=============================
Nombre: ${currentUser.name}
Fecha: ${new Date().toLocaleString()}

Clave Pública (npub):
${currentUser.publicKey}

Clave Privada (nsec):
${currentUser.privateKey}

⚠️ NUNCA compartas tu clave privada (nsec)
=============================`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `liberbit-${currentUser.name}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification('Claves descargadas 📥');
}

function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    if (type === 'error') notification.style.borderColor = '#ff4d4f';
    
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 3000);
}
