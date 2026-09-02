#pragma once
#include <Arduino.h>
#include <stddef.h>

// ============================================================================
//  Security layer.
//
//  This layer is intentionally SEPARATE from the application/user-configuration
//  layer. A user factory reset must never touch anything owned here (device
//  identity, provisioning state, security keys/eFuses).
//
//  It provides:
//   - device identity (eFuse MAC derived) + product serial
//   - security status introspection (Secure Boot / Flash Encryption)
//   - secure-OTA primitives: ECDSA-P256/SHA-256 image signature verification
//     and anti-rollback version parsing
//
//  Irreversible hardware security (Secure Boot, Flash Encryption, anti-rollback
//  eFuses) is NEVER enabled by the firmware itself. It is provisioned by an
//  explicit, documented offline process (see tools/production/).
// ============================================================================

namespace Security {

void   begin();                     // non-destructive: init identity / secure NVS

String deviceId();                  // stable hex ID derived from eFuse MAC
String serialNumber();              // provisioned serial, else derived from deviceId
bool   isProvisioned();             // production provisioning flag (secure NVS)

bool   isProduction();              // compile-time build type
bool   secureBootEnabled();         // hardware Secure Boot v2 active
bool   flashEncryptionEnabled();    // hardware Flash Encryption active

// --- Secure OTA ---
bool   requireSignedOTA();          // true on production builds
// Verify an ECDSA-P256 signature (DER) over a SHA-256 digest using the embedded
// manufacturer public key.
bool   verifyImage(const uint8_t *sha256, const uint8_t *sig, size_t sigLen);
// Parse the semantic version code from an ESP-IDF app image header buffer.
// Returns -1 if the version cannot be determined.
int    parseImageVersionCode(const uint8_t *buf, size_t len);
int    runningVersionCode();        // currently running firmware version code

} // namespace Security
