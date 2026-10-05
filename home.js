const INVENTORY_SHEET = "الاصناف والكميات";
const API_BASE = (window.DAWAEY_API_BASE ?? ((location.hostname === "localhost" || location.hostname === "127.0.0.1") ? "" : "https://dawaey-production.up.railway.app")).replace(/\/+$/, "");
const apiUrl = (path) => `${API_BASE}/api/${path}`;
const SUPPLY_SHEET = "طلبات التوريد";
const PHARMACY_SHEET = "بيانات الصيداليات";
const numberFormat = new Intl.NumberFormat("ar-EG");
const state = { inventory: [], supplyByNumber: new Map(), pharmacies: [], matches: [], saved: new Set(), onboardingStep: 0, recognition: null, user: null, areaQuery: "", selectedMedicine: null };
const aliases = new Map([
  ["بنادول", "panadol"], ["بانادول", "panadol"], ["كاتافلام", "cataflam"], ["كتافلام", "cataflam"],
  ["بروفين", "brufen"], ["فولتارين", "voltaren"], ["ادول", "adol"], ["أدول", "adol"],
  ["اوجمنتين", "augmentin"], ["أوجمنتين", "augmentin"], ["كونجستال", "congestal"],
  ["فلاجيل", "flagyl"], ["موتيليوم", "motilium"], ["نوروڤين", "nurofen"], ["نيروفين", "nurofen"],
]);

const searchInput = document.querySelector("#medicine-search");
const suggestionList = document.querySelector("#search-suggestions");
const resultsSection = document.querySelector("#search-results");
const toast = document.querySelector("#toast");
let toastTimer;
const ingredientByType = {
  "مسكن وخافض للحرارة": ["باراسيتامول", "تخفيف الألم والحرارة"],
  "مضاد حيوي": ["تختلف حسب الاسم والتركيبة", "علاج عدوى بكتيرية بوصفة طبية"],
  "مضاد للالتهاب": ["تختلف حسب الاسم والتركيبة", "تخفيف الالتهاب والألم"],
  "فيتامينات": ["مزيج فيتامينات حسب المنتج", "تعويض نقص غذائي محدد"],
};

function renderMedicineInfo(record) {
  const panel = document.querySelector("#medicine-info-content");
  const empty = document.querySelector("#medicine-info-empty");
  if (!panel || !empty || !record) return;
  const type = String(record["طبيعة الدواء"] || "صنف دوائي");
  const details = [record["المادة الفعالة"] || "غير محددة في ملف المصدر — راجع الصيدلي", type];
  panel.innerHTML = `<span class="info-subtitle">تفاصيل تعليمية عن النتيجة المختارة</span><h3>${escapeHtml(record["اسم الدواء"] || "دواء")}</h3><div class="info-grid"><div class="info-item"><b>المادة الفعالة</b><span>${escapeHtml(details[0])}</span></div><div class="info-item"><b>الاستخدام العام</b><span>${escapeHtml(details[1])}</span></div><div class="info-item"><b>الكود</b><span>${escapeHtml(record["الكود"] || "غير متاح")}</span></div><div class="info-item"><b>حالة السجل</b><span>${escapeHtml(getStatus(record).label)}</span></div></div><p class="info-warning">تنبيه: لا تبدأ أو توقف دواءً اعتمادًا على هذه البطاقة؛ اسأل الصيدلي عن المادة الفعالة والجرعة المناسبة.</p>`;
  empty.hidden = true; panel.hidden = false; state.selectedMedicine = record;
  document.querySelector("#medicine-info")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function loadOcrScript() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"; script.onload = () => resolve(window.Tesseract); script.onerror = reject; document.head.appendChild(script); });
}

async function searchFromPhoto(file) {
  showToast("بنقرأ اسم الدواء من الصورة بالعربي والإنجليزي...");
  try {
    const Tesseract = await loadOcrScript();
    const result = await Tesseract.recognize(file, "ara+eng", { logger: (message) => { if (message.status === "recognizing text" && message.progress > .7) showToast("قربنا نخلص قراءة العلبة..."); } });
    const text = result.data.text.replace(/\s+/g, " ").trim();
    const candidate = findMatches(text)[0];
    if (!candidate) { showToast("قرأنا الصورة لكن الاسم مش موجود في سجل المصدر؛ جرّب كتابة الاسم."); return; }
    searchInput.value = candidate["اسم الدواء"]; performSearch(candidate["اسم الدواء"]);
  } catch { showToast("تعذر قراءة الصورة. جرّب صورة أوضح أو اكتب اسم الدواء يدويًا."); }
}


function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function normalize(value) {
  return String(value ?? "").toLocaleLowerCase("ar-EG").normalize("NFD").replace(/[\u064B-\u065F\u0670]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").trim();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function getRecords() {
  return state.inventory.map((item) => ({ ...item, ...(state.supplyByNumber.get(String(item["م"])) ?? {}) }));
}

function editDistance(left, right) {
  if (Math.abs(left.length - right.length) > 2) return 3;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

function findMatches(query) {
  const normalizedQuery = normalize(query);
  const aliasedQuery = normalize(aliases.get(normalizedQuery) ?? query);
  if (!aliasedQuery) return [];
  return getRecords().map((record) => {
    const name = normalize(record["اسم الدواء"]);
    const category = normalize(record["طبيعة الدواء"]);
    const code = normalize(record["الكود"]);
    let score = 0;
    if (name === aliasedQuery || code === aliasedQuery) score = 100;
    else if (name.startsWith(aliasedQuery) || code.startsWith(aliasedQuery)) score = 80;
    else if (`${name} ${category}`.includes(aliasedQuery)) score = 60;
    else if (aliasedQuery.length >= 4 && editDistance(name.split(" ")[0], aliasedQuery) <= (aliasedQuery.length > 7 ? 2 : 1)) score = 30;
    return { ...record, score };
  }).filter((record) => record.score > 0).sort((left, right) => right.score - left.score || String(left["اسم الدواء"]).localeCompare(String(right["اسم الدواء"]))).slice(0, 30);
}

function getStatus(record) {
  const quantity = Number(record["الكمية الحالية"] ?? record["الكمية"] ?? 0);
  const minimum = Number(record["الحد الأدنى"] ?? 0);
  if (quantity <= 0 || String(record["حالة المخزون"] ?? "").includes("غير متاح")) return { label: "غير متاح في السجل", className: "out" };
  if (quantity <= minimum) return { label: "كمية قليلة في السجل", className: "low" };
  return { label: "متاح في سجل المصدر", className: "available" };
}

function renderSuggestions(query) {
  if (!query.trim()) {
    suggestionList.hidden = true;
    suggestionList.replaceChildren();
    return;
  }
  const suggestions = findMatches(query).slice(0, 5);
  if (!suggestions.length) {
    suggestionList.innerHTML = '<div class="suggestion-option"><span class="suggestion-pill">?</span><span><strong>مش لاقيين تطابق</strong><small>جرّب الاسم العلمي أو الكود</small></span></div>';
  } else {
    suggestionList.innerHTML = suggestions.map((record, index) => `<button type="button" class="suggestion-option" role="option" aria-selected="${index === 0}" data-select-medicine="${escapeHtml(record["اسم الدواء"])}"><span class="suggestion-pill">Rx</span><span><strong>${escapeHtml(record["اسم الدواء"])}</strong><small>${escapeHtml(record["طبيعة الدواء"] || record["الكود"] || "دواء")}</small></span></button>`).join("");
  }
  suggestionList.hidden = false;
}

function renderMedicineCard(record) {
  const status = getStatus(record);
  const saved = state.saved.has(String(record["م"]));
  const nearby = nearbyPharmacyMarkup(record);
  return `<article class="medicine-result">
    <span class="medicine-glyph" aria-hidden="true"><i></i><b>Rx</b></span>
    <div class="medicine-main"><div class="medicine-title-row"><div><h3>${escapeHtml(record["اسم الدواء"])}</h3><p>${escapeHtml(record["طبيعة الدواء"] || "صنف دوائي")}</p></div><span class="medicine-status ${status.className}">${status.label}</span></div>
      <div class="medicine-meta"><span>الكود ${escapeHtml(record["الكود"] || "—")}</span><span>الكمية في السجل: ${numberFormat.format(Number(record["الكمية الحالية"] ?? record["الكمية"] ?? 0))} ${escapeHtml(record["وحدة القياس"] || record["الوحدة"] || "")}</span><span>حد الطلب: ${numberFormat.format(Number(record["الحد الأدنى"] ?? 0))}</span><span>المادة الفعالة: ${escapeHtml(record["المادة الفعالة"] || "غير محددة")}</span></div>
      <button class="save-medicine" type="button" data-save-medicine="${escapeHtml(record["م"])}" aria-pressed="${saved}">${saved ? "★ محفوظ في أدويتي" : "☆ أضف لأدويتي"}</button>
    </div>
    ${nearby}
  </article>`;
}

function uniquePharmacies() {
  const unique = new Map();
  for (const pharmacy of state.pharmacies) {
    const key = [pharmacy["اسم الصيدلية"], pharmacy["المنطقة / العنوان المتوقع"], pharmacy["رقم التليفون / الخط الساخن"]].join("|");
    if (!unique.has(key)) unique.set(key, pharmacy);
  }
  return [...unique.values()];
}

function simplifyArea(value) {
  return normalize(value).replace(/^محافظة\s*/, "").replace(/^ال/, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function getNearbyPharmacies(query = state.areaQuery) {
  const normalizedQuery = simplifyArea(query);
  if (!normalizedQuery) return [];
  return uniquePharmacies().filter((pharmacy) => {
    const area = normalize(pharmacy["المنطقة / العنوان المتوقع"]);
    const segments = area.split(/\s*[-–/]\s*/).map(simplifyArea);
    return area.includes(normalize(query)) || segments.some((segment) => segment.includes(normalizedQuery) || normalizedQuery.includes(segment));
  });
}

function nearbyPharmacyMarkup(record) {
  const entries = getNearbyPharmacies().slice(0, 10);
  const area = state.areaQuery.trim();
  if (!area) {
    return `<section class="medicine-nearby"><div class="nearby-heading"><strong>أقرب فروع الدليل</strong><span>حدد منطقتك</span></div><p>اكتب منطقتك أو استخدم موقعك لعرض الصيدليات المسجلة فيها.</p><button class="nearby-choose-area" type="button" data-focus-area>اختار المنطقة <span aria-hidden="true">←</span></button></section>`;
  }
  if (!entries.length) {
    return `<section class="medicine-nearby"><div class="nearby-heading"><strong>مفيش فرع مطابق في الدليل</strong><span>${escapeHtml(area)}</span></div><p>جرّب اسم منطقة أقرب أو اتصل بصيدلية موثوقة.</p></section>`;
  }
  const pharmacies = entries.map((pharmacy) => {
    const phone = String(pharmacy["رقم التليفون / الخط الساخن"] ?? "");
    const dial = (phone.split("/")[0].match(/[\d+()\-\s]+/)?.[0] ?? "").replace(/[^\d+]/g, "");
    const location = String(pharmacy["المنطقة / العنوان المتوقع"] ?? "").split(/\s*[-–/]\s*/).at(-1) ?? area;
    return `<article class="nearby-pharmacy"><div class="nearby-pharmacy-copy"><strong>${escapeHtml(pharmacy["اسم الصيدلية"])}</strong><small>${escapeHtml(location)} · مطابقة لمنطقتك</small><span>اتصل للتأكد من توفر الدواء</span></div>${dial ? `<a class="nearby-call" href="tel:${escapeHtml(dial)}" aria-label="اتصل بـ${escapeHtml(pharmacy["اسم الصيدلية"])}">اتصال</a>` : `<span class="nearby-phone">${escapeHtml(phone || "رقم غير مدرج")}</span>`}</article>`;
  }).join("");
  return `<section class="medicine-nearby"><div class="nearby-heading"><strong>فروع الدليل الأقرب حسب المنطقة</strong><span>${escapeHtml(area)}</span></div><div class="nearby-pharmacy-list">${pharmacies}</div><p class="nearby-caveat">الترتيب حسب المنطقة المسجلة، مش المسافة الدقيقة. ملف المصدر لا يربط مخزون الدواء بالفرع.</p></section>`;
}

function renderAreaResults(query = "") {
  const normalizedQuery = normalize(query);
  const entries = getNearbyPharmacies(query).slice(0, 200);
  const container = document.querySelector("#area-results");
  if (!normalizedQuery) {
    container.innerHTML = '<div class="area-result"><span>اكتب اسم المنطقة عشان نرتّب الفروع المسجلة الأقرب.</span></div>';
    return;
  }
  if (!entries.length) {
    container.innerHTML = `<div class="area-result"><span>${query ? "مفيش منطقة مطابقة في الدليل" : "اكتب اسم المنطقة لعرض الفروع المسجلة"}</span></div>`;
    return;
  }
  container.innerHTML = entries.map((pharmacy) => {
    const phone = String(pharmacy["رقم التليفون / الخط الساخن"] ?? "");
    const dial = (phone.split("/")[0].match(/[\d+()\-\s]+/)?.[0] ?? "").replace(/[^\d+]/g, "");
    return `<div class="area-result"><span>${escapeHtml(pharmacy["اسم الصيدلية"])}<br><small>${escapeHtml(pharmacy["المنطقة / العنوان المتوقع"])}</small></span>${dial ? `<a href="tel:${escapeHtml(dial)}">اتصال</a>` : `<span>${escapeHtml(phone)}</span>`}</div>`;
  }).join("");
}

function updateSavedList() {
  const savedList = document.querySelector("#saved-list");
  const records = getRecords().filter((record) => state.saved.has(String(record["م"])));
  if (!records.length) {
    savedList.innerHTML = '<span class="saved-empty">لسه مفيش أدوية محفوظة.</span>';
    return;
  }
  savedList.innerHTML = records.map((record) => `<span class="saved-item">${escapeHtml(record["اسم الدواء"])}<button type="button" data-remove-saved="${escapeHtml(record["م"])}" aria-label="حذف ${escapeHtml(record["اسم الدواء"])} من أدويتي">×</button></span>`).join("");
}

function updateStats() {
  const uniqueNames = new Set(getRecords().map((record) => record["اسم الدواء"]));
  const pharmacyNames = new Set(state.pharmacies.map((record) => record["اسم الصيدلية"]));
  const contacts = uniquePharmacies();
  const values = { medicines: uniqueNames.size, pharmacies: pharmacyNames.size, contacts: contacts.length };
  for (const [key, value] of Object.entries(values)) {
    const element = document.querySelector(`[data-stat="${key}"]`);
    if (!element) continue;
    const startedAt = performance.now();
    const animate = (now) => {
      const progress = Math.min(1, (now - startedAt) / 700);
      element.textContent = numberFormat.format(Math.round(value * progress));
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }
}

function performSearch(query) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    searchInput.focus();
    showToast("اكتب اسم الدواء الأول");
    return;
  }
  state.matches = findMatches(trimmedQuery);
  const isPatient = state.user?.role === "patient";
  document.querySelector("#results-title").textContent = `نتائج: ${trimmedQuery}`;
  document.querySelector("#results-summary").textContent = state.matches.length ? `لقينا ${numberFormat.format(state.matches.length)} تطابق في سجل الأصناف.${!isPatient && state.matches.length > 5 ? " عرضنا أول ٥ للزائر." : ""}` : "ملقيناش الاسم ده في الكتالوج الحالي.";
  renderMedicineResults();
  if (state.matches[0]) renderMedicineInfo(state.matches[0]);
  resultsSection.hidden = false;
  suggestionList.hidden = true;
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderMedicineResults() {
  const isPatient = state.user?.role === "patient";
  const visibleMatches = isPatient ? state.matches : state.matches.slice(0, 5);
  const guestNotice = !isPatient && state.matches.length > 5 ? '<div class="guest-limit-note">دي معاينة محدودة. <a href="auth.html">سجّل كمريض لعرض نتائج أكتر.</a></div>' : "";
  document.querySelector("#medicine-results").innerHTML = state.matches.length
    ? `${visibleMatches.map(renderMedicineCard).join("")}${guestNotice}`
    : `<div class="empty-results"><strong>مش لاقيين الدواء ده في ملف المصدر.</strong><br>جرّب اسمًا أو كودًا مختلفًا.</div>`;
}

const onboardingSlides = [
  { icon: "⌖", title: "منطقتك على راحتك", copy: "اختيار الموقع هيساعد لاحقًا في ترتيب الفروع. نسخة العرض الحالية لا تحتوي مواقع دقيقة للصيدليات." },
  { icon: "＋", title: "رتّب أدويتك", copy: "احفظ الأدوية المهمة لقائمة محلية على جهازك، من غير إرسالها لخادم." },
  { icon: "♧", title: "خليك على اطلاع", copy: "إشعارات التوفر تحتاج ربطًا مباشرًا بمخزون الصيدليات، وده غير مفعّل في نسخة العرض." },
];

function showOnboarding() {
  const welcome = new URLSearchParams(window.location.search).has("welcome");
  if (welcome) window.history.replaceState(null, "", `${window.location.pathname}#top`);
  if (!welcome || state.user?.role !== "patient") return;
  if (localStorage.getItem("dawaey-onboarding-done") === "yes") return;
  state.onboardingStep = 0;
  renderOnboarding();
  document.querySelector("#onboarding-dialog").showModal();
}

function renderOnboarding() {
  const step = onboardingSlides[state.onboardingStep];
  document.querySelector("#onboarding-progress").style.width = `${(state.onboardingStep + 1) / onboardingSlides.length * 100}%`;
  document.querySelector("#onboarding-content").innerHTML = `<div class="onboarding-copy"><span class="step-icon">${step.icon}</span><h2>${step.title}</h2><p>${step.copy}</p></div>`;
  document.querySelector("#onboarding-next").textContent = state.onboardingStep === onboardingSlides.length - 1 ? "ابدأ" : "التالي";
}

function setupVoiceSearch() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showToast("البحث الصوتي مش مدعوم في المتصفح ده");
    return;
  }
  if (state.recognition) {
    state.recognition.stop();
    return;
  }
  const recognition = new Recognition();
  state.recognition = recognition;
  recognition.lang = "ar-EG";
  recognition.interimResults = false;
  recognition.onresult = (event) => {
    searchInput.value = event.results[0][0].transcript;
    performSearch(searchInput.value);
  };
  recognition.onerror = () => showToast("ما قدرناش نسمع بوضوح، جرّب تكتب اسم الدواء");
  recognition.onend = () => { state.recognition = null; document.querySelector("#voice-search").classList.remove("is-listening"); };
  recognition.start();
  document.querySelector("#voice-search").classList.add("is-listening");
  showToast("سامعينك.. قول اسم الدواء");
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector("#theme-toggle").setAttribute("aria-label", theme === "dark" ? "التبديل للمظهر النهاري" : "التبديل للمظهر الليلي");
  try { localStorage.setItem("dawaey-theme", theme); } catch { /* Keep the selected theme for this page only. */ }
}

function setupTabs() {
  const panel = document.querySelector("#audience-panel");
  document.querySelectorAll("[data-audience]").forEach((tab) => tab.addEventListener("click", () => {
    const patient = tab.dataset.audience === "patient";
    document.querySelectorAll("[data-audience]").forEach((item) => {
      const active = item === tab;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    const pharmacyContent = `<div class="audience-symbol">✚</div><div><h3>إدارة أوضح للمخزون</h3><p>مساحة مخصصة للصيدلية لمتابعة الأصناف والطلبات، بعد ربط النظام ببيانات الفرع ومراجعته.</p><ul><li>عرض حالة المخزون حسب حدود الفرع</li><li>استقبال طلبات التحويل بين الصيدليات</li><li>توثيق الحساب قبل النشر</li></ul></div>`;
    const patientContent = `<div class="audience-symbol">💚</div><div><h3>معلومة أوضح قبل المشوار</h3><p>ابحث في الأصناف، احتفظ بأدويتك على جهازك، وتواصل مع الفروع المدرجة بدون ما نخلط بين دليل الفروع وسجل المخزون.</p><ul><li>بحث بالاسم والكود والفئة</li><li>حفظ محلي للأدوية اللي تهمك</li><li>إظهار حدود البيانات بوضوح</li></ul></div>`;
    panel.setAttribute("aria-labelledby", patient ? "patient-tab" : "pharmacy-tab");
    panel.innerHTML = patient ? patientContent : pharmacyContent;
  }));
}

function setupDemo() {
  const labels = { available: ["متاح", "متوفر"], low: ["كمية قليلة", "باقي كمية محدودة"], out: ["خلص", "غير متوفر"] };
  document.querySelectorAll("[data-demo]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-demo]").forEach((item) => item.classList.toggle("is-active", item === button));
    const [status, quantity] = labels[button.dataset.demo];
    const statusBadge = document.querySelector("#demo-status");
    statusBadge.textContent = status;
    statusBadge.className = `demo-status ${button.dataset.demo === "available" ? "" : button.dataset.demo}`;
    document.querySelector("#demo-quantity").textContent = quantity;
  }));
}

function setupObservers() {
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("is-visible");
    observer.unobserve(entry.target);
  }), { threshold: .12 });
  document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
  window.addEventListener("scroll", () => document.querySelector("#site-header").classList.toggle("is-scrolled", window.scrollY > 24), { passive: true });
}

function renderDonationResults(medicine, area) {
  const container = document.querySelector("#donation-results");
  const entries = getNearbyPharmacies(area).slice(0, 12);
  if (!medicine || !area) { container.innerHTML = "<p>اكتب اسم الدواء والمنطقة لعرض الصيدليات المسجلة.</p>"; return; }
  const matches = findMatches(medicine);
  const medicineName = matches[0]?.["اسم الدواء"] || medicine;
  if (!entries.length) { container.innerHTML = `<p>مش لاقيين صيدلية مسجلة في <strong>${escapeHtml(area)}</strong>. جرّب منطقة قريبة أو تواصل مع صيدلية موثوقة.</p>`; return; }
  container.innerHTML = `<div class="donation-result-title"><strong>فروع قريبة للتواصل بخصوص ${escapeHtml(medicineName)}</strong><small>${numberFormat.format(entries.length)} فرعًا مطابقًا للمنطقة</small></div>` + entries.map((pharmacy) => {
    const phone = String(pharmacy["رقم التليفون / الخط الساخن"] ?? "");
    const dial = (phone.split("/")[0].match(/[\d+()\-\s]+/)?.[0] ?? "").replace(/[^\d+]/g, "");
    return `<div class="donation-result"><span><strong>${escapeHtml(pharmacy["اسم الصيدلية"])}</strong><small>${escapeHtml(pharmacy["المنطقة / العنوان المتوقع"])}</small></span>${dial ? `<a href="tel:${escapeHtml(dial)}">اتصال</a>` : `<em>${escapeHtml(phone || "رقم غير مدرج")}</em>`}</div>`;
  }).join("");
}

function assistantReply(question) {
  const query = normalize(question);
  const medicine = getRecords().find((record) => {
    const name = normalize(record["اسم الدواء"]);
    return name && query.includes(name);
  }) || findMatches(question)[0];
  if (medicine) return `لقيت <strong>${escapeHtml(medicine["اسم الدواء"])}</strong>. المادة الفعالة المسجلة: <strong>${escapeHtml(medicine["المادة الفعالة"] || "غير محددة في المصدر")}</strong>، وتصنيفه: ${escapeHtml(medicine["طبيعة الدواء"] || "صنف دوائي")}. اسأل الصيدلي عن الملاءمة والجرعة.`;

  const emergencySymptoms = ["ضيق تنفس", "صعوبة تنفس", "ألم صدر", "فقدان وعي", "نزيف شديد", "تشنج", "حساسية شديدة", "تورم الوجه"];
  if (emergencySymptoms.some((symptom) => query.includes(normalize(symptom)))) return "دي علامة تستدعي مساعدة عاجلة. لا تنتظر اقتراح دواء من الشات؛ اتصل بالإسعاف 123 أو توجّه لأقرب طوارئ فورًا.";

  const advice = [
    { words: ["صداع", "وجع راس", "رأس", "الم راس", "ألم راس"], category: "ألم أو صداع", options: "من الخيارات الشائعة التي يمكن سؤال الصيدلي عنها: باراسيتامول مثل Panadol أو Adol" },
    { words: ["حراره", "سخنيه", "حمى", "سخونه", "درجة الحرارة"], category: "حرارة أو حمى", options: "يمكن سؤال الصيدلي عن باراسيتامول مثل Panadol أو Adol بعد قياس الحرارة" },
    { words: ["حساسيه", "رشح", "عطس", "حكة", "حكه", "انسداد الانف"], category: "حساسية أو رشح", options: "يمكن سؤال الصيدلي عن سيتريزين أو لوراتادين، مع التأكد من عدم وجود مانع للاستخدام" },
    { words: ["حموضه", "حرقان", "ارتجاع", "معدة", "المعدة"], category: "حموضة أو ارتجاع", options: "يمكن سؤال الصيدلي عن أدوية الحموضة مثل أوميبرازول أو مضاد حموضة مناسب" },
    { words: ["كحه", "كحة", "بلغم", "سعال"], category: "كحة أو سعال", options: "اسأل الصيدلي عن علاج مناسب حسب كون الكحة جافة أو مصحوبة ببلغم؛ لا تستخدم مضادًا حيويًا من نفسك" },
    { words: ["مغص", "تقلص", "تقلصات", "الم بطن", "ألم بطن"], category: "مغص أو تقلصات", options: "يمكن سؤال الصيدلي عن مضاد للتقلصات، لكن ألم البطن المستمر يحتاج تقييم السبب أولًا" },
    { words: ["التهاب حلق", "زور", "حلق", "الم حلق", "ألم حلق"], category: "ألم أو التهاب الحلق", options: "يمكن سؤال الصيدلي عن أقراص استحلاب ومسكن مناسب، ولا تبدأ مضادًا حيويًا دون كشف" },
    { words: ["غثيان", "ترجيع", "قيء"], category: "غثيان أو قيء", options: "اسأل الصيدلي عن خيار مناسب، واهتم بالسوائل؛ القيء المتكرر أو المصحوب بدم يحتاج طوارئ" },
    { words: ["اسهال", "إسهال"], category: "إسهال", options: "ابدأ بمحلول الإماهة بعد سؤال الصيدلي، واطلب تقييمًا طبيًا عند وجود دم أو جفاف أو حرارة عالية" },
  ];
  const matched = advice.find((item) => item.words.some((word) => query.includes(normalize(word))));
  if (matched) {
    const tokens = matched.options.split(/مثل|أو|،/).map((token) => normalize(token)).filter((token) => token.length > 3);
    const catalog = getRecords().filter((record) => {
      const text = `${normalize(record["اسم الدواء"])} ${normalize(record["طبيعة الدواء"])} ${normalize(record["المادة الفعالة"])}`;
      return text.includes(normalize(matched.category)) || tokens.some((token) => text.includes(token));
    }).slice(0, 4);
    const names = catalog.map((record) => `<strong>${escapeHtml(record["اسم الدواء"])}</strong>`).join("، ");
    return `أفهم إنك بتشتكي من <strong>${escapeHtml(matched.category)}</strong>.<br><strong>اقتراح مبدئي:</strong> ${matched.options}.${names ? `<br><strong>موجود في سجل دوائي:</strong> ${names}.` : ""}<br><small>ده توجيه عام وليس تشخيصًا أو وصفة. لا تستخدم أي دواء إذا عندك حمل، مرض مزمن، حساسية، أو إذا كان المريض طفلًا إلا بعد سؤال الطبيب أو الصيدلي. لو الأعراض شديدة أو مستمرة اطلب تقييمًا طبيًا.</small>`;
  }
  const areaMatch = question.match(/(?:في|بـ|ب|منطقة)\s+(.+)/i);
  if (query.includes("صيدلي") || query.includes("فرع") || query.includes("عنوان")) {
    const area = areaMatch?.[1]?.trim() || state.areaQuery;
    const entries = getNearbyPharmacies(area).slice(0, 10);
    if (entries.length) return `لقيت ${numberFormat.format(entries.length)} فروع مسجلة في ${escapeHtml(area)}. تواصل معهم قبل الذهاب للتأكد من الخدمة والتوفر.`;
    return "اكتب اسم المنطقة أو المحافظة بشكل أوضح، وسأبحث في دليل الفروع المسجلة.";
  }
  if (query.includes("جرع") || query.includes("تشخيص")) return "أقدر أوضح بيانات الدواء وأقترح فئة عامة فقط، لكن لا أحدد جرعة أو أشخّص. اسأل طبيبًا أو صيدليًا، ولو الحالة طارئة اتصل بـ123.";
  return "أقدر أساعدك في البحث عن دواء، المادة الفعالة، شكوى عامة مثل الصداع أو الحموضة، أو صيدلية حسب المنطقة. اكتب الأعراض بالتفصيل بدون بيانات شخصية.";
}
function addAssistantMessage(text, kind) {
  const messages = document.querySelector("#assistant-messages");
  if (!messages) return;
  const bubble = document.createElement("div"); bubble.className = `assistant-message ${kind}`; bubble.innerHTML = `<span>${text}</span>`; messages.appendChild(bubble); messages.scrollTop = messages.scrollHeight;
}

function setupDonationAndAssistant() {
  document.querySelector("#donation-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const medicine = document.querySelector("#donation-medicine").value.trim();
    const area = document.querySelector("#donation-area").value.trim();
    const quantity = document.querySelector("#donation-quantity").value.trim() || "غير محددة";
    renderDonationResults(medicine, area);
    try {
      const requests = JSON.parse(localStorage.getItem("dawaey-donation-requests") || "[]");
      requests.unshift({ id: `don-${Date.now()}`, medicine, area, quantity, createdAt: new Date().toISOString(), status: "pending" });
      localStorage.setItem("dawaey-donation-requests", JSON.stringify(requests.slice(0, 100)));
      const notice = document.querySelector("#donation-results");
      notice.insertAdjacentHTML("afterbegin", '<p class="donation-saved-note">تم تسجيل طلب التبرع ليظهر للصيدليات في هذه الصفحة.</p>');
    } catch { /* Local storage can be unavailable in private browsing. */ }
  });
  document.querySelector("#assistant-form")?.addEventListener("submit", (event) => { event.preventDefault(); const input = document.querySelector("#assistant-input"); const question = input.value.trim(); if (!question) return; addAssistantMessage(escapeHtml(question), "user"); addAssistantMessage(assistantReply(question), "assistant"); input.value = ""; });
  document.querySelectorAll("[data-assistant-prompt]").forEach((button) => button.addEventListener("click", () => { const input = document.querySelector("#assistant-input"); input.value = button.dataset.assistantPrompt; input.focus(); }));
}

function setupEvents() {
  document.querySelector("#medicine-search-form").addEventListener("submit", (event) => { event.preventDefault(); performSearch(searchInput.value); });
  document.querySelector("#web-search-arabic")?.addEventListener("click", () => {
    const query = searchInput.value.trim();
    if (!query) { showToast("اكتب اسم الدواء أولًا للبحث عنه على الويب بالعربي."); searchInput.focus(); return; }
    const webQuery = `${query} دواء المادة الفعالة الاستخدامات الصيدليات مصر`;
    const url = `https://www.google.com/search?hl=ar&gl=eg&q=${encodeURIComponent(webQuery)}`;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) window.location.href = url;
  });
  searchInput.addEventListener("input", () => renderSuggestions(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && !suggestionList.hidden) {
      event.preventDefault();
      suggestionList.querySelector(".suggestion-option[role=option]")?.focus();
    }
    if (event.key === "Escape") suggestionList.hidden = true;
  });
  suggestionList.addEventListener("click", (event) => {
    const suggestion = event.target.closest("[data-select-medicine]");
    if (!suggestion) return;
    searchInput.value = suggestion.dataset.selectMedicine;
    performSearch(searchInput.value);
  });
  document.querySelectorAll("[data-query]").forEach((button) => button.addEventListener("click", () => {
    searchInput.value = button.dataset.query;
    performSearch(searchInput.value);
  }));
  document.querySelector("#clear-search").addEventListener("click", () => {
    resultsSection.hidden = true;
    searchInput.value = "";
    searchInput.focus();
  });
  document.querySelector("#area-search").addEventListener("input", (event) => {
    state.areaQuery = event.target.value.trim();
    renderAreaResults(state.areaQuery);
    if (state.matches.length) renderMedicineResults();
  });
  document.querySelector("#nearby-filter").addEventListener("click", () => {
    document.querySelector("#area-search").focus();
    document.querySelector("#area-search").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  document.querySelector("#medicine-results").addEventListener("click", (event) => {
    if (!event.target.closest("[data-focus-area]")) return;
    document.querySelector("#area-search").focus();
    document.querySelector("#area-search").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  document.querySelector("#voice-search").addEventListener("click", setupVoiceSearch);
  document.querySelector("#medicine-photo").addEventListener("change", (event) => {
    if (event.target.files?.length) searchFromPhoto(event.target.files[0]);
    event.target.value = "";
  });
  document.querySelector("#use-location").addEventListener("click", () => {
    if (!navigator.geolocation) { showToast("المتصفح مش بيدعم تحديد الموقع"); return; }
    showToast("بنحدد المنطقة التقريبية من OpenStreetMap...");
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const parameters = new URLSearchParams({ lat: String(coords.latitude), lon: String(coords.longitude) });
        const response = await fetch(`${API_BASE}/api/area?${parameters}`, { credentials: "include" });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.area) throw new Error(result.error || "area unavailable");
        const area = result.area;
        state.areaQuery = area;
        document.querySelector("#area-search").value = area;
        renderAreaResults(area);
        if (state.matches.length) renderMedicineResults();
        showToast(`لقينا الفروع المسجلة في ${area}. توافر الدواء محتاج تأكيد بالاتصال.`);
      } catch (error) {
        showToast(error.message || "اكتب اسم المنطقة يدويًا عشان نلاقي الفروع المسجلة.");
        document.querySelector("#area-search").focus();
      }
    }, () => showToast("الموقع غير متاح؛ اكتب اسم المنطقة يدويًا"), { timeout: 7000, maximumAge: 60000 });
  });
  const openEmergency = () => document.querySelector("#emergency-dialog")?.showModal();
  document.querySelector("#emergency-top")?.addEventListener("click", openEmergency);
  document.querySelector("#emergency-button")?.addEventListener("click", openEmergency);
  document.querySelectorAll("[data-action]").forEach((card) => {
    const activate = () => { if (card.dataset.action === "search") { searchInput.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); } else if (card.dataset.action === "source") { document.querySelector("#medicine-info")?.scrollIntoView({ behavior: "smooth" }); } else { document.querySelector("#for-everyone")?.scrollIntoView({ behavior: "smooth" }); } };
    card.addEventListener("click", activate); card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } });
  });
  document.querySelector("#theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  document.querySelector("#command-search").addEventListener("input", (event) => {
    const query = event.target.value.trim();
    const matches = query ? findMatches(query).slice(0, 8) : [];
    document.querySelector("#command-results").innerHTML = matches.map((record) => `<button type="button" class="command-item" data-command-select="${escapeHtml(record["اسم الدواء"])}"><strong>${escapeHtml(record["اسم الدواء"])}</strong><small>${escapeHtml(record["طبيعة الدواء"] || record["الكود"] || "دواء")}</small></button>`).join("") || '<span class="dialog-hint">ابدأ بكتابة اسم الدواء</span>';
  });
  document.querySelector("#command-results").addEventListener("click", (event) => {
    const item = event.target.closest("[data-command-select]");
    if (!item) return;
    document.querySelector("#command-dialog").close();
    searchInput.value = item.dataset.commandSelect;
    performSearch(searchInput.value);
  });
  document.querySelector("#command-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      document.querySelector("#command-dialog").close();
      performSearch(event.target.value);
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      document.querySelector("#command-dialog").showModal();
      document.querySelector("#command-search").focus();
    }
    if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      searchInput.focus();
    }
  });
  document.querySelector("#onboarding-next").addEventListener("click", () => {
    if (state.onboardingStep === onboardingSlides.length - 1) { document.querySelector("#onboarding-dialog").close(); return; }
    state.onboardingStep += 1;
    renderOnboarding();
  });
  document.querySelector("#onboarding-skip").addEventListener("click", () => document.querySelector("#onboarding-dialog").close());
  document.querySelector("#onboarding-dialog").addEventListener("close", () => {
    try { localStorage.setItem("dawaey-onboarding-done", "yes"); } catch { /* The tour remains dismissible without storage. */ }
  });
  document.querySelector("#medicine-results").addEventListener("click", (event) => {
    const infoCard = event.target.closest(".medicine-result");
    if (infoCard && !event.target.closest("button, a")) { const index = [...document.querySelectorAll(".medicine-result")].indexOf(infoCard); if (state.matches[index]) renderMedicineInfo(state.matches[index]); return; }
    const button = event.target.closest("[data-save-medicine]");
    if (!button) return;
    const key = String(button.dataset.saveMedicine);
    if (state.saved.has(key)) state.saved.delete(key);
    else state.saved.add(key);
    try { localStorage.setItem("dawaey-saved-medications", JSON.stringify([...state.saved])); } catch { showToast("تعذر الحفظ على الجهاز"); }
    button.setAttribute("aria-pressed", String(state.saved.has(key)));
    button.textContent = state.saved.has(key) ? "★ محفوظ في أدويتي" : "☆ أضف لأدويتي";
    updateSavedList();
  });
  document.querySelector("#saved-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-saved]");
    if (!button) return;
    state.saved.delete(String(button.dataset.removeSaved));
    try { localStorage.setItem("dawaey-saved-medications", JSON.stringify([...state.saved])); } catch { /* Keep this change in memory. */ }
    updateSavedList();
  });
}

async function loadStaticCatalog() {
  const response = await fetch("data/dawaey-data.json", { cache: "no-store" });
  if (!response.ok) throw new Error("تعذر تحميل ملف بيانات الأدوية");
  const workbook = await response.json();
  const sheets = workbook.sheets || {};
  const inventory = sheets[INVENTORY_SHEET] || [];
  const supply = sheets[SUPPLY_SHEET] || [];
  const pharmacies = sheets[PHARMACY_SHEET] || [];
  const supplyByNumber = new Map(supply.map((record) => [String(record["م"]), record]));
  return {
    catalog: inventory.map((item) => ({ ...item, ...(supplyByNumber.get(String(item["م"])) || {}) })),
    pharmacies,
  };
}

async function start() {
  let data;
  let session = { user: null };
  try {
    const response = await fetch(apiUrl("bootstrap"), { credentials: "include" });
    if (!response.ok) throw new Error("API unavailable");
    data = await response.json();
  } catch {
    try {
      data = await loadStaticCatalog();
      showToast("تم تحميل بيانات الأدوية من الملف المحلي");
    } catch {
      showToast("بيانات البحث غير متاحة؛ تأكد من رفع مجلد data مع الموقع");
    }
  }
  try {
    const response = await fetch(apiUrl("session"), { credentials: "include" });
    if (response.ok) session = await response.json();
  } catch {
    // Static hosting has no session API; the patient search remains available.
  }
  if (data) {
    state.inventory = data.catalog ?? [];
    state.pharmacies = data.pharmacies ?? [];
    state.user = session.user ?? null;
    updateStats();
    updateSavedList();
    renderAreaResults();
    const loginLink = document.querySelector(".login-link");
    if (loginLink && state.user) {
      loginLink.textContent = state.user.name;
      loginLink.setAttribute("aria-label", `حساب ${state.user.name}`);
    }
  }
  setupTabs();
  setupDemo();
  setupObservers();
  setupEvents();
  setupDonationAndAssistant();
  try {
    const savedTheme = localStorage.getItem("dawaey-theme");
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme);
    const saved = JSON.parse(localStorage.getItem("dawaey-saved-medications") ?? "[]");
    state.saved = new Set(saved.map(String));
    updateSavedList();
  } catch { /* The default theme and empty list still work without storage. */ }
  if (state.user?.role === "patient") {
    document.querySelector(".hero-copy h1").innerHTML = `أهلاً بيك يا ${escapeHtml(state.user.name)}<br><span>دواءك أقرب.</span>`;
  }
  showOnboarding();
}

start();