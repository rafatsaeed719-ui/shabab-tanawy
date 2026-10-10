import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, sendPasswordResetEmail, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, addDoc, collection, query, where,
  orderBy, limit, onSnapshot, serverTimestamp, Bytes
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ================= الإعدادات الثابتة =================
   مواعيد الاجتماع بالدقايق من نص الليل (توقيت القاهرة)
   القيم دي الافتراضية، وقائد الاجتماع يقدر يغيرها من التطبيق (بتتحفظ في config/app) */
const DAYS = ["", "الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت", "الحد"]; // نفس ترقيم قواعد الأمان
const SCH = { day: 5, start: 19 * 60, greenEnd: 19 * 60 + 5, yellowEnd: 19 * 60 + 40, end: 21 * 60 };
let START = SCH.start, END = SCH.end;
const LEVELS = {
  green:  { name: "أخضر", pts: 10, until: SCH.greenEnd },
  yellow: { name: "أصفر", pts: 5,  until: SCH.yellowEnd },
  red:    { name: "أحمر", pts: 0,  until: SCH.end }
};
function applySchedule(d = {}) {
  for (const k of Object.keys(SCH)) if (Number.isInteger(d[k])) SCH[k] = d[k];
  START = SCH.start; END = SCH.end;
  LEVELS.green.until = SCH.greenEnd; LEVELS.yellow.until = SCH.yellowEnd; LEVELS.red.until = SCH.end;
  renderScheduleTexts();
}
function fmtMins(m) {
  const h = Math.floor(m / 60), mi = m % 60, h12 = ((h + 11) % 12) + 1;
  return `${ar(h12)}:${ar(mi).padStart(2, "٠")} ${h < 12 ? "ص" : "م"}`;
}
function renderScheduleTexts() {
  $("meet-when").textContent = `كل أسبوع يوم ${DAYS[SCH.day]} · من ${fmtMins(SCH.start)} لـ ${fmtMins(SCH.end)}`;
  $("meet-note").textContent = `أخضر لحد ${fmtMins(SCH.greenEnd)} · أصفر لحد ${fmtMins(SCH.yellowEnd)} · أحمر لحد ${fmtMins(SCH.end)}`;
  if (S.user) { renderAttCard(); renderHome(); }
  fillScheduleForm();
}

/* ================= Firebase ================= */
const $ = (id) => document.getElementById(id);
const cfg = window.FIREBASE_CONFIG || {};
if (!cfg.apiKey || cfg.apiKey.startsWith("PUT_")) {
  $("splash-msg").textContent = "التطبيق محتاج يتربط بمشروع Firebase الأول (ملف config.js).";
  throw new Error("Firebase config missing");
}
const fbApp = initializeApp(cfg);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const SNAP = { serverTimestamps: "estimate" };

/* ================= أدوات ================= */
const ar = (n) => Number(n || 0).toLocaleString("ar-EG");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CAIRO = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Cairo", year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric", weekday: "short", hourCycle: "h23"
});
function cairoNow(d = new Date()) {
  const p = Object.fromEntries(CAIRO.formatToParts(d).map((x) => [x.type, x.value]));
  const y = +p.year, mo = +p.month, da = +p.day, h = +p.hour % 24, mi = +p.minute, s = +p.second;
  const wall = Date.UTC(y, mo - 1, da, h, mi, s);
  return {
    y, mo, da, h, mi, s,
    dow: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday],
    mins: h * 60 + mi,
    secs: h * 3600 + mi * 60 + s,
    dayKey: `${y}-${mo}-${da}`,                       // نفس الشكل اللي في قواعد الأمان
    offset: Math.round((wall - (d.getTime() - d.getMilliseconds())) / 3600000)
  };
}
function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}
const signed = (n) => `<bdi dir="ltr">${n < 0 ? "−" + ar(-n) : "+" + ar(n)}</bdi>`;
const keyNum = (k) => { const [y, m, d] = k.split("-").map(Number); return y * 10000 + m * 100 + d; };
function timeLabel(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit", timeZone: "Africa/Cairo" });
}
function mmss(totalSec) {
  totalSec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  const two = (n) => ar(n).padStart(2, "٠");
  return h ? `${ar(h)}:${two(m)}:${two(s)}` : `${ar(m)}:${two(s)}`;
}
let toastT;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200);
}
function sheet(html, bind) {
  $("sheet-body").innerHTML = html;
  $("sheet").hidden = false;
  bind?.($("sheet-body"));
}
function closeSheet() { $("sheet").hidden = true; $("sheet-body").innerHTML = ""; }
// زرار الرجوع في الموبايل: يقفل النافذة المفتوحة الأول، وبعدين يرجع للحضور
window.__back = () => {
  if (!$("sheet").hidden) { closeSheet(); return true; }
  const home = document.querySelector('#tabs button[data-v="home"]');
  if (!$("app").hidden && $("v-home").hidden) { home.click(); return true; }
  return false;
};
$("sheet").addEventListener("click", (e) => { if (e.target.id === "sheet" || e.target.dataset.close != null) closeSheet(); });

/* ================= الحالة ================= */
const S = {
  user: null, isAdmin: false,
  myAtt: [], myAdj: [], mySubs: [], messages: [], tasks: [], photos: [], events: [],
  allUsers: [], allAtt: [], allAdj: [], allSubs: [], admins: new Set()
};
let unsubs = [];
let adminUnsubs = [];
const stop = (arr) => { arr.forEach((u) => u()); arr.length = 0; };

/* ================= الدخول ================= */
let mode = "login";
function setMode(m) {
  mode = m;
  $("tab-login").classList.toggle("on", m === "login");
  $("tab-signup").classList.toggle("on", m === "signup");
  $("name-row").hidden = m !== "signup";
  $("auth-submit").textContent = m === "login" ? "دخول" : "إنشاء الحساب";
  $("f-pass").autocomplete = m === "login" ? "current-password" : "new-password";
  $("forgot").hidden = m !== "login";
  $("auth-err").hidden = true;
}
$("tab-login").onclick = () => setMode("login");
$("tab-signup").onclick = () => setMode("signup");

const AUTH_ERR = {
  "auth/invalid-email": "الإيميل مكتوب غلط.",
  "auth/invalid-credential": "الإيميل أو الباسورد غلط. لو دي أول مرة تدخل، اضغط \"حساب جديد\" فوق واعمل حسابك الأول.",
  "auth/operation-not-allowed": "الدخول بالإيميل لسه متفعلش في Firebase (Authentication ← Email/Password).",
  "auth/wrong-password": "الباسورد غلط.",
  "auth/user-not-found": "مفيش حساب بالإيميل ده. اعمل حساب جديد.",
  "auth/email-already-in-use": "الإيميل ده عليه حساب بالفعل. ادخل من \"دخول\".",
  "auth/weak-password": "الباسورد لازم يبقى ٦ حروف أو أرقام على الأقل.",
  "auth/network-request-failed": "مفيش إنترنت. اتأكد من الاتصال وجرب تاني.",
  "auth/too-many-requests": "محاولات كتير. استنى شوية وجرب تاني."
};
function showAuthErr(e) {
  $("auth-err").textContent = AUTH_ERR[e?.code] || "حصلت مشكلة، جرب تاني.";
  $("auth-err").hidden = false;
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("f-email").value.trim(), pass = $("f-pass").value, name = $("f-name").value.trim();
  if (mode === "signup" && name.length < 3) { $("auth-err").textContent = "اكتب اسمك بالكامل."; $("auth-err").hidden = false; return; }
  $("auth-submit").disabled = true;
  try {
    if (mode === "login") {
      await signInWithEmailAndPassword(auth, email, pass);
    } else {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(db, "users", cred.user.uid), { name, email, createdAt: serverTimestamp() });
    }
  } catch (err) { showAuthErr(err); }
  $("auth-submit").disabled = false;
});
$("forgot").onclick = async () => {
  const email = $("f-email").value.trim();
  if (!email) { $("auth-err").textContent = "اكتب إيميلك الأول وبعدين دوس نسيت الباسورد."; $("auth-err").hidden = false; return; }
  try { await sendPasswordResetEmail(auth, email); toast("بعتنالك رسالة على الإيميل لتغيير الباسورد."); }
  catch (err) { showAuthErr(err); }
};

onAuthStateChanged(auth, async (u) => {
  stop(unsubs); stop(adminUnsubs);
  $("splash").hidden = true;
  if (!u) { S.user = null; $("app").hidden = true; $("auth").hidden = false; return; }
  S.user = u;
  $("auth").hidden = true; $("app").hidden = false;
  $("hello").textContent = `أهلاً ${(u.displayName || "").split(" ")[0] || ""}`;
  // تأكيد وجود ملف العضو
  try {
    const ref = doc(db, "users", u.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) await setDoc(ref, { name: u.displayName || u.email, email: u.email, createdAt: serverTimestamp() });
    else if (snap.data().name) $("hello").textContent = `أهلاً ${snap.data().name.split(" ")[0]}`;
  } catch (_) { /* هيتعاد في الدخول الجاي */ }
  startListeners();
});

/* ================= الاستماع للبيانات ================= */
function startListeners() {
  const uid = S.user.uid;
  unsubs.push(onSnapshot(query(collection(db, "attendance"), where("uid", "==", uid)), (s) => {
    const all = s.docs.map((d) => ({ id: d.id, ...d.data(SNAP) })).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));
    S.myAtt = all.filter((a) => a.kind !== "adjust");
    S.myAdj = all.filter((a) => a.kind === "adjust");
    renderHome();
  }));
  unsubs.push(onSnapshot(query(collection(db, "submissions"), where("uid", "==", uid)), (s) => {
    S.mySubs = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderHome(); renderTasks();
  }));
  unsubs.push(onSnapshot(collection(db, "tasks"), (s) => {
    S.tasks = s.docs.map((d) => ({ id: d.id, ...d.data(SNAP) })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderTasks(); renderReview();
  }));
  unsubs.push(onSnapshot(query(collection(db, "photos"), orderBy("createdAt", "desc"), limit(60)), (s) => {
    S.photos = s.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    renderPhotos();
  }));
  unsubs.push(onSnapshot(collection(db, "events"), (s) => {
    S.events = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderEvents();
  }));
  unsubs.push(onSnapshot(doc(db, "config", "app"), (s) => applySchedule(s.exists() ? s.data() : {}), () => {}));
  let firstMsgs = true;
  unsubs.push(onSnapshot(query(collection(db, "messages"), orderBy("createdAt", "desc"), limit(30)), (s) => {
    S.messages = s.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    if (!firstMsgs && !s.metadata.hasPendingWrites && s.docChanges().some((c) => c.type === "added") && $("v-messages").hidden) toast("وصلتك رسالة جديدة من قائد الاجتماع");
    firstMsgs = false;
    renderMessages();
    if (!$("v-messages").hidden) markMessagesRead(); else updateBadge();
  }));
  if (location.hash === "#messages") document.querySelector('#tabs button[data-v="messages"]').click();
  // هل المستخدم ده مسؤول؟
  const mainAdmin = (S.user.email || "").toLowerCase() === (window.ADMIN_EMAIL || "").toLowerCase();
  unsubs.push(onSnapshot(doc(db, "admins", uid), (s) => setAdmin(mainAdmin || s.exists()), () => setAdmin(mainAdmin)));
}

function setAdmin(on) {
  if (on === S.isAdmin) return;
  S.isAdmin = on;
  document.querySelectorAll(".admin-only").forEach((el) => (el.hidden = !on));
  document.querySelector(".total").hidden = on; // القائد مش بيجمع نقاط
  stop(adminUnsubs);
  if (!on) return;
  syncClockOffset();
  adminUnsubs.push(onSnapshot(collection(db, "users"), (s) => { S.allUsers = s.docs.map((d) => ({ id: d.id, ...d.data() })); renderAdmin(); }));
  adminUnsubs.push(onSnapshot(collection(db, "attendance"), (s) => {
    const all = s.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    S.allAtt = all.filter((a) => a.kind !== "adjust");
    S.allAdj = all.filter((a) => a.kind === "adjust");
    renderAdmin();
  }));
  adminUnsubs.push(onSnapshot(collection(db, "submissions"), (s) => { S.allSubs = s.docs.map((d) => ({ id: d.id, ...d.data(SNAP) })); renderAdmin(); renderTasks(); }));
  adminUnsubs.push(onSnapshot(collection(db, "admins"), (s) => { S.admins = new Set(s.docs.map((d) => d.id)); renderAdmin(); }));
  renderTasks(); renderPhotos(); renderEvents(); renderMessages();
}

// قواعد الأمان بتحسب توقيت القاهرة من فرق الساعات المحفوظ هنا (بيتغير مع التوقيت الصيفي)
async function syncClockOffset() {
  const off = cairoNow().offset;
  try {
    const ref = doc(db, "config", "app");
    const s = await getDoc(ref);
    if (!s.exists() || s.data().utcOffset !== off) await setDoc(ref, { utcOffset: off }, { merge: true });
  } catch (_) {}
}

/* ================= التبويبات ================= */
document.querySelectorAll("#tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "v-" + b.dataset.v));
    window.scrollTo(0, 0);
    if (b.dataset.v === "messages") markMessagesRead(); else updateBadge();
  };
});

/* ================= الحضور ================= */
function todayRecord() {
  const k = cairoNow().dayKey;
  return S.myAtt.find((a) => a.day === k);
}
function nextMeetingSeconds(now) {
  // ثواني لحد بداية الاجتماع الجاي
  let days = (SCH.day - now.dow + 7) % 7;
  if (days === 0 && now.mins >= START) days = 7;
  return days * 86400 + START * 60 - now.secs;
}

function renderAttCard() {
  const c = $("att-card");
  if (!S.user) return;
  const now = cairoNow();
  const rec = todayRecord();
  const open = now.dow === SCH.day && now.mins >= START && now.mins < END;

  if (rec) {
    const L = LEVELS[rec.color] || LEVELS.red;
    c.innerHTML = `
      <p class="eyebrow">${esc(dayLabel(rec.day))}</p>
      <p class="big">تم تسجيل حضورك</p>
      <div class="done-badge ${rec.color}">
        <span class="dot ${rec.color}" style="width:18px;height:18px;border-radius:50%"></span>
        <div style="flex:1"><strong>${L.name}</strong><br><small>الساعة ${esc(timeLabel(rec.at))}</small></div>
        <strong>${signed(rec.points)}</strong>
      </div>`;
    return;
  }

  if (!open) {
    const left = nextMeetingSeconds(now);
    const days = Math.floor(left / 86400);
    c.innerHTML = `
      <p class="eyebrow">التسجيل مقفول دلوقتي</p>
      <p class="big">بيفتح ${DAYS[SCH.day]} الساعة ${fmtMins(SCH.start)}</p>
      <p class="clock">${days >= 1 ? `${ar(days)} ${days === 1 ? "يوم" : days === 2 ? "يومين" : "أيام"}` : mmss(left)}</p>
      <p class="muted" style="margin:0">${days >= 1 ? "فاضل على الاجتماع" : "فاضل على فتح التسجيل"}</p>`;
    return;
  }

  const items = Object.entries(LEVELS).map(([key, L]) => {
    const closed = now.mins >= L.until;
    const leftSec = L.until * 60 - now.secs;
    const when = closed ? "قفل" : `يقفل بعد ${mmss(leftSec)}`;
    return `<button class="choice ${closed ? "closed" : key}" data-c="${key}" ${closed ? "disabled" : ""} type="button">
      <span class="dot"></span>
      <span><span class="lbl">${L.name}</span><br><span class="when">${when}</span></span>
      <span class="pts">${ar(L.pts)}</span>
    </button>`;
  }).join("");
  c.innerHTML = `
    <p class="eyebrow">${esc(dayLabel(now.dayKey))} · التسجيل مفتوح</p>
    <p class="big">سجّل حضورك</p>
    <div class="choices">${items}</div>`;
  c.querySelectorAll(".choice:not(:disabled)").forEach((b) => (b.onclick = () => confirmAttend(b.dataset.c)));
}

function confirmAttend(color) {
  const L = LEVELS[color];
  sheet(`
    <h3>تأكيد الحضور</h3>
    <p style="margin:0">هتسجّل حضورك <b>${L.name}</b> وتاخد <b>${ar(L.pts)}</b> نقط. مينفعش تغيّره بعد كده.</p>
    <div class="actions"><button class="btn ghost" data-close type="button">رجوع</button><button class="btn primary" id="go" type="button">تأكيد</button></div>`,
  (el) => {
    el.querySelector("#go").onclick = async (e) => {
      e.target.disabled = true;
      const now = cairoNow();
      try {
        await setDoc(doc(db, "attendance", `${now.dayKey}_${S.user.uid}`), {
          uid: S.user.uid, day: now.dayKey, color, points: L.pts, at: serverTimestamp()
        });
        closeSheet(); toast(`تم تسجيل حضورك ${L.name} ✓`);
      } catch (err) {
        closeSheet();
        toast(err?.code === "permission-denied" ? "الاختيار ده قفل أو اتسجلت قبل كده." : "مفيش اتصال، جرب تاني.");
      }
    };
  });
}

function renderHome() {
  renderAttCard();
  const cnt = { green: 0, yellow: 0, red: 0 };
  let attPts = 0;
  S.myAtt.forEach((a) => { cnt[a.color] = (cnt[a.color] || 0) + 1; attPts += a.points || 0; });
  const extra = S.mySubs.filter((s) => s.status === "approved").reduce((t, s) => t + (s.points || 0), 0)
    + S.myAdj.reduce((t, a) => t + (a.points || 0), 0);
  $("total-pts").textContent = ar(attPts + extra);
  $("breakdown").innerHTML = `
    <div class="bd green"><b>${ar(cnt.green * 10)}</b><span>أخضر · ${ar(cnt.green)} مرة</span></div>
    <div class="bd yellow"><b>${ar(cnt.yellow * 5)}</b><span>أصفر · ${ar(cnt.yellow)} مرة</span></div>
    <div class="bd red"><b>${ar(0)}</b><span>أحمر · ${ar(cnt.red)} مرة</span></div>
    <div class="bd white"><b>${ar(extra)}</b><span>نقاط إضافية</span></div>`;
  const hist = [...S.myAtt, ...S.myAdj].sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));
  $("history").innerHTML = hist.length
    ? hist.map((a) => a.kind === "adjust"
      ? `<li><span class="dot white"></span><span class="d">${a.points < 0 ? "خصم" : "نقاط"} من القائد${a.reason ? " · " + esc(a.reason) : ""}</span><span class="p">${signed(a.points)}</span></li>`
      : `<li><span class="dot ${a.color}"></span><span class="d">${esc(dayLabel(a.day))}</span><span class="p">${signed(a.points)}</span></li>`).join("")
    : `<li><span class="d muted">لسه مسجلتش حضور. أول اجتماع جاي يوم ${DAYS[SCH.day]} الساعة ${fmtMins(SCH.start)}!</span></li>`;
}
setInterval(() => { if (!$("v-home").hidden && !$("app").hidden) renderAttCard(); }, 1000);

/* ================= الصور ================= */
function renderPhotos() {
  $("gallery").innerHTML = S.photos.map((p, i) => `
    <button class="ph" data-i="${i}" type="button"><img src="${p.img}" alt="${esc(p.caption || "صورة من الاجتماع")}" loading="lazy">
    ${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ""}</button>`).join("");
  $("gallery-empty").hidden = S.photos.length > 0;
  $("gallery").querySelectorAll(".ph").forEach((b) => (b.onclick = () => openPhoto(S.photos[+b.dataset.i])));
}
function openPhoto(p) {
  const d = p.createdAt?.toDate ? p.createdAt.toDate().toLocaleDateString("ar-EG", { day: "numeric", month: "long", year: "numeric" }) : "";
  sheet(`
    <div class="viewer"><img src="${p.img}" alt=""></div>
    ${p.caption ? `<p style="margin:0;font-weight:600">${esc(p.caption)}</p>` : ""}
    <p class="muted" style="margin:0">${esc(d)}</p>
    <div class="actions">
      ${S.isAdmin ? `<button class="btn danger" id="del" type="button">حذف الصورة</button>` : ""}
      <button class="btn ghost" data-close type="button">قفل</button>
    </div>`, (el) => {
    const del = el.querySelector("#del");
    if (del) del.onclick = async () => { await deleteDoc(doc(db, "photos", p.id)); closeSheet(); toast("اتحذفت الصورة."); };
  });
}
function compress(file, max = 1280, q = 0.72) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      let out = c.toDataURL("image/jpeg", q);
      if (out.length > 900000) out = c.toDataURL("image/jpeg", 0.5);
      URL.revokeObjectURL(img.src);
      res(out);
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
$("photo-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const caption = $("photo-caption").value.trim();
  let done = 0;
  for (const f of files) {
    $("photo-progress").textContent = `بيرفع ${ar(done + 1)} من ${ar(files.length)}…`;
    try { await addDoc(collection(db, "photos"), { img: await compress(f), caption, createdAt: serverTimestamp() }); done++; }
    catch (_) { toast("صورة منهم مترفعتش."); }
  }
  $("photo-progress").textContent = "";
  $("photo-caption").value = ""; e.target.value = "";
  toast(`اترفع ${ar(done)} صورة.`);
});

/* ================= المواعيد ================= */
const KIND = { meeting: "اجتماع", activity: "نشاط", trip: "رحلة" };
function renderEvents() {
  const nowMs = Date.now() - 6 * 3600 * 1000;
  const list = [...S.events].sort((a, b) => new Date(a.when) - new Date(b.when));
  const up = list.filter((e) => new Date(e.when).getTime() >= nowMs);
  const past = list.filter((e) => new Date(e.when).getTime() < nowMs).reverse().slice(0, 5);
  const row = (e, isPast) => {
    const d = new Date(e.when);
    const day = d.toLocaleDateString("ar-EG", { day: "numeric" });
    const mon = d.toLocaleDateString("ar-EG", { month: "short" });
    const full = d.toLocaleDateString("ar-EG", { weekday: "long" }) + " · " + d.toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit" });
    return `<li class="ev ${isPast ? "past" : ""} ${editingEvent === e.id ? "editing" : ""}">
      <div class="date"><b>${esc(day)}</b><small>${esc(mon)}</small></div>
      <div class="body">
        <h3>${esc(e.title)}<span class="tag">${KIND[e.kind] || "نشاط"}</span></h3>
        <p>${esc(full)}${e.place ? " · " + esc(e.place) : ""}</p>
        ${e.details ? `<p class="details">${esc(e.details)}</p>` : ""}
        ${S.isAdmin ? `<div class="admin-btns"><button class="btn small ghost" data-edit="${e.id}" type="button">تعديل</button><button class="btn small danger" data-del="${e.id}" type="button">حذف</button></div>` : ""}
      </div></li>`;
  };
  $("events").innerHTML = up.map((e) => row(e, false)).join("") + past.map((e) => row(e, true)).join("");
  $("events-empty").hidden = up.length + past.length > 0;
  $("events").querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => startEditEvent(b.dataset.edit)));
  $("events").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => sheet(`
    <h3>حذف الميعاد؟</h3><p style="margin:0">هيتمسح عند كل الشباب.</p>
    <div class="actions"><button class="btn ghost" data-close type="button">رجوع</button><button class="btn danger" id="go" type="button">حذف</button></div>`,
    (el) => (el.querySelector("#go").onclick = async () => {
      await deleteDoc(doc(db, "events", b.dataset.del));
      if (editingEvent === b.dataset.del) stopEditEvent();
      closeSheet(); toast("اتحذف الميعاد.");
    }))));
}

// تعديل ميعاد موجود: الفورم فوق بيتملي ببياناته، والزرار يبقى "حفظ التعديل"
let editingEvent = null;
function startEditEvent(id) {
  const ev = S.events.find((x) => x.id === id);
  if (!ev) return;
  editingEvent = id;
  const [d, t] = String(ev.when || "").split("T");
  $("e-title").value = ev.title || "";
  $("e-kind").value = ev.kind || "activity";
  $("e-date").value = d || "";
  $("e-time").value = (t || "").slice(0, 5);
  $("e-place").value = ev.place || "";
  $("e-details").value = ev.details || "";
  $("e-head").textContent = "تعديل الميعاد";
  $("e-submit").textContent = "حفظ التعديل";
  $("e-cancel").hidden = false;
  renderEvents();
  $("event-form").scrollIntoView({ behavior: "smooth", block: "start" });
}
function stopEditEvent() {
  editingEvent = null;
  $("event-form").reset();
  $("e-head").textContent = "إضافة ميعاد أو نشاط";
  $("e-submit").textContent = "إضافة";
  $("e-cancel").hidden = true;
  renderEvents();
}
$("e-cancel").onclick = stopEditEvent;
$("event-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("e-title").value.trim(), date = $("e-date").value, time = $("e-time").value;
  if (!title || !date || !time) return toast("اكتب العنوان واختار اليوم والساعة.");
  const data = { title, when: `${date}T${time}`, kind: $("e-kind").value, place: $("e-place").value.trim(), details: $("e-details").value.trim() };
  $("e-submit").disabled = true;
  try {
    if (editingEvent) {
      await updateDoc(doc(db, "events", editingEvent), data);
      toast("اتعدل الميعاد ✓");
    } else {
      await addDoc(collection(db, "events"), { ...data, createdAt: serverTimestamp() });
      toast("اتضاف الميعاد ✓");
    }
    stopEditEvent();
  } catch (_) { toast("مقدرناش نحفظ. اتأكد من الإنترنت."); }
  $("e-submit").disabled = false;
});

/* ================= اكسب نقاط ================= */
function renderTasks() {
  const mine = Object.fromEntries(S.mySubs.map((s) => [s.taskId, s]));
  const visible = S.isAdmin ? S.tasks : S.tasks.filter((t) => t.active !== false || mine[t.id]);
  $("tasks").innerHTML = visible.map((t) => {
    const s = mine[t.id];
    let foot = "";
    if (s?.status === "approved") foot = `<div class="state approved">إجابتك اتقبلت · ${signed(s.points)} نقطة</div>`;
    else if (s?.status === "rejected") foot = `<div class="state rejected">إجابتك متقبلتش المرة دي</div>`;
    else if (s) foot = `<div class="state pending">إجابتك وصلت ومستنية المراجعة</div>`;
    else if (t.active === false) foot = `<div class="state rejected">السؤال ده خلص</div>`;
    else foot = `<form data-t="${t.id}"><textarea rows="3" placeholder="اكتب إجابتك هنا" required></textarea><button class="btn primary" type="submit">إرسال الإجابة</button></form>`;
    let admin = "";
    if (S.isAdmin) {
      const n = S.allSubs.filter((x) => x.taskId === t.id).length;
      admin = `<div class="admin-row">
        <span class="muted" style="flex:1">${ar(n)} إجابة</span>
        <button class="btn small ghost" data-toggle="${t.id}" type="button">${t.active === false ? "إعادة فتح" : "قفل السؤال"}</button>
        <button class="btn small danger" data-deltask="${t.id}" type="button">حذف</button></div>`;
    }
    return `<li class="task"><div class="task-head"><p class="task-q">${esc(t.body)}</p><span class="wpill">${signed(t.points)}</span></div>${S.isAdmin ? admin : foot}</li>`;
  }).join("");
  $("tasks-empty").hidden = visible.length > 0;
  $("tasks").querySelectorAll("form[data-t]").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const answer = f.querySelector("textarea").value.trim();
    if (!answer) return;
    f.querySelector("button").disabled = true;
    try {
      await setDoc(doc(db, "submissions", `${f.dataset.t}_${S.user.uid}`), {
        uid: S.user.uid, taskId: f.dataset.t, answer, status: "pending", points: 0, createdAt: serverTimestamp()
      });
      toast("وصلت إجابتك ✓");
    } catch (_) { toast("مقدرناش نبعت الإجابة. جرب تاني."); f.querySelector("button").disabled = false; }
  }));
  $("tasks").querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = () => {
    const t = S.tasks.find((x) => x.id === b.dataset.toggle);
    updateDoc(doc(db, "tasks", t.id), { active: t.active === false });
  }));
  $("tasks").querySelectorAll("[data-deltask]").forEach((b) => (b.onclick = () => sheet(`
    <h3>حذف السؤال؟</h3><p style="margin:0">النقاط اللي اتاخدت منه هتفضل محسوبة.</p>
    <div class="actions"><button class="btn ghost" data-close type="button">رجوع</button><button class="btn danger" id="go" type="button">حذف</button></div>`,
    (el) => (el.querySelector("#go").onclick = async () => { await deleteDoc(doc(db, "tasks", b.dataset.deltask)); closeSheet(); }))));
}
$("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = $("t-body").value.trim(), points = parseInt($("t-points").value, 10);
  if (!body || !(points > 0)) return toast("اكتب السؤال وعدد النقاط.");
  await addDoc(collection(db, "tasks"), { body, points, active: true, createdAt: serverTimestamp() });
  e.target.reset(); $("t-points").value = 5; toast("اتنشر السؤال.");
});

/* ================= الإدارة ================= */
document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".seg-pane").forEach((p) => (p.hidden = p.id !== "seg-" + b.dataset.seg));
}));
const nameOf = (uid) => S.allUsers.find((u) => u.id === uid)?.name || "عضو";

function totals() {
  const t = {};
  S.allUsers.forEach((u) => (t[u.id] = { att: 0, extra: 0, g: 0, y: 0, r: 0 }));
  S.allAtt.forEach((a) => { const x = (t[a.uid] ||= { att: 0, extra: 0, g: 0, y: 0, r: 0 }); x.att += a.points || 0; x[a.color?.[0]]++; });
  S.allSubs.filter((s) => s.status === "approved").forEach((s) => { (t[s.uid] ||= { att: 0, extra: 0, g: 0, y: 0, r: 0 }).extra += s.points || 0; });
  S.allAdj.forEach((a) => { (t[a.uid] ||= { att: 0, extra: 0, g: 0, y: 0, r: 0 }).extra += a.points || 0; });
  return t;
}

function renderReview() {
  if (!S.isAdmin) return;
  const pending = S.allSubs.filter((s) => s.status === "pending").sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  $("review-count").textContent = pending.length ? `(${ar(pending.length)})` : "";
  $("seg-review").innerHTML = pending.length ? `<div style="display:grid;gap:10px">${pending.map((s) => {
    const t = S.tasks.find((x) => x.id === s.taskId);
    return `<div class="review">
      <strong>${esc(nameOf(s.uid))}</strong>
      <p class="q">${esc(t?.body || "سؤال اتحذف")}</p>
      <p class="a">${esc(s.answer)}</p>
      <div class="actions">
        <input type="number" min="0" value="${t?.points ?? 0}" aria-label="النقاط" data-pts="${s.id}">
        <button class="btn small primary" data-ok="${s.id}" type="button">قبول</button>
        <button class="btn small danger" data-no="${s.id}" type="button">رفض</button>
      </div></div>`;
  }).join("")}</div>` : `<p class="empty">مفيش إجابات مستنية مراجعة.</p>`;
  $("seg-review").querySelectorAll("[data-ok]").forEach((b) => (b.onclick = () => {
    const pts = Math.max(0, parseInt($("seg-review").querySelector(`[data-pts="${b.dataset.ok}"]`).value, 10) || 0);
    updateDoc(doc(db, "submissions", b.dataset.ok), { status: "approved", points: pts });
  }));
  $("seg-review").querySelectorAll("[data-no]").forEach((b) => (b.onclick = () => updateDoc(doc(db, "submissions", b.dataset.no), { status: "rejected", points: 0 })));
}

function renderAdmin() {
  if (!S.isAdmin) return;
  renderReview();
  // حضور النهارده (أو آخر جمعة)
  const now = cairoNow();
  const days = [...new Set(S.allAtt.map((a) => a.day))];
  const key = days.includes(now.dayKey) ? now.dayKey : days.sort((a, b) => keyNum(b) - keyNum(a))[0];
  const list = S.allAtt.filter((a) => a.day === key).sort((a, b) => (a.at?.seconds || 0) - (b.at?.seconds || 0));
  const c = { green: 0, yellow: 0, red: 0 }; list.forEach((a) => c[a.color]++);
  $("seg-today").innerHTML = key ? `
    <p class="eyebrow">${esc(dayLabel(key))}${key === now.dayKey ? " · النهارده" : " · آخر اجتماع"}</p>
    <div class="counts">
      <span><i class="dot green"></i>${ar(c.green)}</span><span><i class="dot yellow"></i>${ar(c.yellow)}</span>
      <span><i class="dot red"></i>${ar(c.red)}</span><span>الإجمالي ${ar(list.length)}</span>
    </div>
    <ul class="rows">${list.map((a) => `<li><span class="dot ${a.color}"></span><span class="n">${esc(nameOf(a.uid))}</span><span class="muted">${esc(timeLabel(a.at))}</span></li>`).join("")}</ul>`
    : `<p class="empty">لسه محدش سجل حضور.</p>`;

  // الأعضاء مرتبين بالنقاط
  const t = totals();
  const members = [...S.allUsers].sort((a, b) => (t[b.id].att + t[b.id].extra) - (t[a.id].att + t[a.id].extra));
  $("seg-members").innerHTML = `<p class="eyebrow">${ar(members.length)} عضو · مرتبين بالنقاط · اضغط على أي اسم عشان تضيف أو تخصم نقاط</p><ul class="rows">${members.map((u, i) => {
    const x = t[u.id];
    return `<li data-u="${u.id}" style="cursor:pointer">
      <span class="muted" style="width:22px">${ar(i + 1)}</span>
      <span class="n">${esc(u.name)}${S.admins.has(u.id) ? ' <span class="tag">خادم</span>' : ""}<small>${ar(x.g)} أخضر · ${ar(x.y)} أصفر · ${ar(x.r)} أحمر · ${signed(x.extra)} إضافي</small></span>
      <span class="score">${ar(x.att + x.extra)}</span></li>`;
  }).join("")}</ul>`;
  $("seg-members").querySelectorAll("[data-u]").forEach((li) => (li.onclick = () => memberSheet(li.dataset.u)));
}

function memberSheet(uid) {
  const u = S.allUsers.find((x) => x.id === uid);
  const isAdm = S.admins.has(uid);
  const now = cairoNow();
  const has = S.allAtt.some((a) => a.uid === uid && a.day === now.dayKey);
  const tt = totals()[uid];
  const adj = S.allAdj.filter((a) => a.uid === uid).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0)).slice(0, 8);
  sheet(`
    <h3>${esc(u.name)}</h3>
    <p class="muted" style="margin:0" dir="ltr">${esc(u.email || "")}</p>
    <p style="margin:0"><b style="font-size:22px;font-family:var(--display)">${ar(tt.att + tt.extra)}</b> نقطة</p>
    <p class="eyebrow" style="margin-top:6px">إضافة أو خصم نقاط</p>
    <div class="row2">
      <input type="number" id="adj-n" min="1" max="1000" value="5" aria-label="عدد النقاط">
      <input type="text" id="adj-r" placeholder="السبب (اختياري)">
    </div>
    <div class="actions">
      <button class="btn primary" id="adj-add" type="button">إضافة +</button>
      <button class="btn danger" id="adj-sub" type="button">خصم −</button>
    </div>
    ${adj.length ? `<ul class="rows">${adj.map((a) => `<li><span class="n">${signed(a.points)}<small>${esc(a.reason || "بدون سبب")}</small></span><button class="btn small ghost" data-undo="${a.id}" type="button">إلغاء</button></li>`).join("")}</ul>` : ""}
    ${has ? `<p class="muted" style="margin:0">حضوره النهارده متسجل.</p>` : `
      <p class="eyebrow" style="margin-top:6px">تسجيل حضور النهارده يدوي</p>
      <div class="actions">
        <button class="btn small" style="background:var(--green-soft);color:var(--green)" data-m="green" type="button">أخضر ١٠</button>
        <button class="btn small" style="background:var(--yellow-soft);color:var(--yellow)" data-m="yellow" type="button">أصفر ٥</button>
        <button class="btn small" style="background:var(--red-soft);color:var(--red)" data-m="red" type="button">أحمر ٠</button>
      </div>`}
    ${uid !== S.user.uid ? `<button class="btn ghost" id="adm" type="button">${isAdm ? "شيل صلاحية الخادم" : "خليه خادم (يقدر يدير التطبيق)"}</button>` : ""}
    <button class="btn ghost" data-close type="button">قفل</button>`, (el) => {
    const adjust = async (sign) => {
      const n = parseInt(el.querySelector("#adj-n").value, 10);
      if (!(n > 0)) return toast("اكتب عدد النقاط.");
      const reason = el.querySelector("#adj-r").value.trim();
      try {
        await addDoc(collection(db, "attendance"), { kind: "adjust", uid, points: sign * n, reason, at: serverTimestamp() });
        toast(`${sign > 0 ? "اتضاف" : "اتخصم"} ${ar(n)} نقطة لـ ${u.name}`);
        memberSheet(uid);
      } catch (_) { toast("مقدرناش نحفظ. اتأكد من الإنترنت."); }
    };
    el.querySelector("#adj-add").onclick = () => adjust(1);
    el.querySelector("#adj-sub").onclick = () => adjust(-1);
    el.querySelectorAll("[data-undo]").forEach((b) => (b.onclick = async () => {
      await deleteDoc(doc(db, "attendance", b.dataset.undo));
      toast("اتلغت."); setTimeout(() => memberSheet(uid), 300);
    }));
    el.querySelectorAll("[data-m]").forEach((b) => (b.onclick = async () => {
      const L = LEVELS[b.dataset.m];
      await setDoc(doc(db, "attendance", `${now.dayKey}_${uid}`), { uid, day: now.dayKey, color: b.dataset.m, points: L.pts, at: serverTimestamp(), manual: true });
      closeSheet(); toast("اتسجل الحضور.");
    }));
    const adm = el.querySelector("#adm");
    if (adm) adm.onclick = async () => {
      if (isAdm) await deleteDoc(doc(db, "admins", uid)); else await setDoc(doc(db, "admins", uid), { email: u.email || "", at: serverTimestamp() });
      closeSheet();
    };
  });
}

// تسجيل الخروج
$("logout").onclick = () => sheet(`
  <h3>تسجيل الخروج؟</h3>
  <div class="actions"><button class="btn ghost" data-close type="button">رجوع</button><button class="btn danger" id="out" type="button">خروج</button></div>`,
  (el) => (el.querySelector("#out").onclick = () => { closeSheet(); signOut(auth); }));

/* ================= الرسائل =================
   الفيديو بيتقسم أجزاء (كل جزء أقل من ١ ميجا) جوه Firestore عشان يفضل على الخطة المجانية.
   meta/latest بيقول للموبايلات (حتى والتطبيق مقفول) إن فيه رسالة جديدة عشان يطلع إشعار. */
const CHUNK = 900 * 1024;
const MAX_VIDEO = 60 * 1024 * 1024;
let pendingImg = "", pendingVid = null;
const videoCache = {};
const msgTime = (m) => (m.createdAt?.toMillis ? m.createdAt.toMillis() : 0);
const mb = (n) => `${ar((n / 1048576).toFixed(1))} ميجا`;
const safeLink = (u) => (/^https?:\/\/\S+$/i.test(u || "") ? u : "");
function getLastRead() { try { return +localStorage.getItem("msgs-last-read") || 0; } catch (_) { return 0; } }
function setLastRead(v) { try { localStorage.setItem("msgs-last-read", String(v)); } catch (_) {} }
function nativeSeen(id) { try { window.Android && window.Android.markSeen(id); } catch (_) {} }

function updateBadge() {
  const seen = getLastRead();
  const n = S.messages.filter((m) => msgTime(m) > seen).length;
  const b = $("msg-badge");
  b.textContent = ar(n);
  b.hidden = !n || !$("v-messages").hidden;
}
function markMessagesRead() {
  const latest = S.messages[0];
  if (latest) { setLastRead(Math.max(getLastRead(), msgTime(latest))); nativeSeen(latest.id); }
  updateBadge();
}

function renderMessages() {
  $("msgs").innerHTML = S.messages.map((m) => {
    const when = m.createdAt?.toDate ? m.createdAt.toDate().toLocaleString("ar-EG", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }) : "";
    const link = safeLink(m.link);
    return `<li class="msg">
      <div class="meta"><b>قائد الاجتماع</b><span>${esc(when)}</span></div>
      ${m.text ? `<p class="txt">${esc(m.text)}</p>` : ""}
      ${m.img ? `<img src="${m.img}" alt="صورة مع الرسالة" loading="lazy">` : ""}
      ${m.video ? `<div data-vid="${m.id}"><button class="vid-btn" type="button"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>تشغيل الفيديو · ${mb(m.video.size)}</button></div>` : ""}
      ${link ? `<a class="lnk" href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a>` : ""}
      ${S.isAdmin ? `<button class="btn small danger" data-delmsg="${m.id}" type="button" style="justify-self:start">حذف الرسالة</button>` : ""}
    </li>`;
  }).join("");
  $("msgs-empty").hidden = S.messages.length > 0;
  $("msgs").querySelectorAll("[data-vid]").forEach((box) => {
    const m = S.messages.find((x) => x.id === box.dataset.vid);
    if (videoCache[m.id]) box.innerHTML = `<video src="${videoCache[m.id]}" controls playsinline></video>`;
    else box.querySelector("button").onclick = () => loadVideo(m, box);
  });
  $("msgs").querySelectorAll("[data-delmsg]").forEach((b) => (b.onclick = () => sheet(`
    <h3>حذف الرسالة؟</h3><p style="margin:0">هتتمسح عند كل الشباب.</p>
    <div class="actions"><button class="btn ghost" data-close type="button">رجوع</button><button class="btn danger" id="go" type="button">حذف</button></div>`,
    (el) => (el.querySelector("#go").onclick = async () => {
      const m = S.messages.find((x) => x.id === b.dataset.delmsg);
      closeSheet();
      try {
        for (let i = 0; i < (m.video?.chunks || 0); i++) await deleteDoc(doc(db, "messages", m.id, "chunks", String(i)));
        await deleteDoc(doc(db, "messages", m.id));
        toast("اتحذفت الرسالة.");
      } catch (_) { toast("مقدرناش نحذف. اتأكد من الإنترنت."); }
    }))));
}

async function loadVideo(m, box) {
  box.innerHTML = `<div class="progress"><span></span></div><p class="muted" style="margin:6px 0 0">بيحمّل الفيديو… ${mb(m.video.size)}</p>`;
  const bar = box.querySelector(".progress span");
  try {
    const parts = [];
    for (let i = 0; i < m.video.chunks; i++) {
      const snap = await getDoc(doc(db, "messages", m.id, "chunks", String(i)));
      parts.push(snap.data().d.toUint8Array());
      bar.style.width = `${Math.round(((i + 1) / m.video.chunks) * 100)}%`;
    }
    const url = URL.createObjectURL(new Blob(parts, { type: m.video.type || "video/mp4" }));
    videoCache[m.id] = url;
    box.innerHTML = `<video src="${url}" controls playsinline autoplay></video>`;
  } catch (_) {
    box.innerHTML = `<button class="vid-btn" type="button">مقدرناش نحمّل الفيديو · جرب تاني</button>`;
    box.querySelector("button").onclick = () => loadVideo(m, box);
  }
}

function attachInfo() {
  const parts = [];
  if (pendingImg) parts.push("صورة جاهزة ✓");
  if (pendingVid) parts.push(`فيديو ${mb(pendingVid.size)} ✓`);
  $("m-info").textContent = parts.join(" · ");
}
$("m-img").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { pendingImg = await compress(f); } catch (_) { toast("الصورة دي مش مدعومة."); pendingImg = ""; }
  attachInfo();
});
$("m-vid").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > MAX_VIDEO) { toast(`الفيديو أكبر من ${mb(MAX_VIDEO)}. ابعته على واتساب لنفسك الأول عشان يصغر، أو حط لينك يوتيوب.`); e.target.value = ""; return; }
  pendingVid = f; attachInfo();
});

$("msg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("m-text").value.trim();
  const rawLink = $("m-link").value.trim();
  const link = rawLink && !/^https?:\/\//i.test(rawLink) ? "https://" + rawLink : rawLink;
  if (!text && !pendingImg && !pendingVid && !link) return toast("اكتب رسالة أو اختار صورة أو فيديو.");
  const btn = $("m-send"), prog = $("m-prog"), bar = prog.querySelector("span");
  btn.disabled = true; prog.hidden = false; bar.style.width = "3%";
  try {
    const ref = doc(collection(db, "messages"));
    let video = null;
    if (pendingVid) {
      btn.textContent = "بيرفع الفيديو…";
      const buf = new Uint8Array(await pendingVid.arrayBuffer());
      const chunks = Math.ceil(buf.length / CHUNK);
      for (let i = 0; i < chunks; i++) {
        await setDoc(doc(db, "messages", ref.id, "chunks", String(i)), { d: Bytes.fromUint8Array(buf.subarray(i * CHUNK, (i + 1) * CHUNK)) });
        bar.style.width = `${Math.round(((i + 1) / chunks) * 95)}%`;
      }
      video = { chunks, size: buf.length, type: pendingVid.type || "video/mp4" };
    }
    await setDoc(ref, { text, img: pendingImg, link: safeLink(link), video, createdAt: serverTimestamp() });
    const preview = text || (video ? "فيديو جديد 🎬" : pendingImg ? "صورة جديدة 📷" : "لينك جديد");
    await setDoc(doc(db, "meta", "latest"), { id: ref.id, preview: preview.slice(0, 140), at: Date.now() });
    nativeSeen(ref.id);
    bar.style.width = "100%";
    e.target.reset(); pendingImg = ""; pendingVid = null; attachInfo();
    toast("اتبعتت الرسالة للكل ✓");
  } catch (_) {
    toast("الرسالة متبعتتش. اتأكد من الإنترنت وجرب تاني.");
  }
  btn.disabled = false; btn.textContent = "إرسال للكل";
  setTimeout(() => { prog.hidden = true; bar.style.width = "0"; }, 800);
});

/* ================= مواعيد الاجتماع (لقائد الاجتماع) ================= */
const toMins = (v) => { const [h, m] = (v || "").split(":").map(Number); return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : NaN; };
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
function fillScheduleForm() {
  if (!$("sch-day") || document.activeElement?.closest?.("#sch-form")) return;
  $("sch-day").value = String(SCH.day);
  $("sch-start").value = toTime(SCH.start);
  $("sch-green").value = toTime(SCH.greenEnd);
  $("sch-yellow").value = toTime(SCH.yellowEnd);
  $("sch-end").value = toTime(SCH.end);
}
$("sch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = {
    day: parseInt($("sch-day").value, 10),
    start: toMins($("sch-start").value),
    greenEnd: toMins($("sch-green").value),
    yellowEnd: toMins($("sch-yellow").value),
    end: toMins($("sch-end").value)
  };
  if (Object.values(d).some((v) => !Number.isInteger(v))) return toast("اختار كل المواعيد.");
  if (!(d.start < d.greenEnd && d.greenEnd <= d.yellowEnd && d.yellowEnd <= d.end)) {
    return toast("الترتيب لازم يبقى: البداية ← الأخضر ← الأصفر ← النهاية.");
  }
  try {
    await setDoc(doc(db, "config", "app"), { ...d, utcOffset: cairoNow().offset }, { merge: true });
    toast("اتحفظت المواعيد ✓ وهتطبق عند كل الشباب");
  } catch (_) { toast("مقدرناش نحفظ. اتأكد إن قواعد الأمان متحدثة والإنترنت شغال."); }
});
renderScheduleTexts();
