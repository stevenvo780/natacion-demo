// Run: node --test tests/attendance-registration.test.cjs
// Offline source-handler tests. These model hook state/commit boundaries, not React or a browser.
// Every record below is an invented adult fixture; no camera, network, storage or timers run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const files = ['index.html', 'maquetas/control-asistencia.html'];
const plain = value => JSON.parse(JSON.stringify(value));
const adult = (id, nombre) => ({
  id, nombre, apellidos: 'Adult Fixture', categoria: 'Adultos',
  horario: { profesor: 'Fixture Coach', dias: ['Lunes', 'Miércoles'], hora: '17:00' },
  incidencias: [], llamado: false, ultimaConversacion: ''
});
const syntheticStudents = () => [adult('fixture-a', 'Alpha'), adult('fixture-b', 'Beta')];

function slice(source, start, end, offset = 0) {
  const begin = source.indexOf(start, offset);
  assert.ok(begin >= 0, `Missing source marker: ${start}`);
  const finish = source.indexOf(end, begin);
  assert.ok(finish > begin, `Missing source marker: ${end}`);
  return source.slice(begin, finish);
}

// State updates wait until the next explicit render. Refs are shared across renders.
// This also catches duplicates queued before React could commit the first access.
function hookModel() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const changed = (before, after) => !before || after.some((v, i) => !Object.is(v, before[i]));
  const updates = [];
  return {
    updates,
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial, pending: [] };
      const slot = slots[i];
      return [slot.value, update => { slot.pending.push(update); updates.push(update); }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { current: initial };
      return slots[i];
    },
    useMemo(factory, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: factory(), deps };
      return slots[i].value;
    },
    useCallback(fn, deps) { return this.useMemo(() => fn, deps); },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) {
        effects.push(() => {
          slots[i]?.cleanup?.();
          slots[i] = { deps, cleanup: effect() };
        });
      }
    },
    render(fn) {
      for (const slot of slots) {
        if (slot?.kind !== 'state') continue;
        for (const update of slot.pending.splice(0)) {
          if (typeof update === 'function') {
            const first = update(slot.value);
            assert.deepEqual(plain(update(slot.value)), plain(first), 'state updater must be pure when replayed');
            slot.value = first;
          } else slot.value = update;
        }
      }
      cursor = 0;
      const result = fn();
      for (const effect of effects.splice(0)) effect();
      return result;
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); }
  };
}

function fixture(source, initialRecords = []) {
  const hooks = hookModel();
  let now = new Date(2026, 9, 3, 12, 0).getTime();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const utilities = slice(source, '    function toDateKey(date) {', '    // ── Componentes de presentación');
  const appPrefix = slice(source, '    function App() {', '      const selected = students.find');
  const scope = {
    Date: FixedDate,
    loadState: () => ({ students: syntheticStudents(), ausencias: [], registros: plain(initialRecords) }),
    saveState: () => true,
    SEED_STUDENTS: [],
    setTimeout: () => 'synthetic-timeout'
  };
  for (const name of ['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect']) scope[name] = hooks[name].bind(hooks);
  const component = vm.runInNewContext(`${utilities}\n${appPrefix}\nreturn { registrarAcceso, registros, students, setStudents, markCalled, undoCall, toggleIncidencia };\n}\nApp;`, scope);
  const render = () => hooks.render(component);
  let view = render();
  return {
    get view() { return view; },
    render() { view = render(); return view; },
    setTime(value) { now = value.getTime(); },
    successes: () => hooks.updates.filter(value => value?.type === 'ok'),
    errors: () => hooks.updates.filter(value => value?.type === 'err')
  };
}

function scanner(source, app, options = {}) {
  const hooks = hookModel();
  const intervals = new Map();
  let token = 0;
  let code = 'fixture-a';
  let stoppedTracks = 0;
  const prefix = slice(source, '    function QRView({ students, registros, onRegister }) {', '      const hoy = toDateKey(new Date());');
  const scope = {
    navigator: { mediaDevices: { getUserMedia: async () => {
      const stream = { getTracks: () => [{ stop: () => stoppedTracks++ }] };
      return options.getUserMedia ? options.getUserMedia(stream) : stream;
    } } },
    window: { BarcodeDetector: class { async detect() { return options.detect ? options.detect(code) : [{ rawValue: code }]; } } },
    setInterval(callback, delay) { assert.equal(delay, 700); intervals.set(++token, callback); return token; },
    clearInterval(id) { intervals.delete(id); }
  };
  for (const name of ['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect']) scope[name] = hooks[name].bind(hooks);
  const component = vm.runInNewContext(`${prefix}\nreturn { start, stop, videoRef, status, errorMsg };\n}\nQRView;`, scope);
  const render = () => hooks.render(() => component({ students: app.view.students, registros: app.view.registros, onRegister: app.view.registrarAcceso }));
  let view = render();
  view.videoRef.current = { srcObject: null, play: async () => options.play?.() };
  return {
    start: () => view.start(),
    stop: () => view.stop(),
    tick: async () => { for (const callback of [...intervals.values()]) await callback(); },
    setCode(value) { code = value; },
    render() { view = render(); },
    unmount: () => hooks.unmount(),
    intervalCount: () => intervals.size,
    stoppedTracks: () => stoppedTracks,
    status: () => view.status,
    error: () => view.errorMsg
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  test(`${file}: repeated QR frames and stale handlers register only once`, async () => {
    const app = fixture(source);
    const retained = app.view.registrarAcceso;
    const reader = scanner(source, app);
    await reader.start();
    await reader.tick();
    app.render();
    reader.render();
    retained('fixture-a');
    await reader.tick();
    app.render();
    reader.render();
    await reader.tick();
    assert.equal(app.render().registros.length, 1);
    assert.equal(app.successes().length, 1);
    reader.unmount();
  });

  test(`${file}: rapid mixed QR/manual calls before a render remain idempotent`, async () => {
    const app = fixture(source);
    const register = app.view.registrarAcceso;
    const reader = scanner(source, app);
    await reader.start();
    await Promise.all([reader.tick(), reader.tick(), reader.tick()]);
    register('fixture-a');
    register('fixture-b');
    register('fixture-b');
    const records = app.render().registros;
    assert.deepEqual(plain(records.map(row => row.alumnoId)), ['fixture-a', 'fixture-b']);
    assert.equal(new Set(records.map(row => row.id)).size, 2, 'rapid distinct students need distinct row keys');
    assert.equal(app.successes().length, 2);
    reader.unmount();
  });

  test(`${file}: existing attendance and historical records are preserved`, async () => {
    const initial = [
      { id: 'existing', alumnoId: 'fixture-a', alumno: 'Alpha Adult Fixture', fecha: '2026-10-03', hora: '09:00' },
      { id: 'history', alumnoId: 'fixture-b', alumno: 'Beta Adult Fixture', fecha: '2026-10-02', hora: '18:00' }
    ];
    const app = fixture(source, initial);
    const reader = scanner(source, app);
    await reader.start();
    await reader.tick();
    app.view.registrarAcceso('fixture-a');
    reader.setCode('fixture-b');
    await reader.tick();
    const records = app.render().registros;
    assert.deepEqual(plain(records.slice(0, 2)), initial);
    assert.equal(records.length, 3);
    assert.equal(app.successes().length, 1);
    reader.unmount();
  });

  test(`${file}: manual IDs, trimmed names and unknown values keep their behavior`, () => {
    const app = fixture(source);
    app.view.registrarAcceso('  ALPHA ADULT FIXTURE  ');
    app.render().registrarAcceso('fixture-a');
    app.view.registrarAcceso('unknown-fixture');
    app.view.registrarAcceso('   ');
    app.view.registrarAcceso('fixture-b');
    assert.equal(app.render().registros.length, 2);
    assert.equal(app.successes().length, 2);
    assert.equal(app.errors().length, 2);
  });

  test(`${file}: active scanner sees updated students without losing schedules`, async () => {
    const app = fixture(source);
    const original = plain(app.view.students);
    const reader = scanner(source, app);
    await reader.start();
    app.view.setStudents(prev => prev.map(student => student.id === 'fixture-a' ? { ...student, nombre: 'Renamed' } : student));
    app.render();
    reader.render();
    reader.setCode('Renamed Adult Fixture');
    await reader.tick();
    const state = app.render();
    assert.equal(state.registros.length, 1);
    assert.equal(state.registros[0].alumno, 'Renamed Adult Fixture');
    assert.deepEqual(plain(state.students.map(student => student.horario)), original.map(student => student.horario));
    assert.equal(app.errors().length, 0);
    reader.unmount();
  });

  test(`${file}: stop, restart, leave and reopen do not add another daily record`, async () => {
    const app = fixture(source);
    let reader = scanner(source, app);
    await reader.start();
    await reader.tick();
    app.render();
    reader.stop();
    assert.equal(reader.intervalCount(), 0);
    assert.equal(reader.stoppedTracks(), 1);
    reader.render();
    await reader.start();
    await reader.tick();
    reader.unmount();
    assert.equal(reader.intervalCount(), 0);
    assert.equal(reader.stoppedTracks(), 2);
    reader = scanner(source, app);
    await reader.start();
    await reader.tick();
    assert.equal(app.render().registros.length, 1);
    assert.equal(app.successes().length, 1);
    reader.unmount();
    assert.equal(reader.intervalCount(), 0);
  });

  test(`${file}: next local day admits one new record with the correct time`, async () => {
    const app = fixture(source);
    const reader = scanner(source, app);
    app.setTime(new Date(2026, 9, 3, 23, 59, 59));
    await reader.start();
    await reader.tick();
    app.render();
    app.setTime(new Date(2026, 9, 4, 0, 0, 1));
    await reader.tick();
    await reader.tick();
    const records = app.render().registros;
    assert.deepEqual(plain(records.map(({ fecha, hora }) => ({ fecha, hora }))), [
      { fecha: '2026-10-03', hora: '23:59' }, { fecha: '2026-10-04', hora: '00:00' }
    ]);
    assert.equal(app.successes().length, 2);
    reader.unmount();
  });

  for (const action of ['stop', 'unmount']) {
    for (const outcome of ['resolve', 'reject']) {
      test(`${file}: pending detection ${outcome} after ${action} cannot register`, async () => {
        const app = fixture(source);
        const pending = deferred();
        const reader = scanner(source, app, { detect: () => pending.promise });
        await reader.start();
        const inFlight = reader.tick();
        reader[action]();
        assert.equal(reader.intervalCount(), 0);
        assert.equal(reader.stoppedTracks(), 1);
        if (outcome === 'resolve') pending.resolve([{ rawValue: 'fixture-a' }]);
        else pending.reject(new Error('Synthetic late detector failure'));
        await inFlight;
        assert.equal(app.render().registros.length, 0);
        assert.equal(app.successes().length, 0);
        assert.equal(app.errors().length, 0);
        if (action === 'stop') {
          reader.render();
          assert.equal(reader.status(), 'idle');
          reader.unmount();
        }
      });
    }
  }

  test(`${file}: old detection generation cannot affect a restarted scanner`, async () => {
    const app = fixture(source);
    const pending = deferred();
    let first = true;
    const reader = scanner(source, app, { detect: code => {
      if (first) { first = false; return pending.promise; }
      return [{ rawValue: code }];
    } });
    await reader.start();
    const oldTick = reader.tick();
    reader.stop();
    await reader.start();
    await reader.tick();
    assert.equal(app.render().registros.length, 1);
    pending.resolve([{ rawValue: 'fixture-b' }]);
    await oldTick;
    assert.equal(app.render().registros.length, 1, 'old generation must not add a different adult');
    assert.equal(app.successes().length, 1);
    reader.setCode('fixture-b');
    await reader.tick();
    assert.equal(app.render().registros.length, 2, 'new generation still accepts that adult');
    assert.equal(reader.intervalCount(), 1);
    assert.equal(reader.stoppedTracks(), 1);
    reader.unmount();
    assert.equal(reader.stoppedTracks(), 2);
  });

  test(`${file}: late detection from a closed view cannot affect its replacement`, async () => {
    const app = fixture(source);
    const pending = deferred();
    const oldReader = scanner(source, app, { detect: () => pending.promise });
    await oldReader.start();
    const oldTick = oldReader.tick();
    oldReader.unmount();
    const reader = scanner(source, app);
    await reader.start();
    pending.resolve([{ rawValue: 'fixture-b' }]);
    await oldTick;
    assert.equal(app.render().registros.length, 0);
    await reader.tick();
    assert.equal(app.render().registros.length, 1);
    assert.equal(app.successes().length, 1);
    assert.equal(oldReader.stoppedTracks(), 1);
    reader.unmount();
    assert.equal(reader.stoppedTracks(), 1);
  });

  for (const phase of ['getUserMedia', 'play']) {
    for (const outcome of ['resolve', 'reject']) {
      test(`${file}: pending ${phase} ${outcome} after stop stays stopped and releases stream`, async () => {
        const app = fixture(source);
        const pending = deferred();
        const entered = deferred();
        let delayedStream;
        const reader = scanner(source, app, { [phase]: stream => {
          delayedStream = stream;
          entered.resolve();
          return pending.promise;
        } });
        const starting = reader.start();
        await entered.promise;
        reader.stop();
        if (outcome === 'resolve') pending.resolve(delayedStream);
        else pending.reject(new Error('Synthetic late startup failure'));
        await starting;
        reader.render();
        assert.equal(reader.status(), 'idle');
        assert.equal(reader.error(), '');
        assert.equal(reader.intervalCount(), 0);
        assert.equal(reader.stoppedTracks(), phase === 'getUserMedia' && outcome === 'reject' ? 0 : 1);
        assert.equal(app.render().registros.length, 0);
        reader.unmount();
      });
    }
  }

  test(`${file}: superseded pending startup cleans only its own stream`, async () => {
    const app = fixture(source);
    const pending = deferred();
    let oldStream;
    let requests = 0;
    const reader = scanner(source, app, { getUserMedia: stream => {
      if (requests++ === 0) { oldStream = stream; return pending.promise; }
      return stream;
    } });
    const oldStart = reader.start();
    await reader.start();
    assert.equal(reader.intervalCount(), 1);
    pending.resolve(oldStream);
    await oldStart;
    assert.equal(reader.stoppedTracks(), 1);
    assert.equal(reader.intervalCount(), 1, 'new session interval survives old startup');
    await reader.tick();
    assert.equal(app.render().registros.length, 1);
    reader.unmount();
    assert.equal(reader.stoppedTracks(), 2);
    assert.equal(reader.intervalCount(), 0);
  });

  test(`${file}: current startup failure releases its stream and shows the existing error`, async () => {
    const app = fixture(source);
    const reader = scanner(source, app, { play: async () => { throw new Error('Synthetic playback failure'); } });
    await reader.start();
    reader.render();
    assert.equal(reader.status(), 'error');
    assert.match(reader.error(), /Synthetic playback failure/);
    assert.equal(reader.stoppedTracks(), 1);
    assert.equal(reader.intervalCount(), 0);
    reader.unmount();
    assert.equal(reader.stoppedTracks(), 1);
  });

  test(`${file}: unrelated student edits cannot reset queued attendance`, () => {
    const app = fixture(source);
    const register = app.view.registrarAcceso;
    register('fixture-a');
    app.view.markCalled('fixture-a', 'Synthetic note');
    app.render();
    app.view.undoCall('fixture-a');
    register('fixture-a');
    register('fixture-b');
    const state = app.render();
    assert.equal(state.registros.length, 2);
    assert.equal(state.students[0].llamado, false);
    assert.equal(state.students[0].ultimaConversacion, 'Synthetic note');
    assert.equal(app.successes().filter(value => value.text.startsWith('Acceso registrado:')).length, 2);
  });
}

test('served attendance page and mockup remain byte-identical', () => {
  assert.equal(fs.readFileSync(path.join(root, files[0]), 'utf8'), fs.readFileSync(path.join(root, files[1]), 'utf8'));
});
