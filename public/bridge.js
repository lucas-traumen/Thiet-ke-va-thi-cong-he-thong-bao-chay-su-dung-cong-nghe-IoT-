const mqtt = require('mqtt');
const admin = require('firebase-admin');

// --- CẤU HÌNH ---
const MQTT_BROKER_URL = 'mqtt://broker.emqx.io';
const DATABASE_URL = 'https://firealarmsystem-aa15d-default-rtdb.asia-southeast1.firebasedatabase.app/';
const SERVICE_ACCOUNT_PATH = './serviceAccountKey.json';
// -----------------

console.log('Khởi động Bridge Node.js...');
try {
  const serviceAccount = require(SERVICE_ACCOUNT_PATH);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL,
  });
  const db = admin.database();
  console.log('✅ Kết nối Firebase Admin thành công.');

  const mqttClient = mqtt.connect(MQTT_BROKER_URL);
  
  // ===============================================================
  // NHIỆM VỤ 1: MQTT -> FIREBASE (Gửi data từ ESP32 lên Web)
  // ===============================================================
  mqttClient.on('connect', () => {
    console.log('✅ Kết nối MQTT Broker thành công.');

    const dataTopic = 'iot/fire/+/telemetry';
    const historyTopic = 'iot/fire/+/history/+';
    const stateTopic = 'iot/fire/+/state';

    mqttClient.subscribe(dataTopic, (err) => {
      if (!err) console.log(`📡 Đang lắng nghe MQTT topic: ${dataTopic}`);
    });
    mqttClient.subscribe(historyTopic, (err) => {
      if (!err) console.log(`📡 Đang lắng nghe MQTT topic: ${historyTopic}`);
    });
    mqttClient.subscribe(stateTopic, (err) => {
      if (!err) console.log(`📡 Đang lắng nghe MQTT topic: ${stateTopic}`);
    });
  });

  mqttClient.on('message', (topic, payload) => {
    const message = payload.toString();
    console.log(`[MQTT RX] ${topic} -> ${message}`);

    const parts = topic.split('/');
    if (parts.length < 4) return;

    const deviceID = parts[2];
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.warn('Lỗi parse JSON:', e.message);
      return;
    }

    if (parts[3] === 'telemetry') {
      const ref = db.ref(`devices/${deviceID}/telemetry`);
      ref.set(data)
         .then(() => console.log(`[FB WRITE] Đã ghi telemetry cho ${deviceID}`))
         .catch((err) => console.error('Lỗi ghi telemetry:', err));

    } else if (parts[3] === 'history' && parts.length === 5) {
      const timestamp = parts[4];
      const ref = db.ref(`history/${deviceID}/${timestamp}`);
      ref.set(data)
         .then(() => console.log(`[FB WRITE] Đã ghi history cho ${deviceID} @ ${timestamp}`))
         .catch((err) => console.error('Lỗi ghi history:', err));

    } else if (parts[3] === 'state') {
      const updates = {};
      if (data.led_mode !== undefined) updates[`cmd/led`] = data.led_mode;
      if (data.buzzer_state !== undefined) updates[`cmd/buzzer`] = data.buzzer_state;
      
      const ref = db.ref(`devices/${deviceID}`);
      ref.update(updates)
         .then(() => console.log(`[FB WRITE] Đã ghi feedback state cho ${deviceID}`))
         .catch((err) => console.error('Lỗi ghi feedback:', err));
    }
  });

  // ===============================================================
  // NHIỆM VỤ 2: FIREBASE -> MQTT (Gửi lệnh từ Web xuống ESP32)
  // ===============================================================
  
  function handleCommand(deviceID, command, value) {
    if (!value) {
      console.log(`[FB RX] Bỏ qua lệnh rỗng: ${command} = ${value}`);
      return;
    }

    const topic = `iot/fire/${deviceID}/cmd/${command}`;
    console.log(`[FB RX] Lệnh mới cho ${deviceID}: ${command} -> ${value}`);
    
    mqttClient.publish(topic, String(value), { retain: false }, (err) => {
      if (err) console.error('Lỗi gửi lệnh MQTT:', err);
      else console.log(`[MQTT TX] Đã gửi lệnh: ${topic} -> ${value}`);
    });
  }

  const devicesRef = db.ref('devices');
  
  devicesRef.on('child_added', (deviceSnap) => {
    const deviceID = deviceSnap.key;
    const cmdRef = deviceSnap.child('cmd').ref;

    console.log(`[FB LISTEN] Phát hiện thiết bị: ${deviceID}, đang lắng nghe lệnh...`);

    cmdRef.on('child_added', (cmdSnap) => {
      const command = cmdSnap.key;   // 'led', 'buzzer', 'alarm'
      const value = cmdSnap.val();   // 'on', 'off', 'clear'
      handleCommand(deviceID, command, value);
    });

    cmdRef.on('child_changed', (cmdSnap) => {
      const command = cmdSnap.key;
      const value = cmdSnap.val();
      handleCommand(deviceID, command, value);
    });
  });

  console.log('🚀 Bridge đã sẵn sàng!');
  console.log('💡 Đang chờ dữ liệu từ ESP32 và lệnh từ Dashboard...\n');

} catch (e) {
  console.error('❌ KHỞI ĐỘNG BRIDGE THẤT BẠI!');
  console.error('Lỗi:', e.message);
  console.error('Vui lòng kiểm tra lại đường dẫn file serviceAccountKey.json');
}