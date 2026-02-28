/**
 * LiberBit World - Supabase Proxy Client
 * 
 * Reemplaza las llamadas directas a supabaseClient con llamadas
 * al proxy de Vercel. Las credenciales NUNCA llegan al navegador.
 * 
 * USO: Se usa exactamente igual que el supabaseClient original:
 *   supabaseClient.from('users').select('*').eq('id', 123)
 *   → se convierte en una petición POST al proxy
 */

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000/api'
    : 'https://liberbit-api.vercel.app/api';  // ← CAMBIAR por tu URL de Vercel

console.log('🔒 LiberBit World - Modo seguro (API proxy)');

class SupabaseProxyQuery {
    constructor(table) {
        this._table = table;
        this._operation = null;
        this._data = null;
        this._select = '*';
        this._filters = [];
        this._options = {};
    }

    select(columns = '*') {
        if (this._operation === null) {
            this._operation = 'select';
            this._select = columns;
        } else {
            // .select() after .insert() or .update() → return inserted/updated data
            this._options.select = true;
        }
        return this;
    }

    insert(data) {
        this._operation = 'insert';
        this._data = data;
        return this;
    }

    upsert(data, opts) {
        this._operation = 'upsert';
        this._data = data;
        if (opts) this._options.upsertOptions = opts;
        return this;
    }

    update(data) {
        this._operation = 'update';
        this._data = data;
        return this;
    }

    delete() {
        this._operation = 'delete';
        return this;
    }

    // Filter methods
    eq(col, val)    { this._filters.push({ method: 'eq', args: [col, val] }); return this; }
    neq(col, val)   { this._filters.push({ method: 'neq', args: [col, val] }); return this; }
    gt(col, val)    { this._filters.push({ method: 'gt', args: [col, val] }); return this; }
    gte(col, val)   { this._filters.push({ method: 'gte', args: [col, val] }); return this; }
    lt(col, val)    { this._filters.push({ method: 'lt', args: [col, val] }); return this; }
    lte(col, val)   { this._filters.push({ method: 'lte', args: [col, val] }); return this; }
    like(col, val)  { this._filters.push({ method: 'like', args: [col, val] }); return this; }
    ilike(col, val) { this._filters.push({ method: 'ilike', args: [col, val] }); return this; }
    in(col, val)    { this._filters.push({ method: 'in', args: [col, val] }); return this; }
    is(col, val)    { this._filters.push({ method: 'is', args: [col, val] }); return this; }
    not(col, op, val){ this._filters.push({ method: 'not', args: [col, op, val] }); return this; }
    or(expr)        { this._filters.push({ method: 'or', args: [expr] }); return this; }
    order(col, opts){ this._filters.push({ method: 'order', args: [col, opts] }); return this; }
    limit(n)        { this._filters.push({ method: 'limit', args: [n] }); return this; }
    range(from, to) { this._filters.push({ method: 'range', args: [from, to] }); return this; }
    
    single() {
        this._filters.push({ method: 'single', args: [] });
        return this;
    }

    maybeSingle() {
        this._filters.push({ method: 'maybeSingle', args: [] });
        return this;
    }

    // Execute the query (called implicitly by await)
    async then(resolve, reject) {
        try {
            const result = await this._execute();
            resolve(result);
        } catch (err) {
            if (reject) reject(err);
            else resolve({ data: null, error: err.message });
        }
    }

    async _execute() {
        const payload = {
            table: this._table,
            operation: this._operation || 'select',
            select: this._select,
            filters: this._filters,
            data: this._data,
            options: this._options
        };

        try {
            const response = await fetch(`${API_BASE}/db`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            
            // Handle single() filter client-side if needed
            const hasSingle = this._filters.some(f => f.method === 'single');
            const hasMaybeSingle = this._filters.some(f => f.method === 'maybeSingle');
            
            if (hasSingle && result.data && Array.isArray(result.data)) {
                if (result.data.length > 1) {
                    console.warn(`[Proxy] single() returned ${result.data.length} rows for table ${this._table} — using first match`);
                }
                result.data = result.data[0] || null;
                if (!result.data) {
                    result.error = 'Row not found';
                }
            } else if (hasMaybeSingle && result.data && Array.isArray(result.data)) {
                if (result.data.length > 1) {
                    console.warn(`[Proxy] maybeSingle() returned ${result.data.length} rows for table ${this._table} — using first match`);
                }
                result.data = result.data[0] || null;
            }

            return result;
        } catch (err) {
            console.error('API proxy error:', err);
            return { data: null, error: err.message };
        }
    }
}

// Proxy client that mimics supabaseClient interface
const supabaseClient = {
    from(table) {
        return new SupabaseProxyQuery(table);
    }
};

console.log('✅ Supabase proxy client initialized');

// ================================================
// Everything below is unchanged from original config.js
// ================================================

// Function to count and display active nodes
async function updateActiveNodesCounter() {
    try {
        let userCount = 0;
        
        const { data, error } = await supabaseClient
            .from('users')
            .select('id');
        
        if (error) {
            const savedKeys = localStorage.getItem('liberbit_keys');
            if (savedKeys) userCount = 1;
        } else if (data) {
            userCount = data.length;
        } else {
            userCount = 1;
        }
        
        const counter = document.getElementById('activeNodesCount');
        if (counter) {
            const currentValue = parseInt(counter.textContent) || 0;
            animateCounter(counter, currentValue, userCount, 1500);
        }
    } catch (err) {
        const counter = document.getElementById('activeNodesCount');
        if (counter && counter.textContent === '0') {
            counter.textContent = '1';
        }
    }
}

// Function to animate counter
function animateCounter(element, start, end, duration) {
    const range = end - start;
    const increment = range / (duration / 16);
    let current = start;
    
    const timer = setInterval(() => {
        current += increment;
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            current = end;
            clearInterval(timer);
        }
        element.textContent = Math.round(current);
    }, 16);
}

const IDENTITIES_BASE_OFFSET = 35;

async function updateIdentitiesCounter() {
    try {
        const { data, error } = await supabaseClient
            .from('users')
            .select('id');
        
        let realCount = 0;
        if (!error && data) {
            realCount = data.length;
        } else {
            const savedKeys = localStorage.getItem('liberbit_keys');
            if (savedKeys) realCount = 1;
        }
        
        const displayCount = realCount + IDENTITIES_BASE_OFFSET;
        
        const counter = document.getElementById('identitiesCount');
        if (counter) {
            const currentValue = parseInt(counter.textContent) || 0;
            animateCounter(counter, currentValue, displayCount, 1500);
        }
    } catch (err) {
        const counter = document.getElementById('identitiesCount');
        if (counter && counter.textContent === '0') {
            counter.textContent = IDENTITIES_BASE_OFFSET;
        }
    }
}

// Load hero background
window.addEventListener('DOMContentLoaded', () => {
    const heroBackground = document.getElementById('heroBackground');
    if (heroBackground) {
        heroBackground.style.background = `
            linear-gradient(135deg, rgba(44, 95, 111, 0.8) 0%, rgba(13, 23, 30, 0.9) 100%),
            url('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"%3E%3Crect fill="%232C5F6F" width="1200" height="800"/%3E%3C/svg%3E')
        `;
        heroBackground.style.backgroundSize = 'cover';
        heroBackground.style.backgroundPosition = 'center';
    }
});

let currentUser = null;
let allPosts = [];
let currentFilter = 'todos';
let allDirectMessages = [];
let currentChatWith = null;
let allProposals = [];
let allVotes = [];
let currentProposalFilter = 'all';
let activeNodesInterval = null;
let userProfile = null;
