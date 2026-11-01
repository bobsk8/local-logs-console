// Minimal test runner: executes every test/test-*.js and reports a summary.
// Runs all suites even after a failure so one broken suite can't hide others.
const { readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const testDir = __dirname;
const files = readdirSync(testDir)
    .filter(f => /^test-.*\.js$/.test(f))
    .sort();

const failed = [];
for (const file of files) {
    const result = spawnSync(process.execPath, [path.join(testDir, file)], { stdio: 'inherit' });
    if (result.status !== 0) {
        failed.push(file);
        console.error(`\n✗ ${file} failed (exit ${result.status})\n`);
    }
}

if (failed.length > 0) {
    console.error(`\n✗ ${failed.length} of ${files.length} test suites failed: ${failed.join(', ')}`);
    process.exit(1);
}
console.log(`\n✓ ${files.length} test suites passed.`);
