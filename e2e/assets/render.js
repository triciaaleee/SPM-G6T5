/*
 * Renders the swimlane pages from data.js. A scenario page sets
 * <body data-scenario="s1"> and is drawn as a BPMN-style diagram: one lane
 * per role, the flow running left to right, start and end events, and
 * gateways where the flow splits. The index page sets <body data-page="index">.
 */
(function () {
  "use strict";

  var D = window.SWIMLANE_DATA;

  var MODES = {
    ui: { label: "UI", title: "UI-driven: the browser performs this step's action" },
    check: { label: "API + UI check", title: "The action goes through the API; the browser checks what the user sees" },
    api: { label: "API", title: "API-driven: REST calls through e2e/support/backend.ts, no browser" },
    none: { label: "No Playwright test", title: "No Playwright test exercises this step" },
  };
  var SHORT_MODE = { ui: "UI", check: "API + UI", api: "API", none: "No test" };
  var MODE_RANK = { ui: 3, check: 2, api: 1, none: 0 };
  var STATE_LABELS = { event: "Event", booking: "Booking", equipment: "Equipment", registration: "Registration" };
  var LOCAL_TITLE = "Needs time to pass, so it only runs against a local Supabase; it is skipped against the shared dev database";

  // ---------------------------------------------------------------- helpers

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null || value === false) return;
      if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function svgEl(tag, attrs, children) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function statusClass(name) {
    if (/^(—|-)$/.test(name)) return "st-none";
    if (/Confirmed|Approved|Arranged|Registered|Completed/.test(name)) return name === "Completed" ? "st-end" : "st-ok";
    if (/Needs Review|Replacement Required|On Hold|Clarification/.test(name)) return "st-warn";
    if (/Rejected|Cancelled|Expired/.test(name)) return "st-bad";
    if (/Withdrawn|Returned/.test(name)) return "st-end";
    return "";
  }

  function modeChip(mode, extraTitle) {
    return h("span", { class: "mode m-" + mode, title: extraTitle || MODES[mode].title, text: MODES[mode].label });
  }

  function localChip() {
    return h("span", { class: "mode m-local", title: LOCAL_TITLE, text: "local DB only" });
  }

  function bullets(items, cls) {
    return h(
      "ul",
      { class: cls },
      items.map(function (item) {
        return h("li", { text: item });
      }),
    );
  }

  function laneChip(lane) {
    return h("span", { class: "lane-chip lane-" + lane, text: D.lanes[lane].label });
  }

  function shortService(name) {
    return name.replace(/-service$/, "");
  }

  /** Flattens a scenario's phases into numbered steps. */
  function prepare(sc, index) {
    var steps = [];
    var byId = {};
    sc.phases.forEach(function (phase, pi) {
      phase.steps.forEach(function (raw) {
        var step = Object.assign({}, raw, { n: steps.length + 1, phase: pi });
        steps.push(step);
        if (raw.id) byId[raw.id] = step;
      });
    });
    steps.forEach(function (step) {
      if (typeof step.after === "string" && !byId[step.after]) console.warn("Unknown step id", step.after);
      if (typeof step.alongside === "string" && !byId[step.alongside]) console.warn("Unknown step id", step.alongside);
      step.refs = (step.tests || []).map(function (ref) {
        var test = D.tests[ref.t];
        if (!test) console.warn("Unknown test key", ref.t);
        return { key: ref.t, test: test, mode: ref.mode || test.mode };
      });
      step.coverage = step.refs.reduce(function (best, ref) {
        return MODE_RANK[ref.mode] > MODE_RANK[best] ? ref.mode : best;
      }, "none");
    });

    var used = {};
    steps.forEach(function (step) {
      used[step.lane] = true;
    });
    return {
      sc: sc,
      number: index + 1,
      steps: steps,
      byId: byId,
      lanes: D.laneOrder.filter(function (lane) {
        return used[lane];
      }),
    };
  }

  var prepared = D.scenarios.map(prepare);

  function legend() {
    return h("div", { class: "legend" }, [
      h("div", { class: "legend-group" }, [
        h("b", { text: "Playwright coverage:" }),
        modeChip("ui"),
        modeChip("check"),
        modeChip("api"),
        modeChip("none"),
        localChip(),
      ]),
    ]);
  }

  function testItem(ref) {
    return h("li", {}, [
      modeChip(ref.mode),
      ref.test.local ? " " : null,
      ref.test.local ? localChip() : null,
      " ",
      h("span", { class: "mono", text: ref.test.spec }),
      h("span", { class: "tname-full", text: ref.test.name }),
    ]);
  }

  // ---------------------------------------------------------------- the flow graph

  /**
   * Turns a scenario into BPMN nodes and sequence flows:
   * - a step with `after: null` starts its own flow, from a start event;
   * - a step whose predecessor already has a successor branches off it, so an
   *   exclusive gateway (labelled from the phases' `label`) is put in between;
   * - a `parallel` phase sits between a parallel split and join;
   * - every step with nothing after it ends at an end event.
   */
  function buildGraph(p) {
    var sc = p.sc;
    var nodes = [];
    var taskOf = {};
    var last = null;
    var firstStart = true;

    function add(node) {
      node.id = nodes.length;
      node.key = node.key === undefined ? node.id : node.key;
      node.in = [];
      node.out = [];
      nodes.push(node);
      return node;
    }
    function link(a, b, label) {
      var edge = { from: a, to: b, label: label || null };
      a.out.push(edge);
      b.in.push(edge);
    }
    function start(lane, label, phase) {
      var node = add({ type: "start", lane: lane, label: label, phase: phase });
      firstStart = false;
      return node;
    }
    /** Where a new step attaches to `src`: src itself, or the gateway that splits it. */
    function attachPoint(src) {
      if (src.xor) return src.xor;
      if (!src.out.length || src.type === "and" || src.type === "xor") return src;
      var x = add({ type: "xor", lane: src.lane, question: src.step && src.step.decision, key: src.key + 0.5, phase: src.phase });
      src.out.forEach(function (edge) {
        edge.from = x;
        if (!edge.label) edge.label = edge.to.branchLabel || null;
        x.out.push(edge);
      });
      src.out = [];
      link(src, x);
      src.xor = x;
      return x;
    }

    sc.phases.forEach(function (phase, pi) {
      var steps = p.steps.filter(function (step) {
        return step.phase === pi;
      });

      if (phase.parallel) {
        var pred = last || start(steps[0].lane, phase.startLabel || sc.starts, pi);
        var split = add({ type: "and", lane: steps[0].lane, phase: pi });
        link(pred, split);
        var tasks = steps.map(function (step) {
          var task = add({ type: "task", lane: step.lane, step: step, phase: pi });
          taskOf[step.n] = task;
          link(split, task);
          return task;
        });
        var join = add({ type: "and", lane: steps[0].lane, phase: pi });
        tasks.forEach(function (task) {
          link(task, join);
        });
        last = join;
        return;
      }

      steps.forEach(function (step) {
        var pred;
        if (step.after === null || !last) {
          pred = start(step.lane, step.startLabel || (firstStart ? sc.starts : phase.title), pi);
          if (step.alongside) pred.alongside = p.byId[step.alongside].n;
        } else if (typeof step.after === "string") {
          pred = attachPoint(taskOf[p.byId[step.after].n]);
        } else {
          pred = attachPoint(last);
        }
        var task = add({ type: "task", lane: step.lane, step: step, phase: pi, branchLabel: phase.label });
        taskOf[step.n] = task;
        link(pred, task, pred.type === "xor" ? phase.label : null);
        last = task;
      });
    });

    nodes
      .filter(function (node) {
        return node.type === "task" && !node.out.length;
      })
      .forEach(function (task) {
        var end = add({ type: "end", lane: task.lane, label: endLabel(task.step), key: task.key + 0.5, phase: task.phase });
        link(task, end);
      });

    // Resolve `alongside` to the task node now every task exists.
    nodes.forEach(function (node) {
      if (node.alongside) node.alongside = taskOf[node.alongside];
    });
    return { nodes: nodes, taskOf: taskOf };
  }

  function endLabel(step) {
    if (step.endLabel) return step.endLabel;
    var state = step.state || {};
    if (state.event) return state.event[1];
    var key = Object.keys(STATE_LABELS).filter(function (k) {
      return state[k];
    })[0];
    return key ? STATE_LABELS[key] + " " + state[key][1] : "";
  }

  // ---------------------------------------------------------------- layout

  var G = {
    TASK_W: 150,
    TASK_H: 74,
    EVENT_W: 34,
    GW: 21,
    GAP: 54,
    ROW_H: 134,
    BAND_H: 26,
    LABEL_W: 44,
    PAD: 64,
    MAX_SUB: 3,
  };

  function nodeWidth(node) {
    if (node.type === "task") return G.TASK_W;
    if (node.type === "xor" || node.type === "and") return G.GW * 2;
    return G.EVENT_W;
  }

  /** Columns by longest path (in key order), lanes by role; a clash in one cell moves to a sub-row of the lane. */
  function layout(p, graph) {
    var nodes = graph.nodes;
    var placed = {};
    var occupied = {};
    var maxCol = -1;
    var remaining = nodes.slice();

    while (remaining.length) {
      var ready = remaining
        .filter(function (node) {
          return node.in.every(function (edge) {
            return placed[edge.from.id];
          });
        })
        .sort(function (a, b) {
          return a.key - b.key;
        });
      var node = ready[0];
      remaining.splice(remaining.indexOf(node), 1);

      var col;
      // A new flow skips a column, so the last flow's end label and this
      // flow's start label get room and don't run into each other.
      if (!node.in.length) col = node.alongside ? node.alongside.col + 1 : maxCol < 0 ? 0 : maxCol + 2;
      else
        col = Math.max.apply(
          null,
          node.in.map(function (edge) {
            return edge.from.col + 1;
          }),
        );

      var sameLanePred = node.in
        .map(function (edge) {
          return edge.from;
        })
        .filter(function (pred) {
          return pred.lane === node.lane;
        })[0];
      var preferred = sameLanePred ? sameLanePred.sub : 0;
      var subs = [preferred];
      for (var s = 0; s < G.MAX_SUB; s += 1) if (subs.indexOf(s) === -1) subs.push(s);

      var spot = null;
      for (var c = col; !spot; c += 1) {
        for (var i = 0; i < subs.length; i += 1) {
          if (!occupied[node.lane + "|" + c + "|" + subs[i]]) {
            spot = { col: c, sub: subs[i] };
            break;
          }
        }
      }
      node.col = spot.col;
      node.sub = spot.sub;
      occupied[node.lane + "|" + node.col + "|" + node.sub] = true;
      placed[node.id] = true;
      maxCol = Math.max(maxCol, node.col);
    }

    // Column x positions.
    var colW = [];
    nodes.forEach(function (node) {
      colW[node.col] = Math.max(colW[node.col] || 0, nodeWidth(node));
    });
    var colX = [];
    var x = G.PAD;
    for (var k = 0; k <= maxCol; k += 1) {
      colW[k] = colW[k] || G.EVENT_W;
      colX[k] = x;
      x += colW[k] + G.GAP;
    }
    var width = x - G.GAP + G.PAD + 20;

    // Phase bands across the top, stacked when branches overlap.
    var bands = p.sc.phases.map(function (phase, pi) {
      var cols = nodes
        .filter(function (node) {
          return node.phase === pi && node.type !== "end";
        })
        .map(function (node) {
          return node.col;
        });
      return { phase: phase, from: Math.min.apply(null, cols), to: Math.max.apply(null, cols) };
    });
    var bandRows = [];
    bands.forEach(function (band) {
      for (var r = 0; ; r += 1) {
        var row = bandRows[r] || (bandRows[r] = []);
        var clash = row.some(function (other) {
          return band.from <= other.to && other.from <= band.to;
        });
        if (!clash) {
          row.push(band);
          band.row = r;
          break;
        }
      }
    });
    var top = bandRows.length * G.BAND_H + 12;

    // Lane heights from the sub-rows they use.
    var lanes = p.lanes.map(function (lane) {
      var subs = nodes
        .filter(function (node) {
          return node.lane === lane;
        })
        .map(function (node) {
          return node.sub;
        });
      return { lane: lane, rows: Math.max.apply(null, subs) + 1 };
    });
    var y = top;
    lanes.forEach(function (lane) {
      lane.top = y;
      lane.height = lane.rows * G.ROW_H;
      y += lane.height;
    });
    var laneOf = {};
    lanes.forEach(function (lane) {
      laneOf[lane.lane] = lane;
    });

    nodes.forEach(function (node) {
      var w = nodeWidth(node);
      node.cx = colX[node.col] + colW[node.col] / 2;
      node.cy = laneOf[node.lane].top + node.sub * G.ROW_H + G.ROW_H / 2;
      var hh = node.type === "task" ? G.TASK_H / 2 : node.type === "xor" || node.type === "and" ? G.GW : G.EVENT_W / 2;
      node.left = node.cx - w / 2;
      node.right = node.cx + w / 2;
      node.top = node.cy - hh;
      node.bottom = node.cy + hh;
    });

    bands.forEach(function (band) {
      band.x1 = colX[band.from] - G.GAP / 2 + 3;
      band.x2 = colX[band.to] + colW[band.to] + G.GAP / 2 - 3;
      band.y = 6 + band.row * G.BAND_H;
    });

    return { width: width, height: y + 8, lanes: lanes, bands: bands };
  }

  // ---------------------------------------------------------------- text in SVG

  var measureCtx = document.createElement("canvas").getContext("2d");
  var FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  var MONO = "ui-monospace, 'Cascadia Code', Consolas, Menlo, monospace";

  function textWidth(text, size, weight, family) {
    measureCtx.font = (weight || 400) + " " + size + "px " + (family || FONT);
    return measureCtx.measureText(text).width;
  }

  /** Word-wraps `text` into at most `maxLines` lines no wider than `maxW`. */
  function wrap(text, maxW, size, maxLines, weight, family, separator) {
    var sep = separator || " ";
    var words = text.split(sep);
    var lines = [];
    var line = "";
    words.forEach(function (word) {
      var next = line ? line + sep + word : word;
      if (!line || textWidth(next, size, weight, family) <= maxW) line = next;
      else {
        lines.push(line);
        line = word;
      }
    });
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      var lastLine = lines[maxLines - 1];
      while (lastLine.length > 1 && textWidth(lastLine + "…", size, weight, family) > maxW) lastLine = lastLine.slice(0, -1);
      lines[maxLines - 1] = lastLine.replace(/[\s·]+$/, "") + "…";
    }
    return lines;
  }

  function multiline(lines, x, y, lineHeight, cls, anchor) {
    var text = svgEl("text", { x: x, y: y, class: cls, "text-anchor": anchor || "middle" });
    lines.forEach(function (line, i) {
      var tspan = svgEl("tspan", { x: x, dy: i === 0 ? 0 : lineHeight });
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    return text;
  }

  function title(text) {
    var node = svgEl("title");
    node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------- drawing

  function edgePath(edge) {
    var a = edge.from;
    var b = edge.to;
    var gateway = function (node) {
      return node.type === "xor" || node.type === "and";
    };
    var sy = a.cy;
    var ty = b.cy;
    if (Math.abs(sy - ty) < 1) return { d: "M" + a.right + "," + sy + " H" + b.left, lx: a.right + 6, ly: sy - 7 };
    var down = ty > sy;
    if (gateway(a)) {
      var y0 = down ? a.bottom : a.top;
      // Label each branch where it turns towards its own task, so two branches
      // leaving the same corner don't print their labels on top of each other.
      return { d: "M" + a.cx + "," + y0 + " V" + ty + " H" + b.left, lx: a.cx + 10, ly: ty - 8 };
    }
    if (gateway(b)) {
      var y1 = down ? b.top : b.bottom;
      return { d: "M" + a.right + "," + sy + " H" + b.cx + " V" + y1 };
    }
    var mx = b.left - G.GAP / 2;
    return { d: "M" + a.right + "," + sy + " H" + mx + " V" + ty + " H" + b.left, lx: a.right + 6, ly: sy - 7 };
  }

  function statePill(step) {
    var state = step.state || {};
    var keys = Object.keys(STATE_LABELS).filter(function (k) {
      return state[k];
    });
    if (!keys.length) return null;
    var key = keys[0];
    var to = state[key][1];
    var text = (key === "event" ? "→ " : STATE_LABELS[key] + " → ") + to + (keys.length > 1 ? "  +" + (keys.length - 1) : "");
    var size = 10.5;
    var w = Math.min(G.TASK_W, textWidth(text, size, 600) + 12);
    var lines = wrap(text, G.TASK_W - 12, size, 1, 600);
    return { text: lines[0], w: w, cls: statusClass(to) };
  }

  function drawTask(node, onSelect) {
    var step = node.step;
    var x = node.left;
    var y = node.top;
    var g = svgEl("g", {
      class: "dg-task lane-" + step.lane,
      id: "step-" + step.n,
      tabindex: "0",
      role: "button",
      "aria-label": "Step " + step.n + ": " + step.title,
    });
    g.appendChild(title("Step " + step.n + ": " + step.title + "\nClick for details"));

    var pill = statePill(step);
    if (pill) {
      var pg = svgEl("g", { class: "dg-pill " + pill.cls });
      pg.appendChild(svgEl("rect", { x: node.cx - pill.w / 2, y: y - 21, width: pill.w, height: 16, rx: 4 }));
      var pt = svgEl("text", { x: node.cx, y: y - 9.5, "text-anchor": "middle" });
      pt.textContent = pill.text;
      pg.appendChild(pt);
      g.appendChild(pg);
    }

    g.appendChild(svgEl("rect", { class: "box", x: x, y: y, width: G.TASK_W, height: G.TASK_H, rx: 9 }));
    g.appendChild(svgEl("rect", { class: "lane-strip", x: x + 1, y: y + 8, width: 3, height: G.TASK_H - 16, rx: 1.5 }));

    var lines = wrap(step.title, G.TASK_W - 22, 12, 3, 500);
    var titleTop = y + 8 + (3 - lines.length) * 7 + 12;
    g.appendChild(multiline(lines, node.cx + 2, titleTop, 14, "dg-title"));

    // Bottom row: step number, coverage, notification and note markers.
    var by = y + G.TASK_H - 15;
    g.appendChild(svgEl("circle", { class: "dg-num", cx: x + 15, cy: by + 5, r: 8 }));
    var num = svgEl("text", { class: "dg-num-text", x: x + 15, y: by + 8.5, "text-anchor": "middle" });
    num.textContent = String(step.n);
    g.appendChild(num);

    var covText = SHORT_MODE[step.coverage];
    var covW = textWidth(covText, 9.5, 600) + 10;
    var cov = svgEl("g", { class: "dg-cov m-" + step.coverage });
    cov.appendChild(svgEl("rect", { x: x + 28, y: by - 2, width: covW, height: 14, rx: 7 }));
    var ct = svgEl("text", { x: x + 28 + covW / 2, y: by + 8.5, "text-anchor": "middle" });
    ct.textContent = covText;
    cov.appendChild(ct);
    g.appendChild(cov);

    var mx = x + G.TASK_W - 12;
    if (step.notifies && step.notifies.length) {
      var env = svgEl("g", { class: "dg-mail" }, [
        title("Notifies: " + step.notifies.join(", ")),
        svgEl("rect", { x: mx - 7, y: by, width: 14, height: 10, rx: 1.5 }),
        svgEl("path", { d: "M" + (mx - 7) + "," + by + " L" + mx + "," + (by + 5.5) + " L" + (mx + 7) + "," + by }),
      ]);
      g.appendChild(env);
    }

    // Footer under the box: the services behind the step.
    var svc = step.services.map(shortService).join(" · ");
    var svcLines = wrap(svc, G.TASK_W + 6, 9.5, 2, 400, MONO, " · ");
    var svcText = multiline(svcLines, node.cx, y + G.TASK_H + 13, 12, "dg-svc");
    svcText.appendChild(title("ConnectSphere Online services: " + step.services.join(", ")));
    g.appendChild(svcText);

    g.addEventListener("click", function () {
      onSelect(step.n);
    });
    g.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        onSelect(step.n);
      }
    });
    return g;
  }

  function drawEvent(node) {
    var g = svgEl("g", { class: "dg-event " + node.type });
    g.appendChild(svgEl("circle", { cx: node.cx, cy: node.cy, r: G.EVENT_W / 2 - (node.type === "end" ? 1.5 : 0) }));
    if (node.label) {
      var lines = wrap(node.label, 104, 10.5, 3, 500);
      g.appendChild(multiline(lines, node.cx, node.bottom + 15, 12, "dg-event-label"));
    }
    return g;
  }

  function drawGateway(node) {
    var g = svgEl("g", { class: "dg-gw" });
    var r = G.GW;
    g.appendChild(
      svgEl("path", {
        class: "diamond",
        d: "M" + node.cx + "," + (node.cy - r) + " L" + (node.cx + r) + "," + node.cy + " L" + node.cx + "," + (node.cy + r) + " L" + (node.cx - r) + "," + node.cy + " Z",
      }),
    );
    var m = 7;
    var mark =
      node.type === "xor"
        ? "M" + (node.cx - m) + "," + (node.cy - m) + " L" + (node.cx + m) + "," + (node.cy + m) + " M" + (node.cx + m) + "," + (node.cy - m) + " L" + (node.cx - m) + "," + (node.cy + m)
        : "M" + node.cx + "," + (node.cy - m - 2) + " V" + (node.cy + m + 2) + " M" + (node.cx - m - 2) + "," + node.cy + " H" + (node.cx + m + 2);
    g.appendChild(svgEl("path", { class: "mark", d: mark }));
    g.appendChild(title(node.type === "xor" ? "Exclusive gateway: one path is taken" : "Parallel gateway: all paths run"));
    if (node.question) {
      var lines = wrap(node.question, 120, 10.5, 2, 600);
      g.appendChild(multiline(lines, node.cx, node.top - 8 - (lines.length - 1) * 12, 12, "dg-question"));
    }
    return g;
  }

  /** The diagram itself, plus the frozen lane labels that stay put while it scrolls sideways. */
  function drawDiagram(p, graph, box, onSelect) {
    var svg = svgEl("svg", { class: "dg", viewBox: "0 0 " + box.width + " " + box.height, role: "img", "aria-label": "Swimlane diagram of " + p.sc.title });
    svg.dataset.w = box.width;
    svg.dataset.h = box.height;
    var defs = svgEl("defs");
    defs.appendChild(svgEl("marker", { id: "dg-arrow", viewBox: "0 0 10 10", refX: "9.5", refY: "5", markerWidth: "9", markerHeight: "9", orient: "auto-start-reverse" }, [svgEl("path", { d: "M0,0.5 L10,5 L0,9.5 z" })]));
    svg.appendChild(defs);

    box.lanes.forEach(function (lane, i) {
      svg.appendChild(svgEl("rect", { class: "dg-lane stripe-" + (i % 2), x: 0, y: lane.top, width: box.width, height: lane.height }));
      svg.appendChild(svgEl("line", { class: "dg-lane-line", x1: 0, x2: box.width, y1: lane.top, y2: lane.top }));
    });
    var lastLane = box.lanes[box.lanes.length - 1];
    svg.appendChild(svgEl("line", { class: "dg-lane-line", x1: 0, x2: box.width, y1: lastLane.top + lastLane.height, y2: lastLane.top + lastLane.height }));

    box.bands.forEach(function (band) {
      var g = svgEl("g", { class: "dg-band" });
      var w = band.x2 - band.x1;
      g.appendChild(svgEl("rect", { x: band.x1, y: band.y, width: w, height: G.BAND_H - 6, rx: 5 }));
      var label = wrap(band.phase.title, w - 14, 11, 1, 600)[0];
      var t = svgEl("text", { x: band.x1 + 8, y: band.y + 14 });
      t.textContent = label;
      g.appendChild(t);
      g.appendChild(title(band.phase.title + (band.phase.note ? " — " + band.phase.note : "")));
      svg.appendChild(g);
      svg.appendChild(svgEl("line", { class: "dg-band-guide", x1: band.x1, x2: band.x1, y1: band.y + G.BAND_H - 6, y2: box.height - 8 }));
    });

    graph.nodes.forEach(function (node) {
      node.out.forEach(function (edge) {
        var path = edgePath(edge);
        svg.appendChild(svgEl("path", { class: "dg-edge", d: path.d, "marker-end": "url(#dg-arrow)" }));
        if (edge.label && path.lx !== undefined) {
          var t = svgEl("text", { class: "dg-edge-label", x: path.lx, y: path.ly });
          t.textContent = edge.label;
          svg.appendChild(t);
        }
      });
    });

    graph.nodes.forEach(function (node) {
      if (node.type === "task") svg.appendChild(drawTask(node, onSelect));
      else if (node.type === "xor" || node.type === "and") svg.appendChild(drawGateway(node));
      else svg.appendChild(drawEvent(node));
    });

    var labels = svgEl("svg", { class: "dg-labels", viewBox: "0 0 " + G.LABEL_W + " " + box.height, "aria-hidden": "true" });
    labels.dataset.w = G.LABEL_W;
    labels.dataset.h = box.height;
    box.lanes.forEach(function (lane, i) {
      var g = svgEl("g", { class: "lane-" + lane.lane });
      g.appendChild(svgEl("rect", { class: "dg-lane-head stripe-" + (i % 2), x: 0, y: lane.top, width: G.LABEL_W, height: lane.height }));
      g.appendChild(svgEl("rect", { class: "dg-lane-color", x: 0, y: lane.top, width: 5, height: lane.height }));
      g.appendChild(svgEl("line", { class: "dg-lane-line", x1: 0, x2: G.LABEL_W, y1: lane.top, y2: lane.top }));
      var cx = G.LABEL_W / 2 + 3;
      var cy = lane.top + lane.height / 2;
      var lines = wrap(D.lanes[lane.lane].label, lane.height - 16, 12, 2, 700);
      var t = multiline(lines, 0, 0, 13, "dg-lane-name");
      t.setAttribute("transform", "translate(" + (cx - (lines.length - 1) * 6.5 + 4) + "," + cy + ") rotate(-90)");
      t.querySelectorAll("tspan").forEach(function (tspan) {
        tspan.setAttribute("x", 0);
      });
      g.appendChild(t);
      labels.appendChild(g);
    });
    labels.appendChild(svgEl("line", { class: "dg-lane-line", x1: 0, x2: G.LABEL_W, y1: lastLane.top + lastLane.height, y2: lastLane.top + lastLane.height }));
    labels.appendChild(svgEl("line", { class: "dg-lane-edge", x1: G.LABEL_W - 0.5, x2: G.LABEL_W - 0.5, y1: box.lanes[0].top, y2: lastLane.top + lastLane.height }));
    return { svg: svg, labels: labels };
  }

  // ---------------------------------------------------------------- details drawer

  function stepDetails(p, step) {
    var states = Object.keys(STATE_LABELS)
      .filter(function (key) {
        return step.state && step.state[key];
      })
      .map(function (key) {
        var pair = step.state[key];
        return h("div", { class: "state-row" }, [
          h("span", { class: "state-label", text: STATE_LABELS[key] }),
          h("span", { class: "status " + statusClass(pair[0]), text: pair[0] }),
          h("span", { class: "arrow", text: "→" }),
          h("span", { class: "status " + statusClass(pair[1]), text: pair[1] }),
        ]);
      });
    return [
      h("div", { class: "drawer-kicker" }, [laneChip(step.lane), h("span", { class: "dim", text: "Step " + step.n + " of " + p.steps.length + " · " + p.sc.phases[step.phase].title })]),
      h("h2", { class: "drawer-title", text: step.title }),
      states.length ? h("div", { class: "states" }, states) : null,
      step.detail ? h("p", { class: "detail", text: step.detail }) : null,
      step.notifies && step.notifies.length ? h("div", { class: "drawer-block" }, [h("h3", { text: "Notifies" }), h("ul", { class: "plain" }, step.notifies.map(function (n) {
        return h("li", { text: n });
      }))]) : null,
    ]
      .concat([
        h("div", { class: "drawer-block" }, [h("h3", { text: "ConnectSphere Online services" }), h("p", { class: "mono svc-full", text: step.services.join(" · ") })]),
        h("div", { class: "drawer-block" }, [
          h("h3", { text: "Playwright" }),
          step.refs.length ? h("ul", { class: "test-full" }, step.refs.map(testItem)) : modeChip("none"),
        ]),
      ]);
  }

  // ---------------------------------------------------------------- scenario page

  function testsTable(p) {
    var rows = {};
    p.steps.forEach(function (step) {
      step.refs.forEach(function (ref) {
        var row = rows[ref.key] || (rows[ref.key] = { test: ref.test, modes: {}, steps: [] });
        row.modes[ref.mode] = true;
        if (row.steps.indexOf(step.n) === -1) row.steps.push(step.n);
      });
    });
    var keys = Object.keys(rows).sort(function (x, y) {
      return (rows[x].test.spec + rows[x].test.name).localeCompare(rows[y].test.spec + rows[y].test.name);
    });
    return h("div", { class: "table-wrap" }, [
      h("table", {}, [
        h("thead", {}, [h("tr", {}, [h("th", { text: "Spec" }), h("th", { text: "Test" }), h("th", { text: "How" }), h("th", { text: "Steps" })])]),
        h(
          "tbody",
          {},
          keys.map(function (key) {
            var row = rows[key];
            return h("tr", {}, [
              h("td", { class: "mono", text: row.test.spec }),
              h("td", { text: row.test.name }),
              h(
                "td",
                {},
                Object.keys(row.modes)
                  .map(function (mode) {
                    return modeChip(mode);
                  })
                  .concat(row.test.local ? [" ", localChip()] : []),
              ),
              h(
                "td",
                { class: "step-links" },
                row.steps.map(function (n) {
                  return h("a", { href: "#step-" + n, text: String(n) });
                }),
              ),
            ]);
          }),
        ),
      ]),
    ]);
  }

  function stepsTable(p) {
    return h("div", { class: "table-wrap" }, [
      h("table", {}, [
        h("thead", {}, [
          h("tr", {}, [h("th", { class: "num", text: "#" }), h("th", { text: "Lane" }), h("th", { text: "Step" }), h("th", { text: "Status change" }), h("th", { text: "Services" }), h("th", { text: "Playwright" })]),
        ]),
        h(
          "tbody",
          {},
          p.steps.map(function (step) {
            var state = step.state || {};
            var changes = Object.keys(STATE_LABELS)
              .filter(function (k) {
                return state[k];
              })
              .map(function (k) {
                return h("div", { class: "state-row" }, [
                  h("span", { class: "state-label", text: STATE_LABELS[k] }),
                  h("span", { class: "status " + statusClass(state[k][0]), text: state[k][0] }),
                  h("span", { class: "arrow", text: "→" }),
                  h("span", { class: "status " + statusClass(state[k][1]), text: state[k][1] }),
                ]);
              });
            return h("tr", {}, [
              h("td", { class: "num" }, [h("a", { href: "#step-" + step.n, text: String(step.n) })]),
              h("td", {}, [laneChip(step.lane)]),
              h("td", { text: step.title }),
              h("td", {}, changes.length ? changes : [h("span", { class: "dim", text: "—" })]),
              h("td", { class: "mono small", text: step.services.map(shortService).join(" · ") }),
              h(
                "td",
                {},
                step.refs.length
                  ? step.refs.map(function (ref) {
                      return h("div", { class: "test-cell", title: ref.test.name }, [modeChip(ref.mode), " ", h("span", { class: "mono small", text: ref.test.spec })]);
                    })
                  : [modeChip("none")],
              ),
            ]);
          }),
        ),
      ]),
    ]);
  }

  function renderScenario(id) {
    var p = prepared.filter(function (x) {
      return x.sc.id === id;
    })[0];
    var sc = p.sc;
    document.title = "Scenario " + p.number + ": " + sc.title;
    var uncovered = p.steps.filter(function (step) {
      return step.coverage === "none";
    });
    var prev = prepared[p.number - 2];
    var next = prepared[p.number];

    var graph = buildGraph(p);
    var box = layout(p, graph);
    var selected = null;
    var drawer = h("aside", { class: "drawer", "aria-label": "Step details", hidden: "hidden" });
    var drawn = drawDiagram(p, graph, box, select);
    var inner = h("div", { class: "dg-inner" }, [drawn.labels, drawn.svg]);
    var scroller = h("div", { class: "dg-scroll", tabindex: "0", "aria-label": "Diagram, scroll sideways" }, [inner]);

    var zoom = 1;
    var zoomLabel = h("span", { class: "zoom-value", text: "100%" });
    function setZoom(z) {
      zoom = Math.max(0.4, Math.min(1.6, Math.round(z * 100) / 100));
      [drawn.svg, drawn.labels].forEach(function (el) {
        el.setAttribute("width", el.dataset.w * zoom);
        el.setAttribute("height", el.dataset.h * zoom);
      });
      zoomLabel.textContent = Math.round(zoom * 100) + "%";
    }
    function zoomButton(text, label, fn) {
      var b = h("button", { type: "button", class: "tool", "aria-label": label, title: label, text: text });
      b.addEventListener("click", fn);
      return b;
    }
    var toolbar = h("div", { class: "toolbar" }, [
      h("div", { class: "zoom" }, [
        zoomButton("−", "Zoom out", function () {
          setZoom(zoom - 0.1);
        }),
        zoomLabel,
        zoomButton("+", "Zoom in", function () {
          setZoom(zoom + 0.1);
        }),
        zoomButton("Fit height", "Zoom so every lane fits on screen", fitHeight),
        zoomButton("100%", "Actual size", function () {
          setZoom(1);
        }),
      ]),
      h("span", { class: "dim hint", text: "Drag or scroll sideways to move along the flow · click a task for its details" }),
    ]);

    function fitHeight() {
      var available = window.innerHeight - scroller.getBoundingClientRect().top - 24;
      setZoom(Math.min(1, Math.max(0.4, available / box.height)));
    }

    function select(n, scroll) {
      if (selected) {
        var old = document.getElementById("step-" + selected);
        if (old) old.classList.remove("selected");
      }
      selected = n;
      var step = p.steps[n - 1];
      var el = document.getElementById("step-" + n);
      el.classList.add("selected");
      drawer.replaceChildren(
        h("div", { class: "drawer-bar" }, [
          navButton("← Previous", n > 1 ? n - 1 : null),
          navButton("Next →", n < p.steps.length ? n + 1 : null),
          closeButton(),
        ]),
        h("div", { class: "drawer-body" }, stepDetails(p, step)),
      );
      drawer.hidden = false;
      document.body.classList.add("drawer-open");
      if (history.replaceState) history.replaceState(null, "", "#step-" + n);
      if (scroll) centreOn(graph.taskOf[n]);
    }
    function closeDrawer() {
      drawer.hidden = true;
      document.body.classList.remove("drawer-open");
      if (selected) {
        var el = document.getElementById("step-" + selected);
        if (el) el.classList.remove("selected");
      }
      selected = null;
      if (history.replaceState) history.replaceState(null, "", location.pathname);
    }
    function navButton(text, n) {
      var b = h("button", { type: "button", class: "tool", text: text, disabled: n ? null : "disabled" });
      if (n)
        b.addEventListener("click", function () {
          select(n, true);
        });
      return b;
    }
    function closeButton() {
      var b = h("button", { type: "button", class: "tool close", "aria-label": "Close details", text: "×" });
      b.addEventListener("click", closeDrawer);
      return b;
    }
    function centreOn(node) {
      var visible = scroller.clientWidth - G.LABEL_W * zoom - (document.body.classList.contains("drawer-open") && window.innerWidth > 900 ? 400 : 0);
      scroller.scrollTo({ left: Math.max(0, node.cx * zoom - visible / 2), behavior: "smooth" });
      var rect = scroller.getBoundingClientRect();
      var nodeY = rect.top + node.cy * zoom;
      if (nodeY < 80 || nodeY > window.innerHeight - 80) window.scrollBy({ top: nodeY - window.innerHeight / 2, behavior: "smooth" });
    }

    // Drag the background to pan, like a diagram editor.
    var drag = null;
    scroller.addEventListener("pointerdown", function (evt) {
      if (evt.button !== 0 || evt.target.closest(".dg-task")) return;
      drag = { x: evt.clientX, y: evt.clientY, left: scroller.scrollLeft, top: window.scrollY };
      scroller.classList.add("dragging");
    });
    window.addEventListener("pointermove", function (evt) {
      if (!drag) return;
      scroller.scrollLeft = drag.left - (evt.clientX - drag.x);
      window.scrollTo(window.scrollX, drag.top - (evt.clientY - drag.y));
    });
    window.addEventListener("pointerup", function () {
      drag = null;
      scroller.classList.remove("dragging");
    });
    document.addEventListener("keydown", function (evt) {
      if (!selected) return;
      if (evt.key === "Escape") closeDrawer();
      else if (evt.key === "ArrowRight" && selected < p.steps.length) select(selected + 1, true);
      else if (evt.key === "ArrowLeft" && selected > 1) select(selected - 1, true);
    });

    var page = h("main", { class: "page" }, [
      h("nav", { class: "crumb" }, [h("a", { href: "index.html", text: "← All scenarios" })]),
      h("h1", {}, [h("span", { class: "kicker", text: "Scenario " + p.number }), sc.title]),
      bullets(sc.summary, "lede-list"),
      h("div", { class: "meta" }, [
        h("span", {}, [h("b", { text: "Starts: " }), sc.starts]),
        h("span", {}, [h("b", { text: "Ends: " }), sc.ends]),
        h("span", {}, [h("b", { text: "Steps: " }), String(p.steps.length)]),
        h("span", {}, [h("b", { text: "Steps with no Playwright test: " }), String(uncovered.length)]),
      ]),
      legend(),
      toolbar,
      scroller,
      h("p", { class: "dg-key dim" }, [
        "Each task: the status it moves to (above), its step number and Playwright coverage (inside), and the ConnectSphere Online services behind it (below). ",
        "✉ = sends important notifications.",
      ]),
      h("h2", { text: "All steps" }),
      stepsTable(p),
      h("h2", { text: "Playwright tests in this scenario" }),
      testsTable(p),
      h("h2", { text: "Steps with no Playwright test" }),
      uncovered.length
        ? h(
            "ul",
            { class: "gap-list" },
            uncovered.map(function (step) {
              return h("li", {}, [h("a", { href: "#step-" + step.n, text: "Step " + step.n }), " · " + D.lanes[step.lane].label + ": " + step.title]);
            }),
          )
        : h("p", { class: "dim", text: "Every step has at least one test." }),
      h("footer", { class: "page-foot" }, [
        prev ? h("a", { href: prev.sc.file, text: "← Scenario " + prev.number + ": " + prev.sc.title }) : null,
        prev && next ? "   ·   " : null,
        next ? h("a", { href: next.sc.file, text: "Scenario " + next.number + ": " + next.sc.title + " →" }) : null,
      ]),
    ]);
    document.body.appendChild(page);
    document.body.appendChild(drawer);

    // Start as large as fits the screen, but never below 75% so the text stays readable.
    var available = window.innerHeight - scroller.getBoundingClientRect().top - 24;
    setZoom(Math.min(1, Math.max(0.75, available / box.height)));

    // Links to #step-n (from the tables and the index page) open that step.
    function fromHash() {
      var match = /^#step-(\d+)$/.exec(location.hash);
      if (match && p.steps[Number(match[1]) - 1]) select(Number(match[1]), true);
    }
    window.addEventListener("hashchange", fromHash);
    page.addEventListener("click", function (evt) {
      var link = evt.target.closest('a[href^="#step-"]');
      if (!link) return;
      evt.preventDefault();
      select(Number(link.getAttribute("href").slice(6)), true);
    });
    fromHash();
  }

  // ---------------------------------------------------------------- index page

  function coverageCounts(p) {
    var counts = { ui: 0, check: 0, api: 0, none: 0 };
    p.steps.forEach(function (step) {
      counts[step.coverage] += 1;
    });
    return counts;
  }

  function scenarioCard(p) {
    var counts = coverageCounts(p);
    var total = p.steps.length;
    return h("a", { class: "scenario-card", href: p.sc.file }, [
      h("span", { class: "num", text: "Scenario " + p.number }),
      h("h3", { text: p.sc.title }),
      bullets(p.sc.summary, "card-bullets"),
      h("div", { class: "lane-chips" }, p.lanes.map(laneChip)),
      h(
        "div",
        { class: "cov-bar", title: "Steps by their strongest Playwright coverage" },
        ["ui", "check", "api", "none"].map(function (mode) {
          return h("span", { class: "m-" + mode, style: "width:" + (counts[mode] / total) * 100 + "%" });
        }),
      ),
      h("div", { class: "cov-stats" }, [
        h("span", { class: "dim", text: total + " steps:" }),
        h("span", { class: "mode m-ui", text: counts.ui + " UI" }),
        h("span", { class: "mode m-check", text: counts.check + " API + UI check" }),
        h("span", { class: "mode m-api", text: counts.api + " API" }),
        h("span", { class: "mode m-none", text: counts.none + " no test" }),
      ]),
    ]);
  }

  /** Where each test sits: scenario steps, or a cross-cutting rule. */
  function testPlacements() {
    var places = {};
    Object.keys(D.tests).forEach(function (key) {
      places[key] = [];
    });
    prepared.forEach(function (p) {
      p.steps.forEach(function (step) {
        step.refs.forEach(function (ref) {
          places[ref.key].push({ p: p, step: step, mode: ref.mode });
        });
      });
    });
    return places;
  }

  function matrix(places) {
    var specs = [];
    Object.keys(D.tests).forEach(function (key) {
      if (specs.indexOf(D.tests[key].spec) === -1) specs.push(D.tests[key].spec);
    });
    specs.sort();
    var head = [h("th", { text: "Spec file" }), h("th", { class: "num", title: "Rows in the full test table below; one row can stand for a group, e.g. one login test per role", text: "Test entries" })]
      .concat(
        prepared.map(function (p) {
          return h("th", { class: "num", title: p.sc.title, text: "S" + p.number });
        }),
      )
      .concat([h("th", { class: "num", text: "Cross-cutting" })]);
    var body = specs.map(function (spec) {
      var keys = Object.keys(D.tests).filter(function (key) {
        return D.tests[key].spec === spec;
      });
      var cells = prepared.map(function (p) {
        var steps = {};
        keys.forEach(function (key) {
          places[key].forEach(function (place) {
            if (place.p === p) steps[place.step.n] = true;
          });
        });
        var count = Object.keys(steps).length;
        return h("td", { class: "num" + (count ? "" : " dim"), text: count ? count + (count === 1 ? " step" : " steps") : "—" });
      });
      var cross = keys.some(function (key) {
        return D.crossCutting[key];
      });
      return h(
        "tr",
        {},
        [h("td", { class: "mono", text: spec }), h("td", { class: "num", text: String(keys.length) })]
          .concat(cells)
          .concat([h("td", { class: "num" + (cross ? "" : " dim"), text: cross ? "yes" : "—" })]),
      );
    });
    return h("div", { class: "table-wrap" }, [h("table", {}, [h("thead", {}, [h("tr", {}, head)]), h("tbody", {}, body)])]);
  }

  function allTestsTable(places) {
    var keys = Object.keys(D.tests).sort(function (x, y) {
      return (D.tests[x].spec + D.tests[x].name).localeCompare(D.tests[y].spec + D.tests[y].name);
    });
    return h("div", { class: "table-wrap" }, [
      h("table", {}, [
        h("thead", {}, [h("tr", {}, [h("th", { text: "Spec" }), h("th", { text: "Test" }), h("th", { text: "How" }), h("th", { text: "Where it sits" })])]),
        h(
          "tbody",
          {},
          keys.map(function (key) {
            var test = D.tests[key];
            var where = places[key].map(function (place) {
              return h("a", { href: place.p.sc.file + "#step-" + place.step.n, title: place.step.title, text: "S" + place.p.number + " step " + place.step.n });
            });
            if (D.crossCutting[key]) where.push(h("span", { class: "dim", text: D.crossCutting[key] }));
            if (!where.length) where.push(h("span", { class: "dim", text: "Not placed on a scenario" }));
            return h("tr", {}, [
              h("td", { class: "mono", text: test.spec }),
              h("td", { text: test.name }),
              h("td", {}, [modeChip(test.mode)].concat(test.local ? [" ", localChip()] : [])),
              h("td", { class: "step-links" }, where),
            ]);
          }),
        ),
      ]),
    ]);
  }

  function renderIndex() {
    var places = testPlacements();
    var totalSteps = 0;
    var uncovered = 0;
    prepared.forEach(function (p) {
      totalSteps += p.steps.length;
      uncovered += coverageCounts(p).none;
    });
    var testCount = Object.keys(D.tests).length;

    document.body.appendChild(
      h("main", { class: "page" }, [
        h("h1", {}, [h("span", { class: "kicker", text: "ConnectSphere · IS212 G6T5" }), "End-to-end scenarios"]),
        h("p", {
          class: "lede",
          text:
            "Five scenarios, drawn as swimlanes with one lane per role, that together walk every part of the event lifecycle (AGENTS.md §3), venue bookings (§3a) and registration (§3b). Each step names the ConnectSphere Online services behind it and the Playwright tests in frontend/e2e that exercise it.",
        }),
        h("div", { class: "meta" }, [
          h("span", {}, [h("b", { text: "Scenarios: " }), String(prepared.length)]),
          h("span", {}, [h("b", { text: "Steps: " }), String(totalSteps)]),
          h("span", {}, [h("b", { text: "Playwright tests mapped: " }), String(testCount)]),
          h("span", {}, [h("b", { text: "Steps with no Playwright test: " }), String(uncovered)]),
        ]),
        h("div", { class: "lane-chips", style: "margin-bottom:24px" }, D.laneOrder.map(laneChip)),

        h("h2", { text: "Scenarios" }),
        h("div", { class: "scenario-grid" }, prepared.map(scenarioCard)),

        h("h2", { text: "How the end-to-end tests were derived" }),
        h("ol", { class: "method" }, [
          h("li", {}, [
            h("b", { text: "Start from the rules, not the screens" }),
            "Every status, transition and who-may-act rule comes from AGENTS.md §3, §3a and §3b and was checked against the services' route handlers.",
          ]),
          h("li", {}, [
            h("b", { text: "Walk each role's journey" }),
            "The rules were grouped into five journeys and drawn as swimlanes, so every hand-off between roles (and to ConnectSphere Online) is visible.",
          ]),
          h("li", {}, [
            h("b", { text: "One test per hand-off or rule" }),
            "Each test sets up its own data through the real services' APIs (frontend/e2e/support/backend.ts), with a real database and RabbitMQ, nothing mocked. Only the step under test is driven in the browser.",
          ]),
          h("li", {}, [
            h("b", { text: "Map tests back onto steps" }),
            "Each test is placed on the steps it exercises, marked UI, API + UI check, or API. A step with no test is a known gap, listed on each scenario page.",
          ]),
        ]),
        legend(),

        h("h2", { text: "Coverage by spec file" }),
        h("p", { class: "lede", text: "How many steps of each scenario a spec file's tests land on. screenshots.e2e.ts is left out: it captures every page for review and asserts nothing." }),
        matrix(places),

        h("h2", { text: "Every Playwright test and where it sits" }),
        allTestsTable(places),
      ]),
    );
  }

  // ---------------------------------------------------------------- boot

  function boot() {
    var scenario = document.body.getAttribute("data-scenario");
    if (scenario) renderScenario(scenario);
    else renderIndex();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
