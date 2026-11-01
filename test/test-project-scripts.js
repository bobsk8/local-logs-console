// Tests for the package.json scripts reader (real temp folders, no vscode).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readProjectScripts, detectPackageManager, scriptCommand } = require('../out/ui/projectScripts');

function run() {
    console.log('Running project scripts tests...');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llc-scripts-'));
    try {
        assert.deepStrictEqual(readProjectScripts(dir), [], 'no package.json');

        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
            scripts: { predev: 'echo pre', dev: 'vite', build: 'tsc', 'test:unit': 'node t.js', postinstall: 'x', bad: 42 }
        }));
        assert.strictEqual(detectPackageManager(dir), 'npm');
        const scripts = readProjectScripts(dir);
        assert.deepStrictEqual(scripts.map(s => s.name), ['dev', 'build', 'test:unit', 'postinstall'],
            'pre/post hooks of existing scripts are hidden, non-string scripts skipped');
        assert.strictEqual(scripts[0].command, 'npm run dev');
        assert.strictEqual(scripts[0].body, 'vite');

        fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
        assert.strictEqual(detectPackageManager(dir), 'pnpm');
        assert.strictEqual(readProjectScripts(dir)[0].command, 'pnpm run dev');
        fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
        fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
        assert.strictEqual(readProjectScripts(dir)[0].command, 'yarn dev');

        assert.strictEqual(scriptCommand('bun', 'dev'), 'bun run dev');
        assert.strictEqual(scriptCommand('npm', 'weird name'), 'npm run "weird name"');

        fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
        assert.deepStrictEqual(readProjectScripts(dir), [], 'invalid package.json');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('All project scripts tests passed.');
}

run();
