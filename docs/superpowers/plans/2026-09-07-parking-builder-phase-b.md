# Parking Builder — Phase B (the wall editor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user draw, connect, reshape and dimension walls on the plan, in a build mode that leaves drive mode untouched.

**Architecture:** All document mutation and all snapping maths live in a new DOM-free `App.edit` namespace, unit-tested like `geom`/`layout`/`compile`. Only pointer handling, the overlay painter and the properties panel live in the main IIFE. Every mutation goes through `App.edit`, which returns a new document; the caller recompiles and pushes an undo snapshot.

**Tech Stack:** Vanilla ES2020+, Canvas 2D, no dependencies, no build step. Tests via `node --test test/*.test.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-07-parking-builder-design.md`

**Builds on:** `docs/superpowers/plans/2026-09-07-parking-builder-phase-a.md` (complete, merged at `32a287c`)

## Global Constraints

- **One self-contained `index.html`.** No build step, no runtime dependencies.
- **Must open by double-clicking the file.** `fetch()` and ES modules are both CORS-blocked over `file://` — never introduce either into `index.html`.
- **World units are metres.** Origin at the top-left of the plan.
- **Drive mode must not change.** Same collisions, same spawn, same pixels as `32a287c` whenever build mode is off.
- **`<script data-ns="…">` blocks are DOM-free and app-state-free** — the harness runs them in a bare `vm` context with no `window` or `document`. `App.edit` is one of these.
- **Every coordinate asserted finite.** A `NaN` does not throw and does not miss — `collide` returns `{d: NaN, …}` and the vehicle teleports to `NaN` and vanishes.
- **`App.compile` requires an already-validated document.** Always `App.layout.unpack` first.
- **After ANY document mutation you MUST recompile.** `world.solids` are snapshots but `world.runs[].points` and `world.drawList[].obj` are live references into the document. Skip the recompile and the scene repaints correctly while collision stays stale — it presents as a physics bug, not a missing-recompile bug.
- **`item.at` is always the centre**, for every item type.
- **A registry layer carries either `fill` or `draw`** (areas), never both; for items a layer with both runs `draw` and ignores `fill`.
- **Every painter sets every stroke/fill property it uses and inherits none.** `drawRun` leaves `lineWidth` at a wall thickness.
- **Never `git push`.**

## What Phase A left us

Read these before starting; they are the API this plan builds on.

| Surface | Shape |
|---|---|
| `App.geom` | `cornersOf, rectCorners, collide, pointInVehicle, wallQuad(p,q,t), rectQuad(cx,cy,w,h,a), bboxOf` |
| `App.registry` | `VEHICLE_Z (50), BAY_Z (35), DIM_Z (80), types, get(t)` |
| `App.layout` | `VERSION, validate(doc) -> string[], pack, unpack(json) -> {doc}|{errors}, migrate, blank(name)` |
| `App.compile` | `compile(doc) -> {extent, solids, bounds, runs, drawList, bays, dims, spawn, brief, warnings}` |
| main IIFE | `doc`, `let world`, `view {scale,ox,oy}`, `toWorld(cx,cy)`, `fit()`, `paintList(from,to)`, `draw()`, `step(dt)`, `keys`, `reset()` |

Document shape: `nodes` is `{id: [x,y]}`; `walls` are `{id, from, to, t, type}`.

## File Structure

| File | Responsibility |
|---|---|
| `index.html` (modify) | Gains a `data-ns="edit"` block after `compile`; the main IIFE gains mode state, the overlay painter, pointer tools and the properties panel |
| `test/edit.test.mjs` (create) | `App.edit` — history, GC, mutations, snapping |
| `CLAUDE.md` (modify) | Document the editor's mutation contract |

## Verifying a change in this project

There are two traps that cost hours in Phase A. Both still apply:

- **The preview pane pauses `requestAnimationFrame` while hidden**, so the sim clock freezes between tool calls and scripted driving measures nothing. Take a screenshot to force a paint before reading canvas state.
- **`devicePixelRatio` flips between 1 and 2 between tool calls.** Any before/after canvas comparison must capture both builds in ONE batch and assert the dpr matched, or the comparison is meaningless.

For "did the picture change" questions, compare whole-canvas dark-pixel count and mean luminance, plus scanlines through specific features. Do not eyeball two screenshots taken at different times.

---

### Task 1: `App.edit` — history, node GC, delete

Pure document operations, no pointer code. This is the foundation every later task mutates through.

**Files:**
- Modify: `index.html` (new `data-ns="edit"` block, immediately after the `data-ns="compile"` block)
- Create: `test/edit.test.mjs`

**Interfaces:**
- Consumes: `App.layout.pack` (for snapshots).
- Produces:
  - `App.edit.history(limit = 50) -> {push(doc), undo(doc) -> doc|null, redo(doc) -> doc|null, canUndo(), canRedo(), depth()}`
  - `App.edit.gcNodes(doc) -> doc` — drops nodes referenced by no wall and no area
  - `App.edit.deleteWalls(doc, ids) -> doc` — removes walls, then GCs orphaned nodes

- [ ] **Step 1: Write the failing test**

Create `test/edit.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/edit.test.mjs`
Expected: FAIL — `Cannot read properties of undefined (reading 'history')`

- [ ] **Step 3: Add the edit namespace block**

Insert immediately after the `data-ns="compile"` block in `index.html`:

```html
<script data-ns="edit">
globalThis.App = globalThis.App || {};
App.edit = (() => {
  'use strict';
  const clone = d => JSON.parse(JSON.stringify(d));

  // Nodes exist only to be shared by walls. Anything no wall points at is an orphan,
  // which node merging produces on every join — GC after any wall removal or repoint.
  function gcNodes(doc) {
    const out = clone(doc), used = new Set();
    for (const w of out.walls) { used.add(w.from); used.add(w.to); }
    for (const id of Object.keys(out.nodes)) if (!used.has(id)) delete out.nodes[id];
    return out;
  }

  function deleteWalls(doc, ids) {
    const drop = new Set(ids), out = clone(doc);
    out.walls = out.walls.filter(w => !drop.has(w.id));
    return gcNodes(out);
  }

  // Snapshot history. The caller pushes the document as it was BEFORE a mutation, so
  // undo restores that snapshot and redo re-applies what the caller had at undo time.
  function history(limit = 50) {
    const past = [], future = [];
    return {
      push(doc) { past.push(clone(doc)); if (past.length > limit) past.shift(); future.length = 0; },
      undo(current) { if (!past.length) return null; future.push(clone(current)); return past.pop(); },
      redo(current) { if (!future.length) return null; past.push(clone(current)); return future.pop(); },
      canUndo: () => past.length > 0,
      canRedo: () => future.length > 0,
      depth: () => past.length,
    };
  }

  return { gcNodes, deleteWalls, history };
})();
</script>
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/*.test.mjs`
Expected: PASS, 53 existing + 12 new = 65

- [ ] **Step 5: Commit**

```bash
git add index.html test/edit.test.mjs
git commit -m "Add App.edit: snapshot history, node GC and wall deletion"
```

---

### Task 2: `App.edit` — geometry mutations

The primitives every tool composes: add a wall, move a node, merge two nodes, split a wall.

**Files:**
- Modify: `index.html` (`data-ns="edit"` block)
- Modify: `test/edit.test.mjs`

**Interfaces:**
- Consumes: `App.geom.wallQuad` is NOT needed here; these are document operations only.
- Produces:
  - `App.edit.addNode(doc, pt) -> {doc, id}`
  - `App.edit.addWall(doc, fromId, toId, t, type) -> {doc, id}`
  - `App.edit.moveNode(doc, id, pt) -> doc`
  - `App.edit.mergeNodes(doc, keepId, dropId) -> doc` — repoints walls, drops walls left with both ends equal, GCs
  - `App.edit.splitWall(doc, wallId, pt) -> {doc, nodeId, wallIds}` — replaces one wall with two sharing a new node
  - `App.edit.setLength(doc, wallId, metres, anchor)` where `anchor` is `'from'` or `'to'` — moves the OTHER end along the current direction

- [ ] **Step 1: Write the failing test**

Append to `test/edit.test.mjs`:

```js
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
  assert.deepEqual(out.walls.map(w => [w.from, w.to]), [['a', 'b'], ['b', 'a']]);
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/edit.test.mjs`
Expected: FAIL — `edit.addNode is not a function`

- [ ] **Step 3: Implement the mutations**

Inside the `data-ns="edit"` block, before the `return`:

```js
  let seq = 0;
  const freshId = (obj, prefix) => { let id; do { id = prefix + (++seq).toString(36); } while (id in obj); return id; };

  function addNode(doc, pt) {
    const out = clone(doc), id = freshId(out.nodes, 'n');
    out.nodes[id] = [pt[0], pt[1]];
    return { doc: out, id };
  }

  function addWall(doc, fromId, toId, t, type) {
    const out = clone(doc);
    const taken = Object.fromEntries(out.walls.map(w => [w.id, true]));
    const id = freshId(taken, 'w');
    out.walls.push({ id, from: fromId, to: toId, t, type });
    return { doc: out, id };
  }

  function moveNode(doc, id, pt) {
    const out = clone(doc);
    if (out.nodes[id]) out.nodes[id] = [pt[0], pt[1]];
    return out;
  }

  // Joining two corners: every wall on the dropped node now points at the kept one.
  // A wall whose two ends collapse onto the same node is no longer a wall.
  function mergeNodes(doc, keepId, dropId) {
    if (keepId === dropId) return clone(doc);
    const out = clone(doc);
    for (const w of out.walls) { if (w.from === dropId) w.from = keepId; if (w.to === dropId) w.to = keepId; }
    out.walls = out.walls.filter(w => w.from !== w.to);
    // A merge can also leave two walls spanning the SAME pair of nodes. They stroke as a
    // folded run and emit overlapping solids, so keep the first and drop the rest.
    const seen = new Set();
    out.walls = out.walls.filter(w => {
      const key = w.from < w.to ? w.from + '|' + w.to : w.to + '|' + w.from;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    return gcNodes(out);
  }

  function splitWall(doc, wallId, pt) {
    const src = doc.walls.find(w => w.id === wallId);
    if (!src) return { doc: clone(doc), nodeId: null, wallIds: [] };
    let { doc: out, id: nodeId } = addNode(doc, pt);
    const a = addWall(out, src.from, nodeId, src.t, src.type); out = a.doc;
    const b = addWall(out, nodeId, src.to, src.t, src.type); out = b.doc;
    out.walls = out.walls.filter(w => w.id !== wallId);
    return { doc: out, nodeId, wallIds: [a.id, b.id] };
  }

  // With shared nodes a length change must move exactly one end. The anchor stays put
  // and the far end slides along the wall's current direction.
  function setLength(doc, wallId, metres, anchor) {
    const w = doc.walls.find(x => x.id === wallId);
    // Infinity passes `> 0`, and one non-finite coordinate is enough to make the
    // vehicle teleport away — guard finiteness explicitly, never by comparison alone.
    if (!w || !Number.isFinite(metres) || metres <= 0) return clone(doc);
    const keepId = anchor === 'to' ? w.to : w.from, moveId = anchor === 'to' ? w.from : w.to;
    const p = doc.nodes[keepId], q = doc.nodes[moveId];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!(len > 1e-9)) return clone(doc);
    const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
    return moveNode(doc, moveId, [p[0] + ux * metres, p[1] + uy * metres]);
  }
```

Add all six to the returned object.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/*.test.mjs`
Expected: PASS, 76

- [ ] **Step 5: Commit**

```bash
git add index.html test/edit.test.mjs
git commit -m "Add App.edit geometry mutations: add, move, merge, split, set length"
```

---

### Task 3: `App.edit.snap` — snap resolution

The feature that makes walls connect. Pure: it takes a document and a world point and reports what would be snapped to.

**Files:**
- Modify: `index.html` (`data-ns="edit"` block), `test/edit.test.mjs`

**Interfaces:**
- Produces: `App.edit.snap(doc, pt, opts) -> {pt, kind, nodeId?, wallId?}`
  - `opts` is `{radius, grid = 0.5, from = null, angleStep = 15, enabled = true}`
  - `App.edit.clampPt(doc, pt) -> [x, y]` — clamps a point into the plot. Kept OUT of the
    mutations deliberately: `setLength` must report an honest length even when it runs off
    the plot, so clamping is an editor-boundary guardrail, not a geometry rule.
  - `radius` is a **world** distance the caller derives from screen pixels (`10 / view.scale`), so the feel is zoom-independent
  - `kind` is one of `'node' | 'wall' | 'grid' | 'angle' | 'free'`, in that priority order
  - `from` is the previous point when drawing, enabling angle snapping; `null` disables it

- [ ] **Step 1: Write the failing test**

Append to `test/edit.test.mjs`:

```js
const snapDoc = () => Object.assign(layout.blank('t'), {
  nodes: { a: [0, 0], b: [10, 0] },
  walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' }],
});

test('snap prefers an existing node within the radius', () => {
  const s = edit.snap(snapDoc(), [0.05, 0.05], { radius: 0.2 });
  assert.equal(s.kind, 'node');
  assert.equal(s.nodeId, 'a');
  assert.deepEqual(s.pt, [0, 0]);
});

test('snap falls to a wall centreline when no node is near', () => {
  const s = edit.snap(snapDoc(), [5, 0.05], { radius: 0.2 });
  assert.equal(s.kind, 'wall');
  assert.equal(s.wallId, 'w1');
  assert.deepEqual(s.pt.map(round), [5, 0], 'projected onto the centreline');
});

test('a point beyond a wall end does not snap to that wall', () => {
  const s = edit.snap(snapDoc(), [11, 0], { radius: 0.2, grid: 0 });
  assert.notEqual(s.kind, 'wall');
});

test('snap falls to the grid when nothing else is near', () => {
  const s = edit.snap(snapDoc(), [3.42, 7.61], { radius: 0.2, grid: 0.5 });
  assert.equal(s.kind, 'grid');
  assert.deepEqual(s.pt, [3.5, 7.5]);
});

test('angle snapping constrains to 15 degree increments from the previous point', () => {
  const s = edit.snap(snapDoc(), [4, 0.3], { radius: 0.01, grid: 0, from: [0, 0], angleStep: 15 });
  assert.equal(s.kind, 'angle');
  assert.equal(round(s.pt[1]), 0, 'nearest increment to ~4 degrees is 0');
  assert.equal(round(s.pt[0]), round(Math.hypot(4, 0.3)), 'length preserved along the snapped ray');
});

test('angle snapping picks 45 degrees when that is nearest', () => {
  const s = edit.snap(snapDoc(), [3, 3.2], { radius: 0.01, grid: 0, from: [0, 0], angleStep: 15 });
  const len = Math.hypot(3, 3.2);
  assert.equal(round(s.pt[0]), round(len * Math.cos(Math.PI / 4)));
  assert.equal(round(s.pt[1]), round(len * Math.sin(Math.PI / 4)));
});

test('disabled snapping returns the raw point', () => {
  const s = edit.snap(snapDoc(), [0.05, 0.05], { radius: 0.2, enabled: false });
  assert.equal(s.kind, 'free');
  assert.deepEqual(s.pt, [0.05, 0.05]);
});

test('clampPt holds a point inside the plot', () => {
  const d = snapDoc();                      // blank() gives plot 20 x 16
  assert.deepEqual(edit.clampPt(d, [-3, 20]), [0, 16]);
  assert.deepEqual(edit.clampPt(d, [5, 5]), [5, 5], 'an interior point is untouched');
});

test('snap never returns a non-finite point, including for non-finite input', () => {
  const bad = [[NaN, 0], [Infinity, 0], [0, NaN], [-Infinity, -Infinity]];
  for (const p of [[0, 0], [5, 0], [3.42, 7.61], [1e6, -1e6], ...bad])
    assert.ok(edit.snap(snapDoc(), p, { radius: 0.2, from: [0, 0] }).pt.every(Number.isFinite),
      `snap returned a non-finite point for ${JSON.stringify(p)}`);
});

test('clampPt replaces a non-finite component rather than propagating it', () => {
  assert.deepEqual(edit.clampPt(snapDoc(), [NaN, 5]), [0, 5]);
  assert.deepEqual(edit.clampPt(snapDoc(), [Infinity, 3]), [20, 3]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/edit.test.mjs`
Expected: FAIL — `edit.snap is not a function`

- [ ] **Step 3: Implement snap**

```js
  // Priority: an existing node (the merge case) beats a wall centreline (the split
  // case) beats the grid beats an angle constraint. The radius is a WORLD distance the
  // caller derives from screen pixels, so the feel does not change with zoom.
  const finite2 = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

  function snap(doc, pt, opts) {
    // Defend the invariant at the door. Every tier below compares against `pt`, and every
    // comparison with NaN is false, so a non-finite input would fall through all of them
    // and be echoed straight back out — handing a NaN to the caller that puts it in the
    // document, after which a vehicle silently teleports away.
    if (!finite2(pt)) return { pt: [0, 0], kind: 'free' };
    const o = Object.assign({ radius: 0.2, grid: 0.5, from: null, angleStep: 15, enabled: true }, opts);
    if (!o.enabled) return { pt: [pt[0], pt[1]], kind: 'free' };

    let best = null;
    for (const [id, n] of Object.entries(doc.nodes)) {
      const d = Math.hypot(n[0] - pt[0], n[1] - pt[1]);
      if (d <= o.radius && (!best || d < best.d)) best = { d, pt: [n[0], n[1]], kind: 'node', nodeId: id };
    }
    if (best) return { pt: best.pt, kind: best.kind, nodeId: best.nodeId };

    for (const w of doc.walls) {
      const p = doc.nodes[w.from], q = doc.nodes[w.to];
      if (!p || !q) continue;
      const vx = q[0] - p[0], vy = q[1] - p[1], L2 = vx * vx + vy * vy;
      if (L2 < 1e-12) continue;
      const t = ((pt[0] - p[0]) * vx + (pt[1] - p[1]) * vy) / L2;
      if (t <= 0 || t >= 1) continue;                       // past an end is the node's job
      const cx = p[0] + vx * t, cy = p[1] + vy * t;
      const d = Math.hypot(cx - pt[0], cy - pt[1]);
      if (d <= o.radius && (!best || d < best.d)) best = { d, pt: [cx, cy], kind: 'wall', wallId: w.id };
    }
    if (best) return { pt: best.pt, kind: best.kind, wallId: best.wallId };

    if (o.grid > 0) {
      const gx = Math.round(pt[0] / o.grid) * o.grid, gy = Math.round(pt[1] / o.grid) * o.grid;
      if (Math.hypot(gx - pt[0], gy - pt[1]) <= o.grid / 2) return { pt: [gx, gy], kind: 'grid' };
    }

    if (o.from && o.angleStep > 0) {
      const dx = pt[0] - o.from[0], dy = pt[1] - o.from[1], len = Math.hypot(dx, dy);
      if (len > 1e-9) {
        const step = o.angleStep * Math.PI / 180;
        const a = Math.round(Math.atan2(dy, dx) / step) * step;
        return { pt: [o.from[0] + Math.cos(a) * len, o.from[1] + Math.sin(a) * len], kind: 'angle' };
      }
    }
    return { pt: [pt[0], pt[1]], kind: 'free' };
  }

  // Math.min/max propagate NaN, so a non-finite component must be replaced, not clamped.
  const clampPt = (doc, pt) => [
    Number.isFinite(pt[0]) ? Math.min(doc.plot.w, Math.max(0, pt[0])) : 0,
    Number.isFinite(pt[1]) ? Math.min(doc.plot.h, Math.max(0, pt[1])) : 0,
  ];
```

Add `snap` and `clampPt` to the returned object.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/*.test.mjs`
Expected: PASS, 87

- [ ] **Step 5: Commit**

```bash
git add index.html test/edit.test.mjs
git commit -m "Add App.edit.snap: node, centreline, grid and angle snapping"
```

---

### Task 4: Build/drive mode and mode-aware input routing

The first task that touches the running app. Drive mode must be byte-identical afterwards.

**Files:**
- Modify: `index.html` — the panel markup, the `keydown` handler, `step`'s caller in `loop`, and the compact-layout CSS

**Interfaces:**
- Consumes: nothing new.
- Produces: `mode` (`'drive' | 'build'`), `setEditMode(on)`, and `history` (an `App.edit.history()` instance) in the main IIFE.

- [ ] **Step 1: Add the mode toggle to the panel**

In the `.panel` markup, before the `#controlsGroup` div, add:

```html
  <div class="group">
    <label>Mode</label>
    <div class="row seg">
      <button id="modeDrive" class="seg-btn" aria-pressed="true">Drive</button>
      <button id="modeBuild" class="seg-btn" aria-pressed="false">Build</button>
    </div>
  </div>
```

The `.seg`/`.seg-btn` styles already exist from the touch-controls work; no CSS needed for the buttons.

- [ ] **Step 2: Hide build mode on touch layouts**

The spec puts the editor on desktop only. In the compact media block, alongside the other compact rules, add:

```css
    #modeDrive, #modeBuild { display: none; }
```

Phones therefore keep exactly today's drive-only panel.

- [ ] **Step 3: Add the mode state and the routing guard**

After the `const doc = …; let world = …;` block, add:

```js
// ---------- Build mode. Drive mode must behave exactly as it did before this existed.
const history = App.edit.history();
let mode = 'drive', selection = { walls: [], nodes: [] };
const isBuild = () => mode === 'build';
```

Then replace the first line of the `keydown` handler. It currently reads:

```js
  if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') && !e.key.startsWith('Arrow')) return;
```

Replace with:

```js
  // A text field owns every key while it has focus — otherwise typing "3.5" into a
  // thickness box also fires the R reset. INPUT was missing from this guard.
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
  if ((tag === 'SELECT' || tag === 'BUTTON') && !e.key.startsWith('Arrow')) return;
  if (isBuild()) { editorKey(e); return; }      // build mode never drives the car
```

- [ ] **Step 4: Add the editor key handler and the mode switch**

```js
function editorKey(e) {
  if (e.key === 'Escape') { selection = { walls: [], nodes: [] }; return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!selection.walls.length) return;
    e.preventDefault();
    commit(App.edit.deleteWalls(doc, selection.walls));
    selection = { walls: [], nodes: [] };
    return;
  }
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    const next = e.shiftKey ? history.redo(doc) : history.undo(doc);
    if (next) replaceDoc(next);
  }
}

// Every document mutation goes through here: snapshot for undo, swap, recompile.
// The recompile is not optional — world.runs and world.drawList hold live references
// into the document, so skipping it leaves collision stale while rendering looks right.
function commit(next) { history.push(doc); replaceDoc(next); }
function replaceDoc(next) {
  for (const k of Object.keys(doc)) delete doc[k];
  Object.assign(doc, next);
  world = App.compile(doc);
  if (world.warnings.length) console.warn('layout warnings:', world.warnings);
}

function setEditMode(on) {
  mode = on ? 'build' : 'drive';
  modeBuild.setAttribute('aria-pressed', String(on));
  modeDrive.setAttribute('aria-pressed', String(!on));
  document.body.classList.toggle('build-mode', on);
  if (on) { keys.ArrowUp = keys.ArrowDown = keys.ArrowLeft = keys.ArrowRight = false; }
  else selection = { walls: [], nodes: [] };
}
modeDrive.addEventListener('click', () => setEditMode(false));
modeBuild.addEventListener('click', () => setEditMode(true));
```

Add `modeDrive` and `modeBuild` to the DOM-handles line at the top of the IIFE.

`doc` is declared `const`, so `replaceDoc` mutates it in place rather than rebinding — that keeps every existing closure over `doc` valid.

- [ ] **Step 5: Freeze the simulation in build mode**

In `loop`, the fixed-step call currently reads `while (acc >= DT) { step(DT); acc -= DT; }`. Replace with:

```js
  while (acc >= DT) { if (!isBuild()) step(DT); acc -= DT; }
```

Vehicles stay exactly where they are while you build.

- [ ] **Step 6: Verify drive mode is untouched**

Run: `node --test test/*.test.mjs`
Expected: PASS, 87

Run the extract-and-`node --check` recipe.

Then open the page and confirm all of:
- the Mode toggle shows Drive selected, and the scene is unchanged
- driving still works: arrows accelerate and steer, `R` resets, collisions increment
- switching to Build freezes the car; arrows and `R` no longer affect it
- switching back to Drive works, and the car has not moved

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "Add build/drive mode with mode-aware input routing"
```

---

### Task 5: The editor overlay and selection

Draw what is editable, and let the user pick it.

**Files:**
- Modify: `index.html` — `draw()`, a new overlay painter, the canvas `pointerdown` handler

**Interfaces:**
- Consumes: `world.runs`, `doc.nodes`, `doc.walls`, `toWorld`, `view`.
- Produces: `hitTest(worldPt) -> {wallId?, nodeId?}` and `drawEditOverlay()` in the main IIFE.

- [ ] **Step 1: Add hit testing**

The snap function already solves "what is near this point", so reuse it rather than writing a second geometry path:

```js
// Reuses App.edit.snap so hit-testing and snapping can never disagree about what is
// under the pointer. The radius is 10 screen pixels expressed in world units.
function hitTest(pt) {
  const s = App.edit.snap(doc, pt, { radius: 10 / view.scale, grid: 0, from: null });
  if (s.kind === 'node') return { nodeId: s.nodeId };
  if (s.kind === 'wall') return { wallId: s.wallId };
  return {};
}
```

- [ ] **Step 2: Add the overlay painter**

```js
function drawEditOverlay() {
  g.save();
  // wall centrelines, so you can see what you are about to grab
  g.strokeStyle = 'rgba(46,53,56,.35)'; g.lineWidth = 1; g.setLineDash([px(0.12), px(0.12)]);
  for (const w of doc.walls) {
    const p = doc.nodes[w.from], q = doc.nodes[w.to];
    g.beginPath(); g.moveTo(px(p[0]), px(p[1])); g.lineTo(px(q[0]), px(q[1])); g.stroke();
  }
  g.setLineDash([]);
  // selected walls
  g.strokeStyle = '#f2b233'; g.lineWidth = Math.max(2, px(0.06));
  for (const id of selection.walls) {
    const w = doc.walls.find(x => x.id === id); if (!w) continue;
    const p = doc.nodes[w.from], q = doc.nodes[w.to];
    g.beginPath(); g.moveTo(px(p[0]), px(p[1])); g.lineTo(px(q[0]), px(q[1])); g.stroke();
  }
  // node handles
  for (const [id, n] of Object.entries(doc.nodes)) {
    const sel = selection.nodes.includes(id);
    g.beginPath(); g.arc(px(n[0]), px(n[1]), Math.max(3, px(0.09)), 0, Math.PI * 2);
    g.fillStyle = sel ? '#f2b233' : '#fff'; g.fill();
    g.strokeStyle = '#2e3538'; g.lineWidth = 1.5; g.stroke();
  }
  g.restore();
}
```

- [ ] **Step 3: Call it from `draw()`**

`draw()` currently ends with `paintList(App.registry.VEHICLE_Z, Infinity);`. Add immediately after it:

```js
  if (isBuild()) drawEditOverlay();
```

The overlay is chrome, not scene, so it sits above everything and deliberately does not go through the z queue.

- [ ] **Step 4: Route pointerdown by mode**

The canvas `pointerdown` handler currently selects a vehicle. Wrap it:

```js
cv.addEventListener('pointerdown', e => {
  const [x, y] = toWorld(e.clientX, e.clientY);
  if (isBuild()) return editorPointerDown(e, [x, y]);
  for (let i = vehicles.length - 1; i >= 0; i--) if (pointInVehicle(x, y, vehicles[i])) { select(vehicles[i]); return; }
});

function editorPointerDown(e, pt) {
  const hit = hitTest(pt);
  const add = e.shiftKey;
  if (hit.nodeId) {
    selection = add ? { walls: selection.walls, nodes: [...new Set([...selection.nodes, hit.nodeId])] }
                    : { walls: [], nodes: [hit.nodeId] };
  } else if (hit.wallId) {
    selection = add ? { walls: [...new Set([...selection.walls, hit.wallId])], nodes: selection.nodes }
                    : { walls: [hit.wallId], nodes: [] };
  } else if (!add) selection = { walls: [], nodes: [] };
}
```

- [ ] **Step 5: Verify**

Run: `node --test test/*.test.mjs` → 87 passing, and the `node --check` recipe.

Open the page, switch to Build, and confirm: node handles appear on every wall corner, clicking a wall highlights it, clicking a node highlights it, shift-click adds to the selection, clicking empty space clears it, `Esc` clears it, and `Delete` removes selected walls with their orphaned nodes. Switch back to Drive and confirm the overlay disappears and the scene is unchanged.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Add the editor overlay and selection hit-testing"
```

---

### Task 6: The wall tool — draw and chain

**Files:**
- Modify: `index.html` — the panel markup (tool buttons), `editorPointerDown`, new pointermove/up handlers, `drawEditOverlay`

**Interfaces:**
- Produces: `tool` (`'select' | 'wall'`), `draft` (the in-progress chain), and the snap indicator in the overlay.

- [ ] **Step 1: Add the tool buttons**

Inside the Mode group, after the Drive/Build row, add a row shown only in build mode:

```html
    <div class="row seg" id="toolRow" hidden>
      <button id="toolSelect" class="seg-btn" aria-pressed="true">Select</button>
      <button id="toolWall" class="seg-btn" aria-pressed="false">Wall</button>
    </div>
```

`setEditMode` toggles `toolRow.hidden = !on`.

- [ ] **Step 2: Track the draft chain**

```js
let tool = 'select';
let draft = null;      // { pts: [[x,y], …], snap: <last snap result> }

function setTool(t) {
  tool = t; draft = null;
  toolSelect.setAttribute('aria-pressed', String(t === 'select'));
  toolWall.setAttribute('aria-pressed', String(t === 'wall'));
}
toolSelect.addEventListener('click', () => setTool('select'));
toolWall.addEventListener('click', () => setTool('wall'));
```

- [ ] **Step 3: Resolve a snap for the current pointer**

```js
// Alt suspends every snap, per the spec. The radius is 10 screen px in world units so
// the feel is identical at any zoom.
function snapAt(pt, e) {
  pt = App.edit.clampPt(doc, pt);          // nodes never leave the plot
  return App.edit.snap(doc, pt, {
    radius: 10 / view.scale,
    grid: 0.5,
    from: draft && draft.pts.length ? draft.pts[draft.pts.length - 1] : null,
    enabled: !e.altKey,
  });
}
```

- [ ] **Step 4: Commit a chain into the document**

```js
// A chain becomes a run of walls sharing nodes. Where a point snapped to an existing
// node we reuse it (that IS the connection); where it snapped to a centreline we split
// that wall so the junction is real rather than coincidental.
function commitChain(pts, snaps) {
  let next = doc, ids = [];
  for (let i = 0; i < pts.length; i++) {
    const s = snaps[i];
    if (s && s.kind === 'node') { ids.push(s.nodeId); continue; }
    if (s && s.kind === 'wall') {
      // splitWall REPLACES the wall with two halves, so a second point in the same
      // chain that snapped to the same wall would name an id that no longer exists.
      // splitWall reports nodeId null for an unknown id; fall back to a plain node.
      const r = App.edit.splitWall(next, s.wallId, pts[i]);
      if (r.nodeId) { next = r.doc; ids.push(r.nodeId); continue; }
    }
    const r = App.edit.addNode(next, pts[i]);
    next = r.doc; ids.push(r.id);
  }
  for (let i = 0; i + 1 < ids.length; i++) {
    if (ids[i] === ids[i + 1]) continue;                    // zero-length, skip
    next = App.edit.addWall(next, ids[i], ids[i + 1], 0.2, 'wall').doc;
  }
  commit(next);
}
```

- [ ] **Step 5: Wire the pointer events**

The spec gives the wall tool **two** gestures: press-drag-release draws a single wall,
and click-click-click chains a run. They share one code path — a press starts a draft, and
what happens on release decides which gesture it was.

In `editorPointerDown`, before the selection logic:

```js
  if (tool === 'wall') {
    const s = snapAt(pt, e);
    if (!draft) draft = { pts: [s.pt], snaps: [s], down: s };
    else { draft.pts.push(s.pt); draft.snaps.push(s); }
    pressAt = { pt: s.pt, t: performance.now() };
    cv.setPointerCapture(e.pointerId);
    return;
  }
```

and add a release handler that distinguishes a drag from a click:

```js
// A release far from where the press landed was a drag: that gesture draws exactly one
// wall and ends. A release at the press point was a click: leave the chain open.
// Under DRAG_MIN the gesture is discarded rather than creating a degenerate wall.
const DRAG_MIN = 0.1;                       // metres, per the spec's guardrail
function wallPointerUp(e) {
  if (tool !== 'wall' || !draft || !pressAt) return;
  const s = snapAt(toWorld(e.clientX, e.clientY), e);
  const moved = Math.hypot(s.pt[0] - pressAt.pt[0], s.pt[1] - pressAt.pt[1]);
  pressAt = null;
  if (moved < DRAG_MIN) return;             // a click: the chain stays open
  draft.pts.push(s.pt); draft.snaps.push(s);
  endChain();                               // a drag: one wall, done
}
```

Declare `let pressAt = null;`, and call `wallPointerUp` from the canvas `pointerup`,
`pointercancel` and `lostpointercapture` listeners alongside `endDrag`.

`endChain` must also refuse degenerate results:

```js
function endChain() {
  if (draft && draft.pts.length >= 2) {
    const kept = [draft.pts[0]], keptSnaps = [draft.snaps[0]];
    for (let i = 1; i < draft.pts.length; i++) {
      const prev = kept[kept.length - 1];
      if (Math.hypot(draft.pts[i][0] - prev[0], draft.pts[i][1] - prev[1]) >= DRAG_MIN) {
        kept.push(draft.pts[i]); keptSnaps.push(draft.snaps[i]);
      }
    }
    if (kept.length >= 2) commitChain(kept, keptSnaps);
  }
  draft = null;
}
```

Add a `pointermove` listener that keeps the snap indicator live, and end the chain on `Escape`, `Enter` or double-click:

```js
cv.addEventListener('pointermove', e => {
  if (!isBuild()) return;
  const pt = toWorld(e.clientX, e.clientY);
  hoverSnap = tool === 'wall' ? snapAt(pt, e) : null;
});
cv.addEventListener('dblclick', () => { if (isBuild() && tool === 'wall') endChain(); });

function endChain() {
  if (draft && draft.pts.length >= 2) commitChain(draft.pts, draft.snaps);
  draft = null;
}
```

Extend `editorKey`: `Enter` calls `endChain()`, and `Escape` clears `draft` before clearing the selection.

- [ ] **Step 6: Draw the draft and the snap indicator**

At the end of `drawEditOverlay`:

```js
  if (draft && draft.pts.length) {
    g.strokeStyle = '#f2b233'; g.lineWidth = Math.max(2, px(0.06)); g.setLineDash([]);
    g.beginPath();
    draft.pts.forEach(([x, y], i) => i ? g.lineTo(px(x), px(y)) : g.moveTo(px(x), px(y)));
    if (hoverSnap) g.lineTo(px(hoverSnap.pt[0]), px(hoverSnap.pt[1]));
    g.stroke();
  }
  if (hoverSnap && hoverSnap.kind !== 'free') {
    const [hx, hy] = hoverSnap.pt;
    g.strokeStyle = hoverSnap.kind === 'node' ? '#c62f2f' : hoverSnap.kind === 'wall' ? '#3f8f5a' : '#6b7178';
    g.lineWidth = 2; g.setLineDash([]);
    g.beginPath(); g.arc(px(hx), px(hy), Math.max(5, px(0.14)), 0, Math.PI * 2); g.stroke();
  }
```

Declare `let hoverSnap = null;` beside `draft`. The colour tells the user what will happen: red means "joins that corner", green means "splits that wall", grey means grid or angle.

- [ ] **Step 7: Verify**

Run: `node --test test/*.test.mjs` → 87, and the `node --check` recipe.

Open the page, switch to Build, pick Wall, and confirm: clicking places points, the rubber band follows the pointer, the indicator turns red over a node and green over a wall, holding Alt suspends snapping, `Enter`/double-click ends the chain, `Esc` abandons it, and the finished walls render as real walls in drive mode. Confirm the car now collides with a wall you drew — that is the proof the recompile ran.

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "Add the wall tool: chained drawing with live snapping"
```

---

### Task 7: Dragging nodes and walls

**Files:**
- Modify: `index.html` — `editorPointerDown`, `pointermove`, `pointerup`

**Interfaces:**
- Produces: `drag` state in the main IIFE.

- [ ] **Step 1: Begin a drag on a hit**

In `editorPointerDown`'s select branch, after setting the selection:

```js
  if (hit.nodeId) drag = { kind: 'node', id: hit.nodeId, start: pt, orig: JSON.parse(JSON.stringify(doc)) };
  else if (hit.wallId) drag = { kind: 'wall', id: hit.wallId, start: pt, orig: JSON.parse(JSON.stringify(doc)) };
  if (drag) cv.setPointerCapture(e.pointerId);
```

Declare `let drag = null, dragSnap = null;` beside the other editor state.

- [ ] **Step 2: Apply the drag live, without touching history**

In the `pointermove` handler, before the hover-snap line:

```js
  if (drag) {
    const s = snapAt(pt, e);
    let next = drag.orig;
    if (drag.kind === 'node') next = App.edit.moveNode(drag.orig, drag.id, s.pt);
    else {
      const w = drag.orig.walls.find(x => x.id === drag.id);
      const dx = pt[0] - drag.start[0], dy = pt[1] - drag.start[1];
      const p = drag.orig.nodes[w.from], q = drag.orig.nodes[w.to];
      next = App.edit.moveNode(drag.orig, w.from, [p[0] + dx, p[1] + dy]);
      next = App.edit.moveNode(next, w.to, [q[0] + dx, q[1] + dy]);
    }
    replaceDoc(next);          // live preview: recompile, but no undo snapshot yet
    dragSnap = drag.kind === 'node' ? s : null;
    return;
  }
```

Every intermediate position recompiles so the preview and collision agree, but **no snapshot is pushed** — that is the difference between a live drag and 200 undo entries.

- [ ] **Step 3: Commit once on release, merging if dropped on a node**

```js
const endDrag = e => {
  if (!drag) return;
  const pt = toWorld(e.clientX, e.clientY);
  let next = doc;
  if (drag.kind === 'node') {
    const s = App.edit.snap(drag.orig, pt, { radius: 10 / view.scale, grid: 0, enabled: !e.altKey });
    if (s.kind === 'node' && s.nodeId !== drag.id) next = App.edit.mergeNodes(doc, s.nodeId, drag.id);
  }
  const moved = JSON.stringify(next) !== JSON.stringify(drag.orig);
  const orig = drag.orig;
  drag = null; dragSnap = null;
  if (!moved) return;
  // one snapshot per drag, taken from where the drag began
  replaceDoc(orig); commit(next);
};
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('lostpointercapture', endDrag);
```

`lostpointercapture` matters for the same reason it did for the steering wheel: a torn-away capture must end the drag, or it keeps chasing the pointer.

- [ ] **Step 4: Verify**

Run: `node --test test/*.test.mjs` → 87, and the `node --check` recipe.

Open the page and confirm: dragging a node moves every wall that shares it; dragging a wall body moves both ends and stretches its neighbours; dropping a node onto another merges them and the merged node has all the walls; a single `Cmd/Ctrl-Z` undoes an entire drag in one step, not one pixel of it; and after undo the car collides with the wall in its original position.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add node and wall dragging with merge-on-drop"
```

---

### Task 8: The properties panel

**Files:**
- Modify: `index.html` — panel markup, a new `syncProps()` called on selection change, CSS for the number rows

**Interfaces:**
- Produces: `syncProps()` in the main IIFE.

- [ ] **Step 1: Add the markup**

After the tool row:

```html
  <div class="group" id="propsGroup" hidden>
    <label>Selected wall</label>
    <div class="row"><span class="plab">Thickness</span><input id="pT" type="number" step="0.01" min="0.02" max="1"><span class="punit">m</span></div>
    <div class="row"><span class="plab">Length</span><input id="pLen" type="number" step="0.05" min="0.1"><span class="punit">m</span></div>
    <div class="row"><span class="plab">Angle</span><input id="pAng" type="number" step="1"><span class="punit">°</span></div>
    <div class="row"><span class="plab">Anchor</span>
      <div class="seg"><button id="pAnchorFrom" class="seg-btn" aria-pressed="true">⟵</button><button id="pAnchorTo" class="seg-btn" aria-pressed="false">⟶</button></div>
    </div>
    <div class="row"><span class="plab">Type</span><select id="pType"></select></div>
    <div class="note" id="pNote"></div>
  </div>
```

CSS, alongside the existing `.group` rules:

```css
  .group .plab { font-size: 12px; color: var(--ink-soft); flex: 1; align-self: center; }
  .group .punit { font-size: 12px; color: var(--ink-soft); align-self: center; }
  .group input[type=number] { width: 78px; font: inherit; font-size: 14px; color: var(--ink);
    background: #fff; border: 1px solid var(--hairline); border-radius: 3px; padding: 6px 8px; }
  .group .row + .row { margin-top: 8px; }
```

Populate `#pType` from `App.registry.types`, filtered to `kind === 'wall'`.

Add every new id to the `$()` handles line at the top of the IIFE — `propsGroup`, `pT`,
`pLen`, `pAng`, `pType`, `pNote`, `pAnchorFrom`, `pAnchorTo`, `toolRow`, `toolSelect`,
`toolWall`, `modeDrive`, `modeBuild`. This file addresses elements through `$('id')`
handles, never through bare `window.<id>` globals.

- [ ] **Step 2: Sync the panel to the selection**

```js
let anchor = 'from';
function syncProps() {
  const ids = selection.walls;
  propsGroup.hidden = !isBuild() || ids.length === 0;
  if (propsGroup.hidden) return;
  const ws = ids.map(id => doc.walls.find(w => w.id === id)).filter(Boolean);
  const multi = ws.length > 1;
  const w = ws[0];
  const p = doc.nodes[w.from], q = doc.nodes[w.to];
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  pT.value = multi && ws.some(x => x.t !== w.t) ? '' : w.t.toFixed(2);
  pLen.value = multi ? '' : len.toFixed(2);
  pAng.value = multi ? '' : (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI).toFixed(1);
  pType.value = multi && ws.some(x => x.type !== w.type) ? '' : w.type;
  // multi-select applies thickness and type to all; length and angle are meaningless
  pLen.disabled = pAng.disabled = multi;
  pAnchorFrom.disabled = pAnchorTo.disabled = multi;
  pNote.textContent = multi ? `${ws.length} walls selected — thickness and type apply to all` : '';
}
```

Call `syncProps()` at the end of `editorPointerDown`, `setEditMode`, `commit` and `replaceDoc`.

- [ ] **Step 3: Wire the inputs**

```js
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

pT.addEventListener('change', () => {
  const v = clamp(parseFloat(pT.value), 0.02, 1);          // spec's guardrail
  if (!Number.isFinite(v)) return syncProps();
  let next = doc;
  for (const id of selection.walls) {
    next = JSON.parse(JSON.stringify(next));
    const w = next.walls.find(x => x.id === id); if (w) w.t = v;
  }
  commit(next);
});

pLen.addEventListener('change', () => {
  const v = parseFloat(pLen.value);
  if (!Number.isFinite(v) || v < 0.1) return syncProps();   // degenerate walls are refused
  commit(App.edit.setLength(doc, selection.walls[0], v, anchor));
});

pAng.addEventListener('change', () => {
  const v = parseFloat(pAng.value);
  if (!Number.isFinite(v)) return syncProps();
  const w = doc.walls.find(x => x.id === selection.walls[0]); if (!w) return;
  const keepId = anchor === 'to' ? w.to : w.from, moveId = anchor === 'to' ? w.from : w.to;
  const p = doc.nodes[keepId], q = doc.nodes[moveId];
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]), a = v * Math.PI / 180;
  commit(App.edit.moveNode(doc, moveId, [p[0] + Math.cos(a) * len, p[1] + Math.sin(a) * len]));
});

pType.addEventListener('change', () => {
  let next = doc;
  for (const id of selection.walls) {
    next = JSON.parse(JSON.stringify(next));
    const w = next.walls.find(x => x.id === id); if (w) w.type = pType.value;
  }
  commit(next);
});

const setAnchor = a => { anchor = a; pAnchorFrom.setAttribute('aria-pressed', String(a === 'from')); pAnchorTo.setAttribute('aria-pressed', String(a === 'to')); };
pAnchorFrom.addEventListener('click', () => setAnchor('from'));
pAnchorTo.addEventListener('click', () => setAnchor('to'));
```

- [ ] **Step 4: Verify**

Run: `node --test test/*.test.mjs` → 87, and the `node --check` recipe.

Open the page and confirm: selecting a wall fills the panel; typing a thickness changes it and does NOT trigger the `R` reset (this is the `INPUT` guard from Task 4 doing its job — test it explicitly by typing `3.5` into the thickness field and confirming the vehicles do not reset); changing length moves the far end and holds the anchor; flipping the anchor moves the other end instead; selecting two walls disables length and angle but still applies thickness to both; thickness clamps at 0.02 and 1.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add the wall properties panel with anchored length editing"
```

---

### Task 9: Recompile performance and documentation

Editing recompiles on every pointer move. Make that cheap, and write down the contract.

**Files:**
- Modify: `index.html` — `paintList`; `CLAUDE.md`

- [ ] **Step 1: Cache the sorted paint queue**

`paintList` currently rebuilds and sorts its op list on every call, twice per frame. Dragging recompiles on every pointermove on top of that. Build the queue once per compile instead:

```js
// The queue only changes when `world` does, so build it once per compile instead of
// twice per frame. Dragging recompiles on every pointermove, so this is not academic.
let ops = null;
function buildOps() {
  const { BAY_Z, DIM_Z } = App.registry;
  const out = [];
  for (const d of world.drawList) {
    if (d.kind === 'area' && d.layer.fill) out.push([d.z, () => drawArea(d.obj.poly, d.layer.fill)]);
    else if (d.kind === 'item' && d.layer.fill) out.push([d.z, () => drawItemFill(d.obj, d.layer.fill)]);
    else if (d.layer.draw) out.push([d.z, () => d.layer.draw(g, d.obj, { px })]);
  }
  for (const run of world.runs) out.push([run.z, () => drawRun(run, run.stroke)]);
  out.push([BAY_Z, () => {
    g.save(); g.setLineDash([px(0.22), px(0.14)]); g.strokeStyle = 'rgba(46,53,56,.45)'; g.lineWidth = Math.max(1, px(0.04));
    for (const b of world.bays) g.strokeRect(px(b.rect[0]), px(b.rect[1]), px(b.rect[2]), px(b.rect[3]));
    g.restore();
  }]);
  out.push([DIM_Z, () => { for (const d of world.dims) drawDim(d.from[0], d.from[1], d.to[0], d.to[1], d.label); }]);
  return out.sort((a, b) => a[0] - b[0]);
}
function paintList(from, to) {
  if (!ops) ops = buildOps();
  g.save();
  for (const [z, fn] of ops) if (z >= from && z < to) fn();
  g.restore();
}
```

Copy the branch list from the CURRENT `paintList` rather than from this snippet if the
two ever disagree — the live file is the authority on which paint branches exist.

Set `ops = null` at the end of `replaceDoc` and wherever `world` is reassigned. The closures capture `world` through the outer scope, so they must be rebuilt whenever it changes — a stale `ops` would paint the previous document.

- [ ] **Step 2: Document the editor contract in CLAUDE.md**

Add before `## Git`:

```markdown
## Editing the layout

Every document mutation goes through `App.edit`, which is DOM-free and unit-tested:
`addNode`, `addWall`, `moveNode`, `mergeNodes`, `splitWall`, `setLength`, `deleteWalls`,
`gcNodes`, `snap`, `history`. They all take a document and return a NEW one — none
mutates its input, which is what makes undo a plain snapshot stack.

The main IIFE owns only pointer handling, the overlay and the properties panel.

Three rules:

- **`commit(next)` for anything the user should be able to undo; `replaceDoc(next)` for
  live previews.** A drag calls `replaceDoc` on every pointermove and `commit` once on
  release — otherwise one drag fills the undo stack with hundreds of entries.
- **Never skip the recompile.** `replaceDoc` recompiles because `world.runs[].points`
  and `world.drawList[].obj` are live references into the document while `world.solids`
  are snapshots. Mutate without recompiling and the scene repaints correctly while
  collision stays stale — it looks like a physics bug, not a missing recompile.
- **`gcNodes` after anything that removes or repoints a wall.** Merging corners orphans
  nodes on every join, and orphans accumulate invisibly.

Snap radii are always `10 / view.scale` — ten screen pixels expressed in world units, so
the feel does not change with zoom. `Alt` suspends snapping.
```

- [ ] **Step 3: Verify**

Run: `node --test test/*.test.mjs` → 87, and the `node --check` recipe.

Open the page and confirm the scene is unchanged in drive mode, dragging a long wall stays smooth, and undo after a drag restores in one step.

- [ ] **Step 4: Commit**

```bash
git add index.html CLAUDE.md
git commit -m "Cache the paint queue and document the editor contract"
```

---

## Phase B exit criteria

1. `node --test test/*.test.mjs` passes (87 expected).
2. Drive mode is unchanged from `32a287c`: same collisions, same spawn, and the canvas comparison shows the same dark-pixel count and mean luminance at desktop, 375×812 and 844×390.
3. You can draw a chain of walls, and the car collides with them.
4. Dropping a node on another merges them; the merged node carries every wall.
5. One `Cmd/Ctrl-Z` undoes a whole drag.
6. Typing into the thickness field does not reset the vehicles.
7. Deleting a wall leaves no orphaned nodes: `Object.keys(doc.nodes)` only contains ids some wall references.
8. `App.layout.validate(doc)` returns `[]` after any sequence of editor operations.

## Deferred to Phase C

- The bay tool, the brief editor, parking detection and `QAResult` with `layoutHash`.
- Area and item tools (gravel, grass, plants, bollards) — the registry seam is ready; `paintList` already paints item fills.
- Dimension authoring.
- Plot resizing, which must update the `ground` area polygon too, since the extent is stored in both.
- Rotating items: `compile` applies `item.a` to footprints but no painter reads it.
- Serialisation transport — `pack`/`unpack` are ready and transport-agnostic.

## Carried-over test gaps worth closing here

`cornersOf` and `pointInVehicle` have no tests despite being the physics and click-selection entry points; `rectQuad` is only tested at `a = 0`; run splitting on a *type* change is untested; `compile`'s pass-through of `bays`/`dims`/`spawn`/`brief` is untested. Task 1 is the natural place to add the first two, since the editor's hit-testing depends on them.
