const SHEET_NAMES = {
  pharmacies: "بيانات الصيداليات",
  inventory: "الاصناف والكميات",
  supply: "طلبات التوريد",
};

const API_BASE = (window.DAWAEY_API_BASE ?? ((location.hostname === "localhost" || location.hostname === "127.0.0.1") ? "" : "https://dawaey-cilkquad.manus.space")).replace(/\/+$/, "");
const apiUrl = (path) => `${API_BASE}/api/${path}`;

const sectionNames = {
  overview: "نظرة عامة",
  inventory: "الأدوية والمخزون",
  pharmacies: "دليل الصيدليات",
  supply: "التوريد",
  donations: "طلبات التبرع",
  reports: "تقارير الاستهلاك الشهري",
};

const state = {
  data: null,
  view: "overview",
  inventoryQuery: "",
  inventoryCategory: "الكل",
  inventoryFilter: "الكل",
  inventoryPage: 0,
  pharmacyQuery: "",
  supplyQuery: "",
  toastTimer: null,
  alertSignature: "",
  alertTimer: null,
};

const numberFormat = new Intl.NumberFormat("ar-EG");
const dateFormat = new Intl.DateTimeFormat("ar-EG", { weekday: "long", day: "numeric", month: "long" });
const pageSize = 10;
const medicineAliases = new Map([["بنادول", "panadol"], ["بانادول", "panadol"], ["كتافلام", "cataflam"], ["كاتافلام", "cataflam"], ["بروفين", "brufen"], ["فولتارين", "voltaren"], ["أدول", "adol"], ["ادول", "adol"], ["اوجمنتين", "augmentin"], ["أوجمنتين", "augmentin"], ["كونجستال", "congestal"], ["فلاجيل", "flagyl"], ["موتيليوم", "motilium"], ["نيروفين", "nurofen"]]);
function normalizeSearch(value) { return String(value ?? "").toLocaleLowerCase("ar-EG").normalize("NFD").replace(/[\u064B-\u065F\u0670]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").trim(); }
const content = document.querySelector("#page-content");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatNumber(value) {
  const numericValue = Number(value);
  return numberFormat.format(Number.isFinite(numericValue) ? numericValue : 0);
}

function numericValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getSheets() {
  return state.data?.sheets ?? {};
}

function getInventory() {
  return getSheets()[SHEET_NAMES.inventory] ?? [];
}

function getSupply() {
  return getSheets()[SHEET_NAMES.supply] ?? [];
}

function getPharmacies() {
  const unique = new Map();
  for (const pharmacy of getSheets()[SHEET_NAMES.pharmacies] ?? []) {
    const key = [pharmacy["اسم الصيدلية"], pharmacy["المنطقة / العنوان المتوقع"], pharmacy["رقم التليفون / الخط الساخن"]].join("|");
    if (!unique.has(key)) unique.set(key, pharmacy);
  }
  return [...unique.values()];
}

function getPharmacyGroups() {
  const groups = new Map();
  for (const pharmacy of getPharmacies()) {
    const name = pharmacy["اسم الصيدلية"];
    if (!groups.has(name)) groups.set(name, { name, records: [] });
    groups.get(name).records.push(pharmacy);
  }
  return [...groups.values()];
}

function getSupplyByNumber() {
  return new Map(getSupply().map((record) => [String(record["م"]), record]));
}

function getStockState(record) {
  const quantity = numericValue(record["الكمية الحالية"] ?? record["الكمية"]);
  const minimum = numericValue(record["الحد الأدنى"]);
  const sourceStatus = String(record["حالة المخزون"] ?? "");
  if (quantity <= 0 || sourceStatus.includes("غير متاح") || sourceStatus.includes("نفد")) return "out";
  if (quantity <= minimum || sourceStatus.includes("منخفض") || sourceStatus.includes("قليل")) return "low";
  return "available";
}

function stockLabel(stockState) {
  return stockState === "out" ? "غير متاح" : stockState === "low" ? "قارب على النفاد" : "متاح";
}

function statusMarkup(stockState) {
  return `<span class="status-pill ${stockState === "low" ? "low" : stockState === "out" ? "out" : ""}">${stockLabel(stockState)}</span>`;
}

function pageHeading(title, description, eyebrow = "مساحة دوائي") {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div></div>`;
}

function searchIcon() {
  return '<svg class="search-symbol" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 4.5 4.5"/></svg>';
}

function statCard(label, value, caption, glyph, tone = "") {
  return `<article class="stat-card ${tone}"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-glyph" aria-hidden="true">${glyph}</span></div><div class="stat-value">${value}</div><div class="stat-caption">${caption}</div></article>`;
}

function getCategoryCounts() {
  const categories = new Map();
  for (const record of getSupply()) {
    const category = record["طبيعة الدواء"] || "غير مصنف";
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  return [...categories.entries()].sort((left, right) => right[1] - left[1]);
}

function renderOverview() {
  const inventory = getInventory();
  const pharmacyRecords = getPharmacies();
  const pharmacies = getPharmacyGroups();
  const supply = getSupply();
  const availableCount = supply.filter((record) => getStockState(record) === "available").length;
  const reorderCount = supply.filter((record) => getStockState(record) !== "available").length;
  const safeCount = supply.filter((record) => getStockState(record) === "available").length;
  const warningCount = supply.filter((record) => getStockState(record) === "low").length;
  const dangerCount = supply.filter((record) => getStockState(record) === "out").length;
  const warningNames = supply.filter((record) => getStockState(record) === "low").slice(0, 3).map((record) => record["اسم الدواء"]).join("، ");
  const dangerNames = supply.filter((record) => getStockState(record) === "out").slice(0, 3).map((record) => record["اسم الدواء"]).join("، ");
  const categories = getCategoryCounts().slice(0, 6);
  const highestCategory = Math.max(1, ...categories.map(([, count]) => count));
  const supplyByNumber = getSupplyByNumber();
  const suggested = [...supply]
    .sort((left, right) => numericValue(right["كمية التوريد المقترحة"]) - numericValue(left["كمية التوريد المقترحة"]))
    .slice(0, 5);
  const pharmacyRows = pharmacies.slice(0, 5);

  content.innerHTML = `
    <section class="welcome-panel">
      <div class="welcome-copy">
        <span class="eyebrow welcome-accent">صباحك أهدى مع دوائي</span>
        <h1>خلّي كل معلومة عن الدواء <span class="welcome-accent">في مكانها.</span></h1>
        <p>ابحث في الأصناف، راجع كميات المخزون، أو اعثر على بيانات التواصل للصيدليات.</p>
      </div>
      <form class="welcome-search" id="hero-search">
        ${searchIcon()}
        <input id="hero-search-input" type="search" autocomplete="off" placeholder="اكتب اسم الدواء أو الكود..." aria-label="ابحث عن دواء أو كود">
        <button type="submit">ابحث في الأدوية</button>
      </form>
    </section>

    <section class="stats-grid" aria-label="ملخص البيانات">
      ${statCard("أصناف مسجلة", formatNumber(inventory.length), "من ملف كميات الأصناف", "＋")}
      ${statCard("متاح في السجل", formatNumber(availableCount), "حسب بيانات المخزون الحالية", "✓", "blue")}
      ${statCard("أسماء صيدليات", formatNumber(pharmacies.length), `${formatNumber(pharmacyRecords.length)} بيانات تواصل مميزة`, "⌖", "amber")}
      ${statCard("تحت حد الطلب", formatNumber(reorderCount), "أصناف تحتاج مراجعة", "!", "coral")}
    </section>

    <section class="stock-health-grid" aria-label="حالة المخزون">
      <article class="stock-health-card safe"><span class="health-icon">✓</span><div><strong>آمن</strong><small>${formatNumber(safeCount)} صنف متاح فوق حد الطلب</small></div></article>
      <article class="stock-health-card warning"><span class="health-icon">!</span><div><strong>على وشك الخطر</strong><small>${warningCount ? `الأصناف: ${escapeHtml(warningNames)}${warningCount > 3 ? "..." : ""}` : "لا يوجد صنف على وشك النفاد حاليًا"}</small></div></article>
      <article class="stock-health-card danger"><span class="health-icon">×</span><div><strong>خطر / نقص</strong><small>${dangerCount ? `الأصناف: ${escapeHtml(dangerNames)}${dangerCount > 3 ? "..." : ""}` : "لا يوجد نقص خطير حاليًا"}</small></div></article>
    </section>
    <section class="overview-grid">
      <article class="panel">
        <div class="panel-heading"><div><h2>توزيع الأصناف حسب الفئة</h2><p>أكثر الفئات تكرارًا في ملف التوريد</p></div><span class="panel-kicker">${formatNumber(supply.length)} سجل</span></div>
        <div class="category-chart">${categories.map(([category, count]) => `<div class="category-row"><span class="category-name" title="${escapeHtml(category)}">${escapeHtml(category)}</span><span class="category-track"><span class="category-fill" style="--bar-width:${Math.max(4, count / highestCategory * 100)}%"></span></span><span class="category-count">${formatNumber(count)}</span></div>`).join("")}</div>
      </article>
      <article class="panel">
        <div class="panel-heading"><div><h2>مقترحات التوريد</h2><p>أعلى الكميات المقترحة في الملف</p></div><span class="panel-kicker">${formatNumber(supply.length)} صنف</span></div>
        <div class="supply-list">${suggested.map((record) => `<div class="supply-row"><div><strong>${escapeHtml(record["اسم الدواء"])}</strong><small>${escapeHtml(record["طبيعة الدواء"] || "صنف دوائي")}</small></div><span class="supply-quantity">${formatNumber(record["كمية التوريد المقترحة"])} <small>${escapeHtml(record["وحدة القياس"] || "وحدة")}</small></span></div>`).join("")}</div>
        <p class="panel-note"><span aria-hidden="true">i</span><span>الكميات المقترحة من ورقة التوريد، وليست طلبات شراء مؤكدة.</span></p>
      </article>
    </section>

    <section class="panel table-panel">
      <div class="panel-heading"><div><h2>دليل الصيدليات</h2><p>بيانات الفروع وأرقام التواصل من الملف المرفق</p></div><span class="panel-kicker">${formatNumber(pharmacies.length)} فرع</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>الصيدلية</th><th>المنطقة</th><th>رقم التواصل</th><th>البيانات</th></tr></thead><tbody>${pharmacyRows.map((group) => { const pharmacy = group.records[0]; return `<tr><td><span class="table-primary">${escapeHtml(group.name)}</span></td><td>${escapeHtml(pharmacy["المنطقة / العنوان المتوقع"])}</td><td>${escapeHtml(pharmacy["رقم التليفون / الخط الساخن"])}</td><td><span class="status-pill">${formatNumber(group.records.length)} بيانات</span></td></tr>`; }).join("")}</tbody></table></div>
      <a class="panel-footer-link" href="#pharmacies" data-view="pharmacies">عرض دليل الصيدليات بالكامل <span aria-hidden="true">←</span></a>
    </section>
    <p class="pharmacy-disclaimer">تنبيه بيانات: ملف المخزون لا يربط الكميات بفروع محددة؛ حالة التوفر هنا تعكس سجل الأصناف العام فقط.</p>
  `;

  document.querySelector("#hero-search").addEventListener("submit", (event) => {
    event.preventDefault();
    state.inventoryQuery = document.querySelector("#hero-search-input").value.trim();
    state.inventoryPage = 0;
    showView("inventory");
  });

  document.querySelector("#source-note").textContent = `المصدر: ${state.data.source} · ${formatNumber(supplyByNumber.size)} سجل مرتبط بالتسلسل`;
}

function inventoryRows() {
  const rawQuery = state.inventoryQuery.trim();
  const query = normalizeSearch(rawQuery);
  const aliasedQuery = normalizeSearch(medicineAliases.get(query) || rawQuery);
  const supplyByNumber = getSupplyByNumber();
  return getInventory().map((item) => {
    const supply = supplyByNumber.get(String(item["م"])) ?? {};
    return { ...item, ...supply };
  }).filter((record) => {
    const searchable = [record["اسم الدواء"], record["الكود"], record["طبيعة الدواء"]].join(" ").toLocaleLowerCase();
    const matchesQuery = !query || searchable.includes(query) || normalizeSearch(record["اسم الدواء"]).includes(aliasedQuery);
    const matchesCategory = state.inventoryCategory === "الكل" || record["طبيعة الدواء"] === state.inventoryCategory;
    const stockState = getStockState(record);
    const matchesStock = state.inventoryFilter === "الكل" || stockState === state.inventoryFilter;
    return matchesQuery && matchesCategory && matchesStock;
  });
}

function inventoryTableRows(records) {
  if (!records.length) return '<tr><td colspan="6"><div class="empty-state"><strong>مفيش أصناف مطابقة</strong>جرّب كلمة بحث أو فئة مختلفة.</div></td></tr>';
  return records.map((record) => `<tr>
    <td><span class="table-primary">${escapeHtml(record["اسم الدواء"])}</span><span class="table-secondary">${escapeHtml(record["طبيعة الدواء"] || "صنف دوائي")}</span></td>
    <td>${escapeHtml(record["الكود"] || "—")}</td>
    <td class="number-cell">${formatNumber(record["الكمية الحالية"] ?? record["الكمية"])} <span class="table-secondary">${escapeHtml(record["وحدة القياس"] || record["الوحدة"] || "")}</span></td>
    <td class="number-cell">${formatNumber(record["الحد الأدنى"])}</td>
    <td>${statusMarkup(getStockState(record))}</td>
    <td class="number-cell">${formatNumber(record["كمية التوريد المقترحة"])}</td>
  </tr>`).join("");
}

function updateInventoryResults() {
  const results = inventoryRows();
  const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
  state.inventoryPage = Math.min(state.inventoryPage, pageCount - 1);
  const start = state.inventoryPage * pageSize;
  const visibleRecords = results.slice(start, start + pageSize);
  const container = document.querySelector("#inventory-results");
  if (!container) return;

  container.innerHTML = `
    <div class="table-wrap"><table class="data-table"><thead><tr><th>اسم الدواء</th><th>الكود</th><th>الكمية الحالية</th><th>حد الطلب</th><th>الحالة</th><th>توريد مقترح</th></tr></thead><tbody>${inventoryTableRows(visibleRecords)}</tbody></table></div>
    <div class="pagination"><span class="pagination-label">${results.length ? `عرض ${formatNumber(start + 1)}–${formatNumber(Math.min(start + pageSize, results.length))} من ${formatNumber(results.length)}` : "لا توجد نتائج"}</span><div class="pagination-actions"><button class="page-button" data-page="prev" ${state.inventoryPage === 0 ? "disabled" : ""}>السابق</button><button class="page-button" disabled>${formatNumber(state.inventoryPage + 1)} / ${formatNumber(pageCount)}</button><button class="page-button" data-page="next" ${state.inventoryPage >= pageCount - 1 ? "disabled" : ""}>التالي</button></div></div>
  `;
  const count = document.querySelector("#inventory-count");
  if (count) count.textContent = `${formatNumber(results.length)} نتيجة`;
}

function renderInventory() {
  const allCategories = getCategoryCounts().map(([category]) => category);
  const quickCategories = ["الكل", ...allCategories.slice(0, 5)];
  content.innerHTML = `
    ${pageHeading("الأدوية والمخزون", "ابحث في الأصناف المسجلة وراجع حالة المخزون وحدود التوريد.", "كتالوج دوائي")}
    <div class="toolbar"><label class="inline-search">${searchIcon()}<input id="inventory-search" type="search" value="${escapeHtml(state.inventoryQuery)}" placeholder="اسم الدواء، الكود، أو الفئة" autocomplete="off" aria-label="ابحث في الأدوية"></label><span class="toolbar-meta">الكمية حسب ملف الأصناف والتوريد</span></div>
    <div class="filter-row" aria-label="تصفية حسب الفئة والحالة">
      ${quickCategories.map((category) => `<button class="filter-chip ${state.inventoryCategory === category ? "is-active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("")}
      <label class="sr-only" for="category-select">كل الفئات</label><select class="filter-select" id="category-select"><option value="الكل">كل الفئات</option>${allCategories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}</select>
      <span class="result-count" id="inventory-count"></span>
    </div>
    <section class="panel table-panel" id="inventory-results" aria-live="polite"></section>
    <p class="pharmacy-disclaimer">حالة «متاح» تعكس ورقة التوريد في المصنف، ولا تعني توفر الصنف في صيدلية محددة أو تأكيد حجزه.</p>
  `;
  document.querySelector("#category-select").value = state.inventoryCategory;
  updateInventoryResults();
}

function pharmacyCard(group) {
  const name = String(group.name ?? "");
  const initials = [...name].filter((character) => /[\p{L}\p{N}]/u.test(character)).slice(0, 2).join("");
  const contacts = group.records.map((pharmacy) => {
    const phone = String(pharmacy["رقم التليفون / الخط الساخن"] ?? "");
    const dialNumber = (phone.split("/")[0].match(/[\d+()\-\s]+/)?.[0] ?? "").replace(/[^\d+]/g, "");
    return `<div class="pharmacy-contact"><small>${escapeHtml(pharmacy["المنطقة / العنوان المتوقع"] || "العنوان غير مدرج")}</small>${dialNumber ? `<a href="tel:${escapeHtml(dialNumber)}">${escapeHtml(phone)}</a>` : `<span>${escapeHtml(phone || "رقم غير مدرج")}</span>`}</div>`;
  }).join("");
  return `<article class="pharmacy-card"><div class="pharmacy-card-top"><span class="pharmacy-monogram" aria-hidden="true">${escapeHtml(initials || "ص")}</span><h2>${escapeHtml(name)}</h2></div><div class="pharmacy-contact-list">${contacts}</div><div class="pharmacy-card-foot"><small>${formatNumber(group.records.length)} بيانات تواصل</small><small>من ملف المصدر</small></div></article>`;
}

function updatePharmacyResults() {
  const query = state.pharmacyQuery.trim().toLocaleLowerCase();
  const results = getPharmacyGroups().filter((group) => [group.name, ...group.records.flatMap((record) => [record["المنطقة / العنوان المتوقع"], record["رقم التليفون / الخط الساخن"]])].join(" ").toLocaleLowerCase().includes(query));
  const grid = document.querySelector("#pharmacy-results");
  if (!grid) return;
  grid.innerHTML = results.length ? results.map(pharmacyCard).join("") : '<div class="panel empty-state"><strong>ملقيناش فرع بالمعلومات دي</strong>جرّب اسم منطقة أو صيدلية تاني.</div>';
  const contactCount = results.reduce((total, group) => total + group.records.length, 0);
  document.querySelector("#pharmacy-count").textContent = `${formatNumber(results.length)} اسم · ${formatNumber(contactCount)} بيانات تواصل`;
}

function renderPharmacies() {
  content.innerHTML = `
    ${pageHeading("دليل الصيدليات", "ابحث باسم الصيدلية أو المنطقة، واعرض كل بيانات التواصل المدرجة.", "شبكة الفروع")}
    <div class="toolbar"><label class="inline-search">${searchIcon()}<input id="pharmacy-search" type="search" value="${escapeHtml(state.pharmacyQuery)}" placeholder="اسم الصيدلية، المنطقة، أو رقم الهاتف" autocomplete="off" aria-label="ابحث في دليل الصيدليات"></label><span class="toolbar-meta" id="pharmacy-count"></span></div>
    <section class="pharmacy-grid" id="pharmacy-results" aria-live="polite"></section>
    <p class="pharmacy-disclaimer">الأرقام والمناطق من الملف المرفق، وقد تحتاج للتأكيد قبل زيارة الفرع. لا توجد بيانات موقع جغرافي أو ربط بين الفروع والمخزون في المصنف.</p>
  `;
  updatePharmacyResults();
}

function updateSupplyResults() {
  const query = state.supplyQuery.trim().toLocaleLowerCase();
  const records = getSupply().filter((record) => [record["اسم الدواء"], record["طبيعة الدواء"], record["حالة المخزون"]].join(" ").toLocaleLowerCase().includes(query));
  const rows = records.slice(0, 30).map((record) => `<tr><td><span class="table-primary">${escapeHtml(record["اسم الدواء"])}</span><span class="table-secondary">${escapeHtml(record["طبيعة الدواء"] || "صنف دوائي")}</span></td><td class="number-cell">${formatNumber(record["الكمية الحالية"])}</td><td>${escapeHtml(record["وحدة القياس"] || "—")}</td><td class="number-cell">${formatNumber(record["الحد الأدنى"])}</td><td>${statusMarkup(getStockState(record))}</td><td class="number-cell">${formatNumber(record["كمية التوريد المقترحة"])}</td></tr>`).join("");
  document.querySelector("#supply-results").innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>الصنف والفئة</th><th>الكمية الحالية</th><th>وحدة القياس</th><th>حد الطلب</th><th>حالة المخزون</th><th>الكمية المقترحة</th></tr></thead><tbody>${rows || '<tr><td colspan="6"><div class="empty-state"><strong>مفيش بيانات مطابقة</strong>جرّب اسم دواء أو فئة تانية.</div></td></tr>'}</tbody></table></div><div class="pagination"><span class="pagination-label">${formatNumber(records.length)} سجل في الملف${records.length > 30 ? ` · عرض أول ${formatNumber(30)}` : ""}</span><span class="pagination-label">اقتراحات وليست طلبات مؤكدة</span></div>`;
  document.querySelector("#supply-count").textContent = `${formatNumber(records.length)} سجل`;
}

function getDonationRequests() {
  try {
    const requests = JSON.parse(localStorage.getItem("dawaey-donation-requests") || "[]");
    return Array.isArray(requests) ? requests : [];
  } catch { return []; }
}
function donationStatusLabel(status) {
  return status === "accepted" ? "مقبول" : status === "completed" ? "تم التسليم" : status === "rejected" ? "مرفوض" : "جديد";
}
function donationStatusClass(status) { return status === "accepted" ? "accepted" : status === "completed" ? "completed" : status === "rejected" ? "rejected" : "pending"; }
function saveDonationRequests(requests) { localStorage.setItem("dawaey-donation-requests", JSON.stringify(requests)); }
function getConsumptionValue(record) {
  const actual = ["الاستهلاك الشهري", "الاستهلاك", "كمية الاستهلاك"].map((key) => numericValue(record[key])).find((value) => value > 0);
  if (actual) return { value: actual, estimated: false };
  return { value: numericValue(record["كمية التوريد المقترحة"]), estimated: true };
}
function renderConsumptionReports() {
  const rows = getSupply().map((record) => ({ record, ...getConsumptionValue(record) })).filter((row) => row.value > 0).sort((a, b) => b.value - a.value);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const estimated = rows.filter((row) => row.estimated).length;
  const top = rows[0];
  const month = new Intl.DateTimeFormat("ar-EG", { month: "long", year: "numeric" }).format(new Date());
  content.innerHTML = `${pageHeading("تقارير استهلاك الأدوية", "ملخص شهري يساعد الصيدلي على متابعة حركة الأصناف واتخاذ قرار التوريد.", `تقرير ${month}`)}<div class="report-disclaimer"><strong>ملاحظة البيانات:</strong><span>${estimated === rows.length ? "ملف المصدر لا يحتوي حركات صرف شهرية فعلية؛ الأرقام المعروضة مؤشر تقديري مبني على كميات التوريد المقترحة. أضف سجل المبيعات لاحقًا للحصول على استهلاك دقيق." : "التقرير يجمع بين حركات الصرف الفعلية المتاحة والمؤشرات التقديرية للأصناف التي لا تملك سجل صرف."}</span></div><section class="report-summary-grid"><article class="report-summary-card blue"><span>إجمالي الوحدات</span><strong>${formatNumber(total)}</strong><small>مؤشر الشهر الحالي</small></article><article class="report-summary-card orange"><span>الأكثر حركة</span><strong>${escapeHtml(top?.record?.["اسم الدواء"] || "لا توجد بيانات")}</strong><small>${top ? `${formatNumber(top.value)} وحدة${top.estimated ? " تقديريًا" : ""}` : "أضف بيانات الصرف"}</small></article><article class="report-summary-card purple"><span>أصناف التقرير</span><strong>${formatNumber(rows.length)}</strong><small>${formatNumber(estimated)} تقديري · ${formatNumber(rows.length - estimated)} فعلي</small></article></section><section class="panel report-panel"><div class="panel-heading"><div><h2>الأدوية الأعلى استهلاكًا</h2><p>ترتيب تنازلي للشهر الحالي</p></div><span class="panel-kicker">${escapeHtml(month)}</span></div><div class="consumption-table-wrap"><table class="data-table"><thead><tr><th>الترتيب</th><th>اسم الدواء</th><th>الفئة</th><th>الوحدات</th><th>مصدر الرقم</th></tr></thead><tbody>${rows.slice(0, 15).map((row, index) => `<tr><td><span class="rank-badge">${formatNumber(index + 1)}</span></td><td><span class="table-primary">${escapeHtml(row.record["اسم الدواء"] || "غير محدد")}</span></td><td>${escapeHtml(row.record["طبيعة الدواء"] || "صنف دوائي")}</td><td><strong class="consumption-number">${formatNumber(row.value)}</strong></td><td><span class="report-source ${row.estimated ? "estimated" : "actual"}">${row.estimated ? "مؤشر تقديري" : "سجل صرف فعلي"}</span></td></tr>`).join("") || '<tr><td colspan="5"><div class="empty-state"><strong>لا توجد بيانات استهلاك بعد</strong><p>أضف حركة صرف شهرية من نظام المبيعات لبدء التقرير.</p></div></td></tr>'}</tbody></table></div></section>`;
}

function renderDonations() {
  const requests = getDonationRequests();
  const cards = requests.length ? requests.map((request) => `<article class="donation-request-card"><div class="donation-request-top"><div><span class="eyebrow">طلب تبرع</span><h2>${escapeHtml(request.medicine || "دواء غير محدد")}</h2></div><span class="donation-status ${donationStatusClass(request.status)}">${donationStatusLabel(request.status)}</span></div><div class="donation-request-meta"><span>⌖ ${escapeHtml(request.area || "منطقة غير محددة")}</span><span>▣ الكمية: ${escapeHtml(request.quantity || "غير محددة")}</span><span>◷ ${escapeHtml(new Intl.DateTimeFormat("ar-EG", { dateStyle: "short", timeStyle: "short" }).format(new Date(request.createdAt || Date.now())))}</span></div><div class="donation-request-actions">${request.status === "pending" ? '<button class="donation-action accept" data-donation-action="accepted" data-donation-id="' + escapeHtml(request.id) + '">قبول الطلب</button><button class="donation-action reject" data-donation-action="rejected" data-donation-id="' + escapeHtml(request.id) + '">رفض</button>' : ''}${request.status === "accepted" ? '<button class="donation-action complete" data-donation-action="completed" data-donation-id="' + escapeHtml(request.id) + '">تأكيد استلام التبرع</button>' : ''}${request.status !== "pending" ? '<button class="donation-action reset" data-donation-action="pending" data-donation-id="' + escapeHtml(request.id) + '">إعادة فتح</button>' : ''}</div></article>`).join("") : '<div class="panel empty-state donation-empty"><strong>لا توجد طلبات تبرع حتى الآن</strong><p>عندما يرسل مريض طلب تبرع من صفحة المريض، سيظهر هنا فورًا على نفس الجهاز.</p></div>';
  content.innerHTML = `${pageHeading("طلبات التبرع بالأدوية", "راجع طلبات المرضى وحدد ما يمكن للصيدلية استقباله.", "خدمة المجتمع")}<div class="donation-dashboard-note"><strong>تنبيه مهم:</strong><span>تأكد من صلاحية الدواء وسلامة العبوة قبل القبول، وتواصل مع المتبرع خارج الموقع لتنسيق التسليم.</span></div><section class="donation-request-grid" id="donation-request-results">${cards}</section>`;
}

function renderSupply() {
  content.innerHTML = `
    ${pageHeading("التوريد", "راجع حد الطلب والكميات المقترحة حسب بيانات المصنف.", "تخطيط المخزون")}
    <div class="toolbar"><label class="inline-search">${searchIcon()}<input id="supply-search" type="search" value="${escapeHtml(state.supplyQuery)}" placeholder="ابحث باسم الصنف أو الفئة" autocomplete="off" aria-label="ابحث في مقترحات التوريد"></label><span class="toolbar-meta" id="supply-count"></span></div>
    <section class="panel table-panel" id="supply-results" aria-live="polite"></section>
    <p class="pharmacy-disclaimer">الكمية المقترحة محسوبة في ملف المصدر. راجع الاحتياج الفعلي والمورد قبل اعتماد أي طلب.</p>
  `;
  updateSupplyResults();
}

function showView(view, scroll = true) {
  if (!(view in sectionNames)) return;
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelector("#current-section").textContent = sectionNames[view];
  if (view === "overview") renderOverview();
  if (view === "inventory") renderInventory();
  if (view === "pharmacies") renderPharmacies();
  if (view === "supply") renderSupply();
  if (view === "donations") renderDonations();
  if (view === "reports") renderConsumptionReports();
  content.setAttribute("aria-busy", "false");
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvDownload(filename, headers, rows) {
  const content = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("التقرير جاهز للتنزيل");
}

function exportCurrentView() {
  const date = new Date().toISOString().slice(0, 10);
  if (state.view === "pharmacies") {
    const pharmacies = getPharmacies();
    csvDownload(`dawaey-pharmacies-${date}.csv`, ["اسم الصيدلية", "المنطقة", "رقم التواصل"], pharmacies.map((record) => [record["اسم الصيدلية"], record["المنطقة / العنوان المتوقع"], record["رقم التليفون / الخط الساخن"]]));
    return;
  }
  if (state.view === "supply") {
    csvDownload(`dawaey-supply-${date}.csv`, ["اسم الدواء", "الفئة", "الكمية الحالية", "وحدة القياس", "حد الطلب", "الحالة", "كمية التوريد المقترحة"], getSupply().map((record) => [record["اسم الدواء"], record["طبيعة الدواء"], record["الكمية الحالية"], record["وحدة القياس"], record["الحد الأدنى"], record["حالة المخزون"], record["كمية التوريد المقترحة"]]));
    return;
  }
  const supplyByNumber = getSupplyByNumber();
  const rows = state.view === "inventory" ? inventoryRows() : getInventory().map((record) => ({ ...record, ...(supplyByNumber.get(String(record["م"])) ?? {}) }));
  csvDownload(`dawaey-inventory-${date}.csv`, ["اسم الدواء", "الكود", "الفئة", "الكمية الحالية", "الوحدة", "حد الطلب", "حالة المخزون", "كمية التوريد المقترحة"], rows.map((record) => [record["اسم الدواء"], record["الكود"], record["طبيعة الدواء"], record["الكمية الحالية"] ?? record["الكمية"], record["وحدة القياس"] ?? record["الوحدة"], record["الحد الأدنى"], stockLabel(getStockState(record)), record["كمية التوريد المقترحة"]]));
}

function stockAlertRecords(records = getSupply()) {
  return records.filter((record) => ["low", "out"].includes(getStockState(record)));
}
function alertSignature(records) {
  return stockAlertRecords(records).map((record) => `${record["م"]}:${record["اسم الدواء"]}:${getStockState(record)}:${record["الكمية الحالية"] ?? record["الكمية"]}`).sort().join("|");
}
function renderStockAlertPanel(records = getSupply()) {
  const alerts = stockAlertRecords(records);
  const count = document.querySelector("#stock-alert-count");
  const panel = document.querySelector("#stock-alert-panel");
  const button = document.querySelector("#stock-alert-button");
  if (count) count.textContent = formatNumber(alerts.length);
  if (button) button.classList.toggle("has-alerts", alerts.length > 0);
  if (!panel) return;
  panel.innerHTML = alerts.length ? `<div class="alert-panel-heading"><strong>تنبيهات المخزون</strong><button type="button" data-close-alerts>×</button></div>${alerts.map((record) => { const stateName = getStockState(record); return `<article class="stock-alert-item ${stateName === "out" ? "danger" : "warning"}"><span class="alert-item-icon">${stateName === "out" ? "×" : "!"}</span><div><strong>${escapeHtml(record["اسم الدواء"] || "صنف دوائي")}</strong><small>${stateName === "out" ? "خطر: الصنف غير متاح أو نفد" : "تنبيه: الصنف على وشك النفاد"} · الكمية الحالية: ${formatNumber(record["الكمية الحالية"] ?? record["الكمية"])}</small></div><button type="button" data-view="inventory" data-close-alerts>عرض</button></article>`; }).join("")}<button class="notification-permission" type="button" id="enable-stock-notifications">تفعيل تنبيه المتصفح</button>` : `<div class="alert-panel-heading"><strong>تنبيهات المخزون</strong><button type="button" data-close-alerts>×</button></div><div class="stock-alert-empty"><span>✓</span><strong>كل المخزون في أمان</strong><small>لا توجد أصناف خطرة أو قريبة من النفاد حاليًا.</small></div>`;
}
async function refreshStockAlerts() {
  if (!state.data) return;
  try {
    const latest = await loadDashboardData();
    const latestSupply = latest.sheets?.[SHEET_NAMES.supply] ?? [];
    const latestSignature = alertSignature(latestSupply);
    if (state.alertSignature && state.alertSignature !== latestSignature) {
      const newlyAtRisk = stockAlertRecords(latestSupply).filter((record) => !stockAlertRecords(getSupply()).some((old) => String(old["م"]) === String(record["م"]) && getStockState(old) === getStockState(record)));
      showToast(newlyAtRisk.length ? `تنبيه مخزون: ${newlyAtRisk[0]["اسم الدواء"]} وصل لحالة خطر` : "تم تحديث حالة المخزون");
      if ("Notification" in window && Notification.permission === "granted") new Notification("تنبيه مخزون دوائي", { body: newlyAtRisk.length ? `${newlyAtRisk[0]["اسم الدواء"]} يحتاج مراجعة فورية.` : "تم تحديث حالة أحد الأصناف." });
      state.data = latest;
    }
    state.alertSignature = latestSignature;
    renderStockAlertPanel(latestSupply);
  } catch { /* Keep the last known state if a polling request is temporarily unavailable. */ }
}
function startStockAlertPolling() {
  refreshStockAlerts();
  window.clearInterval(state.alertTimer);
  state.alertTimer = window.setInterval(refreshStockAlerts, 8000);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector("#theme-toggle").setAttribute("aria-label", theme === "dark" ? "التبديل للمظهر النهاري" : "التبديل للمظهر الليلي");
  try { localStorage.setItem("dawaey-theme", theme); } catch { /* Storage can be unavailable in private contexts. */ }
}

async function loadDashboardData() {
  const apiResponse = await fetch(apiUrl("pharmacy/bootstrap"), { credentials: "include" });
  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) throw new Error(payload.error || "تعذر تحميل بيانات لوحة الصيدلية");
  if (payload.sheets) return { source: payload.source, sheets: payload.sheets };
  return { source: payload.source, sheets: { "الاصناف والكميات": payload.catalog || [], "طلبات التوريد": payload.catalog || [], "بيانات الصيداليات": payload.pharmacies || [] } };
}
async function startApp() {
  document.querySelector("#today-label").textContent = dateFormat.format(new Date());
  try {
    const sessionResponse = await fetch(apiUrl("session"), { credentials: "include" });
    const session = await sessionResponse.json().catch(() => ({}));
    if (!session.user || session.user.role !== "pharmacy") {
      window.location.assign("auth.html?role=pharmacy");
      return;
    }
    state.data = await loadDashboardData();
    showView("overview", false);
    startStockAlertPolling();
  } catch (error) {
    content.setAttribute("aria-busy", "false");
    content.innerHTML = `<section class="panel empty-state"><strong>مش قادرين نقرأ ملف البيانات</strong><p>${escapeHtml(error.message)}. تأكد إنك فاتح الموقع من خلال خادم محلي.</p><button class="filter-chip" data-retry>حاول تاني</button></section>`;
  }
}
document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    event.preventDefault();
    showView(viewButton.dataset.view);
    return;
  }

  const donationAction = event.target.closest("[data-donation-action]");
  if (donationAction) {
    const requests = getDonationRequests();
    const request = requests.find((item) => item.id === donationAction.dataset.donationId);
    if (request) { request.status = donationAction.dataset.donationAction; saveDonationRequests(requests); renderDonations(); showToast(`تم تحديث حالة طلب ${request.medicine}`); }
    return;
  }
  if (event.target.closest("#stock-alert-button")) {
    const panel = document.querySelector("#stock-alert-panel");
    const button = document.querySelector("#stock-alert-button");
    const open = panel?.hasAttribute("hidden");
    if (open) { renderStockAlertPanel(); panel.removeAttribute("hidden"); button?.setAttribute("aria-expanded", "true"); }
    else { panel?.setAttribute("hidden", ""); button?.setAttribute("aria-expanded", "false"); }
    return;
  }
  if (event.target.closest("[data-close-alerts]") && !event.target.closest("[data-view]")) { document.querySelector("#stock-alert-panel")?.setAttribute("hidden", ""); document.querySelector("#stock-alert-button")?.setAttribute("aria-expanded", "false"); }
  if (event.target.closest("#enable-stock-notifications")) { if ("Notification" in window) Notification.requestPermission().then((permission) => showToast(permission === "granted" ? "تنبيهات المتصفح مفعلة" : "لم يتم تفعيل تنبيهات المتصفح")); else showToast("المتصفح لا يدعم التنبيهات"); return; }
  const categoryButton = event.target.closest("[data-category]");
  if (categoryButton) {
    state.inventoryCategory = categoryButton.dataset.category;
    state.inventoryPage = 0;
    document.querySelectorAll("[data-category]").forEach((button) => button.classList.toggle("is-active", button === categoryButton));
    updateInventoryResults();
    return;
  }

  const pageButton = event.target.closest("[data-page]");
  if (pageButton && !pageButton.disabled) {
    state.inventoryPage += pageButton.dataset.page === "next" ? 1 : -1;
    updateInventoryResults();
    return;
  }

  if (event.target.closest("#export-button")) exportCurrentView();
  if (event.target.closest("#theme-toggle")) setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  if (event.target.closest("[data-retry]")) startApp();
});

document.addEventListener("input", (event) => {
  if (event.target.id === "inventory-search") {
    state.inventoryQuery = event.target.value;
    state.inventoryPage = 0;
    updateInventoryResults();
  }
  if (event.target.id === "pharmacy-search") {
    state.pharmacyQuery = event.target.value;
    updatePharmacyResults();
  }
  if (event.target.id === "supply-search") {
    state.supplyQuery = event.target.value;
    updateSupplyResults();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "category-select") {
    state.inventoryCategory = event.target.value;
    state.inventoryPage = 0;
    document.querySelectorAll("[data-category]").forEach((button) => button.classList.toggle("is-active", button.dataset.category === state.inventoryCategory));
    updateInventoryResults();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    const search = document.querySelector("#hero-search-input, #inventory-search, #pharmacy-search, #supply-search");
    search?.focus();
  }
});

try {
  const savedTheme = localStorage.getItem("dawaey-theme");
  if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme);
} catch { /* The default light theme remains available without storage. */ }

startApp();