// nsys-viewer frontend: vanilla JS, no build step.

const state = {
  mode: "single",          // "single" | "compare"
  files: [],               // [{name, size_bytes, mtime}]
  single: null,            // name of selected file
  compare: new Set(),      // names selected for compare
  groupBy: "short",
  limit: 50,
  search: "",
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

function renderFileList() {
  const ul = $("#file-list");
  ul.innerHTML = "";
  for (const f of state.files) {
    const li = document.createElement("li");
    li.className = "file-item";
    const isActive =
      state.mode === "single" ? state.single === f.name : state.compare.has(f.name);
    if (isActive) li.classList.add("active");

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
    li.appendChild(input);

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.name;
    li.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = fmt.bytes(f.size_bytes);
    li.appendChild(meta);

    li.addEventListener("click", (e) => {
      if (e.target === input) return;
      input.click();
    });
    ul.appendChild(li);
  }
}

async function refresh() {
  if (state.mode === "single") {
    $("#single-pane").classList.remove("hidden");
    $("#compare-pane").classList.add("hidden");
    if (!state.single) {
      renderCards([]);
      $("#single-table-wrap").innerHTML = "<div class='empty'>No file selected.</div>";
      return;
    }
    const [ov, ks] = await Promise.all([
      fetchJSON(`/api/overview?file=${encodeURIComponent(state.single)}`),
      fetchJSON(
        `/api/kernels?file=${encodeURIComponent(state.single)}&group_by=${state.groupBy}&limit=${state.limit}`,
      ),
    ]);
    renderCards([ov]);
    renderSingle(ks);
  } else {
    $("#single-pane").classList.add("hidden");
    $("#compare-pane").classList.remove("hidden");
    const files = [...state.compare];
    if (files.length === 0) {
      renderCards([]);
      $("#compare-table-wrap").innerHTML = "<div class='empty'>Select 1+ files.</div>";
      return;
    }
    const ovs = await Promise.all(
      files.map((f) => fetchJSON(`/api/overview?file=${encodeURIComponent(f)}`)),
    );
    renderCards(ovs);
    const data = await fetchJSON(
      `/api/compare?files=${files.map(encodeURIComponent).join(",")}&group_by=${state.groupBy}&limit=${state.limit}`,
    );
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
  const q = state.search.toLowerCase();
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

function renderSingle(data) {
  const rows = filterBySearch(data.rows);
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
      const deltaClass =
        i > 0 && baseline ? (t > baseline ? "delta-up" : t < baseline ? "delta-down" : "") : "";
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
      if (baseline > 0) {
        const pct = (delta / baseline) * 100;
        cls = delta > 0 ? "up" : delta < 0 ? "down" : "";
        const sign = delta > 0 ? "+" : "";
        label = `${sign}${pct.toFixed(1)}%`;
      } else if (last > 0) {
        cls = "up";
        label = "new";
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
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    refresh();
  }, 150);
});

loadFiles().catch((err) => {
  $("#single-table-wrap").innerHTML = `<div class='empty'>Load failed: ${escapeHtml(err.message)}</div>`;
});
