const assert = require('assert');
const path = require('path');

const { Redactor } = require(path.join('..', 'out', 'core', 'redactor.js'));

// Synthetic token fixtures, assembled at runtime so secret scanners never see
// credential-shaped literals in the repository. None of these are real.
const FAKE = {
    aws: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
    jwtHeader: ['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''),
    jwt: [['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''), ['eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0'].join(''), 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'].join('.'),
    github: ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join(''),
    slack: ['xoxb-', '123456789012-abcdefghijkl'].join(''),
    google: ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'].join('')
};

function run() {
    console.log('Running Redactor tests...');

    const redactor = new Redactor();

    // AWS access key ID
    let r = redactor.redact(`using key ${FAKE.aws} to auth`);
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes(FAKE.aws), 'AWS key must be masked');
    assert(r.text.includes('[REDACTED]'));

    // Bearer token keeps the scheme word
    r = redactor.redact('Authorization: Bearer abcdef123456789.xyz');
    assert.strictEqual(r.redacted, true);
    assert(r.text.includes('Bearer [REDACTED]'), 'Bearer scheme should remain: ' + r.text);
    assert(!r.text.includes('abcdef123456789'));

    // JWT
    r = redactor.redact(`token ${FAKE.jwt} received`);
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes(FAKE.jwtHeader));

    // Credentials in URL
    r = redactor.redact('connecting to postgres://admin:hunter2@db.local:5432/app');
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes('hunter2'));
    assert(r.text.includes('postgres://admin:[REDACTED]@db.local'), 'URL structure preserved: ' + r.text);

    // GitHub / Slack / Google tokens
    r = redactor.redact(FAKE.github);
    assert.strictEqual(r.redacted, true);
    r = redactor.redact(`slack ${FAKE.slack}`);
    assert.strictEqual(r.redacted, true);
    r = redactor.redact(`gkey ${FAKE.google}`);
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

    // Authorization schemes other than Bearer: keep the scheme, mask the whole credential
    for (const scheme of ['Basic', 'Token', 'Digest']) {
        r = redactor.redact(`Authorization: ${scheme} dXNlcjpwYXNzd29yZA==`);
        assert.strictEqual(r.redacted, true);
        assert.strictEqual(r.text, `Authorization: ${scheme} [REDACTED]`, scheme + ' → ' + r.text);
    }

    // Numeric secrets in JSON are masked and the line stays valid JSON
    r = redactor.redact('{"user":"bob","password":123456,"pin_secret":42.5}');
    assert.strictEqual(r.redacted, true);
    const parsedNumeric = JSON.parse(r.text);
    assert.strictEqual(parsedNumeric.password, '[REDACTED]');
    assert.strictEqual(parsedNumeric.pin_secret, '[REDACTED]');
    assert.strictEqual(parsedNumeric.user, 'bob');
    // token counts are not secrets
    r = redactor.redact('{"prompt_tokens":120,"max_tokens":4096}');
    assert.strictEqual(r.redacted, false, 'token counts untouched: ' + r.text);

    // CDN / package URLs with @version are not credentials
    for (const url of ['https://cdn.jsdelivr.net/npm/some-package@1.0.0/dist/x.js', 'git+https://github.com/org/repo.git#main']) {
        r = redactor.redact('loading ' + url);
        assert.strictEqual(r.redacted, false, 'false positive on ' + url + ' → ' + r.text);
    }
    // ...while a real token@host credential is still masked
    r = redactor.redact(`cloning https://${FAKE.github}@github.com/org/repo.git`);
    assert.strictEqual(r.redacted, true);
    assert(!r.text.includes(FAKE.github));

    // CLI flags separated by whitespace
    r = redactor.redact('mysql --user root --password hunter2 --api-key abc123 --verbose');
    assert(!r.text.includes('hunter2') && !r.text.includes('abc123'), r.text);
    assert(r.text.includes('--verbose'));

    console.log('All Redactor tests passed.');
}

run();
