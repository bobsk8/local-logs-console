const assert = require('assert');
const path = require('path');

const { CommandStore } = require(path.join('..', 'out', 'store', 'commandStore.js'));

// Minimal in-memory stand-in for vscode.Memento (get/update only — all CommandStore needs).
function createMemento(initial) {
    const data = Object.assign({}, initial);
    return {
        store: data,
        get(key, defaultValue) {
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : defaultValue;
        },
        update(key, value) {
            data[key] = value;
            return Promise.resolve();
        }
    };
}

function run() {
    console.log('Running CommandStore tests...');

    // Empty store
    const empty = new CommandStore(createMemento());
    assert.deepStrictEqual(empty.getAll(), [], 'Empty store returns []');
    assert.strictEqual(empty.last(), undefined, 'Empty store last() is undefined');

    // Add + last + most-recent-first ordering
    const s1 = new CommandStore(createMemento());
    s1.add('npm run dev');
    s1.add('npm test');
    assert.deepStrictEqual(s1.getAll(), ['npm test', 'npm run dev'], 'Most-recent-first order');
    assert.strictEqual(s1.last(), 'npm test', 'last() is the most recent');

    // Trim on add
    const s2 = new CommandStore(createMemento());
    s2.add('  npm run build  ');
    assert.deepStrictEqual(s2.getAll(), ['npm run build'], 'Command is trimmed');

    // Empty / whitespace-only is ignored
    const s3 = new CommandStore(createMemento());
    s3.add('');
    s3.add('   ');
    assert.deepStrictEqual(s3.getAll(), [], 'Blank commands are ignored');

    // Dedupe + move-to-front
    const s4 = new CommandStore(createMemento());
    s4.add('a');
    s4.add('b');
    s4.add('a');
    assert.deepStrictEqual(s4.getAll(), ['a', 'b'], 'Re-adding moves to front without duplicating');

    // Cap at 20 (MAX_COMMANDS)
    const s5 = new CommandStore(createMemento());
    for (let i = 1; i <= 25; i++) {
        s5.add('cmd' + i);
    }
    const capped = s5.getAll();
    assert.strictEqual(capped.length, 20, 'Capped at 20 entries');
    assert.strictEqual(capped[0], 'cmd25', 'Newest kept at front');
    assert.strictEqual(capped[19], 'cmd6', 'Oldest-over-cap dropped (cmd1..cmd5 gone)');

    // Remove
    const s6 = new CommandStore(createMemento());
    s6.add('a');
    s6.add('b');
    s6.add('c');
    s6.remove('b');
    assert.deepStrictEqual(s6.getAll(), ['c', 'a'], 'remove() drops the entry, keeps order');
    s6.remove('does-not-exist');
    assert.deepStrictEqual(s6.getAll(), ['c', 'a'], 'Removing a missing entry is a no-op');

    // Persistence: a new store over the same memento reads the saved list back
    const memento = createMemento();
    const writer = new CommandStore(memento);
    writer.add('npm start');
    writer.add('npm run watch');
    const reader = new CommandStore(memento);
    assert.deepStrictEqual(reader.getAll(), ['npm run watch', 'npm start'], 'State persists via the Memento');

    console.log('All CommandStore tests passed.');
}

run();
