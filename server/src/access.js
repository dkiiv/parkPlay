'use strict';
// Cloudflare Access JWT verification (RS256, keys from https://<team>/cdn-cgi/access/certs)
// plus short-lived HMAC "stream tickets" for the video hostname, which is NOT behind Access.
const crypto = require('crypto');
const https = require('https');

function b64urlJSON(s) { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

class AccessAuth {
  constructor({ teamDomain, aud, secret, ticketTtlS = 12 * 3600, log = () => {} }) {
    if (!teamDomain || !aud) throw new Error('TV_ACCESS_TEAM and TV_ACCESS_AUD are required');
    if (!secret || secret.length < 32) throw new Error('TV_SECRET missing or too short (>=32 chars)');
    this.team = teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.issuer = `https://${this.team}`;
    this.aud = aud;
    this.secret = secret;
    this.ticketTtlS = ticketTtlS;
    this.log = log;
    this.keys = new Map(); // kid -> KeyObject
    this.keysFetchedAt = 0;
  }

  async refreshKeys(force = false) {
    if (!force && Date.now() - this.keysFetchedAt < 3600 * 1000 && this.keys.size) return;
    if (Date.now() - this.keysFetchedAt < 10 * 1000 && this.keys.size) return; // don't hammer on unknown kid
    const j = await fetchJSON(`${this.issuer}/cdn-cgi/access/certs`);
    const next = new Map();
    for (const jwk of j.keys || []) next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    if (next.size) { this.keys = next; this.keysFetchedAt = Date.now(); }
    this.log(`access: loaded ${next.size} signing keys`);
  }

  tokenFrom(req) {
    const h = req.headers['cf-access-jwt-assertion'];
    if (h) return h;
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    return m ? m[1] : null;
  }

  // Returns the identity (email) or null. Never throws.
  async verify(req) {
    const tok = this.tokenFrom(req);
    if (!tok) return null;
    try {
      const [h, p, s] = tok.split('.');
      if (!h || !p || !s) return null;
      const header = b64urlJSON(h);
      if (header.alg !== 'RS256') return null;
      await this.refreshKeys();
      if (!this.keys.has(header.kid)) await this.refreshKeys(true);
      const key = this.keys.get(header.kid);
      if (!key) return null;
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
      if (!ok) return null;
      const c = b64urlJSON(p);
      const now = Date.now() / 1000;
      const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
      if (!auds.includes(this.aud)) return null;
      if (c.iss !== this.issuer) return null;
      if (typeof c.exp !== 'number' || c.exp < now - 30) return null;
      if (typeof c.nbf === 'number' && c.nbf > now + 30) return null;
      return c.email || c.common_name || 'service';
    } catch (e) {
      this.log('access verify error: ' + e.message);
      return null;
    }
  }

  // ---- stream tickets: "<exp>.<sub>.<hmac>" ----
  issueTicket(sub) {
    const exp = Math.floor(Date.now() / 1000) + this.ticketTtlS;
    const payload = `${exp}.${Buffer.from(sub).toString('base64url')}`;
    const mac = crypto.createHmac('sha256', this.secret).update('stream:' + payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  checkTicket(t) {
    if (!t || typeof t !== 'string') return false;
    const parts = t.split('.');
    if (parts.length !== 3) return false;
    const payload = `${parts[0]}.${parts[1]}`;
    const want = Buffer.from(crypto.createHmac('sha256', this.secret).update('stream:' + payload).digest('base64url'));
    const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
    return Number(parts[0]) > Date.now() / 1000;
  }
}

module.exports = { AccessAuth };
