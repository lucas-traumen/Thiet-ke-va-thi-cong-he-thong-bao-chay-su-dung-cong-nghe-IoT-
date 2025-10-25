
// --- BƯỚC QUAN TRỌNG ---
// 1. Nạp code Arduino "MQTT-Only" (code tôi gửi trước đó).
// 2. Mở Serial Monitor (115200).
// 3. Tìm dòng "DeviceID: xxxxxxxxxxxx"
// 4. Copy 12 ký tự (ID) đó VÀ DÁN VÀO DÒNG DƯỚI:

const DEVICE_ID = "64036C3B015C"; // <--- THAY THẾ ID NÀY BẰNG ID MỚI CỦA BẠN (TỪ chipIdHex)

const MAX_CHART_POINTS = 60;
const CHART_MIN_INTERVAL_MS = 1000;
const HISTORY_LIMIT = 50; 

const DEBUG = true; 
const log = (...args) => DEBUG && console.log(...args);
const warn = (...args) => DEBUG && console.warn(...args);

// --- Firebase Config ---
const firebaseConfig = {
  apiKey: "AIzaSyAR4QPsF0XDu_yfH3V7U_unGlOYJfBFiSI",
  authDomain: "firealarmsystem-aa15d.firebaseapp.com",
  databaseURL: "https://firealarmsystem-aa15d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "firealarmsystem-aa15d",
  storageBucket: "firealarmsystem-aa15d.firebasestorage.app",
  messagingSenderId: "559845349851",
  appId: "1:559845349851:web:6a66d9528f1e6b068deffe",
  measurementId: "G-32F66N6Y1R"
};

log("[APP] V7.1 (Firebase-Only, Fixed) Start - DEVICE_ID=", DEVICE_ID);

// --- Firebase init ---
try {
  firebase.initializeApp(firebaseConfig);
  log("[APP] ✅ Firebase initialized");
} catch (e) {
  console.error("[APP] ❌ Firebase init failed:", e);
}
const db = firebase.database();

log("[APP] ℹ️ MQTT Client đã bị loại bỏ. Dashboard chỉ làm việc với Firebase.");

// --- DOM Refs ---
const placeholder = document.getElementById("single-device-placeholder");
const tmpl = document.getElementById("device-template");
const bookContainer = document.getElementById("book-container");
const chartsTitle = document.getElementById("charts-title");
const btnBack = document.getElementById("btn-back-to-dash");
const historyModal = document.getElementById("history-modal");
const closeHistoryBtn = document.getElementById("close-history");
const historyContent = document.getElementById("history-content");
const historyTitle = document.getElementById("history-title");

let cardNode = null;
let ui = {
  idEl: null, statusEl: null,
  tempEl: null, humEl: null, smokeEl: null, rorEl: null, alarmEl: null,
  ackEl: null,
  btnCharts: null, btnHistory: null,
  btnLedOn: null, btnLedOff: null, btnLedAuto: null,
  btnBuzzerOn: null, btnBuzzerOff: null
};
let chartTemp = null, chartHum = null, chartSmoke = null;
let lastChartPushTs = 0;
let pendingChartTelemetry = null;

function makeChart(ctxId, label, borderColor, bgColor) {
  const el = document.getElementById(ctxId);
  if (!el) return null;
  const ctx = el.getContext("2d");
  return new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [{ label, data: [], borderColor, backgroundColor: bgColor, tension: 0.3, fill: true, pointRadius: 2 }] },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        scales: {
            x: { ticks: { color: "#ddd" }, grid: { color: "rgba(255,255,255,0.06)" } },
            y: { ticks: { color: "#ddd" }, grid: { color: "rgba(255,255,255,0.06)" } }
        },
        plugins: { legend: { labels: { color: "#ddd" } } }
    }
  });
}
function initCharts() {
  chartTemp = makeChart("chart-temp", "Nhiệt độ (°C)", "#ff5252", "rgba(255,82,82,0.18)");
  chartHum  = makeChart("chart-hum",  "Độ ẩm (%)", "#42a5f5", "rgba(66,165,245,0.18)");
  chartSmoke= makeChart("chart-smoke","Gas (ppm)", "#ff9800", "rgba(255,152,0,0.18)");
}
initCharts();

function escapeHtml(str) {
    if (str == null) return "";
    return String(str).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function toLocal(tsSeconds) {
  if (!tsSeconds) return "--";
  return new Date(Number(tsSeconds) * 1000).toLocaleString("vi-VN");
}
function createCardOnce() {
  if (cardNode) return cardNode;
  placeholder.innerHTML = "";
  const node = tmpl.content.cloneNode(true).firstElementChild;
  placeholder.appendChild(node);
  cardNode = node;

  ui.idEl = node.querySelector(".device-id");
  ui.statusEl = node.querySelector(".device-status");
  ui.tempEl = node.querySelector(".data-temp");
  ui.humEl = node.querySelector(".data-hum");
  ui.smokeEl = node.querySelector(".data-smoke");
  ui.rorEl = node.querySelector(".data-ror");
  ui.alarmEl = node.querySelector(".data-alarm");
  ui.ackEl = node.querySelector(".ack-message");
  ui.btnCharts = node.querySelector(".btn-charts");
  ui.btnHistory = node.querySelector(".btn-history");

  ui.idEl.textContent = DEVICE_ID; // Hiển thị ID mới
  ui.btnCharts.addEventListener("click", () => openChartPage(DEVICE_ID));
  ui.btnHistory.addEventListener("click", () => openHistory(DEVICE_ID));

  const btnAlarmClear = node.querySelector(".btn-alarm-clear");
  ui.btnLedOn = node.querySelector(".btn-led-on");
  ui.btnLedOff = node.querySelector(".btn-led-off");
  ui.btnLedAuto = node.querySelector(".btn-led-auto");
  ui.btnBuzzerOn = node.querySelector(".btn-buzzer-unmute");
  ui.btnBuzzerOff = node.querySelector(".btn-buzzer-mute");

  btnAlarmClear.addEventListener("click", () => sendCommand("ALARM_CLEAR"));
  ui.btnLedOn.addEventListener("click", () => sendCommand("LED_ON"));
  ui.btnLedOff.addEventListener("click", () => sendCommand("LED_OFF"));
  ui.btnLedAuto.addEventListener("click", () => sendCommand("LED_AUTO"));
  ui.btnBuzzerOff.addEventListener("click", () => sendCommand("BUZZER_OFF"));
  ui.btnBuzzerOn.addEventListener("click", () => sendCommand("BUZZER_ON"));

  log("[UI] ✅ Card created");
  return cardNode;
}
function sendCommand(cmd) {
  if (DEVICE_ID === "PASTE_YOUR_ID_HERE") {
      showAck("⚠️ Lỗi: Chưa cập nhật DEVICE_ID trong app.js (dòng 17)");
      return;
  }

  let path = "";
  let payload = "";
  const basePath = `devices/${DEVICE_ID}/cmd`; 

  switch(cmd) {
      case "LED_ON": path = `${basePath}/led`; payload = "on"; break;
      case "LED_OFF": path = `${basePath}/led`; payload = "off"; break;
      case "LED_AUTO": path = `${basePath}/led`; payload = "auto"; break;
      case "BUZZER_ON": path = `${basePath}/buzzer`; payload = "on"; break;
      case "BUZZER_OFF": path = `${basePath}/buzzer`; payload = "off"; break;
      case "ALARM_CLEAR": 
            path = `${basePath}/alarm`; 
            payload = "clear"; 
            break; 
        
        default: 
            console.error("Lệnh không xác định:", cmd); 
            return;
    }

    db.ref(path).set(payload)
        .then(() => {
            console.log(`[FB WRITE] ✅ Đã gửi: ${path} -> ${payload}`);
            showAck(`✅ Đã gửi: ${cmd}`);

            if (cmd === "ALARM_CLEAR") {
                setTimeout(() => {
                    db.ref(path).set(null) 
                        .then(() => console.log(`[FB WRITE] Đã xóa lệnh ${cmd}`))
                        .catch(err => console.error("[FB WRITE] Lỗi xóa lệnh:", err));
                }, 1000); 
            }

        })
        .catch((err) => {
            console.error("[FB WRITE] ❌ Lỗi gửi:", err);
            showAck("❌ Lỗi gửi lệnh");
        });
}
function showAck(msg) {
    if (ui.ackEl) {
        ui.ackEl.textContent = msg;
        setTimeout(() => { ui.ackEl.textContent = ""; }, 3000);
    }
}
let lastTelemetry = null, lastSeenTs = 0;
let currentTelemetry = {};
function applyTelemetryEfficient(obj) {
  if (!obj) { markDeviceOffline(); return; };

  lastTelemetry = obj;
  lastSeenTs = Date.now();
  createCardOnce();

  if (!cardNode) {
      log("[WARN] Card node chưa sẵn sàng trong applyTelemetryEfficient");
      return;
  }

  ui.statusEl.textContent = "online";
  ui.statusEl.classList.add("online");
  ui.statusEl.classList.remove("offline");

  ui.tempEl.textContent = obj.temp_c ?? "--";
  ui.humEl.textContent = obj.hum ?? "--";
  ui.smokeEl.textContent = obj.smoke_raw ?? obj.gas_raw ?? "--";
  ui.rorEl.textContent = obj.ror_c_per_min ?? "--";

  const alarmValue = obj.alarm;
  const isAlarm = alarmValue === true || alarmValue === 1 ||
                    String(alarmValue).toLowerCase() === "true" ||
                    String(alarmValue) === "1" ||
                    String(alarmValue).toUpperCase() === "ON";
  log(`[Alarm Check] Received: ${alarmValue}, Type: ${typeof alarmValue}, Result: ${isAlarm}`);
  
  ui.alarmEl.textContent = isAlarm ? "🔥 CÓ CHÁY!" : "✅ Bình thường";


  if (bookContainer.classList.contains("show-charts")) {
      obj.ts = obj.ts ?? Math.floor(Date.now() / 1000); 
      scheduleChartPush(obj); 
  }
}
function updateLedFeedback(state) {
    if (!ui.btnLedAuto) createCardOnce();
    log("[FB] 🔔 LED Feedback:", state);
    if (state === "auto") {
        ui.btnLedAuto.classList.add("active");
        ui.btnLedOn.classList.remove("active");
        ui.btnLedOff.classList.remove("active");
    } else if (state === "on") {
        ui.btnLedAuto.classList.remove("active");
        ui.btnLedOn.classList.add("active");
        ui.btnLedOff.classList.remove("active");
    } else { // "off"
        ui.btnLedAuto.classList.remove("active");
        ui.btnLedOn.classList.remove("active");
        ui.btnLedOff.classList.add("active");
    }
}
function updateBuzzerFeedback(state) {
    if (!ui.btnBuzzerOn) createCardOnce();
    log("[FB] 🔔 Buzzer Feedback:", state);
    if (state === "on") {
        ui.btnBuzzerOn.classList.add("active");
        ui.btnBuzzerOff.classList.remove("active");
    } else { // "off"
        ui.btnBuzzerOn.classList.remove("active");
        ui.btnBuzzerOff.classList.add("active");
    }
}
function scheduleChartPush(tel) {
    pendingChartTelemetry = tel;
    const now = Date.now();
    if (now - lastChartPushTs >= CHART_MIN_INTERVAL_MS) flushChartPush();
    else {
        clearTimeout(scheduleChartPush._t);
        scheduleChartPush._t = setTimeout(flushChartPush, CHART_MIN_INTERVAL_MS);
    }
}
function flushChartPush() {
  if (!pendingChartTelemetry) return;
  const tel = pendingChartTelemetry;
  pendingChartTelemetry = null;
  lastChartPushTs = Date.now();
  
  const label = tel.ts ? toLocal(tel.ts) : new Date().toLocaleTimeString("vi-VN");
  const push = (chart, val) => {
    if (!chart) return;
    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(Number(val) || null);
    if (chart.data.labels.length > MAX_CHART_POINTS) {
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
    }
    chart.update("none");
  };

  push(chartTemp, tel.temp_c);
  push(chartHum, tel.hum);
  push(chartSmoke, tel.smoke_raw ?? tel.gas_raw); 
}
let _fbAttached = false;
let _historyAttached = false;

function attachFirebaseListeners() {
  if (_fbAttached) return;
  if (DEVICE_ID === "PASTE_YOUR_ID_HERE") return; 

  const teleRef = db.ref(`devices/${DEVICE_ID}/telemetry`);
  const historyRef = db.ref(`history/${DEVICE_ID}`);
  const ledCmdRef = db.ref(`devices/${DEVICE_ID}/cmd/led`);
  const buzzerCmdRef = db.ref(`devices/${DEVICE_ID}/cmd/buzzer`);
  
  log("[FB] 📡 Lắng nghe 'telemetry' (on value)...");
  teleRef.on("value", snap => {
    if (!snap.exists()) {
        log("[FB] ⚠️ Node 'telemetry' không tồn tại (chờ Bridge/Arduino tạo)...");
        markDeviceOffline(); 
        return;
    }
    const val = snap.val();
    log("[FB] 🔔 'telemetry' updated:", val);
    currentTelemetry = val;
    applyTelemetryEfficient(currentTelemetry);
  }, (error) => { console.error("[FB] ❌ Lỗi lắng nghe 'telemetry':", error); });

  log("[FB] 📡 Lắng nghe feedback cmd/led, cmd/buzzer...");
  ledCmdRef.on("value", snap => {
      if (snap.exists()) updateLedFeedback(snap.val());
  });
  buzzerCmdRef.on("value", snap => {
      if (snap.exists()) updateBuzzerFeedback(snap.val());
  });

  log("[FB] 📡 Lắng nghe 'history' (orderByKey)...");
  historyRef.orderByKey().limitToLast(1).on("child_added", snap => {
      if (!_historyAttached) return; 
      const val = snap.val();
      val.ts = Number(snap.key); 
      log("[FB] 🔔 'history' new data:", val);
      if (bookContainer.classList.contains("show-charts") && val && val.ts) { 
          scheduleChartPush(val);
      }
  });

  setTimeout(() => { _historyAttached = true; }, 3000);
  _fbAttached = true;
}
function markDeviceOffline() {
  createCardOnce(); 
  ui.statusEl.textContent = "offline";
  ui.statusEl.classList.remove("online");
  ui.statusEl.classList.add("offline");

  currentTelemetry = {};
  if (ui.tempEl) { 
    ui.tempEl.textContent = "--";
    ui.humEl.textContent = "--";
    ui.smokeEl.textContent = "--";
    ui.rorEl.textContent = "--";
    ui.alarmEl.textContent = "--";

    if(ui.btnLedOn) ui.btnLedOn.classList.remove("active");
    if(ui.btnLedOff) ui.btnLedOff.classList.remove("active");
    if(ui.btnLedAuto) ui.btnLedAuto.classList.remove("active");
    if(ui.btnBuzzerOn) ui.btnBuzzerOn.classList.remove("active");
    if(ui.btnBuzzerOff) ui.btnBuzzerOff.classList.remove("active");
  }
}
function openChartPage(deviceId) {
  bookContainer.classList.add("show-charts");
  chartsTitle.textContent = `📈 Biểu đồ lịch sử: ${deviceId}`;

  db.ref(`history/${deviceId}`).orderByKey().limitToLast(MAX_CHART_POINTS).once("value")
    .then(snap => {
      if (!snap.exists()) {
        console.log("[CHARTS] ⚠️ Không có dữ liệu lịch sử");
        if (chartTemp) { chartTemp.data.labels = []; chartTemp.data.datasets[0].data = []; chartTemp.update("none"); }
        if (chartHum)  { chartHum.data.labels = []; chartHum.data.datasets[0].data = []; chartHum.update("none"); }
        if (chartSmoke){ chartSmoke.data.labels = []; chartSmoke.data.datasets[0].data = []; chartSmoke.update("none"); }
        return;
      }

      const obj = snap.val(), labels=[], temps=[], hums=[], smokes=[];

      Object.keys(obj).sort().forEach(k => {
          const v = obj[k];
          const tsSeconds = Number(k);
          if (isNaN(tsSeconds) || tsSeconds === 0) return;
          labels.push(toLocal(tsSeconds));
          temps.push(v.temperature ?? null);
          hums.push(v.humidity ?? null);
          smokes.push(v.gas_raw ?? null); 
      });

      if (chartTemp) { chartTemp.data.labels = labels; chartTemp.data.datasets[0].data = temps; chartTemp.update("none"); }
      if (chartHum)  { chartHum.data.labels = labels; chartHum.data.datasets[0].data = hums;  chartHum.update("none"); }
      if (chartSmoke){ chartSmoke.data.labels = labels; chartSmoke.data.datasets[0].data = smokes; chartSmoke.update("none"); }
      console.log(`[CHARTS] ✅ Đã tải ${labels.length} điểm dữ liệu từ history`);
    })
    .catch(err => console.error("[CHARTS] ❌ Lỗi:", err));
}
if (btnBack) btnBack.addEventListener("click", ()=> bookContainer.classList.remove("show-charts"));
let lastHistoryKey = null; 
let currentDeviceId = null;

async function openHistory(deviceId) {
  currentDeviceId = deviceId;
  lastHistoryKey = null; 

  const modal = document.getElementById("history-modal");
  const content = document.getElementById("history-content");
  const title = document.getElementById("history-title");
  const loadMoreBtn = document.getElementById("load-more-history");

  modal.style.display = "flex";
  title.textContent = `📜 Lịch sử thiết bị - ${deviceId}`;
  content.innerHTML = "<p>⏳ Đang tải dữ liệu...</p>";

  if (loadMoreBtn) loadMoreBtn.style.display = "none";

  try {
    await loadHistoryBatch(deviceId, false);
  } catch (err) {
      console.error("❌ Lỗi tải lịch sử:", err);
      content.innerHTML = "<p>⚠️ Không thể tải dữ liệu lịch sử.</p>";
  }
}

async function loadHistoryBatch(deviceId, append = false) {
  const content = document.getElementById("history-content");
  const loadMoreBtn = document.getElementById("load-more-history");

  let ref = firebase.database().ref(`history/${deviceId}`);
  let query = ref.orderByKey().limitToLast(HISTORY_LIMIT);

  if (lastHistoryKey) {
    query = ref.orderByKey().endAt(lastHistoryKey).limitToLast(HISTORY_LIMIT + 1);
  }

  const snapshot = await query.once("value");

  if (!snapshot.exists()) {
    if (!append) content.innerHTML = "<p>⚠️ Không có dữ liệu lịch sử.</p>";
    if (loadMoreBtn) loadMoreBtn.style.display = "none";
    return;
  }

  const data = snapshot.val();
  const keys = Object.keys(data).sort((a, b) => Number(b) - Number(a));

  if (lastHistoryKey && keys.length > 0) {
    if (keys[0] === lastHistoryKey) {
        keys.shift(); 
    }
  }

  if (keys.length === 0) {
    if (loadMoreBtn) loadMoreBtn.style.display = "none";
    if (!append) content.innerHTML = "<p>⚠️ Không có thêm dữ liệu lịch sử.</p>";
    return;
  }

  lastHistoryKey = keys[keys.length - 1];

  const logs = keys.map(k => {
    const v = data[k];
    const tsSeconds = Number(k);
    if (isNaN(tsSeconds) || tsSeconds === 0) return `⏰ [TIMESTAMP LỖI]`;
    const timeStr = toLocal(tsSeconds); 
    return `⏰ ${timeStr}\n` +
           `    🌡️ Nhiệt độ: ${v.temperature ?? '--'}°C\n` +
           `    💧 Độ ẩm: ${v.humidity ?? '--'}%\n` +
           `    💨 Gas: ${v.gas_raw ?? '--'}`;
  }).join("\n\n" + "─".repeat(50) + "\n\n");

  if (append) {
    const pre = content.querySelector("pre");
    if (pre) pre.textContent += "\n\n" + "─".repeat(50) + "\n\n" + logs;
    else content.innerHTML = `<pre>${logs}</pre>`;
  } else {
    content.innerHTML = `<pre>${logs}</pre>`;
  }

  if (loadMoreBtn) {
    loadMoreBtn.style.display = keys.length >= HISTORY_LIMIT ? "inline-block" : "none";
    loadMoreBtn.textContent = "⬇️ Tải thêm lịch sử";
  }
  log(`[HISTORY] ✅ Đã tải ${keys.length} bản ghi`);
}

setInterval(() => {
    if (lastSeenTs === 0) return;
    const diff = Date.now() - lastSeenTs;
    if (diff > 30000) {
        log("[WATCHDOG] ⚠️ Không thấy data trong 30s → offline");
        markDeviceOffline();
        lastSeenTs = 0;
    }
}, 5000);

window.addEventListener("load", () => {
  console.log("[APP] 🚀 Dashboard đã sẵn sàng");
  if (DEVICE_ID === "PASTE_YOUR_ID_HERE") { 
      alert("LỖI CẤU HÌNH:\n\nBạn chưa cập nhật DEVICE_ID trong app.js (dòng 17).\n\nHãy làm theo hướng dẫn ở đầu file app.js.");
      markDeviceOffline(); 
  }

  createCardOnce();

  const closeHistoryElement = document.getElementById("close-history");
  if (closeHistoryElement) {
      closeHistoryElement.addEventListener("click", () => {
          if (historyModal) historyModal.style.display = "none";
          if (historyContent) historyContent.innerHTML = "";
      });
  }
  else { console.error("❌ Không tìm thấy nút 'close-history'"); }

  const loadMoreElement = document.getElementById("load-more-history");
  if (loadMoreElement) {
      loadMoreElement.addEventListener("click", async () => {
          if (!currentDeviceId) return;
          const btn = loadMoreElement; 
          if (!btn) return;
          btn.textContent = "⏳ Đang tải...";
          btn.disabled = true;
          try {
              await loadHistoryBatch(currentDeviceId, true);
          } catch (err) {
              console.error("❌ Lỗi tải thêm:", err);
          } finally {
              btn.disabled = false;
          }
      });
  }
  else { console.error("❌ Không tìm thấy nút 'load-more-history'"); }
  if (DEVICE_ID !== "PASTE_YOUR_ID_HERE") {
      attachFirebaseListeners();
  }
});