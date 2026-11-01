// Tests for SourceResolver (real temp files, no vscode).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SourceResolver } = require('../out/core/sourceResolver');

async function run() {
    console.log('Running source resolver tests...');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llc-src-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llc-out-'));
    try {
        fs.mkdirSync(path.join(root, 'src', 'users'), { recursive: true });
        const service = path.join(root, 'src', 'users', 'user.service.ts');
        fs.writeFileSync(service, '// x\n');
        const secret = path.join(outside, 'secret.txt');
        fs.writeFileSync(secret, 'nope');

        const resolver = new SourceResolver(() => [root]);

        // absolute path inside the workspace
        assert.strictEqual(resolver.resolve(service), service);
        // relative to the workspace root, and to a capture cwd
        assert.strictEqual(resolver.resolve('src/users/user.service.ts'), service);
        assert.strictEqual(resolver.resolve('./users/user.service.ts', path.join(root, 'src')), service);
        // container path: /app/src/... maps onto the workspace by its tail
        assert.strictEqual(resolver.resolve('/app/src/users/user.service.ts'), service);

        // files outside the workspace never resolve, even when they exist
        assert.strictEqual(resolver.resolve(secret), undefined);
        assert.strictEqual(resolver.resolve(path.relative(root, secret)), undefined, 'no ../ escapes');
        assert.strictEqual(resolver.isInside(secret), false);
        assert.strictEqual(resolver.isInside(service), true);
        // ...unless the capture itself ran there
        assert.strictEqual(resolver.resolve(secret, outside), secret);

        // missing files and directories
        assert.strictEqual(resolver.resolve('src/missing.ts'), undefined);
        assert.strictEqual(resolver.resolve(path.join(root, 'src')), undefined);

        // bare file names go through the finder, filtered to the workspace
        const found = await resolver.resolveAsync('UserService.java', undefined, async () => [secret, service]);
        assert.strictEqual(found, service);
        const none = await resolver.resolveAsync('UserService.java', undefined, async () => [secret]);
        assert.strictEqual(none, undefined);

        // cache is invalidated by reset()
        const later = path.join(root, 'src', 'later.ts');
        assert.strictEqual(resolver.resolve('src/later.ts'), undefined);
        fs.writeFileSync(later, '');
        assert.strictEqual(resolver.resolve('src/later.ts'), undefined, 'cached miss');
        resolver.reset();
        assert.strictEqual(resolver.resolve('src/later.ts'), later);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }

    console.log('All source resolver tests passed.');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
