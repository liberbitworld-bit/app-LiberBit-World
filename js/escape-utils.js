/**
 * LiberBit World — Canonical escape / sanitization utilities
 *
 * Unifies the 7 previously-scattered escape functions. Exposes `window.LBW.escape`
 * (and legacy aliases `window.escapeHtml` / `window._esc`) so existing call sites
 * keep working while new code uses the namespaced API.
 *
 * Security notes:
 *  - escapeHtml() is for HTML text and HTML attribute contexts ONLY.
 *    It is NOT safe to interpolate its output into a JavaScript string literal
 *    inside an HTML attribute (e.g. onclick="foo('${escapeHtml(x)}')"),
 *    because the browser decodes HTML entities before the JS engine runs.
 *    For JS-string contexts inside HTML attributes, use `escapeJsAttr()` OR
 *    (preferred) avoid inline handlers entirely via event delegation with
 *    data-* attributes.
 *  - safeUrl() whitelists URL schemes to block javascript:, data:, vbscript:.
 *
 * Load this BEFORE any other LBW module.
 */
(function (global) {
    'use strict';

    var NS = global.LBW = global.LBW || {};

    /**
     * Escape text for safe interpolation into HTML text or double/single-quoted
     * attribute values. Handles null/undefined gracefully.
     *
     * @param {*} text
     * @returns {string}
     */
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

    /**
     * Escape a string for safe interpolation into a JavaScript string literal
     * that is itself inside an HTML attribute (e.g. onclick="foo('...')").
     *
     * This is the two-step escape required because the browser decodes HTML
     * entities in the attribute BEFORE running the JS. We first JS-escape,
     * then HTML-escape what remains.
     *
     * Prefer event delegation + data-* attributes over using this function.
     *
     * @param {*} text
     * @returns {string}
     */
    function escapeJsAttr(text) {
        if (text === null || text === undefined) return '';
        // First JS-escape: backslashes, quotes, newlines, special chars.
        var jsEscaped = String(text)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029')
            .replace(/</g, '\\x3C')
            .replace(/>/g, '\\x3E')
            .replace(/&/g, '\\x26');
        // Then HTML-escape the result for the attribute context.
        return escapeHtml(jsEscaped);
    }

    /**
     * Validate a URL for use in href/src attributes. Returns the original URL
     * if the scheme is allowed, otherwise returns 'about:blank'.
     *
     * Allowed schemes: http, https, mailto, lightning, nostr, bitcoin.
     * Relative URLs (starting with /, ./, #, ?) are allowed.
     *
     * @param {*} url
     * @returns {string}
     */
    function safeUrl(url) {
        if (url === null || url === undefined) return 'about:blank';
        var s = String(url).trim();
        if (s === '') return 'about:blank';
        // Relative URLs and fragments are safe.
        if (/^[/?#]/.test(s) || /^\.\.?\//.test(s)) return s;
        // Absolute URLs: check scheme against whitelist.
        var m = s.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
        if (!m) {
            // No scheme at all — treat as relative, safe.
            return s;
        }
        var scheme = m[1].toLowerCase();
        var allowed = ['http', 'https', 'mailto', 'lightning', 'nostr', 'bitcoin'];
        if (allowed.indexOf(scheme) === -1) return 'about:blank';
        return s;
    }

    // Public API
    NS.escapeHtml = escapeHtml;
    NS.escapeJsAttr = escapeJsAttr;
    NS.safeUrl = safeUrl;

    // Legacy aliases — existing modules continue to work unchanged.
    global.escapeHtml = escapeHtml;

}(typeof window !== 'undefined' ? window : this));
