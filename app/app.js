'use strict';

(function(document) {
    function _parseKVPairs(pairs, name) {
        const map = pairs.map(function(kv) {
            const eq = kv.indexOf('=');
            return {
                name: unescape(kv.slice(0, eq)),
                value: unescape(kv.slice(eq + 1))
            };
        });
        const kvs = map.filter(kv => kv.name === name);
        return kvs.length > 0 ? kvs[0] : null;
    }

    function _parseCookie(name) {
        const pairs = document.cookie.split(/\s*;\s*/);
        return _parseKVPairs(pairs, name);
    }


    const app = document.querySelector('#app');

    // Check if we have a cookie, if so grab the value: that's our token we're going to use for requests.
    const tokenCookie = _parseCookie('token');
    app.token = tokenCookie ? tokenCookie.value : null;
})(document);
