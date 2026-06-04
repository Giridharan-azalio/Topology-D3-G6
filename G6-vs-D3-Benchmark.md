# Topology Renderer Benchmark — AntV G6 vs D3

**Same data, two engines.** Our topology viewer exists in two builds that load the
**identical** `topology-*.js` datasets and differ *only* in the render engine:

- `d3/index.html` → **D3.js v7** (SVG, immediate-mode)
- `g6/index.html` → **AntV G6 v5.1.1** (canvas, retained-mode scene graph)

This is a controlled A/B: any difference in CPU/memory is the engine, not the data.

---

## TL;DR

For our workload — a **force-directed topology of 4,374 nodes / 4,636 links** with
rich per-node visuals (icon + 3 text labels) — **G6 uses 5–22× the memory and pegs
the CPU at 100%, to the point that the full graph never finishes loading and the
canvas stays black.** D3 renders the same graph in ~1.8s and stays interactive.

> **This is not a bug in our code, and not a bug in G6.** It is an architecture /
> workload mismatch: G6's retained-mode canvas rendering is inherently heavier than
> D3's SVG approach at this node count. *(See "Fairness & caveats" — we tested the
> apps **as-is**; G6 has tuning knobs we did not apply.)*

---

## Headline numbers (measured)

Measured with headless Chrome 148, 20-second observation window per run. Memory and
CPU are read from the browser process via the DevTools Protocol, so a frozen page
thread cannot distort them.

| View | Nodes | Engine | Peak JS heap | Resident heap¹ | JS CPU (of 20s) | Page usable? |
|------|------:|--------|-------------:|---------------:|----------------:|--------------|
| **core** | 165 | D3 | **13 MB** | 9 MB | **1.2 s** | ✅ instant (1 ms) |
| **core** | 165 | G6 | **152 MB** | 78 MB | **17.8 s** | ✅ but 100% CPU |
| **e2e** | 846 | D3 | **51 MB** | 11 MB | **5.4 s** | ✅ instant (2 ms) |
| **e2e** | 846 | G6 | **251 MB** | 237 MB | **15.5 s** | ⚠️ sluggish (119 ms) |
| **full** | 4,374 | D3 | **58 MB** | 13 MB | **7.4 s** | ✅ responsive (180 ms) |
| **full** | 4,374 | G6 | **304 MB** | 279 MB | **20.1 s = pegged** | ❌ **FROZEN / never loads** |

¹ *Resident heap = heap still held at the end of the window. D3 releases almost
everything after layout (graph lives in the browser-managed DOM); G6 holds its entire
scene graph in JS memory permanently.*

**The full view, side by side:**

| D3 — settled in ~1.8s, interactive | G6 — pegged 100% CPU, never finishes loading |
|---|---|
| ![D3 full](bench/shots/d3-full.png) | ![G6 full](bench/shots/g6-full.png) |

These corroborate the real-browser Chrome Task Manager reading that started this
investigation: **D3 tab ≈ 247 MB / 0% CPU (idle); G6 tab ≈ 1.1 GB / 117% CPU (pegged).**

---

## Why the "black screen" happens

When you open `g6/index.html` (default = full view), this is the measured sequence:

1. All CDNs load fine (G6 = HTTP 200 in 0.3 s) — **it is not a download/network problem.**
2. G6 starts a `d3-force` simulation over **4,374 nodes** and **re-renders the entire
   canvas scene every tick**. Each node is not one shape but a group (icon image + 3
   text labels) ≈ **~18,000 shapes** redrawn per tick.
3. The main thread hits **100% CPU and stays there** (20.1s of CPU work in a 20s window).
4. The page's `load` event **never fires within 60 seconds** → the browser tab keeps
   spinning, and the canvas shows **nothing** → the black screen you saw.
5. *Eventually* it paints, but as an unsettled dense tangle, and the thread is still
   frozen (an 8s "are you responsive?" probe timed out).

So the black screen is simply the **long, frozen, pre-paint window**. G6 itself works
fine at small scale — the **core (165-node)** view renders cleanly — it just does not
scale to thousands of nodes the way it's currently used.

---

## Root cause (one paragraph for the team)

> D3 is **immediate-mode**: it writes simple SVG into the DOM and lets the browser
> manage/garbage-collect it, so its JS heap stays tiny (~12 MB) even with 4,374 nodes.
> G6 v5 is **retained-mode** (built on `@antv/g`): every shape is a long-lived JS
> object — ~18k of them — kept in the heap for the life of the page (hence ~280 MB
> resident), and the force layout **re-renders that whole scene graph on every tick**,
> which is what pegs the CPU and freezes the full view. For a "draw a big network with
> a force layout" task, D3's minimalism wins decisively on CPU and memory.

---

## Fairness & caveats (read before presenting)

To keep this airtight when a teammate pushes back:

- **This tests both apps exactly as they ship today ("as-is").** We did **not** apply
  G6's large-graph optimizations. G6 *does* offer them — a **WebGL renderer**
  (`@antv/g-webgl`), **web-worker layout**, and **disabling per-tick re-render** — and
  they would narrow this gap. We have not measured how far. So the honest claim is
  *"G6 as we currently use it,"* **not** *"G6 is incapable of this."*
- **Where the memory lives differs.** D3's nodes live in the **SVG DOM** (the full
  view creates ~69k DOM elements), which is browser-managed and mostly off the JS heap
  — that's why D3's *JS heap* looks so small. The fair holistic number is total tab
  memory (Task Manager): **247 MB vs 1.1 GB**, which still favors D3 by ~4.5×.
- **D3 isn't free either.** The full view costs D3 ~7.4s of JS CPU and 69k DOM nodes.
  The decisive difference is that **D3 stays responsive and paints in ~1.8s, while G6
  freezes and never completes loading.**

The CPU-pegging and the never-completing load are unambiguous regardless of how you
account for memory — that's the strongest, least-arguable evidence.

---

## Recommendation

1. **Short term:** ship the **D3** build for the full/large views; it's proven and light.
2. **If G6 is required** (e.g. for its interaction model), treat the full view as a
   tuning project: WebGL renderer + worker layout + disable layout animation +
   simplify nodes at scale — then re-run this benchmark to verify the gap closes.
3. **Don't tell the team "G6 is buggy."** Tell them: *"For our 4k-node force-directed
   workload, G6's retained-mode canvas rendering costs 5–22× the memory and pegs the
   CPU until the page freezes — as currently configured. D3 renders the same data in
   ~1.8s. Here are the measured numbers."*

---

## How to reproduce (anyone on the team)

```bash
cd "Topology-views 1/bench"
npm install                 # puppeteer-core only; uses the system Chrome
node runner.js              # ~2.5 min; writes results.json + shots/*.png
```

The runner loads each real `index.html` unmodified, injects only a measurement probe,
cycles through core/e2e/full for both engines, and prints the table above.

- Raw data: [bench/results.json](bench/results.json)
- Screenshots: [bench/shots/](bench/shots/)
- Runner: [bench/runner.js](bench/runner.js)

*Generated 2026-06-04 · Chrome 148 · 20s window/run · headless.*
