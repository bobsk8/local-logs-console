// Minimal test runner: executes every test/test-*.js in order and fails fast.
const { readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const testDir = __dirname;
const files = readdirSync(testDir)
    .filter(f => /^test-.*\.js$/.test(f))
    .sort();

let failed = false;
for (const file of files) {
    const result = spawnSync(process.execPath, [path.join(testDir, file)], { stdio: 'inherit' });
    if (result.status !== 0) {
        failed = true;
        console.error(`\n✗ ${file} failed (exit ${result.status})`);
        break;
    }
}

if (failed) {
    process.exit(1);
}
console.log(`\n✓ ${files.length} test suites passed.`);
