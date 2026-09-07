import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const { layout } = loadApp();

const good = () => ({
  v: 1, id: 'lay_test', name: 'T',
  plot: { w: 10, h: 10 },
  nodes: { a: [1, 1], b: [5, 1] },
  walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' }],
  areas: [], items: [],
  bays: [{ id: 'bay1', rect: [2, 3, 2.5, 5], a: 0, label: 'Bay 1' }],
  dims: [], spawn: { at: [8, 8], a: 0 },
  brief: { targets: [], vehicles: [], notes: '' },
});

test('a well-formed document validates', () => {
  assert.deepEqual(layout.validate(good()), []);
});

test('blank() produces a valid document', () => {
  assert.deepEqual(layout.validate(layout.blank('My plot')), []);
});

test('pack/unpack round-trips exactly', () => {
  const doc = good();
  const back = layout.unpack(layout.pack(doc));
  assert.ok(back.doc, JSON.stringify(back.errors));
  assert.deepEqual(back.doc, doc);
});

test('pack returns a deep clone, not the same objects', () => {
  const doc = good();
  const packed = layout.pack(doc);
  packed.nodes.a[0] = 999;
  assert.equal(doc.nodes.a[0], 1);
});

test('a wall referencing a missing node is rejected', () => {
  const doc = good(); doc.walls[0].to = 'nope';
  assert.match(layout.validate(doc).join(), /unknown node/);
});

test('a zero-length wall is rejected', () => {
  const doc = good(); doc.nodes.b = [1, 1];
  assert.match(layout.validate(doc).join(), /zero-length/);
});

test('non-positive thickness is rejected', () => {
  const doc = good(); doc.walls[0].t = 0;
  assert.match(layout.validate(doc).join(), /thickness/);
});

test('a non-finite coordinate is rejected', () => {
  const doc = good(); doc.nodes.a = [NaN, 1];
  assert.match(layout.validate(doc).join(), /finite/);
});

test('an area polygon with fewer than three points is rejected', () => {
  const doc = good(); doc.areas.push({ id: 'a1', type: 'gravel', poly: [[0, 0], [1, 1]] });
  assert.match(layout.validate(doc).join(), /at least 3/);
});

test('unpack refuses a future schema version', () => {
  const doc = good(); doc.v = 99;
  const r = layout.unpack(doc);
  assert.ok(!r.doc);
  assert.match(r.errors.join(), /newer/);
});

test('unpack rejects non-objects without throwing', () => {
  for (const bad of [null, 'x', 7, []]) assert.ok(layout.unpack(bad).errors.length);
});

test('unknown top-level keys survive a round trip', () => {
  const doc = good(); doc.futureThing = { hello: 1 };
  const back = layout.unpack(layout.pack(doc));
  assert.deepEqual(back.doc.futureThing, { hello: 1 });
});
