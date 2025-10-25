// ****************************************************
// * ESP32 Fire Alert (DHT11 + MQ-2 + MQTT) — V1.7 (MQ2 tuned, cleaned)
// * - 3 Chế độ: OFF / ON / AUTO
// * - LED OFF = Tắt hệ thống phát hiện cháy
// * - LED ON  = Bật luôn báo động (test mode)
// * - LED AUTO = Chế độ tự động phát hiện
// * - Xóa Báo Động = Clear + chuyển về AUTO
// * - MQ2: kẹp dải RS/R0, trần PPM, thêm cờ mq2_sat chống "ppm ảo"
// ****************************************************

#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include <time.h>

#define DEBUG_MONITOR 1
#if DEBUG_MONITOR
  #define DBG(...)  Serial.printf(__VA_ARGS__)
#else
  #define DBG(...)
#endif
static inline const char* b2s(bool b){ return b ? "1" : "0"; }

const char* WIFI_SSID = "THANHLAPTOP";
const char* WIFI_PASS = "12345611";
const char* MQTT_BROKER = "broker.emqx.io";
const uint16_t MQTT_PORT = 1883;
const long GMT_OFFSET_SEC = 7 * 3600;
const int  DAYLIGHT_OFFSET_SEC = 0;

#define DHTPIN   21
#define DHTTYPE  DHT11
#define MQ2_PIN  34
#define LED_PIN  18
#define BUZZER_PIN 19

const unsigned long MQ2_WARMUP_MS = 120000UL;
int gas_ABS_PRE   = 5000;
int gas_ABS_ALARM = 10000;
const unsigned long HOLD_PRE_MS   = 5000UL;
const unsigned long HOLD_ALARM_MS = 10000UL;

float TEMP_PRE_C    = 30.0f;
float TEMP_ALARM_C  = 32.0f;
float ROR_PRE_C_PER_MIN    = 6.0f;
float ROR_ALARM_C_PER_MIN  = 8.0f;
const unsigned long ROR_WINDOW_MS = 60000UL;

enum SystemMode { MODE_OFF, MODE_ON, MODE_AUTO };
SystemMode systemMode = MODE_AUTO;

bool buzManual=false, buzWanted=false;
bool buzzerMuted=false;
unsigned long buzzerMutedUntil=0;

WiFiClient espClient;
PubSubClient mqtt(espClient);
DHT dht(DHTPIN, DHTTYPE);

String BASE_TOPIC = "";
unsigned long lastTele = 0;
const unsigned long TELE_PERIOD_MS = 5000;

bool alarmLatched = false;

unsigned long lastWiFiCheck = 0;
const unsigned long WIFI_CHECK_MS = 10000;

unsigned long gasPreSince=0, gasAlarmSince=0;
unsigned long tPreSince=0, tAlarmSince=0;
unsigned long rorPreSince=0, rorAlarmSince=0;

const int TEMP_BUF_N = 24;
float tempBuf[TEMP_BUF_N];
unsigned long tempTs[TEMP_BUF_N];
int tempIdx=0;
bool tempFilled=false;

unsigned long mq2WarmupEnd=0;
bool mq2Ready=false;
float mq2Baseline = NAN; // dùng làm R0 sau khi hiệu chuẩn

// ====== MQ-2 điện / mô hình ======
const float MQ2_VIN_VOLT = 5.0f;
const float MQ2_ADC_FS_VOLT = 3.3f; // ESP32 ADC (11dB) ~ 3.3V
const float MQ2_RL_OHMS = 4700.0f;  // RL trên module MQ-2 thường ≈ 4.7kΩ
const float MQ2_VRL_GAIN = (11000.0f + 10000.0f) / 10000.0f;   // (R_top + R_bot) / R_bot = (11k+10k) / 10k

// Fit log–log (theo tài liệu evive/STEMpedia cho LPG)
const float MQ2_LOG_M = -0.473f;
const float MQ2_LOG_B = 1.413f;
const float MQ2_CLEAN_AIR_RS_R0 = 9.8f;   // RS/R0 ≈ 9.8 trong không khí sạch
const unsigned long MQ2_CAL_TIME_MS = 30000UL;

// === Chống "ppm ảo" (saturation guard) ===
const float MQ2_RATIO_MAX = 30.0f;  // RS/R0 lớn hơn: coi như rất sạch
const int   MQ2_PPM_CAP   = 10000;  // trần giá trị ppm hiển thị
static inline float mq2_ratio_floor_for_cap(int ppmCap){
  return powf(10.0f, MQ2_LOG_M * log10f((float)ppmCap) + MQ2_LOG_B);
}

String chipIdHex(){
  uint64_t mac = ESP.getEfuseMac();
  char chipIdStr[13];
  snprintf(chipIdStr, sizeof(chipIdStr), "%04X%08X", (uint16_t)(mac >> 32), (uint32_t)mac);
  return String(chipIdStr);
}

String topicOf(const char* sub){ return BASE_TOPIC + "/" + sub; }

void setOutputs(bool ledOn, bool buzOn){
  digitalWrite(LED_PIN, ledOn?HIGH:LOW);
  digitalWrite(BUZZER_PIN, buzOn?HIGH:LOW);
}

void publishStatus(const char* s){ mqtt.publish(topicOf("status").c_str(), s, true); }

unsigned long nowEpoch(){
  time_t now = time(nullptr);
  if (now < 100000) return millis()/1000;
  return (unsigned long)now;
}

void publishAck(const char* cmd, const char* result, const char* info=nullptr){
  StaticJsonDocument<240> doc;
  doc["ts"]=nowEpoch(); 
  doc["cmd"]=cmd; 
  doc["result"]=result;
  if(info&&*info) doc["info"]=info;
  char buf[240]; 
  size_t n=serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicOf("ack").c_str(), buf, n);
}

void performAlarmClearState() {
  alarmLatched = false;
  systemMode = MODE_AUTO;
  buzzerMuted = false; 
  buzzerMutedUntil = 0;
  buzManual = false; 
  buzWanted = false; 
  setOutputs(false, false);
}

int readgasRaw(){ 
  const int N=7; 
  int a[N];
  for(int i=0;i<N;++i){ a[i]=analogRead(MQ2_PIN); delay(2); }
  for(int i=0;i<N-1;++i) for(int j=i+1;j<N;++j) if(a[j]<a[i]){ int t=a[i]; a[i]=a[j]; a[j]=t; }
  return a[N/2];
}

void updateTempBuffer(float tC, unsigned long nowMs){
  tempBuf[tempIdx]=tC; tempTs[tempIdx]=nowMs;
  tempIdx=(tempIdx+1)%TEMP_BUF_N; 
  if(tempIdx==0) tempFilled=true;
}

float computeRor(unsigned long nowMs, float tNow){
  float ror=NAN; bool found=false; float tRef=0; unsigned long tsRef=0;
  const int total = tempFilled ? TEMP_BUF_N : tempIdx;
  for(int k=0;k<total;++k){
    int idx=(tempIdx-1-k+TEMP_BUF_N)%TEMP_BUF_N;
    if(nowMs>=tempTs[idx] && (nowMs-tempTs[idx])>=ROR_WINDOW_MS){ tRef=tempBuf[idx]; tsRef=tempTs[idx]; found=true; break; }
  }
  if(found && nowMs>tsRef){
    float mins=(nowMs-tsRef)/60000.0f;
    ror=(tNow - tRef)/mins;
  }
  return ror;
}

int max2(int a, int b){ return (a>b)?a:b; }

bool held(bool cond, unsigned long& sinceVar, unsigned long holdMs, unsigned long nowMs){
  if(cond){ if(sinceVar==0) sinceVar=(nowMs>0?nowMs:1); return (nowMs - sinceVar >= holdMs); }
  else { sinceVar=0; return false; }
}

// ===== MQ-2 helpers =====
static inline float adcRawToVolt(int raw){ return (raw/4095.0f) * MQ2_ADC_FS_VOLT; }
static inline float mq2_VRL_true_from_raw(int raw){ return adcRawToVolt(raw) * MQ2_VRL_GAIN; }
static inline float mq2_RS_from_VRL(float VRL){
  if(VRL < 0.005f) VRL = 0.005f;
  if(VRL > MQ2_VIN_VOLT - 0.005f) VRL = MQ2_VIN_VOLT - 0.005f;
  return (MQ2_VIN_VOLT * MQ2_RL_OHMS) / VRL - MQ2_RL_OHMS;
}
static inline float mq2_ppm_from_ratio(float ratio){
  if(!(ratio>0)) return NAN;
  float logy = log10f(ratio);
  float logx = (logy - MQ2_LOG_B) / MQ2_LOG_M;
  return powf(10.0f, logx);
}

// === telemetry/alert ===
void publishTelemetry(float tC, float hum, int gasPPM, float rorCpm,
                      int gasPreTh, int gasAlmTh, float vrl, float rs, bool mq2Sat){
  StaticJsonDocument<420> doc;
  doc["ts"]=nowEpoch();
  if(!isnan(tC)) doc["temp_c"]=roundf(tC*10)/10.0f; else doc["temp_c"]=nullptr;
  if(!isnan(hum)) doc["hum"]=(int)hum; else doc["hum"]=nullptr;
  doc["gas_raw"] = gasPPM;                           // ppm
  if(!isnan(mq2Baseline)) doc["gas_base"] = (int)mq2Baseline; else doc["gas_base"]=nullptr; // R0
  doc["gas_th_pre"] = gasPreTh;
  doc["gas_th_alarm"] = gasAlmTh;
  if(!isnan(rorCpm)) doc["ror_c_per_min"] = roundf(rorCpm*10)/10.0f; else doc["ror_c_per_min"]=nullptr;
  doc["alarm"]=alarmLatched;
  doc["mq2_vrl_v"] = roundf(vrl*1000)/1000.0f;
  if(!isnan(rs)) doc["mq2_rs_ohm"] = (int)rs; else doc["mq2_rs_ohm"]=nullptr;
  doc["mq2_sat"] = mq2Sat;
  char buf[460]; size_t n=serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicOf("telemetry").c_str(), buf, n);
}

void publishAlert(float tC, float hum, int gasPPM, float rorCpm,
                  float vrl, float rs, float ratio, bool mq2Sat){
  StaticJsonDocument<340> doc;
  doc["ts"]=nowEpoch();
  doc["level"]="FIRE";
  if(!isnan(tC)) doc["temp_c"]=roundf(tC*10)/10.0f; else doc["temp_c"]=nullptr;
  if(!isnan(hum)) doc["hum"]=(int)hum; else doc["hum"]=nullptr;
  doc["gas_raw"]=gasPPM;
  if(!isnan(rorCpm)) doc["ror_c_per_min"]=roundf(rorCpm*10)/10.0f; else doc["ror_c_per_min"]=nullptr;
  doc["mq2_vrl_v"]=roundf(vrl*1000)/1000.0f;
  if(!isnan(rs)) doc["mq2_rs_ohm"]=(int)rs; else doc["mq2_rs_ohm"]=nullptr;
  if(!isnan(ratio)) doc["mq2_rs_r0"]=roundf(ratio*1000)/1000.0f; else doc["mq2_rs_r0"]=nullptr;
  doc["mq2_sat"] = mq2Sat;
  doc["latched"]=true;
  char buf[360]; size_t n=serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicOf("alert").c_str(), buf, n);
}

// ===== network =====
void ntpSetup(){
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC,
             "vn.pool.ntp.org","pool.ntp.org","time.nist.gov");
}

void wifiConnect(){
  WiFi.mode(WIFI_STA); 
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WiFi connecting");
  int retry=0; 
  while(WiFi.status()!=WL_CONNECTED && retry<60){ delay(500); Serial.print("."); retry++; }
  Serial.println();
  if(WiFi.status()==WL_CONNECTED){
    Serial.print("WiFi OK, IP: "); Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi FAIL");
  }
}

void wifiWatchdog(){
  if(millis()-lastWiFiCheck>=WIFI_CHECK_MS){
    lastWiFiCheck=millis();
    if(WiFi.status()!=WL_CONNECTED){
      Serial.println("[WiFi] lost, reconnecting...");
      WiFi.disconnect(); 
      WiFi.reconnect();
    }
  }
}

void handleCmd(char* topic, byte* payload, unsigned int length){
  String t=String(topic);
  String msg; 
  for(unsigned int i=0;i<length;i++) msg+=(char)payload[i]; 
  msg.trim();
  Serial.printf("[MQTT] %s => %s\n", topic, msg.c_str());

  if(t.endsWith("/cmd/buzzer")){
    if(msg=="on"){ 
      buzzerMuted=false; buzzerMutedUntil=0; 
      buzManual=true;  buzWanted=true;  
      publishAck("buzzer on","ok");
      mqtt.publish(topicOf("cmd/buzzer").c_str(), (const uint8_t*)"", 0, false);
    }
    else if(msg=="off"){ 
      buzzerMuted=true;  buzzerMutedUntil=0; 
      buzManual=true;  buzWanted=false; 
      publishAck("buzzer off","ok");
      mqtt.publish(topicOf("cmd/buzzer").c_str(), (const uint8_t*)"", 0, false);
    }
    else if(msg.startsWith("silence:")){ 
      int s=msg.substring(8).toInt(); 
      buzzerMuted=true; 
      buzzerMutedUntil=millis() + (unsigned long)s*1000UL; 
      publishAck("buzzer silence","ok");
      mqtt.publish(topicOf("cmd/buzzer").c_str(), (const uint8_t*)"", 0, false);
    }
    else publishAck("buzzer","error","use: on|off|silence:<s>");

  } else if(t.endsWith("/cmd/led")){
    if(msg=="on"){
      systemMode = MODE_ON;
      alarmLatched = true;
      buzzerMuted=false;
      publishAck("led on","ok","system_mode=ON");
      mqtt.publish(topicOf("cmd/led").c_str(), (const uint8_t*)"", 0, false);
    }
    else if(msg=="off"){
      systemMode = MODE_OFF;
      alarmLatched = false;
      setOutputs(false,false);
      publishAck("led off","ok","system_mode=OFF");
      mqtt.publish(topicOf("cmd/led").c_str(), (const uint8_t*)"", 0, false);
    }
    else if(msg=="auto"){
      systemMode = MODE_AUTO;
      alarmLatched = false;
      publishAck("led auto","ok","system_mode=AUTO");
      mqtt.publish(topicOf("cmd/led").c_str(), (const uint8_t*)"", 0, false);
    }
    else publishAck("led","error","use: on|off|auto");

  } else if(t.endsWith("/cmd/alarm")){
    if(msg=="clear"){
      performAlarmClearState();
      publishAck("alarm clear","ok","system_mode=AUTO");
      mqtt.publish(topicOf("cmd/alarm").c_str(), (const uint8_t*)"", 0, false);
      Serial.println("[CMD] Đã xóa lệnh alarm clear khỏi broker");
    } else if(msg=="status"){
      String mode = (systemMode==MODE_OFF)?"OFF":((systemMode==MODE_ON)?"ON":"AUTO");
      publishAck("alarm status", alarmLatched?"latched":"idle", mode.c_str());
    } else {
      publishAck("alarm","error","use: clear|status");
    }

  } else if(t.endsWith("/cmd/threshold")){
    if(msg.startsWith("ppm:")){
      int b1=msg.indexOf(':',4);
      if(b1>0){
        int pre = msg.substring(4, b1).toInt();
        int alm = msg.substring(b1+1).toInt();
        if(pre>0 && alm>=pre){ 
          gas_ABS_PRE=pre; 
          gas_ABS_ALARM=alm; 
          publishAck("threshold ppm","ok"); 
        } else publishAck("threshold ppm","error","need: alarm>=pre>0");
      } else publishAck("threshold ppm","error","use: ppm:<pre>:<alarm>");
    } else if(msg.startsWith("temp:")){
      float v=msg.substring(5).toFloat(); 
      TEMP_ALARM_C=v; 
      TEMP_PRE_C=v-3.0f; 
      publishAck("threshold temp","ok");
    } else if(msg.startsWith("ror:")){
      int b1=msg.indexOf(':',4);
      if(b1>0){ 
        ROR_PRE_C_PER_MIN=msg.substring(4,b1).toFloat(); 
        ROR_ALARM_C_PER_MIN=msg.substring(b1+1).toFloat(); 
        publishAck("threshold ror","ok"); 
      } else publishAck("threshold ror","error","use: ror:<pre>:<alarm>");
    } else publishAck("threshold","error","use: ppm|temp|ror");
  }
}

void mqttReconnect(){
  while(!mqtt.connected()){
    String clientId = String("esp32-fire-") + chipIdHex();
    String willTopic = topicOf("status");
    const char* willMsg = "offline";
    if(mqtt.connect(clientId.c_str(), nullptr, nullptr, willTopic.c_str(), 1, true, willMsg)){
      Serial.println("MQTT connected");
      publishStatus("online");
      mqtt.subscribe((BASE_TOPIC + "/cmd/#").c_str());
      publishAck("boot","ok","subscribed cmd/#");
    } else {
      Serial.print("MQTT fail, rc="); Serial.println(mqtt.state());
      delay(1000);
    }
  }
}

void setup(){
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  setOutputs(false,false);

  BASE_TOPIC = String("iot/fire/") + chipIdHex();
  Serial.print("BASE_TOPIC: "); Serial.println(BASE_TOPIC);
  Serial.print("DeviceID: "); Serial.println(chipIdHex());

  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(handleCmd);
  mqtt.setKeepAlive(20);
  mqtt.setSocketTimeout(15);
  mqtt.setBufferSize(768);

  analogReadResolution(12);
  analogSetPinAttenuation(MQ2_PIN, ADC_11db);

  mq2WarmupEnd = millis() + MQ2_WARMUP_MS;

  dht.begin();
  wifiConnect();
  ntpSetup();
}

void loop(){
  wifiWatchdog();
  if(!mqtt.connected()) mqttReconnect();
  mqtt.loop();

  unsigned long nowMs = millis();

  if(nowMs - lastTele >= TELE_PERIOD_MS){
    lastTele = nowMs;

    float tC  = dht.readTemperature();
    float hum = dht.readHumidity();
    if(!isnan(tC)) updateTempBuffer(tC, nowMs);
    float ror = (!isnan(tC)) ? computeRor(nowMs, tC) : NAN;

    // ===== MQ-2 đo & tính =====
    int   adcRaw = readgasRaw();
    float VRL    = mq2_VRL_true_from_raw(adcRaw);
    float RS     = mq2_RS_from_VRL(VRL);

    // Hiệu chuẩn R0 sau warmup (R0 lưu ở mq2Baseline)
    static unsigned long calStart=0; 
    static double sumRS=0; 
    static int cntRS=0;
    if(!mq2Ready){
      if(nowMs < mq2WarmupEnd){
        DBG("[MQ2] Warming up... %lus left\n", (mq2WarmupEnd - nowMs)/1000UL);
      } else {
        if(calStart==0) calStart = nowMs;
        sumRS += RS; cntRS++;
        if(nowMs - calStart >= MQ2_CAL_TIME_MS){
          float RS_clean = (float)(sumRS / (cntRS>0?cntRS:1));
          mq2Baseline = RS_clean / MQ2_CLEAN_AIR_RS_R0; // R0 = RS/9.8
          mq2Ready = true;
          DBG("[MQ2] Cal done: R0=%dΩ (avg %d samples)\n", (int)mq2Baseline, cntRS);
          sumRS=0; cntRS=0; calStart=0;
        } else {
          DBG("[MQ2] Calibrating R0... cnt=%d RS≈%dΩ\n", cntRS, (int)RS);
        }
      }
    }

    // Tỉ số & ppm có kẹp dải (anti-saturation)
    float ratio_raw = (!isnan(mq2Baseline) && mq2Baseline>0) ? (RS / mq2Baseline) : NAN;
    bool  mq2Sat = false;
    float ratio = ratio_raw;
    float ratioFloor = mq2_ratio_floor_for_cap(MQ2_PPM_CAP);
    if (ratio_raw > 0 && ratio_raw < ratioFloor) { ratio = ratioFloor; mq2Sat = true; }
    if (ratio > MQ2_RATIO_MAX) ratio = MQ2_RATIO_MAX;

    float ppm   = mq2_ppm_from_ratio(ratio);
    int   gas   = isnan(ppm) ? 0 : min(MQ2_PPM_CAP, max2(0, (int)ppm));

    // Ngưỡng (ppm)
    int gasPreTh = gas_ABS_PRE;
    int gasAlmTh = gas_ABS_ALARM;

    bool gasPreCond   = mq2Ready && !isnan(ppm) && (gas >= gasPreTh);
    bool gasAlarmCond = mq2Ready && !isnan(ppm) && (gas >= gasAlmTh);
    bool gasPreHeld   = held(gasPreCond,  gasPreSince,   HOLD_PRE_MS,   nowMs);
    bool gasAlmHeld   = held(gasAlarmCond,gasAlarmSince, HOLD_ALARM_MS, nowMs);

    // Điều kiện nhiệt
    bool tPreCond   = (!isnan(tC) && tC >= TEMP_PRE_C);
    bool tAlmCond   = (!isnan(tC) && tC >= TEMP_ALARM_C);
    bool rorPreCond = (!isnan(ror) && ror >= ROR_PRE_C_PER_MIN);
    bool rorAlmCond = (!isnan(ror) && ror >= ROR_ALARM_C_PER_MIN);
    bool tPreHeld   = held(tPreCond,   tPreSince,     HOLD_PRE_MS,   nowMs);
    bool tAlmHeld   = held(tAlmCond,   tAlarmSince,   HOLD_ALARM_MS, nowMs);
    bool rorPreHeld = held(rorPreCond, rorPreSince,   HOLD_PRE_MS,   nowMs);
    bool rorAlmHeld = held(rorAlmCond, rorAlarmSince, HOLD_ALARM_MS, nowMs);

    // Quyết định
    bool fireNow = false;
    if(systemMode == MODE_AUTO) {
      fireNow = gasAlmHeld || tAlmHeld || rorAlmHeld
                || ((gasPreHeld || tPreHeld) && rorPreHeld);
    }

    if(systemMode == MODE_AUTO && !fireNow){
      if(alarmLatched){ 
        DBG("[AUTO-RESET] fire cleared\n"); 
        alarmLatched=false; 
      }
    }

    if(systemMode == MODE_AUTO && fireNow && !alarmLatched){
      alarmLatched=true;
      buzzerMuted=false; 
      buzzerMutedUntil=0;
      publishAlert(tC, hum, gas, ror, VRL, RS, ratio, mq2Sat);
    }

    if(systemMode == MODE_ON && !alarmLatched)  alarmLatched = true;
    if(systemMode == MODE_OFF && alarmLatched)  alarmLatched = false;

    const char* modeStr = (systemMode==MODE_OFF)?"OFF":((systemMode==MODE_ON)?"ON":"AUTO");
    DBG("[%lus] MODE=%s T=%.1fC H=%s VRL=%.3fV RS=%s R0=%s RS/R0(raw)=%s RS/R0(use)=%s SAT=%s PPM=%s|th=%d/%d R0ok=%s alarm=%s\n",
        nowMs/1000UL, modeStr,
        isnan(tC)?-99.9f:tC,
        isnan(hum)?"NA":String((int)hum).c_str(),
        VRL,
        isnan(RS)?"NA":String((int)RS).c_str(),
        isnan(mq2Baseline)?"NA":String((int)mq2Baseline).c_str(),
        isnan(ratio_raw)?"NA":String(ratio_raw,3).c_str(),
        isnan(ratio)?"NA":String(ratio,3).c_str(),
        b2s(mq2Sat),
        isnan(ppm)?"NA":String((int)ppm).c_str(),
        gasPreTh, gasAlmTh,
        b2s(mq2Ready), b2s(alarmLatched));

    publishTelemetry(tC, hum, gas, ror, gasPreTh, gasAlmTh, VRL, RS, mq2Sat);

    // History (để app.js vẽ biểu đồ)
    StaticJsonDocument<160> docHist;
    unsigned long ts=nowEpoch();
    if(!isnan(tC)) docHist["temperature"]=roundf(tC*10)/10.0f; else docHist["temperature"]=nullptr;
    if(!isnan(hum)) docHist["humidity"]=(int)hum; else docHist["humidity"]=nullptr;
    docHist["gas_raw"]= gas;

    char histBuf[180]; 
    size_t nHist=serializeJson(docHist, histBuf, sizeof(histBuf));
    String histTopic = topicOf("history") + "/" + String(ts);
    mqtt.publish(histTopic.c_str(), histBuf, nHist);
  }

  if(buzzerMuted && buzzerMutedUntil>0 && millis()>buzzerMutedUntil){
    buzzerMuted=false; 
    buzzerMutedUntil=0; 
    publishAck("buzzer silence","expired");
  }

  bool ledOut=false, buzOut=false;
  if(systemMode == MODE_OFF) {
    ledOut = false; buzOut = false;
  } else if(systemMode == MODE_ON) {
    ledOut = true;  buzOut = buzzerMuted ? false : true;
    if(buzManual) buzOut = buzWanted;
  } else {
    if(alarmLatched){
      ledOut = true;  buzOut = buzzerMuted ? false : true;
      if(buzManual) buzOut = buzWanted;
    } else {
      ledOut = false; buzOut = buzManual ? buzWanted : false;
    }
  }
  setOutputs(ledOut, buzOut);
}
