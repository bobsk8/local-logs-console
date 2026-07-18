// Unit tests for the ReDoS-guarded regex compiler (pure — no vscode).
const assert = require('assert');
const { compileSafeRegex, MAX_REGEX_LENGTH } = require('../out/shared/regexSafety');

function run() {
    console.log('Running regexSafety tests...');

    // valid patterns compile and match
    const re = compileSafeRegex('5\\d\\d', '');
    assert.ok(re instanceof RegExp);
    assert.strictEqual(re.test('status 503'), true);
    assert.strictEqual(re.test('status 200'), false);

    // flags are honored
    const ci = compileSafeRegex('error', 'i');
    assert.ok(ci.test('ERROR'));
    assert.strictEqual(ci.flags.includes('i'), true);
    const cs = compileSafeRegex('error', '');
    assert.strictEqual(cs.test('ERROR'), false);

    // empty source → null
    assert.strictEqual(compileSafeRegex('', ''), null);

    // over the length cap → null
    assert.strictEqual(compileSafeRegex('a'.repeat(MAX_REGEX_LENGTH + 1), ''), null);
    // exactly at the cap is allowed (still a valid regex)
    assert.ok(compileSafeRegex('a'.repeat(MAX_REGEX_LENGTH), '') instanceof RegExp);

    // nested-quantifier heuristic rejects the classic catastrophic shapes
    assert.strictEqual(compileSafeRegex('(a+)+', ''), null);
    assert.strictEqual(compileSafeRegex('(a+)+$', ''), null);
    assert.strictEqual(compileSafeRegex('(a{1,3})+', ''), null);

    // syntactically invalid regex → null (unbalanced group)
    assert.strictEqual(compileSafeRegex('(unclosed', ''), null);
    // invalid flags → null (caught by the try/catch)
    assert.strictEqual(compileSafeRegex('abc', 'z'), null);

    // a safe pattern that merely contains a single quantifier is fine
    assert.ok(compileSafeRegex('\\d+', '') instanceof RegExp);
    assert.ok(compileSafeRegex('a*b', '') instanceof RegExp);

    console.log('All regexSafety tests passed.');
}

run();
