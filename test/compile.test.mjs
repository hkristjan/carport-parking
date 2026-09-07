import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const { layout, compile, defaults, registry } = loadApp();

const doc = (over = {}) => Object.assign(layout.blank('t'), over);

test('extent comes from the plot and bounds ring it', () => {
  const c = compile(doc({ plot: { w: 10, h: 8 } }));
  assert.deepEqual(c.extent, { w: 10, h: 8 });
  assert.equal(c.bounds.length, 4);
  // every bound lies outside the plot
  for (const b of c.bounds) assert.ok(b.x < 0 || b.y < 0 || b.x >= 10 || b.y >= 8);
});

test('the default layout compiles to exactly nine solids', () => {
  assert.equal(compile(defaults.carport).solids.length, 9);
});

test('non-solid types contribute no solids', () => {
  const c = compile(defaults.carport);
  assert.equal(c.solids.length, defaults.carport.walls.length + 1);  // 8 walls + deck
});

test('drawList is sorted by z and includes both carport layers', () => {
  const c = compile(defaults.carport);
  for (let i = 1; i < c.drawList.length; i++) assert.ok(c.drawList[i].z >= c.drawList[i - 1].z);
  const cp = c.drawList.filter(d => d.type === 'carport');
  assert.equal(cp.length, 2);
  assert.ok(cp[0].z < registry.VEHICLE_Z && cp[1].z > registry.VEHICLE_Z);
});

test('a chain through a degree-2 node becomes one run', () => {
  const c = compile(doc({
    nodes: { a: [0, 0], b: [5, 0], d: [5, 5] },
    walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' },
            { id: 'w2', from: 'b', to: 'd', t: 0.2, type: 'wall' }],
  }));
  assert.equal(c.runs.length, 1);
  assert.deepEqual(c.runs[0].points, [[0, 0], [5, 0], [5, 5]]);
});

test('a run splits at a thickness change', () => {
  const c = compile(doc({
    nodes: { a: [0, 0], b: [5, 0], d: [5, 5] },
    walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' },
            { id: 'w2', from: 'b', to: 'd', t: 0.4, type: 'wall' }],
  }));
  assert.equal(c.runs.length, 2);
});

test('a run splits at a degree-3 junction', () => {
  const c = compile(doc({
    nodes: { a: [0, 0], b: [5, 0], d: [10, 0], e: [5, 5] },
    walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' },
            { id: 'w2', from: 'b', to: 'd', t: 0.2, type: 'wall' },
            { id: 'w3', from: 'b', to: 'e', t: 0.2, type: 'wall' }],
  }));
  assert.equal(c.runs.length, 3);
});

test('every wall appears in exactly one run', () => {
  const c = compile(defaults.carport);
  const segs = c.runs.reduce((n, r) => n + r.points.length - 1, 0);
  assert.equal(segs, defaults.carport.walls.length);
});

test('unknown types are skipped rather than fatal', () => {
  const c = compile(doc({
    nodes: { a: [0, 0], b: [1, 0] },
    walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'nosuchtype' }],
  }));
  assert.equal(c.solids.length, 0);
  assert.equal(c.drawList.length, 0);
  assert.match(c.warnings.join(), /nosuchtype/);
});

test('a larger plot compiles to a larger extent and matching bounds', () => {
  const c = compile(doc({ plot: { w: 40, h: 30 } }));
  assert.deepEqual(c.extent, { w: 40, h: 30 });
  assert.deepEqual(c.bounds[1], { x: -1, y: 30, w: 42, h: 1 });
});
