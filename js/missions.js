// ═══════════════════════════════════════════════════════════════
// LiberBit World — Sistema de Misiones (Merit Bounties)
// ═══════════════════════════════════════════════════════════════
// Misiones: La organización emite ofertas de méritos para tareas
// que necesita cubrir. Los usuarios las reclaman y completan.
// ═══════════════════════════════════════════════════════════════

const LBW_Missions = (function () {

    // ── State ────────────────────────────────────────────────
    let _missions = [];
    let _currentFilter = 'todas';
    let _isLoaded = false;

    // ── Constants ────────────────────────────────────────────
    const CATEGORY_META = {
        productiva:      { emoji: '🛠️', label: 'Productiva',      color: '#26A69A', weight: '×1.0' },
        economica:       { emoji: '💰', label: 'Económica',       color: '#E5B95C', weight: '×1.0' },
        responsabilidad: { emoji: '🔐', label: 'Responsabilidad', color: '#4CAF50', weight: '×1.2' },
        financiada:      { emoji: '⏳', label: 'Financiada',      color: '#FFB74D', weight: '×0.6' }
    };

    const MIN_CITIZENSHIP_TO_CREATE = 'Ciudadano Senior'; // Ciudadano Senior, Embajador, Gobernador
    const MIN_MERITS_TO_CREATE = 1000;

    // ── Helpers ──────────────────────────────────────────────
    function _esc(str) {
        if (!str) return '';
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function _myPubkey() {
        return LBW_Nostr?.isLoggedIn() ? LBW_Nostr.getPubkey() : (currentUser?.pubkey || '');
    }

    function _myMerits() {
        const el = document.getElementById('userTotalMerits');
        return parseInt(el?.textContent) || 0;
    }

    function _isGovernor() {
        return _myMerits() >= 3000;
    }

    function _canCreateMission() {
        return _myMerits() >= MIN_MERITS_TO_CREATE;
    }

    function _statusLabel(status) {
        const labels = {
            open:      { text: 'Abierta',    emoji: '🟢', color: '#4CAF50' },
            claimed:   { text: 'Reclamada',  emoji: '🟡', color: '#FF9800' },
            completed: { text: 'Completada', emoji: '✅', color: '#26A69A' },
            cancelled: { text: 'Cancelada',  emoji: '❌', color: '#FF5252' }
        };
        return labels[status] || labels.open;
    }

    function _formatDate(iso) {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch { return iso; }
    }

    function _daysUntil(deadline) {
        if (!deadline) return null;
        const diff = new Date(deadline) - new Date();
        return Math.ceil(diff / (1000 * 60 * 60 * 24));
    }

    // ── Supabase CRUD ─────────────────────────────────────────
    async function loadMissions() {
        try {
            const { data, error } = await supabaseClient
                .from('missions')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            _missions = data || [];
            _isLoaded = true;
            return _missions;
        } catch (e) {
            console.error('[Missions] Error loading:', e);
            _missions = [];
            _isLoaded = true;
            return [];
        }
    }

    async function createMission(data) {
        const pubkey = _myPubkey();
        if (!pubkey) throw new Error('No estás autenticado.');
        if (!_canCreateMission()) throw new Error(`Necesitas al menos ${MIN_MERITS_TO_CREATE} méritos para crear misiones.`);

        const mission = {
            title: data.title.trim(),
            description: data.description.trim(),
            merit_category: data.merit_category,
            merit_amount: parseInt(data.merit_amount),
            min_citizenship: data.min_citizenship || 'Amigo',
            deadline: data.deadline || null,
            delivery_instructions: data.delivery_instructions || '',
            status: _isGovernor() ? 'open' : 'pending_approval',
            creator_pubkey: pubkey,
            creator_name: currentUser?.name || pubkey.substring(0, 12),
            claimed_by_pubkey: null,
            claimed_at: null,
            delivery_url: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const { data: inserted, error } = await supabaseClient
            .from('missions')
            .insert(mission)
            .select()
            .single();

        if (error) throw error;
        _missions.unshift(inserted);
        return inserted;
    }

    async function claimMission(missionId) {
        const pubkey = _myPubkey();
        if (!pubkey) throw new Error('No estás autenticado.');

        const mission = _missions.find(m => m.id === missionId);
        if (!mission) throw new Error('Misión no encontrada.');
        if (mission.status !== 'open') throw new Error('Esta misión ya no está disponible.');
        if (mission.creator_pubkey === pubkey) throw new Error('No puedes reclamar tu propia misión.');

        // Check min citizenship
        if (mission.min_citizenship && mission.min_citizenship !== 'Amigo') {
            const minMerits = _minMeritsForCitizenship(mission.min_citizenship);
            if (_myMerits() < minMerits) {
                throw new Error(`Necesitas ser ${mission.min_citizenship} (${minMerits}+ méritos) para reclamar esta misión.`);
            }
        }

        const { data: updated, error } = await supabaseClient
            .from('missions')
            .update({
                status: 'claimed',
                claimed_by_pubkey: pubkey,
                claimed_by_name: currentUser?.name || pubkey.substring(0, 12),
                claimed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', missionId)
            .eq('status', 'open')
            .select()
            .single();

        if (error) throw error;
        const idx = _missions.findIndex(m => m.id === missionId);
        if (idx >= 0) _missions[idx] = updated;
        return updated;
    }

    async function submitDelivery(missionId, deliveryUrl) {
        const pubkey = _myPubkey();
        if (!pubkey) throw new Error('No estás autenticado.');

        const mission = _missions.find(m => m.id === missionId);
        if (!mission) throw new Error('Misión no encontrada.');
        if (mission.claimed_by_pubkey !== pubkey) throw new Error('No eres quien reclamó esta misión.');

        const { data: updated, error } = await supabaseClient
            .from('missions')
            .update({
                delivery_url: deliveryUrl,
                status: 'pending_review',
                updated_at: new Date().toISOString()
            })
            .eq('id', missionId)
            .select()
            .single();

        if (error) throw error;
        const idx = _missions.findIndex(m => m.id === missionId);
        if (idx >= 0) _missions[idx] = updated;
        return updated;
    }

    async function approveMission(missionId) {
        if (!_isGovernor()) throw new Error('Solo los Gobernadores pueden aprobar misiones.');
        const pubkey = _myPubkey();

        const mission = _missions.find(m => m.id === missionId);
        if (!mission) throw new Error('Misión no encontrada.');

        // If approving a pending_approval mission (making it open)
        if (mission.status === 'pending_approval') {
            const { data: updated, error } = await supabaseClient
                .from('missions')
                .update({ status: 'open', updated_at: new Date().toISOString() })
                .eq('id', missionId)
                .select().single();
            if (error) throw error;
            const idx = _missions.findIndex(m => m.id === missionId);
            if (idx >= 0) _missions[idx] = updated;
            return updated;
        }

        // If approving a pending_review mission (awarding merits)
        if (mission.status === 'pending_review') {
            if (mission.creator_pubkey === pubkey && !_isFounder()) {
                throw new Error('Un Gobernador no puede aprobar sus propias misiones.');
            }

            // Award merits to the claimant
            if (mission.claimed_by_pubkey && mission.merit_amount > 0) {
                await _awardMissionMerits(mission);
            }

            const { data: updated, error } = await supabaseClient
                .from('missions')
                .update({
                    status: 'completed',
                    approved_by_pubkey: pubkey,
                    completed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', missionId)
                .select().single();
            if (error) throw error;
            const idx = _missions.findIndex(m => m.id === missionId);
            if (idx >= 0) _missions[idx] = updated;
            return updated;
        }

        throw new Error('Esta misión no se puede aprobar en su estado actual.');
    }

    async function cancelMission(missionId) {
        if (!_isGovernor()) throw new Error('Solo los Gobernadores pueden cancelar misiones.');

        const { data: updated, error } = await supabaseClient
            .from('missions')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('id', missionId)
            .select().single();

        if (error) throw error;
        const idx = _missions.findIndex(m => m.id === missionId);
        if (idx >= 0) _missions[idx] = updated;
        return updated;
    }

    async function _awardMissionMerits(mission) {
        // Use existing merit contribution system
        const cat = mission.merit_category;
        const amount = mission.merit_amount;

        try {
            const { error } = await supabaseClient
                .from('merit_contributions')
                .insert({
                    pubkey: mission.claimed_by_pubkey,
                    value: amount,
                    category: cat,
                    description: `✅ Misión completada: ${mission.title}`,
                    payment_method: 'mission',
                    status: 'approved',
                    approved_by: _myPubkey(),
                    approved_at: new Date().toISOString(),
                    evidence_url: mission.delivery_url || '',
                    created_at: new Date().toISOString()
                });
            if (error) console.error('[Missions] Merit award error:', error);
        } catch (e) {
            console.error('[Missions] Failed to award merits:', e);
        }
    }

    function _isFounder() {
        const FOUNDER = 'npub172vh56w30sgev82c09lfujswr4u2djcd5w9vcj79qrmyk9jd459swvrkf5';
        try {
            const myNpub = LBW_Nostr?.pubkeyToNpub?.(_myPubkey());
            return myNpub === FOUNDER;
        } catch { return false; }
    }

    function _minMeritsForCitizenship(level) {
        const map = {
            'Amigo': 0, 'E-Residency': 100, 'Colaborador': 500,
            'Ciudadano Senior': 1000, 'Embajador': 2000, 'Gobernador': 3000
        };
        return map[level] || 0;
    }

    // ── Rendering ─────────────────────────────────────────────
    function renderMissionsTab() {
        const container = document.getElementById('lbwm-tab-misiones');
        if (!container) return;

        const pubkey = _myPubkey();
        const myMerits = _myMerits();
        const canCreate = _canCreateMission();
        const isGov = _isGovernor();

        // Filter missions
        let visible = _missions.filter(m => m.status !== 'cancelled' || isGov);

        if (_currentFilter === 'open')    visible = visible.filter(m => m.status === 'open');
        if (_currentFilter === 'claimed') visible = visible.filter(m => m.status === 'claimed' || m.status === 'pending_review');
        if (_currentFilter === 'completed') visible = visible.filter(m => m.status === 'completed');
        if (_currentFilter === 'mine')    visible = visible.filter(m => m.claimed_by_pubkey === pubkey || m.creator_pubkey === pubkey);
        if (_currentFilter === 'pending') visible = visible.filter(m => m.status === 'pending_approval' || m.status === 'pending_review');

        container.innerHTML = `
            <div class="lbwm-card">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:1.25rem;">
                    <div>
                        <h3 style="color:var(--color-gold);font-size:1.2rem;margin-bottom:0.3rem;">🎯 Misiones LiberBit</h3>
                        <p style="font-size:0.8rem;color:var(--color-text-secondary);">La organización publica tareas a cambio de méritos. Reclama una misión para contribuir.</p>
                    </div>
                    ${canCreate ? `<button class="btn btn-primary btn-sm" onclick="LBW_Missions.showCreateForm()" style="font-size:0.85rem;">+ Nueva Misión</button>` : `<div style="font-size:0.75rem;color:var(--color-text-secondary);padding:0.4rem 0.8rem;background:rgba(255,255,255,0.05);border-radius:20px;">Ciudadano Senior+ para crear</div>`}
                </div>

                <!-- Filter pills -->
                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1.25rem;" id="missionsFilterPills">
                    ${_filterPill('todas','Todas', _currentFilter === 'todas')}
                    ${_filterPill('open','🟢 Abiertas', _currentFilter === 'open')}
                    ${_filterPill('claimed','🟡 Reclamadas', _currentFilter === 'claimed')}
                    ${_filterPill('completed','✅ Completadas', _currentFilter === 'completed')}
                    ${_filterPill('mine','👤 Las mías', _currentFilter === 'mine')}
                    ${isGov ? _filterPill('pending','⏳ Pendientes', _currentFilter === 'pending') : ''}
                </div>

                <!-- Missions list -->
                <div id="missionsList">
                    ${visible.length === 0 ? _emptyState() : visible.map(m => _missionCard(m, pubkey, isGov)).join('')}
                </div>
            </div>`;
    }

    function _filterPill(value, label, active) {
        const style = active
            ? 'background:rgba(229,185,92,0.2);color:var(--color-gold);border:1px solid var(--color-gold);'
            : 'background:var(--color-bg-dark);color:var(--color-text-secondary);border:1px solid var(--color-border);';
        return `<button style="font-size:0.75rem;padding:0.3rem 0.7rem;border-radius:20px;cursor:pointer;${style}" onclick="LBW_Missions.setFilter('${value}')">${label}</button>`;
    }

    function _emptyState() {
        return `<div style="text-align:center;padding:3rem 1rem;color:var(--color-text-secondary);">
            <div style="font-size:2.5rem;margin-bottom:0.75rem;">🎯</div>
            <p style="font-size:0.95rem;font-weight:600;color:var(--color-text-primary);margin-bottom:0.3rem;">No hay misiones en este filtro</p>
            <p style="font-size:0.8rem;">Las misiones activas aparecerán aquí y en Networking</p>
        </div>`;
    }

    function _missionCard(m, myPubkey, isGov) {
        const cat = CATEGORY_META[m.merit_category] || CATEGORY_META.productiva;
        const status = _statusLabel(m.status);
        const isMine = m.claimed_by_pubkey === myPubkey;
        const isCreator = m.creator_pubkey === myPubkey;
        const days = _daysUntil(m.deadline);
        const deadlineHtml = m.deadline ? `<span style="font-size:0.72rem;color:${days !== null && days < 3 ? '#FF5252' : 'var(--color-text-secondary)'};">📅 ${days !== null && days < 0 ? 'Expirada' : days === 0 ? 'Hoy' : `${days}d`}</span>` : '';
        const isUrgent = days !== null && days <= 3 && days >= 0;

        const canClaim = m.status === 'open' && !isCreator && !isMine;
        const canDeliver = m.status === 'claimed' && isMine;
        const canApprove = isGov && (m.status === 'pending_approval' || m.status === 'pending_review') && !isCreator;
        const canCancel = isGov && (m.status === 'open' || m.status === 'claimed');

        return `
        <div style="border:1.5px solid ${isUrgent ? '#FF9800' : 'var(--color-border)'};border-radius:14px;padding:1.1rem;margin-bottom:0.85rem;background:${m.status === 'completed' ? 'rgba(38,166,154,0.05)' : 'var(--color-bg-dark)'};transition:all 0.2s;" data-mission-id="${m.id}" data-mission-category="${m.merit_category}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.75rem;flex-wrap:wrap;">
                <div style="flex:1;min-width:200px;">
                    <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.4rem;">
                        <span style="font-size:1.1rem;">${cat.emoji}</span>
                        <h4 style="font-size:0.95rem;font-weight:700;color:var(--color-text-primary);margin:0;">${_esc(m.title)}</h4>
                        ${isUrgent ? '<span style="font-size:0.65rem;background:#FF9800;color:#fff;padding:0.15rem 0.5rem;border-radius:10px;font-weight:700;">URGENTE</span>' : ''}
                    </div>
                    <p style="font-size:0.8rem;color:var(--color-text-secondary);margin:0 0 0.75rem;line-height:1.5;">${_esc(m.description)}</p>
                    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
                        <span style="font-size:0.72rem;background:rgba(229,185,92,0.12);color:var(--color-gold);padding:0.2rem 0.6rem;border-radius:12px;font-weight:700;border:1px solid rgba(229,185,92,0.25);">⭐ ${m.merit_amount} LBWM ${cat.weight}</span>
                        <span style="font-size:0.72rem;background:rgba(255,255,255,0.06);color:var(--color-text-secondary);padding:0.2rem 0.6rem;border-radius:12px;">${cat.label}</span>
                        ${m.min_citizenship && m.min_citizenship !== 'Amigo' ? `<span style="font-size:0.72rem;background:rgba(156,39,176,0.1);color:#CE93D8;padding:0.2rem 0.6rem;border-radius:12px;">min. ${m.min_citizenship}</span>` : ''}
                        ${deadlineHtml}
                        <span style="font-size:0.7rem;color:${status.color};font-weight:600;">${status.emoji} ${status.text}</span>
                    </div>
                </div>
                <!-- Actions -->
                <div style="display:flex;flex-direction:column;gap:0.4rem;align-items:flex-end;">
                    ${canClaim ? `<button onclick="LBW_Missions.claim('${m.id}')" style="font-size:0.78rem;padding:0.4rem 0.9rem;background:rgba(229,185,92,0.15);border:1.5px solid var(--color-gold);border-radius:8px;color:var(--color-gold);cursor:pointer;font-weight:700;">🎯 Reclamar</button>` : ''}
                    ${canDeliver ? `<button onclick="LBW_Missions.showDeliveryForm('${m.id}')" style="font-size:0.78rem;padding:0.4rem 0.9rem;background:rgba(38,166,154,0.15);border:1.5px solid var(--color-teal-light);border-radius:8px;color:var(--color-teal-light);cursor:pointer;font-weight:700;">📤 Entregar</button>` : ''}
                    ${canApprove ? `<button onclick="LBW_Missions.approve('${m.id}')" style="font-size:0.78rem;padding:0.4rem 0.9rem;background:rgba(76,175,80,0.15);border:1.5px solid #4CAF50;border-radius:8px;color:#4CAF50;cursor:pointer;font-weight:700;">✅ Aprobar</button>` : ''}
                    <button onclick="LBW_Missions.share('${m.id}')" style="font-size:0.75rem;padding:0.35rem 0.7rem;background:rgba(255,255,255,0.05);border:1px solid var(--color-border);border-radius:8px;color:var(--color-text-secondary);cursor:pointer;">🔗 Compartir</button>
                    ${canCancel ? `<button onclick="LBW_Missions.cancel('${m.id}')" style="font-size:0.72rem;padding:0.3rem 0.6rem;background:rgba(255,82,82,0.1);border:1px solid #FF5252;border-radius:8px;color:#FF5252;cursor:pointer;">✕ Cancelar</button>` : ''}
                </div>
            </div>
            ${m.claimed_by_name ? `<div style="margin-top:0.6rem;padding-top:0.6rem;border-top:1px solid var(--color-border);font-size:0.75rem;color:var(--color-text-secondary);">👤 Reclamada por <strong style="color:var(--color-text-primary);">${_esc(m.claimed_by_name)}</strong>${m.delivery_url ? ` · <a href="${_esc(m.delivery_url)}" target="_blank" style="color:var(--color-teal-light);">Ver entrega ↗</a>` : ''}</div>` : ''}
        </div>`;
    }

    // ── Networking Cards (compact) ────────────────────────────
    function renderMissionCards() {
        const grid = document.getElementById('offersGrid');
        if (!grid) return;

        const openMissions = _missions.filter(m => m.status === 'open');
        if (openMissions.length === 0) return;

        openMissions.forEach(m => {
            const cat = CATEGORY_META[m.merit_category] || CATEGORY_META.productiva;
            const days = _daysUntil(m.deadline);
            const deadlineBadge = m.deadline && days !== null && days <= 7
                ? `<span style="font-size:0.65rem;background:#FF9800;color:#fff;padding:0.1rem 0.4rem;border-radius:8px;">📅 ${days <= 0 ? 'Hoy' : days + 'd'}</span>` : '';

            const card = document.createElement('div');
            card.className = 'offer-card mission-card';
            card.dataset.category = 'misiones';
            card.style.cssText = 'background:linear-gradient(135deg,rgba(229,185,92,0.08) 0%,var(--color-bg-card) 100%);border:2px solid rgba(229,185,92,0.35);border-radius:16px;overflow:hidden;transition:all 0.3s;cursor:pointer;position:relative;';

            card.innerHTML = `
                <div style="background:rgba(229,185,92,0.1);padding:0.4rem 0.9rem;display:flex;align-items:center;justify-content:space-between;">
                    <span style="font-size:0.65rem;font-weight:700;color:var(--color-gold);letter-spacing:0.05em;">🎯 MISIÓN OFICIAL</span>
                    ${deadlineBadge}
                </div>
                <div style="padding:1rem;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem;">
                        <span style="font-size:1.4rem;">${cat.emoji}</span>
                        <span style="font-size:0.7rem;background:rgba(229,185,92,0.12);color:var(--color-gold);padding:0.2rem 0.6rem;border-radius:12px;border:1px solid rgba(229,185,92,0.25);">${cat.label}</span>
                    </div>
                    <h4 style="color:var(--color-text-primary);font-size:0.95rem;margin-bottom:0.4rem;line-height:1.4;">${_esc(m.title)}</h4>
                    <p style="color:var(--color-text-secondary);font-size:0.78rem;margin-bottom:0.85rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5;">${_esc(m.description)}</p>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
                        <span style="font-weight:800;color:var(--color-gold);font-size:1rem;">⭐ ${m.merit_amount} LBWM</span>
                        <span style="font-size:0.7rem;color:var(--color-text-secondary);">${cat.weight}</span>
                    </div>
                    <div style="display:flex;gap:0.5rem;">
                        <button onclick="event.stopPropagation();LBW_Missions.claim('${m.id}')" style="flex:1;padding:0.45rem;background:rgba(229,185,92,0.15);border:1.5px solid var(--color-gold);border-radius:8px;color:var(--color-gold);cursor:pointer;font-size:0.78rem;font-weight:700;">🎯 Reclamar</button>
                        <button onclick="event.stopPropagation();LBW_Missions.share('${m.id}')" style="padding:0.45rem 0.6rem;background:rgba(255,255,255,0.05);border:1px solid var(--color-border);border-radius:8px;color:var(--color-text-secondary);cursor:pointer;font-size:0.78rem;">🔗</button>
                    </div>
                </div>`;

            card.addEventListener('click', function (e) {
                if (e.target.tagName === 'BUTTON') return;
                _showMissionDetail(m);
            });

            grid.appendChild(card);
        });
    }

    function _showMissionDetail(m) {
        const cat = CATEGORY_META[m.merit_category] || CATEGORY_META.productiva;
        const status = _statusLabel(m.status);
        const days = _daysUntil(m.deadline);

        // Simple modal using existing pattern
        const existingModal = document.getElementById('missionDetailModal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'missionDetailModal';
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:600px;padding:2rem;position:relative;">
                <button class="modal-close" onclick="document.getElementById('missionDetailModal').remove()">✕</button>
                <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
                    <span style="font-size:0.7rem;font-weight:700;color:var(--color-gold);background:rgba(229,185,92,0.12);padding:0.2rem 0.7rem;border-radius:12px;border:1px solid rgba(229,185,92,0.3);">🎯 MISIÓN OFICIAL</span>
                    <span style="font-size:0.75rem;color:${status.color};font-weight:600;">${status.emoji} ${status.text}</span>
                </div>
                <h2 style="color:var(--color-text-primary);font-size:1.3rem;margin-bottom:0.75rem;">${_esc(m.title)}</h2>
                <p style="color:var(--color-text-secondary);font-size:0.9rem;line-height:1.7;margin-bottom:1.5rem;">${_esc(m.description)}</p>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1.5rem;">
                    <div style="padding:0.75rem;background:rgba(229,185,92,0.08);border-radius:10px;border:1px solid rgba(229,185,92,0.2);">
                        <div style="font-size:0.7rem;color:var(--color-text-secondary);margin-bottom:0.2rem;">Recompensa</div>
                        <div style="font-size:1.2rem;font-weight:800;color:var(--color-gold);">⭐ ${m.merit_amount} LBWM</div>
                        <div style="font-size:0.7rem;color:var(--color-text-secondary);">${cat.label} ${cat.weight}</div>
                    </div>
                    <div style="padding:0.75rem;background:rgba(255,255,255,0.04);border-radius:10px;border:1px solid var(--color-border);">
                        <div style="font-size:0.7rem;color:var(--color-text-secondary);margin-bottom:0.2rem;">Requisito mínimo</div>
                        <div style="font-size:0.95rem;font-weight:600;color:var(--color-text-primary);">${m.min_citizenship || 'Amigo'}</div>
                        ${m.deadline ? `<div style="font-size:0.7rem;color:${days !== null && days < 3 ? '#FF5252' : 'var(--color-text-secondary)'};">📅 Deadline: ${_formatDate(m.deadline)}</div>` : ''}
                    </div>
                </div>
                ${m.delivery_instructions ? `<div style="padding:0.85rem;background:rgba(38,166,154,0.08);border-radius:10px;border-left:3px solid var(--color-teal-light);margin-bottom:1.5rem;"><div style="font-size:0.75rem;font-weight:700;color:var(--color-teal-light);margin-bottom:0.3rem;">📋 Instrucciones de entrega</div><p style="font-size:0.85rem;color:var(--color-text-secondary);line-height:1.6;margin:0;">${_esc(m.delivery_instructions)}</p></div>` : ''}
                <div style="display:flex;gap:0.75rem;flex-wrap:wrap;">
                    ${m.status === 'open' && m.creator_pubkey !== _myPubkey() ? `<button onclick="document.getElementById('missionDetailModal').remove();LBW_Missions.claim('${m.id}')" class="btn btn-primary" style="flex:1;">🎯 Reclamar esta Misión</button>` : ''}
                    <button onclick="LBW_Missions.share('${m.id}')" class="btn btn-secondary">🔗 Compartir</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    // ── Share ─────────────────────────────────────────────────
    function share(missionId) {
        const m = _missions.find(x => x.id === missionId);
        if (!m) return;

        const cat = CATEGORY_META[m.merit_category] || CATEGORY_META.productiva;
        const deadlineStr = m.deadline ? `\n📅 Deadline: ${_formatDate(m.deadline)}` : '';
        const reqStr = m.min_citizenship && m.min_citizenship !== 'Amigo' ? `\n🛂 Requiere: ${m.min_citizenship}` : '';

        const text = `🎯 MISIÓN LIBERBIT WORLD\n\n${m.title}\n\n${m.description}\n\n${cat.emoji} Categoría: ${cat.label} ${cat.weight}\n⭐ Recompensa: ${m.merit_amount} LBWM${reqStr}${deadlineStr}\n\n¿Puedes completarla? → liberbitworld.org\n\n#LiberBitWorld #LBWM #Bitcoin #Nostr`;

        _showShareModal(text, m);
    }

    function _showShareModal(text, m) {
        const existing = document.getElementById('missionShareModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'missionShareModal';
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:520px;padding:2rem;">
                <button class="modal-close" onclick="document.getElementById('missionShareModal').remove()">✕</button>
                <h3 style="color:var(--color-gold);margin-bottom:1rem;">🔗 Compartir Misión</h3>
                
                <!-- Preview card -->
                <div id="missionSharePreview" style="background:linear-gradient(135deg,#0d1f2d 0%,#0a1520 100%);border:2px solid rgba(229,185,92,0.4);border-radius:16px;padding:1.5rem;margin-bottom:1.25rem;">
                    <div style="font-size:0.65rem;font-weight:800;color:var(--color-gold);letter-spacing:0.1em;margin-bottom:0.75rem;">🎯 MISIÓN · LIBERBIT WORLD</div>
                    <h4 style="color:#fff;font-size:1.05rem;margin-bottom:0.5rem;">${_esc(m.title)}</h4>
                    <p style="color:rgba(255,255,255,0.6);font-size:0.8rem;margin-bottom:1rem;line-height:1.5;">${_esc(m.description.substring(0, 120))}${m.description.length > 120 ? '...' : ''}</p>
                    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                        <span style="font-size:0.75rem;background:rgba(229,185,92,0.15);color:#E5B95C;padding:0.3rem 0.75rem;border-radius:20px;border:1px solid rgba(229,185,92,0.3);font-weight:700;">⭐ ${m.merit_amount} LBWM</span>
                        <span style="font-size:0.75rem;background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.7);padding:0.3rem 0.75rem;border-radius:20px;">${(CATEGORY_META[m.merit_category]||{}).label||m.merit_category}</span>
                        <span style="font-size:0.75rem;background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.5);padding:0.3rem 0.75rem;border-radius:20px;">liberbitworld.org</span>
                    </div>
                </div>

                <!-- Text area to copy -->
                <textarea id="missionShareText" style="width:100%;min-height:140px;padding:0.85rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:10px;color:var(--color-text-secondary);font-family:var(--font-mono);font-size:0.78rem;resize:vertical;line-height:1.6;">${text}</textarea>
                
                <div style="display:flex;gap:0.75rem;margin-top:1rem;flex-wrap:wrap;">
                    <button onclick="LBW_Missions._copyShare()" class="btn btn-primary" style="flex:1;">📋 Copiar texto</button>
                    <button onclick="LBW_Missions._shareTwitter('${m.id}')" style="flex:1;padding:0.6rem 1rem;background:rgba(29,161,242,0.15);border:1.5px solid rgba(29,161,242,0.5);border-radius:8px;color:#1DA1F2;cursor:pointer;font-weight:600;font-size:0.85rem;">𝕏 Twitter/X</button>
                    <button onclick="LBW_Missions._shareTelegram('${m.id}')" style="flex:1;padding:0.6rem 1rem;background:rgba(0,136,204,0.15);border:1.5px solid rgba(0,136,204,0.5);border-radius:8px;color:#0088CC;cursor:pointer;font-weight:600;font-size:0.85rem;">✈️ Telegram</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    function _copyShare() {
        const ta = document.getElementById('missionShareText');
        if (!ta) return;
        navigator.clipboard.writeText(ta.value).then(() => {
            showNotification('✅ Texto copiado al portapapeles', 'success');
        }).catch(() => {
            ta.select();
            document.execCommand('copy');
            showNotification('✅ Copiado', 'success');
        });
    }

    function _shareTwitter(missionId) {
        const ta = document.getElementById('missionShareText');
        const text = ta ? ta.value.substring(0, 280) : '';
        const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
        window.open(url, '_blank');
    }

    function _shareTelegram(missionId) {
        const ta = document.getElementById('missionShareText');
        const text = ta ? ta.value : '';
        const url = `https://t.me/share/url?url=${encodeURIComponent('https://liberbitworld.org')}&text=${encodeURIComponent(text)}`;
        window.open(url, '_blank');
    }

    // ── Create Form ───────────────────────────────────────────
    function showCreateForm() {
        if (!_canCreateMission()) {
            showNotification(`Necesitas al menos ${MIN_MERITS_TO_CREATE} méritos para crear misiones.`, 'error');
            return;
        }

        const existing = document.getElementById('missionCreateModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'missionCreateModal';
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:640px;padding:2rem;max-height:90vh;overflow-y:auto;">
                <button class="modal-close" onclick="document.getElementById('missionCreateModal').remove()">✕</button>
                <h2 style="color:var(--color-gold);margin-bottom:0.4rem;">🎯 Nueva Misión</h2>
                <p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1.5rem;">Publica una tarea que necesita la organización a cambio de méritos LBWM.</p>

                <div class="form-group" style="margin-bottom:1rem;">
                    <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Título *</label>
                    <input type="text" id="missionTitle" maxlength="80" placeholder="Ej: Traducir documentación al inglés" style="width:100%;padding:0.7rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);">
                </div>

                <div class="form-group" style="margin-bottom:1rem;">
                    <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Descripción * <span style="font-size:0.75rem;color:var(--color-text-secondary);">(qué hay que hacer, resultado esperado)</span></label>
                    <textarea id="missionDescription" maxlength="600" rows="4" placeholder="Describe la tarea con detalle..." style="width:100%;padding:0.7rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);resize:vertical;"></textarea>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;" class="mobile-grid-1col">
                    <div class="form-group">
                        <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Categoría *</label>
                        <select id="missionCategory" style="width:100%;padding:0.7rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);">
                            <option value="productiva">🛠️ Productiva ×1.0</option>
                            <option value="economica">💰 Económica ×1.0</option>
                            <option value="responsabilidad">🔐 Responsabilidad ×1.2</option>
                            <option value="financiada">⏳ Financiada ×0.6</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Méritos a otorgar *</label>
                        <input type="number" id="missionMeritAmount" min="10" max="5000" value="100" style="width:100%;padding:0.7rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);">
                    </div>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;" class="mobile-grid-1col">
                    <div class="form-group">
                        <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Ciudadanía mínima</label>
                        <select id="missionMinCitizenship" style="width:100%;padding:0.7rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);">
                            <option value="Amigo">👋 Amigo (cualquiera)</option>
                            <option value="E-Residency">🪪 E-Residency (100+)</option>
                            <option value="Colaborador">🤝 Colaborador (500+)</option>
                            <option value="Ciudadano Senior">🛂 Ciudadano Senior (1000+)</option>
                            <option value="Embajador">🌍 Embajador (2000+)</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Deadline (opcional)</label>
                        <input type="date" id="missionDeadline" style="width:100%;padding:0.7rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);">
                    </div>
                </div>

                <div class="form-group" style="margin-bottom:1.5rem;">
                    <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Instrucciones de entrega <span style="font-size:0.75rem;color:var(--color-text-secondary);">(opcional — cómo entregar el resultado)</span></label>
                    <textarea id="missionDeliveryInstructions" maxlength="300" rows="2" placeholder="Ej: Subir a GitHub y enviar el link, o contactar por DM..." style="width:100%;padding:0.7rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);resize:vertical;"></textarea>
                </div>

                ${!_isGovernor() ? `<div style="padding:0.75rem;background:rgba(255,152,0,0.1);border:1px solid rgba(255,152,0,0.3);border-radius:8px;margin-bottom:1.25rem;font-size:0.8rem;color:#FFB74D;">⚠️ Tu misión quedará <strong>pendiente de aprobación</strong> por un Gobernador antes de publicarse.</div>` : ''}

                <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                    <button onclick="document.getElementById('missionCreateModal').remove()" class="btn btn-secondary">Cancelar</button>
                    <button onclick="LBW_Missions.submitCreate()" class="btn btn-primary">🚀 Publicar Misión</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    async function submitCreate() {
        const title = document.getElementById('missionTitle')?.value.trim();
        const description = document.getElementById('missionDescription')?.value.trim();
        const category = document.getElementById('missionCategory')?.value;
        const amount = parseInt(document.getElementById('missionMeritAmount')?.value);
        const minCitizenship = document.getElementById('missionMinCitizenship')?.value;
        const deadline = document.getElementById('missionDeadline')?.value;
        const deliveryInstructions = document.getElementById('missionDeliveryInstructions')?.value.trim();

        if (!title || title.length < 5) { showNotification('El título es demasiado corto.', 'error'); return; }
        if (!description || description.length < 20) { showNotification('La descripción es demasiado corta (mín. 20 caracteres).', 'error'); return; }
        if (!amount || amount < 10 || amount > 5000) { showNotification('Los méritos deben estar entre 10 y 5000.', 'error'); return; }

        const btn = document.querySelector('#missionCreateModal .btn-primary');
        if (btn) { btn.disabled = true; btn.textContent = 'Publicando...'; }

        try {
            await createMission({ title, description, merit_category: category, merit_amount: amount, min_citizenship: minCitizenship, deadline: deadline || null, delivery_instructions: deliveryInstructions });
            document.getElementById('missionCreateModal')?.remove();
            showNotification(_isGovernor() ? '🎯 ¡Misión publicada!' : '📤 Misión enviada, pendiente de aprobación por un Gobernador.', 'success');
            renderMissionsTab();
            // Refresh networking if visible
            if (document.getElementById('networkingSection')?.classList.contains('active')) {
                _injectMissionsIntoNetworking();
            }
        } catch (e) {
            showNotification('❌ ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.textContent = '🚀 Publicar Misión'; }
        }
    }

    // ── Delivery Form ─────────────────────────────────────────
    function showDeliveryForm(missionId) {
        const existing = document.getElementById('missionDeliveryModal');
        if (existing) existing.remove();

        const m = _missions.find(x => x.id === missionId);
        if (!m) return;

        const modal = document.createElement('div');
        modal.id = 'missionDeliveryModal';
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:500px;padding:2rem;">
                <button class="modal-close" onclick="document.getElementById('missionDeliveryModal').remove()">✕</button>
                <h3 style="color:var(--color-gold);margin-bottom:0.5rem;">📤 Entregar: ${_esc(m.title)}</h3>
                <p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1.25rem;">Adjunta el link a tu entrega para que un Gobernador la revise y apruebe los méritos.</p>
                ${m.delivery_instructions ? `<div style="padding:0.75rem;background:rgba(38,166,154,0.08);border-radius:8px;margin-bottom:1rem;font-size:0.8rem;color:var(--color-teal-light);"><strong>📋 Instrucciones:</strong> ${_esc(m.delivery_instructions)}</div>` : ''}
                <div class="form-group" style="margin-bottom:1.25rem;">
                    <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">URL de entrega *</label>
                    <input type="url" id="deliveryUrl" placeholder="https://github.com/... o enlace a tu trabajo" style="width:100%;padding:0.7rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);">
                    <small style="color:var(--color-text-secondary);font-size:0.75rem;">GitHub, Notion, Google Drive, vídeo, etc.</small>
                </div>
                <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                    <button onclick="document.getElementById('missionDeliveryModal').remove()" class="btn btn-secondary">Cancelar</button>
                    <button onclick="LBW_Missions.submitDeliveryForm('${missionId}')" class="btn btn-primary">📤 Enviar Entrega</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    async function submitDeliveryForm(missionId) {
        const url = document.getElementById('deliveryUrl')?.value.trim();
        if (!url) { showNotification('Introduce la URL de tu entrega.', 'error'); return; }

        const btn = document.querySelector('#missionDeliveryModal .btn-primary');
        if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }

        try {
            await submitDelivery(missionId, url);
            document.getElementById('missionDeliveryModal')?.remove();
            showNotification('✅ Entrega enviada. Un Gobernador la revisará y aprobará los méritos.', 'success');
            renderMissionsTab();
        } catch (e) {
            showNotification('❌ ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.textContent = '📤 Enviar Entrega'; }
        }
    }

    // ── Public Actions ────────────────────────────────────────
    async function claim(missionId) {
        if (!LBW_Nostr?.isLoggedIn()) { showNotification('Debes iniciar sesión para reclamar misiones.', 'error'); return; }
        try {
            await claimMission(missionId);
            showNotification('🎯 ¡Misión reclamada! Complétala y entrega el resultado.', 'success');
            renderMissionsTab();
            // Close detail modal if open
            document.getElementById('missionDetailModal')?.remove();
            // Refresh networking
            if (document.getElementById('networkingSection')?.classList.contains('active')) {
                _injectMissionsIntoNetworking();
            }
        } catch (e) {
            showNotification('❌ ' + e.message, 'error');
        }
    }

    async function approve(missionId) {
        try {
            const m = await approveMission(missionId);
            const wasApproval = m.status === 'open';
            showNotification(wasApproval ? '✅ Misión aprobada y publicada.' : '✅ Misión completada. Méritos asignados.', 'success');
            renderMissionsTab();
        } catch (e) {
            showNotification('❌ ' + e.message, 'error');
        }
    }

    async function cancel(missionId) {
        if (!confirm('¿Cancelar esta misión?')) return;
        try {
            await cancelMission(missionId);
            showNotification('Misión cancelada.', 'info');
            renderMissionsTab();
        } catch (e) {
            showNotification('❌ ' + e.message, 'error');
        }
    }

    function setFilter(filter) {
        _currentFilter = filter;
        renderMissionsTab();
    }

    // ── Networking integration ────────────────────────────────
    function _injectMissionsIntoNetworking() {
        // Remove existing mission cards
        document.querySelectorAll('#offersGrid .mission-card').forEach(c => c.remove());

        const currentFilter = document.querySelector('[data-filter].active')?.dataset.filter || 'todos';
        if (currentFilter === 'todos' || currentFilter === 'misiones') {
            renderMissionCards();
        }
    }

    // Called when networking section opens
    async function onNetworkingOpen() {
        if (!_isLoaded) {
            await loadMissions();
        }
        _injectMissionsIntoNetworking();
    }

    // ── Init ──────────────────────────────────────────────────
    async function init() {
        await loadMissions();
        console.log(`✅ Missions loaded: ${_missions.length}`);
    }

    // ── Public API ────────────────────────────────────────────
    return {
        init,
        loadMissions,
        renderMissionsTab,
        renderMissionCards,
        onNetworkingOpen,
        showCreateForm,
        submitCreate,
        claim,
        approve,
        cancel,
        share,
        setFilter,
        showDeliveryForm,
        submitDeliveryForm,
        _copyShare,
        _shareTwitter,
        _shareTelegram,
        getMissions: () => _missions,
        getOpenCount: () => _missions.filter(m => m.status === 'open').length
    };
})();

console.log('✅ LBW Missions loaded');
