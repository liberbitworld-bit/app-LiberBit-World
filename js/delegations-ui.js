// ============================================================
// LiberBit World — Delegations UI (delegations-ui.js)
//
// UI para el sistema de delegación de voto (liquid democracy).
// Expone funciones globales llamadas desde onclick en index.html.
//
// Dependencias: LBW_Delegations (js/nostr-delegations.js)
//               LBW_Nostr (js/nostr.js)
//               showNotification (js/posts.js)
// ============================================================

(function () {
    'use strict';

    let _autoRefreshHooked = false;

    // ── Helpers ──────────────────────────────────────────────
    function _truncateNpub(npub) {
        if (!npub) return '—';
        return npub.length > 18 ? npub.substring(0, 14) + '…' : npub;
    }

    function _safeNpub(hex) {
        if (!hex) return null;
        try {
            if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.pubkeyToNpub) {
                return LBW_Nostr.pubkeyToNpub(hex);
            }
        } catch (e) {}
        return null;
    }

    function _esc(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        }[c]));
    }

    function _isLoggedIn() {
        return typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn();
    }

    // ── Entry point — called from openSubApp('delegations') ──
    window.loadDelegationsUI = function () {
        _hookAutoRefresh();
        _renderMyDelegation();
        _renderReceivedDelegations();
    };

    // Subscribe once to delegation changes to auto-refresh UI when
    // new events arrive from the relay.
    function _hookAutoRefresh() {
        if (_autoRefreshHooked) return;
        if (typeof LBW_Delegations === 'undefined') return;
        LBW_Delegations.subscribeDelegations(() => {
            // Only refresh if the delegations section is currently visible
            const section = document.getElementById('delegationsSection');
            if (section && section.classList.contains('active')) {
                _renderMyDelegation();
                _renderReceivedDelegations();
            }
        });
        _autoRefreshHooked = true;
    }

    // ── Render: My current delegation ────────────────────────
    function _renderMyDelegation() {
        const container = document.getElementById('myDelegationCard');
        if (!container) return;

        if (!_isLoggedIn()) {
            container.innerHTML = `
                <div style="padding: 2rem; text-align: center; color: var(--color-text-secondary);">
                    <p style="font-size: 1.5rem; margin-bottom: 0.5rem;">🔒</p>
                    <p>Inicia sesión para gestionar tu delegación</p>
                </div>`;
            return;
        }

        if (typeof LBW_Delegations === 'undefined') {
            container.innerHTML = `<p style="color: var(--color-text-secondary); padding: 1rem;">Módulo de delegaciones no cargado</p>`;
            return;
        }

        const mine = LBW_Delegations.getMyDelegation('global');

        if (!mine) {
            container.innerHTML = `
                <div style="text-align: center; padding: 1.5rem;">
                    <p style="font-size: 2rem; margin-bottom: 0.5rem;">🔓</p>
                    <p style="color: var(--color-text-primary); font-weight: 600; margin-bottom: 0.5rem;">Sin delegación activa</p>
                    <p style="color: var(--color-text-secondary); font-size: 0.9rem; margin-bottom: 1.5rem;">
                        Tu voto solo cuenta cuando votas directamente en una propuesta.
                    </p>
                    <button class="btn btn-primary" onclick="openDelegateModal()">
                        🗳️ Delegar mi voto
                    </button>
                </div>`;
            return;
        }

        const delegateNpub = mine.delegateNpub || _safeNpub(mine.delegate) || mine.delegate;
        const npubShort = _truncateNpub(delegateNpub);
        const ts = new Date(mine.created_at * 1000).toLocaleString('es-ES', {
            day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        container.innerHTML = `
            <div style="padding: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1.25rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--color-border);">
                    <div style="
                        width: 48px; height: 48px; border-radius: 50%;
                        background: linear-gradient(135deg, var(--color-teal) 0%, var(--color-teal-light) 100%);
                        display: flex; align-items: center; justify-content: center;
                        font-size: 1.5rem; flex-shrink: 0;
                    ">🗳️</div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="color: var(--color-text-secondary); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem;">
                            Delegado en
                        </div>
                        <div style="font-family: var(--font-mono); color: var(--color-gold); font-size: 0.85rem; word-break: break-all;" title="${_esc(delegateNpub)}">
                            ${_esc(npubShort)}
                        </div>
                        <div style="color: var(--color-text-secondary); font-size: 0.7rem; margin-top: 0.25rem;">
                            Desde ${_esc(ts)}
                        </div>
                    </div>
                </div>

                ${mine.note ? `
                <div style="padding: 0.75rem; background: rgba(44, 95, 111, 0.15); border-radius: 8px; margin-bottom: 1.25rem; font-size: 0.85rem; color: var(--color-text-secondary); font-style: italic;">
                    "${_esc(mine.note)}"
                </div>` : ''}

                <p style="color: var(--color-text-secondary); font-size: 0.85rem; margin-bottom: 1.5rem; line-height: 1.5;">
                    Tu poder de voto fluye a esta persona en <strong>todas las propuestas</strong> en las que no votes directamente. Si votas, tu voto directo prevalece.
                </p>

                <div style="display: flex; gap: 0.75rem;">
                    <button class="btn btn-secondary" onclick="openDelegateModal()" style="flex: 1;">
                        🔄 Cambiar
                    </button>
                    <button class="btn btn-secondary" onclick="confirmRevokeDelegation()" style="flex: 1; color: #ff6b6b; border-color: rgba(255, 107, 107, 0.4);">
                        🚫 Revocar
                    </button>
                </div>
            </div>`;
    }

    // ── Render: Who delegated to me ──────────────────────────
    function _renderReceivedDelegations() {
        const container = document.getElementById('receivedDelegationsCard');
        if (!container) return;

        if (!_isLoggedIn() || typeof LBW_Delegations === 'undefined') {
            container.innerHTML = '';
            return;
        }

        const myPubkey = LBW_Nostr.getPubkey();
        const delegators = LBW_Delegations.getDelegatorsOf(myPubkey);

        if (!delegators || delegators.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 1.5rem; color: var(--color-text-secondary);">
                    <p style="font-size: 1.5rem; margin-bottom: 0.5rem;">🤝</p>
                    <p style="font-size: 0.9rem;">
                        Aún nadie te ha delegado su voto.
                    </p>
                    <p style="font-size: 0.8rem; margin-top: 0.5rem;">
                        Cuando alguien confíe en ti para votar en su nombre, aparecerá aquí.
                    </p>
                </div>`;
            return;
        }

        const rows = delegators.map(({ delegator, scope }) => {
            const npub = _safeNpub(delegator);
            const shown = _truncateNpub(npub || delegator);
            return `
                <div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; background: rgba(44, 95, 111, 0.1); border-radius: 8px; border: 1px solid var(--color-border);">
                    <div style="
                        width: 32px; height: 32px; border-radius: 50%;
                        background: var(--color-teal-dark);
                        display: flex; align-items: center; justify-content: center;
                        font-size: 0.9rem; flex-shrink: 0;
                    ">👤</div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--color-text-primary); word-break: break-all;" title="${_esc(npub || delegator)}">
                            ${_esc(shown)}
                        </div>
                        <div style="font-size: 0.7rem; color: var(--color-text-secondary); margin-top: 0.15rem;">
                            ${scope === 'global' ? 'Todas las propuestas' : _esc(scope)}
                        </div>
                    </div>
                </div>`;
        }).join('');

        container.innerHTML = `
            <div style="padding: 0.5rem;">
                <p style="color: var(--color-text-primary); font-weight: 600; margin-bottom: 1rem;">
                    ${delegators.length} ${delegators.length === 1 ? 'persona confía' : 'personas confían'} en ti
                </p>
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                    ${rows}
                </div>
                <p style="color: var(--color-text-secondary); font-size: 0.8rem; margin-top: 1rem; font-style: italic;">
                    Tu voto en cada propuesta sumará también el peso de estas personas (manteniendo el bloque de cada delegador).
                </p>
            </div>`;
    }

    // ── Modal: Delegate to someone ───────────────────────────
    window.openDelegateModal = function () {
        if (!_isLoggedIn()) {
            showNotification('Inicia sesión primero.', 'error');
            return;
        }
        const modal = document.getElementById('delegateModal');
        if (!modal) return;
        const input = document.getElementById('delegateInput');
        const note  = document.getElementById('delegateNote');
        if (input) input.value = '';
        if (note)  note.value  = '';
        modal.classList.remove('hidden');
    };

    window.closeDelegateModal = function () {
        const modal = document.getElementById('delegateModal');
        if (modal) modal.classList.add('hidden');
    };

    window.confirmDelegation = async function () {
        const input = document.getElementById('delegateInput');
        const note  = document.getElementById('delegateNote');
        const btn   = document.getElementById('confirmDelegateBtn');

        const target = input ? input.value.trim() : '';
        if (!target) {
            showNotification('Introduce un npub o pubkey hex.', 'error');
            return;
        }

        // Basic format validation before calling the module
        const isNpub = /^npub1[a-z0-9]+$/i.test(target);
        const isHex  = /^[0-9a-f]{64}$/i.test(target);
        if (!isNpub && !isHex) {
            showNotification('Formato inválido. Usa npub1… o hex de 64 caracteres.', 'error');
            return;
        }

        if (btn) { btn.disabled = true; btn.textContent = 'Publicando…'; }

        try {
            await LBW_Delegations.delegateTo(target, 'global', (note ? note.value.trim() : ''));
            showNotification('✅ Delegación publicada. Tu voto fluye ahora a esa persona.', 'success');
            window.closeDelegateModal();
            _renderMyDelegation();
            _renderReceivedDelegations();
        } catch (err) {
            console.error('[DelegationsUI] delegateTo error:', err);
            showNotification('Error: ' + (err.message || err), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Confirmar delegación'; }
        }
    };

    // ── Revoke ───────────────────────────────────────────────
    window.confirmRevokeDelegation = async function () {
        if (!confirm('¿Revocar tu delegación? Tu poder de voto volverá a depender únicamente de tu voto directo.')) return;

        try {
            await LBW_Delegations.revokeDelegation('global');
            showNotification('✅ Delegación revocada.', 'success');
            _renderMyDelegation();
        } catch (err) {
            console.error('[DelegationsUI] revoke error:', err);
            showNotification('Error: ' + (err.message || err), 'error');
        }
    };

})();
