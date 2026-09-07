import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './extract.mjs';

const { geom, layout, registry, defaults } = loadApp();
const round = n => { const r = Math.round(n * 1e6) / 1e6; return r === 0 ? 0 : r; }; // normalise -0
const box = r => [round(r.x), round(r.y), round(r.w), round(r.h)];

// Today's nine staticObstacles, verbatim and in source order.
const TODAY = [
  { x: 2.25, y: 0.00, w: 0.22, h: 11.35, kind: 'wall' },
  { x: 8.13, y: 0.00, w: 10.47, h: 1.76, kind: 'deck' },
  { x: 2.55, y: 3.57, w: 7.95, h: 0.42, kind: 'frame' },
  { x: 2.55, y: 3.99, w: 0.10, h: 5.65, kind: 'frame' },
  { x: 10.40, y: 3.99, w: 0.10, h: 2.20, kind: 'post' },
  { x: 10.40, y: 7.45, w: 0.10, h: 2.20, kind: 'post' },
  { x: 2.50, y: 11.23, w: 2.00, h: 0.12, kind: 'curb' },
  { x: 10.90, y: 11.45, w: 7.70, h: 0.14, kind: 'fence' },
  { x: 0.00, y: 15.30, w: 18.6, h: 0.16, kind: 'fence' },
];

test('the default layout is a valid document', () => {
  assert.deepEqual(layout.validate(defaults.carport), []);
});

test('plot matches the old W and H', () => {
  assert.deepEqual(defaults.carport.plot, { w: 18.6, h: 15.6 });
});

test('every wall and the deck reproduce a staticObstacles box exactly', () => {
  const doc = defaults.carport;
  const got = doc.walls.map(w =>
    box(geom.bboxOf(geom.wallQuad(doc.nodes[w.from], doc.nodes[w.to], w.t).corners)));
  const deck = doc.items.find(i => i.type === 'deck');
  const fp = registry.get('deck').footprint;
  got.push(box(geom.bboxOf(geom.rectQuad(deck.at[0], deck.at[1], fp.w, fp.h, deck.a).corners)));

  const want = TODAY.map(box);
  assert.equal(got.length, want.length, 'must cover all nine obstacles');
  for (const w of want) assert.ok(got.some(gv => gv.join() === w.join()), `missing box ${w.join()}`);
});

test('the three bays carry over', () => {
  assert.deepEqual(defaults.carport.bays.map(b => b.rect), [
    [2.70, 4.05, 2.55, 5.55], [5.25, 4.05, 2.55, 5.55], [7.80, 4.05, 2.55, 5.55],
  ]);
});

test('both palms, all five dims and the spawn carry over by value', () => {
  const doc = defaults.carport;
  assert.deepEqual(doc.items.filter(i => i.type === 'palm').map(i => i.at),
    [[13.1, 1.4], [16.7, 1.4]]);
  // by value, not by count: the labels use comma decimal separators deliberately
  assert.deepEqual(doc.dims, [
    { from: [2.55, 2.10],  to: [10.50, 2.10],  label: '7,98 m' },
    { from: [8.13, 2.90],  to: [10.53, 2.90],  label: '2,40 m' },
    { from: [2.60, 11.95], to: [4.60, 11.95],  label: '2,00 m' },
    { from: [4.60, 11.95], to: [10.60, 11.95], label: '6,00 m' },
    { from: [8.13, 1.35],  to: [18.60, 1.35],  label: '12,73 m' },
  ]);
  assert.deepEqual(doc.spawn.at, [16.4, 14.05]);
  assert.equal(round(doc.spawn.a), round(Math.PI));
});

test('every referenced type exists in the registry with a matching kind', () => {
  const doc = defaults.carport;
  for (const [arr, kind] of [['walls', 'wall'], ['areas', 'area'], ['items', 'item']])
    for (const o of doc[arr]) {
      const t = registry.get(o.type);
      assert.ok(t, `unknown type ${o.type}`);
      assert.equal(t.kind, kind, `${o.type} is kind ${t.kind}, used as ${kind}`);
    }
});

test('registry layers all have finite z and vehicles sit between them', () => {
  for (const [name, t] of Object.entries(registry.types)) {
    assert.ok(Array.isArray(t.layers) && t.layers.length, `${name} needs layers`);
    for (const l of t.layers) assert.ok(Number.isFinite(l.z), `${name} layer needs z`);
  }
  const zs = Object.values(registry.types).flatMap(t => t.layers.map(l => l.z));
  assert.ok(Math.min(...zs) < registry.VEHICLE_Z && Math.max(...zs) > registry.VEHICLE_Z,
    'some layers must paint under vehicles and some over');
});

test('pack/unpack round-trips the default layout', () => {
  const back = layout.unpack(layout.pack(defaults.carport));
  assert.ok(back.doc, JSON.stringify(back.errors));
  assert.deepEqual(back.doc, defaults.carport);
});

test('the main script no longer declares world literals', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const main = html.slice(html.lastIndexOf('<script>'));
  for (const name of ['staticObstacles', 'const palms', 'const apron', 'const carport'])
    assert.ok(!main.includes(name), `${name} still present in the main script`);
});
