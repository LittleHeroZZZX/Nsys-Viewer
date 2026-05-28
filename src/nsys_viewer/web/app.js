// nsys-viewer frontend: vanilla JS, no build step.

const state = {
  mode: "single",          // "single" | "compare"
  files: [],               // [{name, size_bytes, mtime}]
  single: null,            // name of selected file
  compare: new Set(),      // names selected for compare
  groupBy: "short",
  limit: 50,
  search: "",              // global client-side name filter (regex)
  compareFilters: {},      // {filename: regexStr} — per-source server-side filter
  thresholdAbs: 0,         // ns; 0 = disabled
  thresholdRel: 0,         // fraction (0.05 = 5%); 0 = disabled
};

const $ = (sel) => document.querySelector(sel);
const fmt = {
  ns: (n) => {
    if (!n) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " s";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + " ms";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + " µs";
    return n + " ns";
  },
  int: (n) => (n ?? 0).toLocaleString(),
  pct: (x) => (x * 100).toFixed(1) + "%",
  bytes: (n) => {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  },
};

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function loadFiles() {
  const data = await fetchJSON("/api/files");
  state.files = data.files;
  $("#root-label").textContent = data.root;
  renderFileList();
  if (!state.single && state.files.length) {
    state.single = state.files[0].name;
    state.compare.add(state.single);
  }
  await refresh();
}

let filterTimer = null;

function validateRegexInput(el, pattern) {
  if (!pattern) { el.classList.remove("invalid-regex"); return; }
  try { new RegExp(pattern); el.classList.remove("invalid-regex"); }
  catch (_) { el.classList.add("invalid-regex"); }
}

function renderFileList() {
  const ul = $("#file-list");
  ul.innerHTML = "";
  for (const f of state.files) {
    const li = document.createElement("li");
    li.className = "file-item";
    const isActive =
      state.mode === "single" ? state.single === f.name : state.compare.has(f.name);
    if (isActive) li.classList.add("active");

    const row = document.createElement("div");
    row.className = "file-row";

    const input = document.createElement("input");
    if (state.mode === "single") {
      input.type = "radio";
      input.name = "single-file";
      input.checked = state.single === f.name;
      input.addEventListener("change", () => {
        state.single = f.name;
        renderFileList();
        refresh();
      });
    } else {
      input.type = "checkbox";
      input.checked = state.compare.has(f.name);
      input.addEventListener("change", () => {
        if (input.checked) state.compare.add(f.name);
        else state.compare.delete(f.name);
        renderFileList();
        refresh();
      });
    }
    row.appendChild(input);

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.name;
    row.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = fmt.bytes(f.size_bytes);
    row.appendChild(meta);

    row.addEventListener("click", (e) => {
      if (e.target === input) return;
      input.click();
    });
    li.appendChild(row);

    // per-file regex filter input — only in compare mode for checked files
    if (state.mode === "compare" && state.compare.has(f.name)) {
      const fi = document.createElement("input");
      fi.type = "search";
      fi.className = "file-filter";
      fi.placeholder = "filter regex…";
      fi.value = state.compareFilters[f.name] || "";
      fi.addEventListener("click", (e) => e.stopPropagation());
      fi.addEventListener("input", (e) => {
        const val = e.target.value.trim();
        validateRegexInput(fi, val);
        state.compareFilters[f.name] = val;
        clearTimeout(filterTimer);
        filterTimer = setTimeout(refresh, 200);
      });
      li.appendChild(fi);
    }

    ul.appendChild(li);
  }
}

async function refresh() {
  if (state.mode === "single") {
    $("#single-pane").classList.remove("hidden");
    $("#compare-pane").classList.add("hidden");
    if (!state.single) {
      renderCards([]);
      $("#single-summary").innerHTML = "";
      $("#single-table-wrap").innerHTML = "<div class='empty'>No file selected.</div>";
      return;
    }
    const params = new URLSearchParams({
      file: state.single,
      group_by: state.groupBy,
      limit: state.limit,
    });
    const [ov, ks] = await Promise.all([
      fetchJSON(`/api/overview?file=${encodeURIComponent(state.single)}`),
      fetchJSON(`/api/kernels?${params}`),
    ]);
    renderCards([ov]);
    renderSingle(ks, ov);
  } else {
    $("#single-pane").classList.add("hidden");
    $("#compare-pane").classList.remove("hidden");
    const files = [...state.compare];
    if (files.length === 0) {
      renderCards([]);
      $("#compare-summary").innerHTML = "";
      $("#compare-table-wrap").innerHTML = "<div class='empty'>Select 1+ files.</div>";
      return;
    }
    const ovs = await Promise.all(
      files.map((f) => fetchJSON(`/api/overview?file=${encodeURIComponent(f)}`)),
    );
    renderCards(ovs);

    const params = new URLSearchParams({
      files: files.join(","),
      group_by: state.groupBy,
      limit: state.limit,
    });
    for (const f of files) {
      params.append("regex", state.compareFilters[f] || "");
    }
    const data = await fetchJSON(`/api/compare?${params}`);
    renderCompare(data);
  }
}

function renderCards(overviews) {
  const wrap = $("#overview-cards");
  wrap.innerHTML = "";
  for (const o of overviews) {
    const c = document.createElement("div");
    c.className = "card";
    const gpu = o.gpu_name ? `GPU: ${o.gpu_name}` : "";
    c.innerHTML = `
      <div class="label">${escapeHtml(o.file)}</div>
      <div class="value">${fmt.ns(o.kernel_total_ns)}</div>
      <div class="sub">${fmt.int(o.kernel_count)} kernels · wall ${fmt.ns(o.wall_ns)}</div>
      <div class="sub">${escapeHtml(gpu)}</div>
    `;
    wrap.appendChild(c);
  }
}

function filterBySearch(rows) {
  if (!state.search) return rows;
  try {
    const rx = new RegExp(state.search, "i");
    return rows.filter((r) => rx.test(r.name));
  } catch (_) {
    const q = state.search.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }
}

// Returns true if the delta should be styled (significant), false if suppressed by threshold.
function isDeltaSignificant(delta, baseline) {
  if (delta === 0) return false;
  const absEnabled = state.thresholdAbs > 0;
  const relEnabled = state.thresholdRel > 0;
  if (!absEnabled && !relEnabled) return true;
  let withinThreshold = true;
  if (absEnabled) withinThreshold = withinThreshold && Math.abs(delta) <= state.thresholdAbs;
  if (relEnabled && baseline > 0) {
    withinThreshold = withinThreshold && Math.abs(delta / baseline) <= state.thresholdRel;
  }
  return !withinThreshold;
}

function renderSingleSummary(ov, rows) {
  const el = $("#single-summary");
  if (!rows.length || !ov) { el.innerHTML = ""; return; }
  const shownNs  = rows.reduce((s, r) => s + (r.total_ns || 0), 0);
  const launches = rows.reduce((s, r) => s + (r.cnt     || 0), 0);
  const covPct   = ov.kernel_total_ns > 0 ? shownNs / ov.kernel_total_ns * 100 : 0;
  const avgNs    = launches > 0 ? shownNs / launches : 0;
  const minAvg   = Math.min(...rows.map((r) => r.avg_ns || 0));
  const maxAvg   = Math.max(...rows.map((r) => r.avg_ns || 0));
  const covCls   = covPct >= 90 ? "good" : covPct >= 70 ? "info" : "warn";
  el.innerHTML = `<div class="sum-row">
    <span class="sum-chip">${rows.length} types · ${fmt.int(launches)} launches</span>
    <span class="sum-chip info">shown ${fmt.ns(shownNs)}</span>
    <span class="sum-chip ${covCls}">coverage ${covPct.toFixed(1)}%</span>
    <span class="sum-chip">avg ${fmt.ns(avgNs)} / launch</span>
    <span class="sum-chip">range ${fmt.ns(minAvg)} – ${fmt.ns(maxAvg)}</span>
  </div>`;
}

function renderCompareSummary(rows, files) {
  const el = $("#compare-summary");
  if (!rows.length || files.length < 2) { el.innerHTML = ""; return; }
  let html = "";
  for (let j = 1; j < files.length; j++) {
    let matched = 0, onlyBase = 0, onlyThis = 0;
    let slower = 0, faster = 0, same = 0;
    let baseNs = 0, thisNs = 0, overhead = 0, savings = 0;
    for (const r of rows) {
      const b = r.totals[0] || 0;
      const t = r.totals[j] || 0;
      if (b > 0 && t > 0) {
        matched++; baseNs += b; thisNs += t;
        const d = t - b;
        if (isDeltaSignificant(d, b)) {
          if (d > 0) { slower++; overhead += d; }
          else       { faster++; savings  += -d; }
        } else { same++; }
      } else if (b > 0) { onlyBase++; }
      else if (t > 0)   { onlyThis++; }
    }
    const net    = thisNs - baseNs;
    const netPct = baseNs > 0 ? net / baseNs * 100 : null;
    const sign   = net > 0 ? "+" : "";
    const netCls = net < 0 ? "good" : net > 0 ? "bad" : "";
    const pctStr = netPct !== null ? ` (${sign}${netPct.toFixed(1)}%)` : "";

    const chips = [];
    chips.push(`<span class="sum-chip ${netCls}">net ${sign}${fmt.ns(net)}${pctStr}</span>`);
    chips.push(`<span class="sum-chip">baseline ${fmt.ns(baseNs)} → ${fmt.ns(thisNs)}</span>`);
    if (slower > 0) chips.push(`<span class="sum-chip bad">${slower} slower +${fmt.ns(overhead)}</span>`);
    if (faster > 0) chips.push(`<span class="sum-chip good">${faster} faster −${fmt.ns(savings)}</span>`);
    if (same   > 0) chips.push(`<span class="sum-chip">${same} unchanged</span>`);
    const extras = [];
    if (onlyThis > 0) extras.push(`${onlyThis} new`);
    if (onlyBase > 0) extras.push(`${onlyBase} gone`);
    if (extras.length) chips.push(`<span class="sum-chip warn">${extras.join(" · ")}</span>`);
    if (matched > 0) chips.push(`<span class="sum-chip">${matched} matched</span>`);

    html += `<div class="sum-row">
      <span class="sum-label">vs ${escapeHtml(files[j])}:</span>
      ${chips.join("")}
    </div>`;
  }
  el.innerHTML = html;
}

function renderSingle(data, ov) {
  const rows = filterBySearch(data.rows);
  renderSingleSummary(ov, rows);
  $("#single-meta").textContent = `${rows.length} rows · group_by=${data.group_by}`;
  if (rows.length === 0) {
    $("#single-table-wrap").innerHTML = "<div class='empty'>No matching kernels.</div>";
    return;
  }
  const maxTotal = rows[0].total_ns || 1;

  let html = `
    <table>
      <thead><tr>
        <th>Kernel</th><th>Count</th><th>Total</th><th>%</th>
        <th>Avg</th><th>Min</th><th>Max</th>
      </tr></thead><tbody>`;
  for (const r of rows) {
    const w = Math.max(2, Math.round((r.total_ns / maxTotal) * 160));
    html += `
      <tr>
        <td><span class="kernel-name" title="${escapeAttr(r.name)}">${escapeHtml(r.name)}</span></td>
        <td>${fmt.int(r.cnt)}</td>
        <td><span class="bar" style="width:${w}px"></span>${fmt.ns(r.total_ns)}</td>
        <td><span class="cell-pct">${fmt.pct(r.pct)}</span></td>
        <td>${fmt.ns(r.avg_ns)}</td>
        <td>${fmt.ns(r.min_ns)}</td>
        <td>${fmt.ns(r.max_ns)}</td>
      </tr>`;
  }
  html += "</tbody></table>";
  $("#single-table-wrap").innerHTML = html;
  wireExpandableNames($("#single-table-wrap"));
}

function renderCompare(data) {
  const files = data.files;
  const rows = filterBySearch(data.rows);
  renderCompareSummary(rows, files);
  $("#compare-meta").textContent = `${rows.length} rows · ${files.length} files · baseline = ${files[0]}`;
  if (rows.length === 0) {
    $("#compare-table-wrap").innerHTML = "<div class='empty'>No matching kernels.</div>";
    return;
  }
  const maxRow = rows[0].max_total || 1;

  let html = "<table><thead><tr><th>Kernel</th>";
  for (const f of files) html += `<th>${escapeHtml(f)}</th>`;
  if (files.length > 1) html += "<th>Δ vs baseline</th>";
  html += "</tr></thead><tbody>";

  for (const r of rows) {
    html += `<tr>
      <td><span class="kernel-name" title="${escapeAttr(r.name)}">${escapeHtml(r.name)}</span></td>`;
    const baseline = r.totals[0] || 0;
    for (let i = 0; i < files.length; i++) {
      const t = r.totals[i] || 0;
      const w = Math.max(0, Math.round((t / maxRow) * 140));
      let deltaClass = "";
      if (i > 0 && baseline > 0 && isDeltaSignificant(t - baseline, baseline)) {
        deltaClass = t > baseline ? "delta-up" : t < baseline ? "delta-down" : "";
      }
      html += `<td>
        <span class="bar ${deltaClass}" style="width:${w}px"></span>${fmt.ns(t)}
        <span class="cell-pct">×${r.counts[i] || 0}</span>
      </td>`;
    }
    if (files.length > 1) {
      const last = r.totals[files.length - 1] || 0;
      const delta = last - baseline;
      let label = "—";
      let cls = "";
      if (baseline <= 0 && last > 0) {
        cls = "up";
        label = "new";
      } else if (baseline > 0 && isDeltaSignificant(delta, baseline)) {
        const pct = (delta / baseline) * 100;
        cls = delta > 0 ? "up" : "down";
        label = `${delta > 0 ? "+" : ""}${pct.toFixed(1)}%`;
      }
      html += `<td><span class="delta ${cls}">${label}</span></td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  $("#compare-table-wrap").innerHTML = html;
  wireExpandableNames($("#compare-table-wrap"));
}

function wireExpandableNames(root) {
  root.querySelectorAll(".kernel-name").forEach((el) => {
    el.addEventListener("click", () => el.classList.toggle("expanded"));
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }

// Wire events
document.querySelectorAll(".seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.mode = b.dataset.mode;
    renderFileList();
    refresh();
  });
});
$("#reload-btn").addEventListener("click", loadFiles);
$("#group-by").addEventListener("change", (e) => { state.groupBy = e.target.value; refresh(); });
$("#limit").addEventListener("change", (e) => {
  const v = parseInt(e.target.value, 10);
  if (Number.isFinite(v) && v > 0) { state.limit = v; refresh(); }
});

let searchTimer = null;
$("#search").addEventListener("input", (e) => {
  const val = e.target.value.trim();
  validateRegexInput(e.target, val);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = val;
    refresh();
  }, 150);
});

$("#thresh-abs").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  state.thresholdAbs = Number.isFinite(v) && v > 0 ? v * 1000 : 0; // µs → ns
  refresh();
});
$("#thresh-rel").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  state.thresholdRel = Number.isFinite(v) && v > 0 ? v / 100 : 0; // % → fraction
  refresh();
});

loadFiles().catch((err) => {
  $("#single-table-wrap").innerHTML = `<div class='empty'>Load failed: ${escapeHtml(err.message)}</div>`;
});
