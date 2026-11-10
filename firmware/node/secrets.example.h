// Template for secrets.h. Copy this file to secrets.h and fill in the real values.
// secrets.h is ignored by Git, so passwords never get committed.

#pragma once

#define WIFI_SSID "your-hotspot-name"  // 2.4 GHz only: the ESP32 can't see 5 GHz networks
#define WIFI_PASS "your-hotspot-password"

#define MQTT_HOST "xxxxxxxx.ala.eu-central-1.emqxsl.com"  // EMQX deployment address
#define MQTT_PORT 8883
// One EMQX login per board (Access Control > Authentication). THIS_NODE in config.h picks it.
#if THIS_NODE == 2
#define MQTT_USER "node-2"
#define MQTT_PASS "node-2-password-from-emqx"
#elif THIS_NODE == 3
#define MQTT_USER "node-3"
#define MQTT_PASS "node-3-password-from-emqx"
#elif THIS_NODE == 4
#define MQTT_USER "node-4"
#define MQTT_PASS "node-4-password-from-emqx"
#endif
