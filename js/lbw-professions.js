// ============================================================
// LiberBit World — Profession Taxonomy (lbw-professions.js)
//
// Taxonomía cerrada de profesiones para perfiles de ciudadanos.
// Sirve como dropdown obligatorio en el perfil + filtro fiable en
// marketplace y mapa (re-agregando por ciudad sin exponer usuarios
// individuales — preserva el principio de privacidad del mapa).
//
// El usuario complementa con un campo libre `lbw_profession_specialty`
// que vive junto al code en kind:0 metadata. La especialidad es
// expresión libre (p.ej. "Programador" + "Rust + Bitcoin Lightning").
//
// v1: una profesión por usuario. Estructura preparada para v2 con
// array — basta cambiar el shape en kind:0 sin tocar las constantes
// de aquí.
// ============================================================

const LBW_Professions = (() => {
    'use strict';

    // ⚠️ Si cambias códigos existentes romperás los perfiles ya
    // guardados — los códigos son IDs estables, no labels visibles.
    // Para añadir nuevas categorías, append al final.
    const LIST = [
        { code: 'dev_software',  label: '💻 Desarrollo software' },
        { code: 'design',        label: '🎨 Diseño' },
        { code: 'marketing',     label: '📣 Marketing / Comunicación' },
        { code: 'legal',         label: '⚖️ Legal / Compliance' },
        { code: 'construction',  label: '🏗️ Construcción / Oficios' },
        { code: 'agriculture',   label: '🌱 Agricultura / Permacultura' },
        { code: 'hospitality',   label: '🍽️ Hostelería / Cocina' },
        { code: 'health',        label: '🩺 Salud / Bienestar' },
        { code: 'education',     label: '📚 Educación' },
        { code: 'finance',       label: '₿ Finanzas / Bitcoin' },
        { code: 'crafts',        label: '🪡 Artesanía' },
        { code: 'professional',  label: '💼 Servicios profesionales' },
        { code: 'other',         label: '🌟 Otros' }
    ];

    function getList() { return LIST.slice(); }
    function getCodes() { return LIST.map(p => p.code); }

    // Devuelve el label legible para un code. Si el code es vacío o no
    // reconocido, devuelve cadena vacía (no '⚠️ Desconocido' — preferimos
    // que la UI decida cómo renderizar la ausencia).
    function getLabel(code) {
        if (!code) return '';
        const item = LIST.find(p => p.code === code);
        return item ? item.label : '';
    }

    // Devuelve solo el emoji (primer carácter visible del label).
    // Útil para tooltips compactos / badges chiquitos en cards.
    function getEmoji(code) {
        const label = getLabel(code);
        if (!label) return '';
        // El label empieza por emoji, posiblemente seguido de espacio.
        // Cogemos hasta el primer espacio.
        const sp = label.indexOf(' ');
        return sp > 0 ? label.substring(0, sp) : label;
    }

    function isValidCode(code) {
        return !!code && LIST.some(p => p.code === code);
    }

    // Construye el <option> set para un <select>. El primer option es
    // siempre la opción vacía (sin profesión) para que el usuario pueda
    // borrar su elección. selectedCode marca cuál pinta como selected.
    function renderOptionsHtml(selectedCode) {
        const safeCode = selectedCode || '';
        const optEmpty = `<option value="" ${safeCode === '' ? 'selected' : ''}>— Sin especificar —</option>`;
        const opts = LIST.map(p => {
            const sel = p.code === safeCode ? 'selected' : '';
            // Escape minimal: codes y labels son nuestros, no UGC, pero por sanidad
            const escLabel = String(p.label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<option value="${p.code}" ${sel}>${escLabel}</option>`;
        }).join('');
        return optEmpty + opts;
    }

    return {
        LIST, getList, getCodes, getLabel, getEmoji, isValidCode, renderOptionsHtml
    };
})();

window.LBW_Professions = LBW_Professions;
