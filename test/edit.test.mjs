import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const { edit, layout, geom, compile } = loadApp();

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

const round = n => { const r = Math.round(n * 1e6) / 1e6; return r === 0 ? 0 : r; };

test('addNode returns a fresh id not already in the document', () => {
  const { doc: out, id } = edit.addNode(doc(), [3, 3]);
  assert.deepEqual(out.nodes[id], [3, 3]);
  assert.equal(Object.keys(out.nodes).length, 5);
});

test('addWall links two existing nodes', () => {
  const { doc: out, id } = edit.addWall(doc(), 'a', 'c', 0.3, 'fence');
  const w = out.walls.find(x => x.id === id);
  assert.deepEqual([w.from, w.to, w.t, w.type], ['a', 'c', 0.3, 'fence']);
});

test('moveNode moves the shared node, so both walls follow', () => {
  const out = edit.moveNode(doc(), 'b', [7, 1]);
  assert.deepEqual(out.nodes.b, [7, 1]);
  assert.deepEqual(out.walls.map(w => [w.from, w.to]), [['a', 'b'], ['b', 'c']]);
});

test('mergeNodes repoints walls onto the kept node and drops the other', () => {
  const out = edit.mergeNodes(doc(), 'a', 'c');
  assert.equal(out.nodes.c, undefined);
  // w2 (b->c) is repointed to b->a, which is the same segment as w1 (a->b) once c is
  // gone — that duplicate is now collapsed too (Fix round 1), so only w1 survives.
  assert.deepEqual(out.walls.map(w => [w.from, w.to]), [['a', 'b']]);
});

test('mergeNodes drops a wall left with both ends identical', () => {
  const out = edit.mergeNodes(doc(), 'a', 'b');   // w1 was a->b
  assert.deepEqual(out.walls.map(w => w.id), ['w2']);
  assert.deepEqual(out.walls[0], { id: 'w2', from: 'a', to: 'c', t: 0.2, type: 'wall' });
});

test('splitWall replaces one wall with two sharing a new node', () => {
  const { doc: out, nodeId, wallIds } = edit.splitWall(doc(), 'w1', [2, 0]);
  assert.deepEqual(out.nodes[nodeId], [2, 0]);
  assert.equal(out.walls.length, 3);
  assert.equal(out.walls.find(w => w.id === 'w1'), undefined, 'the original is replaced');
  const halves = out.walls.filter(w => wallIds.includes(w.id));
  assert.deepEqual(halves.map(w => [w.from, w.to]), [['a', nodeId], [nodeId, 'b']]);
  assert.ok(halves.every(w => w.t === 0.2 && w.type === 'wall'), 'halves inherit t and type');
});

test('setLength moves the far end and holds the anchor', () => {
  const out = edit.setLength(doc(), 'w1', 10, 'from');   // w1 is a[0,0] -> b[5,0]
  assert.deepEqual(out.nodes.a, [0, 0], 'anchor held');
  assert.deepEqual(out.nodes.b.map(round), [10, 0], 'far end moved along the direction');
});

test('setLength anchored to the other end moves the opposite node', () => {
  const out = edit.setLength(doc(), 'w1', 10, 'to');
  assert.deepEqual(out.nodes.b, [5, 0], 'anchor held');
  assert.deepEqual(out.nodes.a.map(round), [-5, 0]);
});

test('setLength moving a shared node drags its neighbour wall with it', () => {
  const out = edit.setLength(doc(), 'w1', 10, 'from');
  // w2 still runs b->c, and b moved, so w2 is now longer
  const [bx, by] = out.nodes.b, [cx, cy] = out.nodes.c;
  assert.equal(round(Math.hypot(cx - bx, cy - by)), round(Math.hypot(5 - 10, 5 - 0)));
});

test('geometry mutations never alter the input document', () => {
  const d = doc(), before = JSON.stringify(d);
  edit.addNode(d, [1, 1]); edit.addWall(d, 'a', 'c', 0.2, 'wall');
  edit.moveNode(d, 'b', [9, 9]); edit.mergeNodes(d, 'a', 'c');
  edit.splitWall(d, 'w1', [2, 0]); edit.setLength(d, 'w1', 3, 'from');
  assert.equal(JSON.stringify(d), before);
});

test('every mutation leaves a document that still validates', () => {
  let d = doc();
  d = edit.addWall(d, 'a', 'c', 0.2, 'wall').doc;
  d = edit.moveNode(d, 'b', [6, 1]);
  d = edit.splitWall(d, 'w2', [5, 2]).doc;
  d = edit.mergeNodes(d, 'a', 'c');
  assert.deepEqual(layout.validate(edit.gcNodes(d)), []);
});

test('setLength rejects Infinity, -Infinity, NaN, zero and negative lengths, leaving the document unchanged', () => {
  const d = doc();
  const before = JSON.stringify(d);
  for (const bad of [Infinity, -Infinity, NaN, 0, -3]) {
    const out = edit.setLength(d, 'w1', bad, 'from');
    assert.deepEqual(out, JSON.parse(before), `setLength with ${bad} must return the document unchanged`);
    assert.deepEqual(layout.validate(out), [], `document after rejecting ${bad} must still validate`);
  }
  assert.equal(JSON.stringify(d), before, 'input document itself must not be mutated');
});

test('mergeNodes collapses two walls that end up spanning the same node pair', () => {
  const d = Object.assign(layout.blank('t'), {
    nodes: { p1: [0, 0], p2: [5, 0], p3: [0, 4], p4: [5, 4] },
    walls: [
      { id: 'wA', from: 'p1', to: 'p2', t: 0.2, type: 'wall' },
      { id: 'wB', from: 'p3', to: 'p4', t: 0.2, type: 'wall' },
    ],
  });
  let out = edit.mergeNodes(d, 'p1', 'p3');
  out = edit.mergeNodes(out, 'p2', 'p4');
  assert.equal(out.walls.length, 1, 'the duplicate wall must be dropped');

  const c = compile(out);
  assert.equal(c.runs.length, 1, 'the surviving wall must compile to a single run');
  assert.equal(c.solids.length, 1, 'the surviving wall must compile to a single solid');
});
