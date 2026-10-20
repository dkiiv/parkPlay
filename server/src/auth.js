'use strict';
// Single-user password auth with an HMAC-signed session cookie.
// Password is stored as scrypt "salt:hash" (hex) in TV_PASSWORD_HASH.
const crypto = require('crypto');

const COOKIE = 'tvs';
const MAX_AGE_S = 90 * 24 * 3600; // 90 days - the car should stay logged in

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), want.length);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

class Auth {
  constructor({ secret, passwordHash }) {
    if (!secret || secret.length < 32) throw new Error('TV_SECRET missing or too short (>=32 chars)');
    if (!passwordHash) throw new Error('TV_PASSWORD_HASH missing (npm run hash-password -- "<pw>")');
    this.secret = secret;
    this.passwordHash = passwordHash;
    this.fails = []; // timestamps of failed logins (global limiter; all traffic is SNAT'd)
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue() {
    const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
    const payload = String(exp);
    return `${payload}.${this.sign(payload)}`;
  }

  cookieHeader(value, secure) {
    return `${COOKIE}=${value}; Max-Age=${MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  clearCookieHeader() {
    return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
  }

  check(req) {
    const raw = req.headers.cookie || '';
    const m = raw.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
    if (!m) return false;
    const val = m.slice(COOKIE.length + 1);
    const [payload, sig] = val.split('.');
    if (!payload || !sig) return false;
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
    return Number(payload) > Date.now() / 1000;
  }

  locked() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    this.fails = this.fails.filter((t) => t > cutoff);
    return this.fails.length >= 10;
  }

  login(pw) {
    if (this.locked()) return { ok: false, locked: true };
    if (verifyPassword(pw, this.passwordHash)) return { ok: true };
    this.fails.push(Date.now());
    return { ok: false, locked: this.locked() };
  }
}

module.exports = { Auth, hashPassword, verifyPassword };

if (require.main === module) {
  const [cmd, pw] = process.argv.slice(2);
  if (cmd === 'hash' && pw) {
    console.log(hashPassword(pw));
  } else {
    console.error('usage: node src/auth.js hash "<password>"');
    process.exit(1);
  }
}
