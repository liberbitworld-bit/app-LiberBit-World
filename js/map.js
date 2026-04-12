/**
 * LBW_Map — Mapa de ciudadanos y nodos de la red LiberBit
 * ─────────────────────────────────────────────────────────────
 *
 * Capas:
 *   🏛️  Nodos físicos (LiberAtlas) — puntos soberanos
 *   👥  Ciudadanos agregados por ciudad — conteo, nunca individuos
 *
 * Principios:
 *   - Privacidad por defecto: NO se exponen npubs, nombres ni coords individuales.
 *     La agregación se hace a nivel ciudad con zoom máximo limitado (z=13).
 *   - Separación absoluta: CityBunker NO aparece en este mapa público.
 *   - Stack libre: Leaflet + tiles CartoDB dark (sin API key, sin tracking).
 *   - Geocoding híbrido: tabla local de ciudades frecuentes → cache localStorage
 *     → Nominatim (rate-limited) como último recurso.
 *
 * Auto-init: observa #mapaSection y arranca cuando recibe la clase .active.
 * API pública: LBW_Map.init(), LBW_Map.refresh().
 */
(function (window) {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // CONFIG
    // ═══════════════════════════════════════════════════════════════
    const CONFIG = {
        // Vista inicial: Península Ibérica
        initialCenter: [40.0, -3.5],
        initialZoom: 5,
        minZoom: 3,
        maxZoom: 13, // Limitado para reforzar privacidad

        // Tiles oscuros CartoDB (uso libre, alineado con el theme de LBW)
        tileUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        tileAttribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> · ' +
            '<a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',

        // Nodos físicos de la red
        // ⚠️  TODO: ajustar coords definitivas de LiberAtlas cuando estén confirmadas.
        //         Mientras tanto, placeholder en Madrid (~centro Península).
        //         CityBunker NO aparece aquí (separación absoluta).
        physicalNodes: [
            {
                id: 'LBTC-1',
                name: 'LiberAtlas',
                subtitle: 'Nodo capital · Península Ibérica',
                coords: [40.4168, -3.7038], // TODO: coords reales
                description: '~400 ha · hasta 10.000 residentes en 5 fases',
                url: 'https://liberatlas.org',
                color: '#E5B95C'
            }
        ],

        // Cache de geocoding en localStorage
        geocodeCacheKey: 'lbw_geocode_cache_v1',

        // Tabla local de ciudades frecuentes (evita llamadas a Nominatim)
        knownCities: {
            // España
            'madrid': [40.4168, -3.7038],
            'barcelona': [41.3851, 2.1734],
            'valencia': [39.4699, -0.3763],
            'sevilla': [37.3891, -5.9845],
            'zaragoza': [41.6488, -0.8891],
            'málaga': [36.7213, -4.4213],
            'malaga': [36.7213, -4.4213],
            'bilbao': [43.2630, -2.9350],
            'murcia': [37.9922, -1.1307],
            'palma': [39.5696, 2.6502],
            'palma de mallorca': [39.5696, 2.6502],
            'las palmas': [28.1235, -15.4363],
            'las palmas de gran canaria': [28.1235, -15.4363],
            'vitoria': [42.8467, -2.6727],
            'granada': [37.1773, -3.5986],
            'a coruña': [43.3623, -8.4115],
            'coruña': [43.3623, -8.4115],
            'la coruña': [43.3623, -8.4115],
            'vigo': [42.2406, -8.7207],
            'gijón': [43.5322, -5.6611],
            'gijon': [43.5322, -5.6611],
            'alicante': [38.3452, -0.4810],
            'córdoba': [37.8882, -4.7794],
            'cordoba': [37.8882, -4.7794],
            'valladolid': [41.6523, -4.7245],
            'pamplona': [42.8125, -1.6458],
            'santander': [43.4623, -3.8099],
            'toledo': [39.8628, -4.0273],
            'salamanca': [40.9701, -5.6635],
            'burgos': [42.3439, -3.6969],
            'león': [42.5987, -5.5671],
            'leon': [42.5987, -5.5671],
            'oviedo': [43.3614, -5.8593],
            'san sebastián': [43.3183, -1.9812],
            'san sebastian': [43.3183, -1.9812],
            'donostia': [43.3183, -1.9812],
            'tenerife': [28.4636, -16.2518],
            'santa cruz de tenerife': [28.4636, -16.2518],
            'logroño': [42.4627, -2.4449],
            'logrono': [42.4627, -2.4449],
            'cádiz': [36.5297, -6.2921],
            'cadiz': [36.5297, -6.2921],
            'almería': [36.8340, -2.4637],
            'almeria': [36.8340, -2.4637],
            'huelva': [37.2614, -6.9447],
            'jerez': [36.6868, -6.1377],
            'marbella': [36.5101, -4.8826],

            // Portugal
            'lisboa': [38.7223, -9.1393],
            'lisbon': [38.7223, -9.1393],
            'porto': [41.1579, -8.6291],
            'oporto': [41.1579, -8.6291],

            // Latam
            'buenos aires': [-34.6037, -58.3816],
            'ciudad de méxico': [19.4326, -99.1332],
            'ciudad de mexico': [19.4326, -99.1332],
            'méxico df': [19.4326, -99.1332],
            'cdmx': [19.4326, -99.1332],
            'bogotá': [4.7110, -74.0721],
            'bogota': [4.7110, -74.0721],
            'medellín': [6.2442, -75.5812],
            'medellin': [6.2442, -75.5812],
            'santiago': [-33.4489, -70.6693],
            'santiago de chile': [-33.4489, -70.6693],
            'lima': [-12.0464, -77.0428],
            'montevideo': [-34.9011, -56.1645],
            'caracas': [10.4806, -66.9036],
            'quito': [-0.1807, -78.4678],
            'la paz': [-16.4897, -68.1193],
            'asunción': [-25.2637, -57.5759],
            'asuncion': [-25.2637, -57.5759],
            'san josé': [9.9281, -84.0907],
            'san jose': [9.9281, -84.0907],
            'panamá': [8.9824, -79.5199],
            'panama': [8.9824, -79.5199],
            'ciudad de panamá': [8.9824, -79.5199],
            'la habana': [23.1136, -82.3666],
            'guadalajara': [20.6597, -103.3496],
            'monterrey': [25.6866, -100.3161],
            'guayaquil': [-2.1709, -79.9224],
            'rosario': [-32.9587, -60.6930],
            'córdoba argentina': [-31.4201, -64.1888],

            // Otros
            'miami': [25.7617, -80.1918],
            'nueva york': [40.7128, -74.0060],
            'new york': [40.7128, -74.0060],
            'londres': [51.5074, -0.1278],
            'london': [51.5074, -0.1278],
            'parís': [48.8566, 2.3522],
            'paris': [48.8566, 2.3522],
            'berlín': [52.5200, 13.4050],
            'berlin': [52.5200, 13.4050],
            'roma': [41.9028, 12.4964],
            'rome': [41.9028, 12.4964],
            'ámsterdam': [52.3676, 4.9041],
            'amsterdam': [52.3676, 4.9041],
            'zurich': [47.3769, 8.5417],
            'zúrich': [47.3769, 8.5417],
            'ginebra': [46.2044, 6.1432],
            'dubai': [25.2048, 55.2708],
            'dubái': [25.2048, 55.2708],
            'singapur': [1.3521, 103.8198],
            'singapore': [1.3521, 103.8198],
            'tokio': [35.6762, 139.6503],
            'tokyo': [35.6762, 139.6503],
            'hong kong': [22.3193, 114.1694],
            'estambul': [41.0082, 28.9784],
            'istanbul': [41.0082, 28.9784]
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // ESTADO INTERNO
    // ═══════════════════════════════════════════════════════════════
    let map = null;
    let initialized = false;
    let loadingCitizens = false;
    let nodeLayer = null;
    let citizenLayer = null;
    let nodeLayerVisible = true;
    let citizenLayerVisible = true;

    // ═══════════════════════════════════════════════════════════════
    // GEOCODING (tabla local → cache → Nominatim)
    // ═══════════════════════════════════════════════════════════════
    function loadGeocodeCache() {
        try {
            const raw = localStorage.getItem(CONFIG.geocodeCacheKey);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }
    function saveGeocodeCache(cache) {
        try {
            localStorage.setItem(CONFIG.geocodeCacheKey, JSON.stringify(cache));
        } catch (e) {}
    }

    async function geocodeCity(cityName) {
        if (!cityName || typeof cityName !== 'string') return null;
        const key = cityName.trim().toLowerCase();
        if (!key) return null;

        // 1. Tabla local
        if (CONFIG.knownCities[key]) return CONFIG.knownCities[key];

        // 2. Cache localStorage
        const cache = loadGeocodeCache();
        if (cache[key]) {
            if (cache[key] === 'NOT_FOUND') return null;
            return cache[key];
        }

        // 3. Nominatim (rate-limited; usar con moderación)
        try {
            const resp = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(cityName)}`,
                { headers: { 'Accept-Language': 'es' } }
            );
            if (!resp.ok) throw new Error('nominatim ' + resp.status);
            const data = await resp.json();
            if (data && data.length > 0) {
                const coords = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
                cache[key] = coords;
                saveGeocodeCache(cache);
                return coords;
            }
            cache[key] = 'NOT_FOUND';
            saveGeocodeCache(cache);
            return null;
        } catch (e) {
            console.warn('[LBW_Map] Geocoding falló para', cityName, e);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // DATOS: ciudadanos por ciudad
    // ═══════════════════════════════════════════════════════════════
    async function loadCitizensByCity() {
        try {
            if (typeof supabaseClient === 'undefined') return {};
            const { data, error } = await supabaseClient
                .from('users')
                .select('city');
            if (error || !data) return {};

            const counts = {};
            data.forEach(u => {
                const c = (u.city || '').trim();
                if (!c) return;
                const key = c.toLowerCase();
                if (!counts[key]) counts[key] = { name: c, count: 0 };
                counts[key].count++;
            });
            return counts;
        } catch (e) {
            console.warn('[LBW_Map] loadCitizensByCity error', e);
            return {};
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ICONOS
    // ═══════════════════════════════════════════════════════════════
    function nodeIcon() {
        return L.divIcon({
            className: 'lbw-node-marker',
            html: '<div class="lbw-node-pin"><span>🏛️</span></div>',
            iconSize: [52, 52],
            iconAnchor: [26, 26],
            popupAnchor: [0, -22]
        });
    }

    function citizenIcon(count) {
        const size = Math.min(62, 28 + Math.log2(count + 1) * 8);
        return L.divIcon({
            className: 'lbw-citizen-marker',
            html: `<div class="lbw-citizen-pin" style="width:${size}px;height:${size}px;font-size:${Math.max(12, size / 3)}px;"><span>${count}</span></div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
            popupAnchor: [0, -size / 2]
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════════════════════════════
    function renderNodes() {
        if (!map) return;
        if (nodeLayer) nodeLayer.clearLayers();
        else nodeLayer = L.layerGroup();

        CONFIG.physicalNodes.forEach(node => {
            const marker = L.marker(node.coords, { icon: nodeIcon() });
            marker.bindPopup(`
                <div class="lbw-map-popup">
                    <div class="lbw-map-popup-title">🏛️ ${node.name}</div>
                    <div class="lbw-map-popup-subtitle">${node.subtitle}</div>
                    <div class="lbw-map-popup-desc">${node.description}</div>
                    <a href="${node.url}" target="_blank" rel="noopener" class="lbw-map-popup-link">
                        Visitar sitio →
                    </a>
                </div>
            `);
            marker.addTo(nodeLayer);
        });

        if (nodeLayerVisible && !map.hasLayer(nodeLayer)) nodeLayer.addTo(map);
        updateStatsBar();
    }

    async function renderCitizens() {
        if (!map || loadingCitizens) return;
        loadingCitizens = true;

        if (citizenLayer) citizenLayer.clearLayers();
        else citizenLayer = L.layerGroup();

        const statusEl = document.getElementById('lbwMapStatus');
        if (statusEl) statusEl.textContent = '⏳ Cargando ciudadanos...';

        const counts = await loadCitizensByCity();
        const entries = Object.values(counts);

        let totalCitizens = 0;
        let mappedCities = 0;
        let pendingGeocode = 0;

        for (const entry of entries) {
            totalCitizens += entry.count;

            // Primero intentamos sin tocar red (tabla local + cache)
            const key = entry.name.trim().toLowerCase();
            let coords = CONFIG.knownCities[key];
            if (!coords) {
                const cache = loadGeocodeCache();
                if (cache[key] && cache[key] !== 'NOT_FOUND') coords = cache[key];
            }

            // Si seguimos sin coords, geocoding online (diferido)
            if (!coords) {
                pendingGeocode++;
                // Dispara async sin bloquear — se refrescará al terminar
                geocodeCity(entry.name).then(c => {
                    if (c) addCitizenMarker(entry, c);
                });
                continue;
            }
            addCitizenMarker(entry, coords);
            mappedCities++;
        }

        if (citizenLayerVisible && !map.hasLayer(citizenLayer)) citizenLayer.addTo(map);

        if (statusEl) {
            const pendingTxt = pendingGeocode > 0 ? ` · ${pendingGeocode} ciudad(es) geocodificándose` : '';
            statusEl.textContent = `${totalCitizens} ciudadano(s) · ${mappedCities} ciudad(es) mapeadas${pendingTxt}`;
        }
        updateStatsBar(totalCitizens, mappedCities);
        loadingCitizens = false;
    }

    function addCitizenMarker(entry, coords) {
        if (!citizenLayer) return;
        const marker = L.marker(coords, { icon: citizenIcon(entry.count) });
        const word = entry.count === 1 ? 'ciudadano' : 'ciudadanos';
        marker.bindPopup(`
            <div class="lbw-map-popup">
                <div class="lbw-map-popup-title">📍 ${entry.name}</div>
                <div class="lbw-map-popup-count">
                    <strong>${entry.count}</strong> ${word}
                </div>
                <div class="lbw-map-popup-desc" style="font-size:0.75rem;opacity:0.7;">
                    Agregado por privacidad
                </div>
            </div>
        `);
        marker.addTo(citizenLayer);
    }

    function updateStatsBar(totalCitizens, mappedCities) {
        const citizenCountEl = document.getElementById('lbwMapCitizenCount');
        const cityCountEl = document.getElementById('lbwMapCityCount');
        const nodeCountEl = document.getElementById('lbwMapNodeCount');
        if (citizenCountEl && typeof totalCitizens === 'number') citizenCountEl.textContent = totalCitizens;
        if (cityCountEl && typeof mappedCities === 'number') cityCountEl.textContent = mappedCities;
        if (nodeCountEl) nodeCountEl.textContent = CONFIG.physicalNodes.length;
    }

    // ═══════════════════════════════════════════════════════════════
    // TOGGLES DE CAPA
    // ═══════════════════════════════════════════════════════════════
    function toggleNodes() {
        if (!map || !nodeLayer) return;
        nodeLayerVisible = !nodeLayerVisible;
        if (nodeLayerVisible) nodeLayer.addTo(map);
        else map.removeLayer(nodeLayer);
        const btn = document.getElementById('lbwMapToggleNodes');
        if (btn) btn.classList.toggle('active', nodeLayerVisible);
    }
    function toggleCitizens() {
        if (!map || !citizenLayer) return;
        citizenLayerVisible = !citizenLayerVisible;
        if (citizenLayerVisible) citizenLayer.addTo(map);
        else map.removeLayer(citizenLayer);
        const btn = document.getElementById('lbwMapToggleCitizens');
        if (btn) btn.classList.toggle('active', citizenLayerVisible);
    }

    // ═══════════════════════════════════════════════════════════════
    // CSS (inyectado para mantener el módulo autocontenido)
    // ═══════════════════════════════════════════════════════════════
    function injectStyles() {
        if (document.getElementById('lbw-map-styles')) return;
        const style = document.createElement('style');
        style.id = 'lbw-map-styles';
        style.textContent = `
            #lbwMapContainer {
                width: 100%;
                height: 520px;
                border-radius: 16px;
                border: 2px solid var(--color-border);
                background: var(--color-bg-dark);
                overflow: hidden;
                z-index: 1;
            }
            .lbw-map-controls {
                display: flex;
                flex-wrap: wrap;
                gap: 0.5rem;
                margin-bottom: 1rem;
            }
            .lbw-map-toggle {
                padding: 0.5rem 1rem;
                border-radius: 10px;
                border: 2px solid var(--color-border);
                background: var(--color-bg-card);
                color: var(--color-text-secondary);
                cursor: pointer;
                font-size: 0.9rem;
                font-weight: 600;
                transition: all 0.2s ease;
            }
            .lbw-map-toggle:hover {
                border-color: var(--color-gold);
                color: var(--color-text-primary);
            }
            .lbw-map-toggle.active {
                border-color: var(--color-gold);
                background: rgba(229, 185, 92, 0.12);
                color: var(--color-gold);
            }
            .lbw-map-status {
                color: var(--color-text-secondary);
                font-size: 0.85rem;
                margin-bottom: 0.75rem;
                font-family: 'JetBrains Mono', monospace;
            }
            .lbw-map-stats-bar {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
                gap: 1rem;
                margin-bottom: 1rem;
            }
            .lbw-map-stat {
                background: var(--color-bg-card);
                padding: 1rem;
                border-radius: 12px;
                border: 2px solid var(--color-border);
                text-align: center;
            }
            .lbw-map-stat-value {
                font-size: 1.8rem;
                font-weight: 700;
                color: var(--color-gold);
            }
            .lbw-map-stat-label {
                font-size: 0.8rem;
                color: var(--color-text-secondary);
                margin-top: 0.25rem;
            }

            /* Markers */
            .lbw-node-marker,
            .lbw-citizen-marker {
                background: transparent;
                border: none;
            }
            .lbw-node-pin {
                width: 52px;
                height: 52px;
                border-radius: 50%;
                background: radial-gradient(circle, #E5B95C 0%, #c89a42 100%);
                border: 3px solid var(--color-bg-dark);
                box-shadow: 0 0 0 2px #E5B95C, 0 4px 16px rgba(229, 185, 92, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                animation: lbw-pulse-gold 2.4s infinite;
            }
            .lbw-citizen-pin {
                border-radius: 50%;
                background: radial-gradient(circle, rgba(44, 95, 111, 0.95) 0%, rgba(26, 61, 74, 0.95) 100%);
                border: 2px solid var(--color-teal-light);
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                font-family: 'JetBrains Mono', monospace;
            }
            @keyframes lbw-pulse-gold {
                0%, 100% { box-shadow: 0 0 0 2px #E5B95C, 0 4px 16px rgba(229, 185, 92, 0.5); }
                50%      { box-shadow: 0 0 0 2px #E5B95C, 0 4px 24px rgba(229, 185, 92, 0.9); }
            }

            /* Popups */
            .leaflet-popup-content-wrapper {
                background: var(--color-bg-card) !important;
                color: var(--color-text-primary) !important;
                border: 1px solid var(--color-gold) !important;
                border-radius: 12px !important;
            }
            .leaflet-popup-tip {
                background: var(--color-bg-card) !important;
                border: 1px solid var(--color-gold) !important;
            }
            .leaflet-popup-content {
                margin: 0.75rem 1rem !important;
                min-width: 180px;
            }
            .lbw-map-popup-title {
                font-weight: 700;
                color: var(--color-gold);
                font-size: 1rem;
                margin-bottom: 0.25rem;
            }
            .lbw-map-popup-subtitle {
                font-size: 0.8rem;
                color: var(--color-text-secondary);
                margin-bottom: 0.5rem;
            }
            .lbw-map-popup-desc {
                font-size: 0.85rem;
                margin-bottom: 0.5rem;
            }
            .lbw-map-popup-count {
                font-size: 0.95rem;
            }
            .lbw-map-popup-count strong {
                color: var(--color-gold);
                font-size: 1.2rem;
            }
            .lbw-map-popup-link {
                display: inline-block;
                color: var(--color-gold) !important;
                text-decoration: none;
                font-weight: 600;
                font-size: 0.85rem;
                margin-top: 0.25rem;
            }
            .lbw-map-popup-link:hover { text-decoration: underline; }

            /* Atribución y controles de Leaflet en tema oscuro */
            .leaflet-control-attribution {
                background: rgba(13, 24, 33, 0.85) !important;
                color: var(--color-text-secondary) !important;
                font-size: 0.7rem !important;
            }
            .leaflet-control-attribution a { color: var(--color-gold) !important; }
            .leaflet-control-zoom a {
                background: var(--color-bg-card) !important;
                color: var(--color-text-primary) !important;
                border-color: var(--color-border) !important;
            }
            .leaflet-control-zoom a:hover {
                background: var(--color-teal) !important;
                color: var(--color-gold) !important;
            }

            @media (max-width: 600px) {
                #lbwMapContainer { height: 420px; }
            }
        `;
        document.head.appendChild(style);
    }

    // ═══════════════════════════════════════════════════════════════
    // INIT
    // ═══════════════════════════════════════════════════════════════
    function init() {
        if (initialized) {
            setTimeout(() => { if (map) map.invalidateSize(); }, 100);
            return;
        }
        const container = document.getElementById('lbwMapContainer');
        if (!container) {
            console.warn('[LBW_Map] Contenedor #lbwMapContainer no encontrado');
            return;
        }
        if (typeof L === 'undefined') {
            console.warn('[LBW_Map] Leaflet no está cargado');
            container.innerHTML =
                '<div style="padding:2rem;text-align:center;color:var(--color-text-secondary);">' +
                '⚠️ No se pudo cargar el mapa. Verifica tu conexión.</div>';
            return;
        }

        injectStyles();

        map = L.map(container, {
            center: CONFIG.initialCenter,
            zoom: CONFIG.initialZoom,
            minZoom: CONFIG.minZoom,
            maxZoom: CONFIG.maxZoom,
            zoomControl: true,
            attributionControl: true,
            worldCopyJump: true
        });

        L.tileLayer(CONFIG.tileUrl, {
            attribution: CONFIG.tileAttribution,
            subdomains: 'abcd',
            maxZoom: CONFIG.maxZoom
        }).addTo(map);

        renderNodes();
        renderCitizens();

        initialized = true;
        setTimeout(() => map.invalidateSize(), 250);

        console.info('[LBW_Map] Inicializado');
    }

    async function refresh() {
        if (!initialized) return init();
        const statusEl = document.getElementById('lbwMapStatus');
        if (statusEl) statusEl.textContent = '🔄 Refrescando...';
        renderNodes();
        await renderCitizens();
    }

    // ═══════════════════════════════════════════════════════════════
    // AUTO-INIT: observa cuando #mapaSection recibe .active
    // ═══════════════════════════════════════════════════════════════
    function setupAutoInit() {
        const section = document.getElementById('mapaSection');
        if (!section) {
            // La sección aún no existe en el DOM: reintenta
            setTimeout(setupAutoInit, 500);
            return;
        }
        const observer = new MutationObserver(() => {
            if (section.classList.contains('active')) {
                init();
            }
        });
        observer.observe(section, { attributes: true, attributeFilter: ['class'] });
        // Si ya está activa al cargar (caso raro), init inmediato
        if (section.classList.contains('active')) init();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupAutoInit);
    } else {
        setupAutoInit();
    }

    // API pública
    window.LBW_Map = {
        init: init,
        refresh: refresh,
        toggleNodes: toggleNodes,
        toggleCitizens: toggleCitizens
    };
})(window);
