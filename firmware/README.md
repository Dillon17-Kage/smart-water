# Node firmware (Arduino IDE)

Phase 1: one sketch for every ESP32 node; each board differs only in `config.h`.
Wi-Fi and MQTT passwords go in `node/secrets.h`, which Git ignores
(copy `secrets.example.h` to start).
