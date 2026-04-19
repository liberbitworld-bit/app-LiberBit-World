// city-prompt.js v3 — Pop-up para usuarios sin ciudad registrada
// Lee datos desde localStorage (profile.js está en IIFE, sus variables no están en window)
// Triggers:
//   1. Tras login/carga (delay 4s)
//   2. Al entrar en la sección de perfil (si aún no hay ciudad)
// Respeta el flag "No volver a mostrar" en ambos triggers.
(function () {
  'use strict';

  const STORAGE_PREFIX = 'lbw_city_prompt_dismissed_';
  const LOGIN_DELAY_MS = 4000;
  const PROFILE_DELAY_MS = 1200;   // margen para que loadUserProfile termine y actualice localStorage
  const MODAL_ID = 'lbw-city-prompt-modal';
  const STYLES_ID = 'lbw-city-prompt-styles';

  // -------------------- estilos --------------------
  function injectStyles() {
    if (document.getElementById(STYLES_ID)) return;
    const style = document.createElement('style');
    style.id = STYLES_ID;
    style.textContent = `
      #${MODAL_ID} {
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, 0.72);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; padding: 16px;
        animation: lbwCpFadeIn .3s ease;
      }
      @keyframes lbwCpFadeIn { from{opacity:0} to{opacity:1} }
      #${MODAL_ID} .lbw-cp-card {
        background: linear-gradient(145deg, #0F1B23 0%, #0D171E 100%);
        border: 1px solid rgba(212, 168, 83, 0.28);
        border-radius: 16px;
        max-width: 440px; width: 100%;
        padding: 32px 28px 22px;
        color: #E8E8E8;
        position: relative;
        box-shadow: 0 20px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(44,95,111,.2);
        animation: lbwCpSlide .4s cubic-bezier(.2,.8,.2,1);
      }
      @keyframes lbwCpSlide { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
      #${MODAL_ID} .lbw-cp-close {
        position: absolute; top: 10px; right: 10px;
        background: transparent; border: none;
        color: #7A8A94; font-size: 22px; line-height: 1;
        width: 32px; height: 32px; border-radius: 50%;
        cursor: pointer; transition: all .2s;
        display: flex; align-items: center; justify-content: center;
      }
      #${MODAL_ID} .lbw-cp-close:hover {
        background: rgba(255,255,255,.08); color: #d4a853;
      }
      #${MODAL_ID} .lbw-cp-icon {
        width: 56px; height: 56px; margin: 0 auto 14px;
        background: linear-gradient(135deg, #d4a853 0%, #b8913f 100%);
        border-radius: 14px;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 8px 24px rgba(212,168,83,.25);
      }
      #${MODAL_ID} .lbw-cp-icon svg { width: 30px; height: 30px; color: #0D171E; }
      #${MODAL_ID} h3 {
        text-align: center; font-size: 20px; font-weight: 600;
        margin: 0 0 8px; color: #d4a853;
      }
      #${MODAL_ID} .lbw-cp-sub {
        text-align: center; color: #B8C4CC;
        font-size: 14px; line-height: 1.5; margin: 0 0 20px;
      }
      #${MODAL_ID} .lbw-cp-benefits {
        list-style: none; padding: 0; margin: 0 0 22px;
        display: flex; flex-direction: column; gap: 11px;
      }
      #${MODAL_ID} .lbw-cp-benefits li {
        display: flex; align-items: flex-start; gap: 12px;
        font-size: 13.5px; line-height: 1.5; color: #D0D8DE;
      }
      #${MODAL_ID} .lbw-cp-benefits li::before {
        content: ""; flex-shrink: 0;
        width: 6px; height: 6px; margin-top: 7px;
        border-radius: 50%; background: #2C5F6F;
        box-shadow: 0 0 0 3px rgba(44,95,111,.25);
      }
      #${MODAL_ID} .lbw-cp-actions {
        display: flex; flex-direction: column; gap: 8px;
      }
      #${MODAL_ID} .lbw-cp-btn-primary {
        background: linear-gradient(135deg, #d4a853 0%, #b8913f 100%);
        color: #0D171E; border: none;
        padding: 13px 20px; border-radius: 10px;
        font-weight: 600; font-size: 14.5px;
        cursor: pointer; transition: all .2s;
        letter-spacing: .2px;
      }
      #${MODAL_ID} .lbw-cp-btn-primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(212,168,83,.35);
      }
      #${MODAL_ID} .lbw-cp-btn-secondary {
        background: transparent; color: #8A98A2;
        border: none; padding: 8px;
        font-size: 13px; cursor: pointer;
        transition: color .2s;
      }
      #${MODAL_ID} .lbw-cp-btn-secondary:hover { color: #d4a853; }
      #${MODAL_ID} .lbw-cp-privacy {
        text-align: center; font-size: 11.5px;
        color: #6A7680; margin: 12px 0 0; line-height: 1.4;
      }
    `;
    document.head.appendChild(style);
  }

  // -------------------- helpers --------------------
  function getCurrentPubkey() {
    // Fuente real: localStorage['liberbit_keys'] contiene {pubkey, privateKey, ...}
    try {
      const raw = localStorage.getItem('liberbit_keys');
      if (!raw) return null;
      const keys = JSON.parse(raw);
      return keys?.pubkey || keys?.publicKey || null;
    } catch (_) {
      return null;
    }
  }

  function getUserProfileCity() {
    // Devuelve:
    //   string con ciudad   → ya la tiene
    //   ''                  → perfil cargado y sin ciudad (mostrar popup)
    //   null                → perfil no cargado aún (no molestar)
    const pubkey = getCurrentPubkey();
    if (!pubkey) return null;
    try {
      const raw = localStorage.getItem('userProfile_' + pubkey);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (p && typeof p.city === 'string' && p.city.trim()) {
        return p.city.trim();
      }
      return ''; // perfil existe en caché pero sin ciudad
    } catch (_) {
      return null;
    }
  }

  function keyFor(pubkey) {
    return STORAGE_PREFIX + (pubkey || '').slice(0, 16);
  }
  function isDismissed(pubkey) {
    return !!pubkey && localStorage.getItem(keyFor(pubkey)) === '1';
  }
  function setDismissed(pubkey) {
    if (pubkey) localStorage.setItem(keyFor(pubkey), '1');
  }

  // -------------------- modal --------------------
  function closeModal() {
    const el = document.getElementById(MODAL_ID);
    if (el) el.remove();
  }

  function goToProfileAndEditCity() {
    closeModal();
    if (typeof window.openApp === 'function') {
      try { window.openApp('perfil'); } catch (e) { console.warn('[LBW_CityPrompt] openApp fallo:', e); }
      setTimeout(() => {
        if (typeof window.showCitizenshipModal === 'function') {
          try { window.showCitizenshipModal(); } catch (e) { console.warn('[LBW_CityPrompt] showCitizenshipModal fallo:', e); }
        }
      }, 900);
      return;
    }
    const tab = document.querySelector('[onclick*="openApp"][onclick*="perfil"]');
    if (tab) { tab.click(); return; }
    window.location.hash = '#profileSection';
  }

  function showModal(pubkey) {
    injectStyles();
    if (document.getElementById(MODAL_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div class="lbw-cp-card" role="dialog" aria-modal="true" aria-labelledby="lbw-cp-title">
        <button class="lbw-cp-close" aria-label="Cerrar" data-action="close">×</button>
        <div class="lbw-cp-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z"/>
            <circle cx="12" cy="9" r="2.5"/>
          </svg>
        </div>
        <h3 id="lbw-cp-title">Conecta con tu comunidad local</h3>
        <p class="lbw-cp-sub">Añade tu ciudad al perfil y forma parte de la red de libertad más cercana a ti.</p>
        <ul class="lbw-cp-benefits">
          <li>Encuentra ofertas P2P y productos del mercado cerca de ti.</li>
          <li>Descubre a otros soberanos de tu zona y coordina encuentros.</li>
          <li>Accede a misiones, eventos y nodos locales de LiberBit City.</li>
          <li>Construye comunidad real, no solo digital.</li>
        </ul>
        <div class="lbw-cp-actions">
          <button class="lbw-cp-btn-primary" data-action="goto">Añadir mi ciudad</button>
          <button class="lbw-cp-btn-secondary" data-action="dismiss">No volver a mostrar</button>
        </div>
        <p class="lbw-cp-privacy">Tu ciudad es opcional y solo tú decides cuánta precisión compartir.</p>
      </div>
    `;

    overlay.addEventListener('click', (e) => {
      const act = e.target.closest('[data-action]')?.dataset.action;
      if (act === 'close')        { closeModal(); return; }
      if (act === 'dismiss')      { setDismissed(pubkey); closeModal(); return; }
      if (act === 'goto')         { setDismissed(pubkey); goToProfileAndEditCity(); return; }
      if (e.target === overlay)   { closeModal(); return; }
    });

    const onEsc = (e) => {
      if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onEsc); }
    };
    document.addEventListener('keydown', onEsc);

    document.body.appendChild(overlay);
  }

  // -------------------- flujo --------------------
  let _checking = false;
  function check(context) {
    if (_checking) return;
    _checking = true;
    try {
      const pubkey = getCurrentPubkey();
      if (!pubkey) return;
      if (isDismissed(pubkey)) return;
      if (document.getElementById(MODAL_ID)) return;

      const city = getUserProfileCity();
      if (city === null) return; // perfil aún no está en caché
      if (city) return;           // ya tiene ciudad

      console.warn('[LBW_CityPrompt] mostrando popup (trigger: ' + (context || 'auto') + ')');
      showModal(pubkey);
    } catch (err) {
      console.warn('[LBW_CityPrompt] check failed:', err);
    } finally {
      _checking = false;
    }
  }

  function scheduleLoginCheck() {
    setTimeout(() => check('login'), LOGIN_DELAY_MS);
  }

  function attachProfileSectionTrigger() {
    const profileSec = document.getElementById('profileSection');
    if (!profileSec) {
      setTimeout(attachProfileSectionTrigger, 500);
      return;
    }
    const obs = new MutationObserver(() => {
      if (profileSec.classList.contains('active')) {
        setTimeout(() => check('profile'), PROFILE_DELAY_MS);
      }
    });
    obs.observe(profileSec, { attributes: true, attributeFilter: ['class'] });
  }

  // API pública
  window.LBW_CityPrompt = {
    check: () => check('manual'),
    showModal: () => showModal(getCurrentPubkey()),
    closeModal,
    reset: () => {
      const pk = getCurrentPubkey();
      if (pk) localStorage.removeItem(keyFor(pk));
      console.warn('[LBW_CityPrompt] dismiss flag limpiado para', pk ? pk.slice(0, 16) : 'null');
    },
    debug: () => {
      const pk = getCurrentPubkey();
      const city = getUserProfileCity();
      const info = {
        pubkey: pk ? pk.slice(0, 16) + '...' : null,
        dismissed: isDismissed(pk),
        city: city,
        cityStatus: city === null ? 'perfil no cargado' : (city === '' ? 'sin ciudad (mostraría popup)' : 'ya registrada'),
        liberbitKeysPresent: !!localStorage.getItem('liberbit_keys'),
        profileCachePresent: pk ? !!localStorage.getItem('userProfile_' + pk) : false
      };
      console.warn('[LBW_CityPrompt] debug:', JSON.stringify(info, null, 2));
      return info;
    }
  };

  // -------------------- init --------------------
  function init() {
    // Triggers posibles tras login
    window.addEventListener('lbw:logged-in', scheduleLoginCheck);
    window.addEventListener('lbw:ready', scheduleLoginCheck);
    window.addEventListener('lbw:profile-loaded', scheduleLoginCheck);

    // Trigger al entrar a perfil
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachProfileSectionTrigger);
    } else {
      attachProfileSectionTrigger();
    }

    // Chequeo inicial (si hay sesión al cargar)
    if (document.readyState === 'complete') {
      scheduleLoginCheck();
    } else {
      window.addEventListener('load', scheduleLoginCheck);
    }
  }

  init();
})();
