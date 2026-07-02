const assert = require('assert');
const path = require('path');

const { parsePsTable } = require(path.join('..', 'out', 'core', 'processTree.js'));

function run() {
    console.log('Running processTree tests...');

    // Typical `ps -A -o pid=,ppid=` output (right-aligned columns)
    const stdout = [
        '    1     0',
        '  100     1',
        '  200   100',
        '  201   100',
        '  300   200',
        ' 4000     1'
    ].join('\n');

    const table = parsePsTable(stdout);
    assert.deepStrictEqual(table.get(1), [100, 4000]);
    assert.deepStrictEqual(table.get(100), [200, 201]);
    assert.deepStrictEqual(table.get(200), [300]);
    assert.strictEqual(table.get(999), undefined);

    // Windows line endings and garbage lines are tolerated
    const messy = '  10   1\r\n\r\nnot a pid line\n  11   10\n';
    const table2 = parsePsTable(messy);
    assert.deepStrictEqual(table2.get(1), [10]);
    assert.deepStrictEqual(table2.get(10), [11]);

    // Empty input
    assert.strictEqual(parsePsTable('').size, 0);

    console.log('All processTree tests passed.');
}

run();
