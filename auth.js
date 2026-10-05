const state = { role: "patient", mode: "login", busy: false };
let staticSiteMode = false;
const form = document.querySelector("#account-form");
const message = document.querySelector("#form-message");
const submitButton = document.querySelector("#submit-button");
const numberFormat = new Intl.NumberFormat("ar-EG");
const API_BASE = (window.DAWAEY_API_BASE ?? ((location.hostname === "localhost" || location.hostname === "127.0.0.1") ? "" : "https://dawaey-production.up.railway.app")).replace(/\/+$/, "");
const apiUrl = (path) => `${API_BASE}/api/${path}`;

function setMessage(text, kind = "error") {
  message.textContent = text;
  message.classList.toggle("is-success", kind === "success");
  message.hidden = !text;
}

function clearFieldErrors() {
  form.querySelectorAll("[aria-invalid='true']").forEach((field) => field.removeAttribute("aria-invalid"));
  setMessage("");
}

function visibleRequired(field) {
  return !field.closest("[hidden]");
}

function syncForm() {
  const registering = state.mode === "register";
  document.body.dataset.authMode = state.mode;
  document.querySelectorAll("[data-register-only]").forEach((element) => {
    const wrongRole = element.dataset.roleFields && element.dataset.roleFields !== state.role;
    element.hidden = !registering || Boolean(wrongRole);
  });

  form.querySelectorAll("[data-required]").forEach((field) => {
    field.required = visibleRequired(field);
  });

  document.querySelectorAll(".role-option").forEach((button) => {
    const active = button.dataset.role === state.role;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll(".auth-mode [data-mode]").forEach((button) => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });

  const contactLabel = document.querySelector("#contact-label");
  const contactInput = form.elements.contact;
  contactLabel.textContent = state.role === "pharmacy" ? "رقم الموبايل المسجل للصيدلية" : "الموبايل أو البريد الإلكتروني";
  contactInput.type = state.role === "pharmacy" ? "tel" : "text";
  contactInput.inputMode = state.role === "pharmacy" ? "tel" : "text";
  contactInput.placeholder = state.role === "pharmacy" ? "01xxxxxxxxx" : "01xxxxxxxxx أو name@email.com";
  form.elements.password.autocomplete = registering ? "new-password" : "current-password";
  document.querySelector("#password-strength").hidden = !registering;
  document.querySelector("#review-note").hidden = !(registering && state.role === "pharmacy");
  document.querySelector("#submit-button").innerHTML = `${registering ? "إنشاء الحساب" : "تسجيل الدخول"} <span aria-hidden="true">←</span>`;
  document.querySelector("#auth-title").textContent = registering ? "حسابك يبدأ من هنا" : "سجّل دخولك";
  document.querySelector("#auth-description").textContent = registering
    ? state.role === "pharmacy" ? "قدّم بيانات الفرع للمراجعة قبل تفعيل الحساب." : "اكتب بياناتك مرة واحدة عشان تحفظ أدويتك." 
    : "ادخل بيانات حسابك للمتابعة في دوائي.";
  document.querySelector("#mode-footnote").textContent = registering
    ? "بيانات التسجيل تُحفظ في قاعدة دوائي الآمنة، وكلمة المرور لا تُحفظ كنص مباشر."
    : "الدخول متاح من الخادم أو كوضع عرض محفوظ على جهازك.";
  clearFieldErrors();
}

function updatePasswordStrength() {
  const password = form.elements.password.value;
  const panel = document.querySelector("#password-strength");
  const length = password.length;
  let score = 0;
  if (length >= 8) score += 1;
  if (length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  const labels = ["اكتب كلمة مرور", "ضعيفة", "مقبولة", "قوية", "قوية جدًا"];
  panel.dataset.level = String(score);
  panel.querySelector(".strength-track i").style.width = `${score * 25}%`;
  panel.querySelector("small").textContent = labels[score];
}

function fillLocationSuggestions(pharmacies) {
  const addresses = [...new Set(pharmacies.map((record) => String(record["المنطقة / العنوان المتوقع"] ?? "").trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, "ar"));
  const districts = [...new Set(addresses.map((address) => address.split(/\s*[-–/]\s*/).at(-1).trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, "ar"));
  const governorates = [...new Set(addresses.map((address) => address.split(/\s*[-–/]\s*/)[0].replace(/^محافظة\s*/, "").trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, "ar"));
  document.querySelector("#district-options").innerHTML = districts.map((district) => `<option value="${escapeHtml(district)}"></option>`).join("");
  document.querySelector("#governorate-options").innerHTML = governorates.map((governorate) => `<option value="${escapeHtml(governorate)}"></option>`).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

async function requestApi(path, payload) {
  const response = await fetch(apiUrl(path), {
    method: payload ? "POST" : "GET",
    credentials: "include",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "تعذر الاتصال بخدمة دوائي.");
  return result;
}

function showAccount(user) {
  form.hidden = true;
  document.querySelector(".role-picker").hidden = true;
  document.querySelector(".auth-mode").hidden = true;
  const panel = document.querySelector("#signed-in-panel");
  const isPharmacy = user.role === "pharmacy";
  panel.innerHTML = `<h2>أهلاً ${escapeHtml(user.name)}</h2><p>${isPharmacy ? `حساب ${escapeHtml(user.pharmacyName || "الصيدلية")} في انتظار موافقة إدارة دوائي.` : "تم تسجيل دخولك. تقدر ترجع للبحث وتكمل من حيث وصلت."}</p><span class="${isPharmacy ? "pending-mark" : "pending-mark"}">${isPharmacy ? "قيد المراجعة" : "حساب مريض"}</span><div class="signed-in-actions"><a href="home.html${isPharmacy ? "#for-everyone" : "#my-medicines"}">العودة إلى دوائي</a><button type="button" id="logout-button">تسجيل الخروج</button></div>`;
  panel.hidden = false;
  document.querySelector("#auth-title").textContent = isPharmacy ? "طلب الصيدلية" : "تم تسجيل الدخول";
  document.querySelector("#auth-description").textContent = isPharmacy ? "هنتواصل معاك بعد مراجعة البيانات." : `الحساب مرتبط بـ ${user.contact}.`;
}

function showPendingApplication(pharmacyName) {
  form.hidden = true;
  document.querySelector(".role-picker").hidden = true;
  document.querySelector(".auth-mode").hidden = true;
  const panel = document.querySelector("#signed-in-panel");
  panel.innerHTML = `<span class="pending-mark">طلب قيد المراجعة</span><h2>وصلنا طلب ${escapeHtml(pharmacyName)}</h2><p>حفظنا بيانات الصيدلية في قاعدة البيانات المحلية. الطلب لن يظهر في دليل الفروع أو يسجل دخولًا قبل موافقة الإدارة.</p><div class="signed-in-actions"><a href="home.html">العودة إلى دوائي</a><button type="button" id="back-to-login">رجوع لتسجيل الدخول</button></div>`;
  panel.hidden = false;
  document.querySelector("#auth-title").textContent = "طلب الصيدلية";
  document.querySelector("#auth-description").textContent = "استلام الطلب لا يعني اعتماد بيانات الفرع.";
}

function restoreForm() {
  document.querySelector("#signed-in-panel").hidden = true;
  document.querySelector(".role-picker").hidden = false;
  document.querySelector(".auth-mode").hidden = false;
  form.hidden = false;
  state.mode = "login";
  syncForm();
}

function setBusy(busy) {
  state.busy = busy;
  submitButton.disabled = busy;
  submitButton.querySelector("span").textContent = busy ? "..." : "←";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFieldErrors();
  const visibleFields = [...form.querySelectorAll("input")].filter((field) => visibleRequired(field));
  const invalid = visibleFields.find((field) => !field.checkValidity());
  if (invalid) {
    invalid.setAttribute("aria-invalid", "true");
    setMessage(invalid.type === "checkbox" ? "وافق على حفظ بيانات الحساب لإكمال التسجيل." : "راجع الحقل المحدد واكتب بيانات صحيحة.");
    invalid.focus();
    return;
  }

  const formData = new FormData(form);
  const password = String(formData.get("password") ?? "");
  if (state.mode === "register" && password !== formData.get("passwordConfirm")) {
    form.elements.passwordConfirm.setAttribute("aria-invalid", "true");
    setMessage("كلمتا المرور مش متطابقتين.");
    form.elements.passwordConfirm.focus();
    return;
  }

  const payload = {
    role: state.role,
    fullName: String(formData.get("fullName") ?? "").trim(),
    contact: String(formData.get("contact") ?? "").trim(),
    password,
  };
  if (state.mode === "register") {
    payload.privacyAccepted = formData.get("privacyAccepted") === "yes";
    const locationPrefix = state.role === "patient" ? "patient" : "pharmacy";
    payload.governorate = String(formData.get(`${locationPrefix}Governorate`) ?? "").trim();
    payload.district = String(formData.get(`${locationPrefix}District`) ?? "").trim();
    if (state.role === "pharmacy") {
      Object.assign(payload, {
        pharmacyName: String(formData.get("pharmacyName") ?? "").trim(),
        pharmacistName: String(formData.get("pharmacistName") ?? "").trim(),
        licenseNumber: String(formData.get("licenseNumber") ?? "").trim(),
        address: String(formData.get("address") ?? "").trim(),
        openingHours: String(formData.get("openingHours") ?? "").trim(),
        whatsapp: String(formData.get("whatsapp") ?? "").trim(),
      });
    }
  }

  setBusy(true);
  try {
    if (state.mode === "register" && state.role === "pharmacy") {
      const response = await requestApi("register", payload);
      showPendingApplication(payload.pharmacyName);
      setMessage(response.message, "success");
    } else {
      const response = await requestApi(state.mode === "register" ? "register" : "login", state.mode === "register" ? { ...payload, privacyAccepted: payload.privacyAccepted } : { role: state.role, contact: payload.contact, password: payload.password });
      if (response.user) window.location.assign("home.html?welcome=1#top");
    }
  } catch (error) {
    if (staticSiteMode) {
      const localUser = { role: payload.role, name: payload.fullName || "مستخدم دوائي", contact: payload.contact, pharmacyName: payload.pharmacyName || "" };
      try { localStorage.setItem("dawaey-static-user", JSON.stringify(localUser)); } catch { /* Continue in memory if storage is unavailable. */ }
      if (state.role === "pharmacy" && state.mode === "register") showPendingApplication(payload.pharmacyName || "الصيدلية");
      else window.location.assign("home.html?welcome=1#top");
    } else {
      setMessage(error.message || "حصلت مشكلة في الاتصال. جرّب تاني.");
    }
  } finally {
    setBusy(false);
  }
});

document.querySelectorAll(".role-option").forEach((button) => button.addEventListener("click", () => {
  state.role = button.dataset.role;
  syncForm();
}));

document.querySelectorAll(".auth-mode [data-mode]").forEach((button) => button.addEventListener("click", () => {
  state.mode = button.dataset.mode;
  syncForm();
}));

form.elements.password.addEventListener("input", updatePasswordStrength);
form.addEventListener("input", (event) => {
  if (event.target.matches("[aria-invalid='true']")) event.target.removeAttribute("aria-invalid");
  if (event.target.name === "password") updatePasswordStrength();
});

document.querySelector(".password-toggle").addEventListener("click", (event) => {
  const input = form.elements.password;
  input.type = input.type === "password" ? "text" : "password";
  event.currentTarget.textContent = input.type === "password" ? "إظهار" : "إخفاء";
  event.currentTarget.setAttribute("aria-label", input.type === "password" ? "إظهار كلمة المرور" : "إخفاء كلمة المرور");
});

document.addEventListener("click", async (event) => {
  if (event.target.closest("#back-to-login")) restoreForm();
  if (!event.target.closest("#logout-button")) return;
  try {
    await requestApi("logout", {});
    restoreForm();
  } catch (error) {
    setMessage(error.message || "تعذر تسجيل الخروج.");
  }
});

async function initializeAuth() {
  const savedTheme = localStorage.getItem("dawaey-theme");
  if (savedTheme === "dark" || savedTheme === "light") document.documentElement.dataset.theme = savedTheme;
  syncForm();
  try {
    const [bootstrap, session] = await Promise.all([requestApi("bootstrap"), requestApi("session")]);
    fillLocationSuggestions(bootstrap.pharmacies ?? []);
    if (session.user) showAccount(session.user);
  } catch {
    staticSiteMode = !API_BASE;
    try {
      const response = await fetch("data/dawaey-data.json", { cache: "no-store" });
      const workbook = await response.json();
      fillLocationSuggestions(workbook.sheets?.["بيانات الصيداليات"] ?? []);
    } catch {
      // Location suggestions are optional in static mode.
    }
    try {
      const localUser = JSON.parse(localStorage.getItem("dawaey-static-user") || "null");
      if (localUser) showAccount(localUser);
      else setMessage("وضع العرض: اكتب بياناتك للدخول التجريبي ومتابعة البحث.", "success");
    } catch {
      setMessage("وضع العرض: اكتب بياناتك للدخول التجريبي ومتابعة البحث.", "success");
    }
  }
}

initializeAuth();
