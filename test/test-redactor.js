const assert = require('assert');
const path = require('path');

const { Redactor } = require(path.join('..', 'out', 'core', 'redactor.js'));

function run() {
    console.log('Running Redactor tests...');

    const redactor = new Redactor();

    // AWS access key ID
    let r = redactor.redact('using key AKIAIOSFODNN7EXAMPLE to auth');
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key must be masked');
    assert(r.text.includes('[REDACTED]'));

    // Bearer token keeps the scheme word
    r = redactor.redact('Authorization: Bearer abcdef123456789.xyz');
    assert.strictEqual(r.redacted, true);
    assert(r.text.includes('Bearer [REDACTED]'), 'Bearer scheme should remain: ' + r.text);
    assert(!r.text.includes('abcdef123456789'));

    // JWT
    r = redactor.redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c received');
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes('eyJhbGciOiJIUzI1NiJ9'));

    // Credentials in URL
    r = redactor.redact('connecting to postgres://admin:hunter2@db.local:5432/app');
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes('hunter2'));
    assert(r.text.includes('postgres://admin:[REDACTED]@db.local'), 'URL structure preserved: ' + r.text);

    // GitHub / Slack / Google tokens
    r = redactor.redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    assert.strictEqual(r.redacted, true);
    r = redactor.redact('slack xoxb-123456789012-abcdefghijkl');
    assert.strictEqual(r.redacted, true);
    r = redactor.redact('gkey AIzaSyA1234567890abcdefghijklmnopqrstuv');
    assert.strictEqual(r.redacted, true);

    // JSON pair: value replaced, line stays valid JSON
    const jsonLine = JSON.stringify({ level: 'info', password: 's3cr3t!', message: 'login ok' });
    r = redactor.redact(jsonLine);
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes('s3cr3t!'));
    const reparsed = JSON.parse(r.text);
    assert.strictEqual(reparsed.password, '[REDACTED]');
    assert.strictEqual(reparsed.level, 'info', 'non-secret fields untouched');
    assert.strictEqual(reparsed.message, 'login ok');

    // JSON pair with escaped quotes in the value stays valid
    r = redactor.redact('{"api_key":"ab\\"cd","x":1}');
    const reparsed2 = JSON.parse(r.text);
    assert.strictEqual(reparsed2.api_key, '[REDACTED]');
    assert.strictEqual(reparsed2.x, 1);

    // Plain key=value
    r = redactor.redact('DB_PASSWORD=supersecret retrying');
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes('supersecret'));

    // key: value plain text
    r = redactor.redact('token: abc123def456');
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes('abc123def456'));

    // Clean lines pass through untouched
    r = redactor.redact('GET /health 200 12ms');
    assert.strictEqual(r.redacted, false);
    assert.strictEqual(r.text, 'GET /health 200 12ms');

    // Disabled redactor is a no-op
    const off = new Redactor({ enabled: false });
    r = off.redact('password=supersecret');
    assert.strictEqual(r.redacted, false);
    assert(r.text.includes('supersecret'));

    // Custom patterns are additive
    const custom = new Redactor({ customPatterns: ['MYCORP-[0-9]{6}'] });
    r = custom.redact('badge MYCORP-123456 scanned');
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes('MYCORP-123456'));

    // Invalid and oversized custom patterns are ignored, not fatal
    const invalid = new Redactor({ customPatterns: ['([', 'x'.repeat(500)] });
    r = invalid.redact('hello world');
    assert.strictEqual(r.redacted, false);

    // Defaults can be turned off while custom patterns still apply
    const noDefaults = new Redactor({ useDefaultPatterns: false, customPatterns: ['zzz+'] });
    r = noDefaults.redact('password=visible zzzz');
    assert(r.text.includes('password=visible'), 'default rules disabled');
    assert(!r.text.includes('zzzz'), 'custom rule still applied');

    console.log('All Redactor tests passed.');
}

run();
