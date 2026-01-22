// inspection.js（フロント）
// Step1: /api/inspection にPOSTして日本語ExcelをDL

const $ = (id) => document.getElementById(id);

function getSelectedLabels() {
  const labels = [];
  if ($("lbl-li").checked) labels.push("リチウムイオン電池");
  if ($("lbl-law").checked) labels.push("法的対象(PSE/無線)");
  return labels;
}

function splitLines(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function setStatus(msg) {
  $("status").textContent = msg || "";
}

function showWarnings(warnings) {
  const box = $("warnBox");
  const list = $("warnList");
  list.innerHTML = "";

  if (!warnings || warnings.length === 0) {
    box.style.display = "none";
    return;
  }

  for (const w of warnings) {
    const li = document.createElement("li");
    li.textContent = w;
    list.appendChild(li);
  }
  box.style.display = "block";
}

function decodeWarningsFromHeader(res) {
  try {
    const raw = res.headers.get("x-warnings");
    if (!raw) return [];
    const json = decodeURIComponent(raw);
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function run() {
  const btn = $("run");
  btn.disabled = true;
  setStatus("生成中…");
  showWarnings([]);

  try {
    const payload = {
      selectedLabels: getSelectedLabels(),
      specText: splitLines($("spec").value),
      opText: splitLines($("op").value),
      accText: splitLines($("acc").value),
    };

    const res = await fetch("/api/inspection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const msg = j?.detail ? String(j.detail) : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const warnings = decodeWarningsFromHeader(res);
    showWarnings(warnings);

    const blob = await res.blob();

    const cd = res.headers.get("content-disposition") || "";
    const name = (() => {
      const m = cd.match(/filename\*\=UTF-8''([^;]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);
      return "検品リスト_日本語.xlsx";
    })();

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);

    setStatus("完了しました");
  } catch (e) {
    console.error(e);
    setStatus("エラーが発生しました");
    alert("生成に失敗しました。\n" + (e?.message ? e.message : String(e)));
  } finally {
    btn.disabled = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  $("run").addEventListener("click", run);
});
