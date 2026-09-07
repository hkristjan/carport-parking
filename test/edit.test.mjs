import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const { edit, layout, geom } = loadApp();

const doc = () => Object.assign(layout.blank('t'), {
  nodes: { a: [0, 0], b: [5, 0], c: [5, 5], orphan: [9, 9] },
  walls: [
    { id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' },
    { id: 'w2', from: 'b', to: 'c', t: 0.2, type: 'wall' },
  ],
});

// Carried over from Phase A's gap list: these two are the physics and click-selection
// entry points, and the editor's hit-testing depends on the second.
test('cornersOf places a vehicle box at its position and heading', () => {
  const bb = geom.bboxOf(geom.cornersOf({ x: 5, y: 5, a: 0 }, { len: 4, wid: 2 }).map(c => c));
  assert.deepEqual([bb.x, bb.y, bb.w, bb.h], [3, 4, 4, 2]);
});

test('pointInVehicle accepts points inside the body and rejects distant ones', () => {
  const v = { x: 5, y: 5, a: 0, spec: { len: 4, wid: 2 } };
  assert.equal(geom.pointInVehicle(5, 5, v), true);
  assert.equal(geom.pointInVehicle(6.9, 5, v), true, 'just inside, with the 0.15 slack');
  assert.equal(geom.pointInVehicle(9, 5, v), false);
});

test('gcNodes drops only nodes no wall references', () => {
  const out = edit.gcNodes(doc());
  assert.deepEqual(Object.keys(out.nodes).sort(), ['a', 'b', 'c']);
});

test('gcNodes drops an orphan even when an area covers the same point', () => {
  const d = doc();
  d.areas.push({ id: 'ar1', type: 'ground', poly: [[9, 9], [10, 9], [10, 10]] });
  // areas hold literal points, not node ids, so the orphan is still dropped
  assert.equal(edit.gcNodes(d).nodes.orphan, undefined);
});

test('deleteWalls removes the walls and their now-orphaned nodes', () => {
  const out = edit.deleteWalls(doc(), ['w1']);
  assert.deepEqual(out.walls.map(w => w.id), ['w2']);
  assert.equal(out.nodes.a, undefined, 'a was only used by w1');
  assert.deepEqual(out.nodes.b, [5, 0], 'b is still used by w2');
});

test('deleteWalls with an unknown id is a no-op, not a throw', () => {
  const out = edit.deleteWalls(doc(), ['nope']);
  assert.equal(out.walls.length, 2);
});

test('mutations do not alter the input document', () => {
  const d = doc();
  const before = JSON.stringify(d);
  edit.deleteWalls(d, ['w1']);
  edit.gcNodes(d);
  assert.equal(JSON.stringify(d), before);
});

test('history undo returns the previous document and redo returns forward', () => {
  const h = edit.history();
  const v1 = doc();
  const v2 = edit.deleteWalls(v1, ['w1']);
  h.push(v1);
  assert.equal(h.canUndo(), true);
  const back = h.undo(v2);
  assert.deepEqual(back.walls.map(w => w.id), ['w1', 'w2']);
  const fwd = h.redo(back);
  assert.deepEqual(fwd.walls.map(w => w.id), ['w2']);
});

test('undo on an empty stack returns null rather than throwing', () => {
  assert.equal(edit.history().undo(doc()), null);
});

test('history is capped and drops the oldest entry', () => {
  const h = edit.history(3);
  for (let i = 0; i < 5; i++) h.push(Object.assign(layout.blank('t'), { name: 'v' + i }));
  assert.equal(h.depth(), 3);
});

test('a new push clears the redo branch', () => {
  const h = edit.history();
  const v1 = doc(), v2 = edit.deleteWalls(v1, ['w1']);
  h.push(v1);
  h.undo(v2);
  assert.equal(h.canRedo(), true);
  h.push(v1);
  assert.equal(h.canRedo(), false);
});

test('history snapshots are deep copies, immune to later mutation', () => {
  const h = edit.history();
  const v1 = doc();
  h.push(v1);
  v1.nodes.a[0] = 999;
  assert.deepEqual(h.undo(doc()).nodes.a, [0, 0]);
});
