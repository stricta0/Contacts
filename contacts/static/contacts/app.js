(function () {
  "use strict";

  /**
   * Contacts UI (table + add/edit modal + delete confirm + CSV import modal)
   * - Loads statuses (for dropdown + badge colors)
   * - Loads contacts (with weather info provided by backend)
   * - Search filter, column sorting
   * - Add contact (POST), Edit contact (PUT), Delete contact (DELETE)
   * - Import CSV (POST multipart)
   */

  // =========================
  // Constants / state
  // =========================

  const STATUS_COLORS = [
    "#34D399", // green
    "#FBBF24", // amber
    "#F97316", // orange
    "#ff0000", // red
    "#5B8CFF", // blue
    "#6EE7B7", // mint
    "#F472B6", // pink
    "#A78BFA", // purple
    "#22D3EE", // cyan
    "#FB7185", // rose
    "#94A3B8", // slate
  ];

  /** @type {{id:number,name:string,description:string}[]} */
  let statuses = [];
  /** @type {Map<string,string>} name(lower) -> color */
  let statusColorByName = new Map();

  /** @type {any[]} */
  let contactsCache = [];

  const statusIdToName = new Map(); // id -> name
  const statusNameToId = new Map(); // name(lower) -> id

  let sortKey = null; // e.g. "email"
  let sortDir = null; // "asc" | "desc" | null

  // =========================
  // DOM refs (single place)
  // =========================

  const $ = (sel, root = document) => root.querySelector(sel);

  const dom = {
    // table/search
    input: $("#searchInput"),
    tbody: $("#contactsTbody"),

    // header sort buttons
    headerButtons: Array.from(document.querySelectorAll(".th-btn")),

    // add/edit modal
    btnAddNew: $("#btnAddNew"),
    addModal: $("#addModal"),
    addForm: $("#addContactForm"),
    btnSubmitAdd: $("#btnSubmitAdd"),
    btnCancelAdd: $("#btnCancelAdd"),
    btnClearAdd: $("#btnClearAdd"),
    addFormError: $("#addFormError"),
    addFormSuccess: $("#addFormSuccess"),
    statusSelect: $("#status"),
    btnDeleteContact: $("#btnDeleteContact"),

    // delete confirm modal
    confirmDeleteModal: $("#confirmDeleteModal"),
    confirmDeleteName: $("#confirmDeleteName"),
    confirmDeleteError: $("#confirmDeleteError"),
    btnConfirmDelete: $("#btnConfirmDelete"),
    btnConfirmDeleteCancel: $("#btnConfirmDeleteCancel"),

    // import CSV modal
    btnImportCsv: $("#btnImportCsv"),
    importCsvModal: $("#importCsvModal"),
    csvDropzone: $("#csvDropzone"),
    csvFileInput: $("#csvFileInput"),
    csvSelectedFile: $("#csvSelectedFile"),
    btnImportCancel: $("#btnImportCancel"),
    btnImportClear: $("#btnImportClear"),
    btnImportStart: $("#btnImportStart"),
    importFormError: $("#importFormError"),
    importResults: $("#importResults"),
    importResultsMeta: $("#importResultsMeta"),
    importLog: $("#importLog"),
  };

  let selectedCsvFile = null;

  // =========================
  // Utils (pure helpers)
  // =========================

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function truncateText(str, maxLen = 25) {
    const s = String(str ?? "");
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 3) + "...";
  }

  function formatDate(iso) {
    return iso ? String(iso).slice(0, 10) : "";
  }

  function safeLower(x) {
    return String(x ?? "").toLowerCase();
  }

  function apiErrorToMessage(data, res) {
    if (!data) return `HTTP ${res?.status ?? ""}`.trim();

    // Old backend format (kept for compatibility)
    if (data.error === "Missing required fields" && Array.isArray(data.missing)) {
      return `Missing: ${data.missing.join(", ")}`;
    }
    if (data.error === "Validation error" && data.details && typeof data.details === "object") {
      const parts = [];
      for (const [field, msgs] of Object.entries(data.details)) {
        const msg = Array.isArray(msgs) ? msgs.join(", ") : String(msgs);
        parts.push(`${field}: ${msg}`);
      }
      return parts.join(" | ");
    }

    // New backend format (most common now): error is already human readable
    if (typeof data.error === "string" && data.error.trim()) {
      return data.error;
    }

    return `HTTP ${res?.status ?? ""}`.trim();
  }

  function weatherInline(weather) {
    if (!weather || typeof weather !== "object") return "";
    if (weather.error) return "";

    const t = weather.temperature?.text;
    const h = weather.humidity?.text;
    const w = weather.wind?.text;

    const parts = [t, h, w].filter(Boolean);
    return parts.length ? parts.map(escapeHtml).join(" · ") : "";
  }

  function statusBadge(status) {
    const raw = String(status ?? "");
    const key = raw.toLowerCase();
    const color = statusColorByName.get(key);

    if (color) {
      return `<span class="badge dynamic" style="--status-color:${escapeHtml(color)}">${escapeHtml(raw)}</span>`;
    }
    return `<span class="badge">${escapeHtml(raw)}</span>`;
  }

  // =========================
  // Sorting
  // =========================

  function getSortValue(c, key) {
    switch (key) {
      case "id":
        return Number(c.id ?? 0);
      case "name":
        return safeLower(c.first_name);
      case "last_name":
        return safeLower(c.last_name);
      case "email":
        return safeLower(c.email);
      case "phone":
        return safeLower(c.phone);
      case "city":
        return safeLower(c.city);
      case "status":
        return safeLower(c.status);
      case "add_date":
        return c.created_at ? Date.parse(c.created_at) : 0;
      default:
        return safeLower(c[key]);
    }
  }

  function sortContacts(items, key, dir) {
    const sign = dir === "asc" ? 1 : -1;

    // stable sort: keep original index as tiebreaker
    return items
      .map((x, idx) => ({ x, idx }))
      .sort((a, b) => {
        const va = getSortValue(a.x, key);
        const vb = getSortValue(b.x, key);
        if (va < vb) return -1 * sign;
        if (va > vb) return 1 * sign;
        return a.idx - b.idx;
      })
      .map((p) => p.x);
  }

  function applySortAndRender() {
    const items = Array.isArray(contactsCache) ? contactsCache.slice() : [];
    const sorted = sortKey && sortDir ? sortContacts(items, sortKey, sortDir) : items;
    renderRows(sorted);
  }

  function initSortableHeaders() {
    const { headerButtons } = dom;

    const setButtonState = (btn, state) => {
      const arrow = btn.querySelector(".th-arrow");
      btn.dataset.sortState = state ?? "none";

      if (!state) {
        btn.classList.remove("is-active");
        btn.setAttribute("aria-pressed", "false");
        if (arrow) arrow.textContent = "↓";
        return;
      }

      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
      if (arrow) arrow.textContent = state === "asc" ? "↑" : "↓";
    };

    const resetAllExcept = (activeBtn) => {
      for (const btn of headerButtons) {
        if (btn !== activeBtn) setButtonState(btn, null);
      }
    };

    const nextState = (current) => {
      if (current === "asc") return "desc";
      if (current === "desc") return null;
      return "asc";
    };

    for (const btn of headerButtons) {
      setButtonState(btn, null);

      btn.addEventListener("click", () => {
        resetAllExcept(btn);

        const current = btn.dataset.sortState;
        const curNormalized = current === "none" ? null : current;
        const state = nextState(curNormalized);

        setButtonState(btn, state);

        sortKey = state ? btn.dataset.sortKey : null;
        sortDir = state;

        applySortAndRender();
      });
    }
  }

  // =========================
  // Rendering
  // =========================

  function renderRows(items) {
    if (!dom.tbody) return;

    dom.tbody.innerHTML = items
      .map((c) => {
        const id = c.id;

        const firstNameFull = String(c.first_name ?? "");
        const lastNameFull = String(c.last_name ?? "");
        const emailFull = String(c.email ?? "");
        const phoneFull = String(c.phone ?? "");
        const cityFull = String(c.city ?? "");

        const firstName = truncateText(firstNameFull, 20);
        const lastName = truncateText(lastNameFull, 20);
        const email = truncateText(emailFull, 28);
        const phone = truncateText(phoneFull, 30);
        const city = truncateText(cityFull, 20);

        const weatherTxt = weatherInline(c.weather);
        const weatherTrunc = truncateText(weatherTxt, 30);

        return `
          <tr class="row-click" data-id="${escapeHtml(id)}">
            <td class="mono" title="${escapeHtml(String(id))}">${escapeHtml(id)}</td>

            <td class="truncate" title="${escapeHtml(firstNameFull)}">${escapeHtml(firstName)}</td>
            <td class="truncate" title="${escapeHtml(lastNameFull)}">${escapeHtml(lastName)}</td>

            <td class="truncate mono" title="${escapeHtml(emailFull)}">${escapeHtml(email)}</td>
            <td class="truncate mono" title="${escapeHtml(phoneFull)}">${escapeHtml(phone)}</td>

            <td>
              <div class="cell-city">
                <div class="city-name truncate" title="${escapeHtml(cityFull)}">${escapeHtml(city)}</div>
                ${
                  weatherTxt
                    ? `<div class="city-weather truncate" title="${escapeHtml(weatherTxt)}">${escapeHtml(
                        weatherTrunc
                      )}</div>`
                    : ""
                }
              </div>
            </td>

            <td>${statusBadge(c.status)}</td>
            <td class="mono" title="${escapeHtml(formatDate(c.created_at))}">${escapeHtml(
              formatDate(c.created_at)
            )}</td>
          </tr>
        `.trim();
      })
      .join("");
  }

  // =========================
  // API calls
  // =========================

  async function loadContacts() {
    if (!dom.tbody) return;

    dom.tbody.innerHTML = `
      <tr>
        <td colspan="8" style="padding:16px; color: rgba(154,164,178,0.92);">Loading...</td>
      </tr>
    `;

    try {
      const res = await fetch("/api/contacts/", {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok !== true) {
        const msg = (data && (data.error || JSON.stringify(data))) || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      contactsCache = data.items || [];
      applySortAndRender();
    } catch (err) {
      dom.tbody.innerHTML = `
        <tr>
          <td colspan="8" style="padding:16px; color: rgba(239,68,68,0.95);">
            Failed to load contacts: ${escapeHtml(err.message || err)}
          </td>
        </tr>
      `;
    }
  }

  async function loadStatuses() {
    const res = await fetch("/api/contacts/statuses/", {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      const msg = (data && (data.error || JSON.stringify(data))) || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    statuses = data.items || [];

    // maps: id <-> name
    statusIdToName.clear();
    statusNameToId.clear();

    for (const s of statuses) {
      statusIdToName.set(Number(s.id), String(s.name));
      statusNameToId.set(String(s.name).toLowerCase(), Number(s.id));
    }

    // name -> color (stable by API order)
    statusColorByName = new Map();
    for (let i = 0; i < statuses.length; i++) {
      const name = String(statuses[i].name || "").toLowerCase();
      const color = STATUS_COLORS[i % STATUS_COLORS.length];
      if (name) statusColorByName.set(name, color);
    }
  }

  // =========================
  // Add/Edit modal
  // =========================

  function setModalMode(mode, editId = "") {
    const { addModal, btnSubmitAdd, addFormError, addFormSuccess, btnDeleteContact } = dom;
    if (!addModal) return;

    addModal.dataset.mode = mode;
    addModal.dataset.editId = editId ? String(editId) : "";

    const title = $("#addModalTitle");
    if (title) title.textContent = mode === "edit" ? "Edit contact" : "Add new contact";
    if (btnSubmitAdd) btnSubmitAdd.textContent = mode === "edit" ? "Edit" : "Add";

    if (addFormError) addFormError.textContent = "";
    if (addFormSuccess) addFormSuccess.textContent = "";
    if (btnDeleteContact) btnDeleteContact.style.display = mode === "edit" ? "" : "none";
  }

  function openModal() {
    if (!dom.addModal) return;
    dom.addModal.classList.add("is-open");
    dom.addModal.setAttribute("aria-hidden", "false");

    // focus first input
    const first = dom.addForm?.querySelector("input, select, textarea, button");
    if (first) first.focus();
  }

  function closeModal() {
    if (!dom.addModal) return;
    dom.addModal.classList.remove("is-open");
    dom.addModal.setAttribute("aria-hidden", "true");
    if (dom.addFormError) dom.addFormError.textContent = "";
  }

  function clearForm() {
    if (!dom.addForm) return;
    dom.addForm.reset();

    const status = dom.addForm.querySelector('select[name="status_name"]');
    if (status) status.value = "";

    if (dom.addFormError) dom.addFormError.textContent = "";
    if (dom.addFormSuccess) dom.addFormSuccess.textContent = "";

    // remove dynamic status styling
    updateStatusSelectStyle(true);
  }

  function validateForm() {
    if (!dom.addForm) return { ok: false, message: "Form not found" };

    const fd = new FormData(dom.addForm);
    const first_name = String(fd.get("first_name") || "").trim();
    const last_name = String(fd.get("last_name") || "").trim();
    const email = String(fd.get("email") || "").trim();
    const phone = String(fd.get("phone") || "").trim();
    const city = String(fd.get("city") || "").trim();
    const status_name = String(fd.get("status_name") || "").trim();

    const missing = [];
    if (!first_name) missing.push("first name");
    if (!last_name) missing.push("last name");
    if (!email) missing.push("email");
    if (!phone) missing.push("phone");
    if (!city) missing.push("city");
    if (!status_name) missing.push("status");

    if (missing.length) return { ok: false, message: `Missing: ${missing.join(", ")}` };

    return { ok: true, payload: { first_name, last_name, email, phone, city, status_name } };
  }

  function fillFormFromContact(c) {
    if (!dom.addForm) return;

    dom.addForm.querySelector('input[name="first_name"]').value = c.first_name ?? "";
    dom.addForm.querySelector('input[name="last_name"]').value = c.last_name ?? "";
    dom.addForm.querySelector('input[name="email"]').value = c.email ?? "";
    dom.addForm.querySelector('input[name="phone"]').value = c.phone ?? "";
    dom.addForm.querySelector('input[name="city"]').value = c.city ?? "";

    const statusEl = dom.addForm.querySelector('select[name="status_name"]');
    if (!statusEl) return;

    // Prefer status_id if present
    if (c.status_id != null) {
      const name = statusIdToName.get(Number(c.status_id));
      if (name) statusEl.value = name;
    } else {
      statusEl.value = String(c.status ?? "").toLowerCase();
    }

    updateStatusSelectStyle();
  }

  function openEditModal(contact) {
    clearForm();
    setModalMode("edit", contact.id);
    fillFormFromContact(contact);
    openModal();
  }

  function updateStatusSelectStyle(forceClear = false) {
    const el = dom.statusSelect;
    if (!el) return;

    el.classList.remove("dynamic-status");
    el.style.removeProperty("--status-color");

    if (forceClear) return;

    const v = String(el.value || "").toLowerCase();
    const color = statusColorByName.get(v);
    if (!color) return;

    el.classList.add("dynamic-status");
    el.style.setProperty("--status-color", color);
  }

  async function submitAddOrEdit() {
    const { btnSubmitAdd, addFormError, addFormSuccess, addModal } = dom;

    const v = validateForm();
    if (!v.ok) {
      if (addFormError) addFormError.textContent = v.message;
      if (addFormSuccess) addFormSuccess.textContent = "";
      return;
    }

    const mode = addModal?.dataset.mode || "add";
    const editId = addModal?.dataset.editId ? Number(addModal.dataset.editId) : null;

    // map status_name -> status_id
    const statusName = String(v.payload.status_name || "").toLowerCase();
    const status_id = statusNameToId.get(statusName);
    if (!status_id) {
      if (addFormError) addFormError.textContent = "Invalid status selected";
      if (addFormSuccess) addFormSuccess.textContent = "";
      return;
    }

    const payload = {
      first_name: v.payload.first_name,
      last_name: v.payload.last_name,
      email: v.payload.email,
      phone: v.payload.phone,
      city: v.payload.city,
      status_id,
    };

    if (addFormError) addFormError.textContent = "";
    if (addFormSuccess) addFormSuccess.textContent = "";

    if (btnSubmitAdd) {
      btnSubmitAdd.disabled = true;
      const prevText = btnSubmitAdd.textContent;
      btnSubmitAdd.textContent = mode === "edit" ? "Saving..." : "Adding...";

      try {
        const url = mode === "edit" ? `/api/contacts/${editId}/` : "/api/contacts/";
        const method = mode === "edit" ? "PUT" : "POST";

        const res = await fetch(url, {
          method,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await res.json().catch(() => null);
        if (!data || data.ok !== true) throw new Error(apiErrorToMessage(data, res));

        if (addFormSuccess) addFormSuccess.textContent = mode === "edit" ? "Contact updated ✅" : "Contact added ✅";

        await loadContacts();

        if (mode === "add") {
          clearForm();
          if (addFormSuccess) addFormSuccess.textContent = "Contact added ✅";
          updateStatusSelectStyle();
          const first = dom.addForm?.querySelector('input[name="first_name"]');
          if (first) first.focus();
        }
      } catch (err) {
        if (addFormSuccess) addFormSuccess.textContent = "";
        if (addFormError) addFormError.textContent = err?.message || String(err);
      } finally {
        btnSubmitAdd.disabled = false;
        btnSubmitAdd.textContent = prevText;
      }
    }
  }

  // =========================
  // Delete confirm modal
  // =========================

  function openConfirmDelete(contact) {
    const { confirmDeleteModal, confirmDeleteName, confirmDeleteError, btnConfirmDelete } = dom;
    if (!confirmDeleteModal) return;

    confirmDeleteModal.classList.add("is-open");
    confirmDeleteModal.setAttribute("aria-hidden", "false");

    if (confirmDeleteError) confirmDeleteError.textContent = "";

    const label = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || `#${contact.id}`;
    if (confirmDeleteName) confirmDeleteName.textContent = label;

    confirmDeleteModal.dataset.deleteId = String(contact.id);
    if (btnConfirmDelete) btnConfirmDelete.focus();
  }

  function closeConfirmDelete() {
    const { confirmDeleteModal, confirmDeleteError } = dom;
    if (!confirmDeleteModal) return;

    confirmDeleteModal.classList.remove("is-open");
    confirmDeleteModal.setAttribute("aria-hidden", "true");
    confirmDeleteModal.dataset.deleteId = "";
    if (confirmDeleteError) confirmDeleteError.textContent = "";
  }

  async function confirmDelete() {
    const { confirmDeleteModal, btnConfirmDelete, confirmDeleteError } = dom;

    const idStr = confirmDeleteModal?.dataset.deleteId;
    const id = idStr ? Number(idStr) : null;
    if (!id) return;

    if (btnConfirmDelete) {
      btnConfirmDelete.disabled = true;
      const prev = btnConfirmDelete.textContent;
      btnConfirmDelete.textContent = "Deleting...";

      try {
        const res = await fetch(`/api/contacts/${id}/`, {
          method: "DELETE",
          headers: { Accept: "application/json" },
        });

        const data = await res.json().catch(() => null);
        if (!data || data.ok !== true) throw new Error(apiErrorToMessage(data, res));

        closeConfirmDelete();
        closeModal();
        await loadContacts();
      } catch (err) {
        if (confirmDeleteError) confirmDeleteError.textContent = err?.message || String(err);
      } finally {
        btnConfirmDelete.disabled = false;
        btnConfirmDelete.textContent = prev;
      }
    }
  }

  // =========================
  // Import CSV modal
  // =========================

  function openImportModal() {
    if (!dom.importCsvModal) return;

    dom.importCsvModal.classList.add("is-open");
    dom.importCsvModal.setAttribute("aria-hidden", "false");

    if (dom.importFormError) dom.importFormError.textContent = "";
    if (dom.importResults) dom.importResults.style.display = "none";
    if (dom.importLog) dom.importLog.innerHTML = "";
    if (dom.importResultsMeta) dom.importResultsMeta.textContent = "OK: 0 · ERROR: 0";
  }

  function closeImportModal() {
    if (!dom.importCsvModal) return;
    dom.importCsvModal.classList.remove("is-open");
    dom.importCsvModal.setAttribute("aria-hidden", "true");
    if (dom.importFormError) dom.importFormError.textContent = "";
  }

  function clearImportState() {
    selectedCsvFile = null;

    if (dom.csvFileInput) dom.csvFileInput.value = "";
    if (dom.csvSelectedFile) dom.csvSelectedFile.textContent = "No file selected";
    if (dom.btnImportStart) dom.btnImportStart.disabled = true;

    if (dom.importFormError) dom.importFormError.textContent = "";
    if (dom.importResults) dom.importResults.style.display = "none";
    if (dom.importLog) dom.importLog.innerHTML = "";
    if (dom.importResultsMeta) dom.importResultsMeta.textContent = "OK: 0 · ERROR: 0";
  }

  function isCsvFile(file) {
    if (!file) return false;
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".csv")) return true;
    const type = (file.type || "").toLowerCase();
    return type === "text/csv" || type.includes("csv");
  }

  function setSelectedCsvFile(file) {
    selectedCsvFile = file || null;

    if (!selectedCsvFile) {
      if (dom.csvSelectedFile) dom.csvSelectedFile.textContent = "No file selected";
      if (dom.btnImportStart) dom.btnImportStart.disabled = true;
      return;
    }

    if (dom.csvSelectedFile) {
      dom.csvSelectedFile.textContent = `${selectedCsvFile.name} (${Math.round(selectedCsvFile.size / 1024)} KB)`;
    }
    if (dom.btnImportStart) dom.btnImportStart.disabled = false;
  }

  function renderImportLogs(apiData) {
    const { importResults, importLog, importResultsMeta } = dom;
    if (!importResults || !importLog || !importResultsMeta) return;

    importResults.style.display = "";
    importLog.innerHTML = "";

    const summary = apiData?.summary || {};
    const okCount = Number(summary.ok_count ?? 0);
    const errCount = Number(summary.error_count ?? 0);
    importResultsMeta.textContent = `OK: ${okCount} · ERROR: ${errCount}`;

    const lines = Array.isArray(apiData?.lines) ? apiData.lines : [];
    if (!lines.length) {
      importLog.innerHTML = `
        <div class="log-line">
          <div class="log-n">INFO</div>
          <div class="log-msg">
            <span class="log-ok">Uploaded:</span>
            ${escapeHtml(apiData?.filename || "file")} (${escapeHtml(apiData?.size || "")} bytes)
          </div>
        </div>
      `.trim();
      return;
    }

    importLog.innerHTML = lines
      .map((x) => {
        const n = x.line != null ? `#${x.line}` : "#?";
        const ok = !!x.ok;
        const msg = x.message || x.error || "";
        return `
          <div class="log-line">
            <div class="log-n">${escapeHtml(n)}</div>
            <div class="log-msg">
              <span class="${ok ? "log-ok" : "log-err"}">${ok ? "OK" : "ERROR"}</span>
              ${escapeHtml(msg)}
            </div>
          </div>
        `.trim();
      })
      .join("");
  }

  async function uploadCsv() {
    if (!selectedCsvFile) {
      if (dom.importFormError) dom.importFormError.textContent = "No file selected.";
      return;
    }
    if (!isCsvFile(selectedCsvFile)) {
      if (dom.importFormError) dom.importFormError.textContent = "Please select a CSV file (.csv).";
      return;
    }

    if (dom.importFormError) dom.importFormError.textContent = "";

    if (dom.btnImportStart) {
      dom.btnImportStart.disabled = true;
      const prev = dom.btnImportStart.textContent;
      dom.btnImportStart.textContent = "Uploading...";

      try {
        const fd = new FormData();
        fd.append("file", selectedCsvFile);

        const res = await fetch("/api/contacts/import-csv/", {
          method: "POST",
          body: fd,
        });

        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.ok !== true) throw new Error(apiErrorToMessage(data, res));

        renderImportLogs(data);
        await loadContacts();
      } catch (err) {
        if (dom.importResults) dom.importResults.style.display = "none";
        if (dom.importFormError) dom.importFormError.textContent = err?.message || String(err);
      } finally {
        dom.btnImportStart.disabled = false;
        dom.btnImportStart.textContent = prev;
      }
    }
  }

  // =========================
  // Event wiring
  // =========================

  function initSearchFilter() {
    if (!dom.input || !dom.tbody) return;

    dom.input.addEventListener("input", () => {
      const q = dom.input.value.trim().toLowerCase();
      for (const row of dom.tbody.querySelectorAll("tr")) {
        const text = row.innerText.toLowerCase();
        row.style.display = text.includes(q) ? "" : "none";
      }
    });
  }

  function initAddEditModalEvents() {
    // Open modal (add)
    if (dom.btnAddNew) {
      dom.btnAddNew.addEventListener("click", () => {
        clearForm();
        setModalMode("add", "");
        updateStatusSelectStyle();
        openModal();
      });
    }

    // Close modal on backdrop
    if (dom.addModal) {
      dom.addModal.addEventListener("click", (e) => {
        const t = e.target;
        if (t && (t.matches("[data-close-modal]") || t.closest("[data-close-modal]"))) closeModal();
      });
    }

    // Cancel/Clear
    if (dom.btnCancelAdd) dom.btnCancelAdd.addEventListener("click", closeModal);
    if (dom.btnClearAdd) dom.btnClearAdd.addEventListener("click", clearForm);

    // Submit add/edit
    if (dom.btnSubmitAdd) dom.btnSubmitAdd.addEventListener("click", submitAddOrEdit);

    // Status change -> dynamic styling
    if (dom.statusSelect) dom.statusSelect.addEventListener("change", () => updateStatusSelectStyle());
  }

  function initRowClickToEdit() {
    if (!dom.tbody) return;

    dom.tbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;

      const id = Number(tr.dataset.id);
      const c = contactsCache.find((x) => Number(x.id) === id);
      if (c) openEditModal(c);
    });
  }

  function initDeleteFlow() {
    // Open confirm from main modal
    if (dom.btnDeleteContact) {
      dom.btnDeleteContact.addEventListener("click", () => {
        const mode = dom.addModal?.dataset.mode || "add";
        const editId = dom.addModal?.dataset.editId ? Number(dom.addModal.dataset.editId) : null;
        if (mode !== "edit" || !editId) return;

        const c = contactsCache.find((x) => Number(x.id) === editId);
        if (c) openConfirmDelete(c);
      });
    }

    // Close confirm on backdrop
    if (dom.confirmDeleteModal) {
      dom.confirmDeleteModal.addEventListener("click", (e) => {
        const t = e.target;
        if (t && (t.matches("[data-close-confirm]") || t.closest("[data-close-confirm]"))) closeConfirmDelete();
      });
    }

    // Cancel confirm
    if (dom.btnConfirmDeleteCancel) dom.btnConfirmDeleteCancel.addEventListener("click", closeConfirmDelete);

    // Confirm delete
    if (dom.btnConfirmDelete) dom.btnConfirmDelete.addEventListener("click", confirmDelete);
  }

  function initImportCsvFlow() {
    // Open import modal
    if (dom.btnImportCsv) {
      dom.btnImportCsv.addEventListener("click", () => {
        clearImportState();
        openImportModal();
        dom.csvDropzone?.focus();
      });
    }

    // Close import on backdrop
    if (dom.importCsvModal) {
      dom.importCsvModal.addEventListener("click", (e) => {
        const t = e.target;
        if (t && (t.matches("[data-close-import]") || t.closest("[data-close-import]"))) closeImportModal();
      });
    }

    // Cancel/Clear
    if (dom.btnImportCancel) dom.btnImportCancel.addEventListener("click", closeImportModal);
    if (dom.btnImportClear) dom.btnImportClear.addEventListener("click", clearImportState);

    // Dropzone: click/keyboard -> open file picker
    if (dom.csvDropzone && dom.csvFileInput) {
      dom.csvDropzone.addEventListener("click", () => dom.csvFileInput.click());
      dom.csvDropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          dom.csvFileInput.click();
        }
      });

      // drag & drop
      dom.csvDropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dom.csvDropzone.classList.add("is-dragover");
      });
      dom.csvDropzone.addEventListener("dragleave", () => dom.csvDropzone.classList.remove("is-dragover"));
      dom.csvDropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dom.csvDropzone.classList.remove("is-dragover");

        const file = e.dataTransfer?.files?.[0] || null;
        if (!file) return;

        if (!isCsvFile(file)) {
          if (dom.importFormError) dom.importFormError.textContent = "Please select a CSV file (.csv).";
          setSelectedCsvFile(null);
          return;
        }
        if (dom.importFormError) dom.importFormError.textContent = "";
        setSelectedCsvFile(file);
      });

      // file picker selection
      dom.csvFileInput.addEventListener("change", () => {
        const file = dom.csvFileInput.files?.[0] || null;
        if (!file) return setSelectedCsvFile(null);

        if (!isCsvFile(file)) {
          if (dom.importFormError) dom.importFormError.textContent = "Please select a CSV file (.csv).";
          return setSelectedCsvFile(null);
        }

        if (dom.importFormError) dom.importFormError.textContent = "";
        setSelectedCsvFile(file);
      });
    }

    // Upload
    if (dom.btnImportStart) dom.btnImportStart.addEventListener("click", uploadCsv);
  }

  function initEscapeKey() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;

      if (dom.addModal?.classList.contains("is-open")) closeModal();
      if (dom.confirmDeleteModal?.classList.contains("is-open")) closeConfirmDelete();
      if (dom.importCsvModal?.classList.contains("is-open")) closeImportModal();
    });
  }

  // =========================
  // Status dropdown
  // =========================

  function populateStatusSelect() {
    if (!dom.statusSelect) return;

    dom.statusSelect.innerHTML = `<option value="" selected disabled>Choose status...</option>`;

    for (const s of statuses) {
      const opt = document.createElement("option");
      opt.value = s.name;
      opt.textContent = s.name;
      dom.statusSelect.appendChild(opt);
    }
  }

  // =========================
  // Init
  // =========================

  async function init() {
    initSearchFilter();
    initSortableHeaders();
    initAddEditModalEvents();
    initRowClickToEdit();
    initDeleteFlow();
    initImportCsvFlow();
    initEscapeKey();

    // Hide delete by default (only visible in edit mode)
    if (dom.btnDeleteContact) dom.btnDeleteContact.style.display = "none";

    // Load statuses first (colors + dropdown), then contacts
    try {
      await loadStatuses();
      populateStatusSelect();
    } catch (e) {
      console.warn("Failed to load statuses:", e);
    }

    await loadContacts();
  }

  document.addEventListener("DOMContentLoaded", init);
})();