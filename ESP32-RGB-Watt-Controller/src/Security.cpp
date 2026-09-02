#include "Security.h"
#include "FirmwareVersion.h"
#include "ManufacturerKey.h"
#include "Log.h"

#include <Preferences.h>
#include <esp_ota_ops.h>
#include <esp_secure_boot.h>
#include <esp_flash_encrypt.h>
#include <mbedtls/pk.h>
#include <mbedtls/md.h>

namespace Security {

// Security identity lives in its OWN NVS namespace, never cleared by a user
// factory reset (which only clears the application "rgbwatt" namespace).
static const char *SEC_NS = "rgbsec";

static String s_deviceId;
static String s_serial;
static bool   s_provisioned = false;

static int semverToCode(const char *v) {
  if (!v) return -1;
  int a = 0, b = 0, c = 0;
  if (sscanf(v, "%d.%d.%d", &a, &b, &c) < 1) return -1;
  return 10000 * a + 100 * b + c;
}

void begin() {
  uint64_t mac = ESP.getEfuseMac();
  char buf[17];
  snprintf(buf, sizeof(buf), "%04X%08X",
           (uint16_t)(mac >> 32), (uint32_t)mac);
  s_deviceId = String(buf);

  Preferences p;
  if (p.begin(SEC_NS, true)) {           // read-only; never created/cleared here casually
    s_provisioned = p.getBool("prov", false);
    s_serial      = p.getString("serial", "");
    p.end();
  }
  if (s_serial.isEmpty()) {
    s_serial = "RGBW-" + s_deviceId.substring(s_deviceId.length() - 6);
  }

  LOGI("[SEC] Device ID: %s", s_deviceId.c_str());
  LOGI("[SEC] Serial: %s", s_serial.c_str());
  LOGI("[SEC] Build: %s  SecureBoot: %d  FlashEnc: %d",
       FW_BUILD_TYPE, (int)secureBootEnabled(), (int)flashEncryptionEnabled());
}

String deviceId()     { return s_deviceId; }
String serialNumber() { return s_serial; }
bool   isProvisioned(){ return s_provisioned; }

bool isProduction() {
#if defined(BUILD_PROD)
  return true;
#else
  return false;
#endif
}

bool secureBootEnabled() {
#if defined(CONFIG_SECURE_BOOT)
  return esp_secure_boot_enabled();
#else
  return esp_secure_boot_enabled();
#endif
}

bool flashEncryptionEnabled() {
  return esp_flash_encryption_enabled();
}

bool requireSignedOTA() {
  return isProduction();
}

bool verifyImage(const uint8_t *sha256, const uint8_t *sig, size_t sigLen) {
  if (!sha256 || !sig || sigLen == 0) return false;
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int rc = mbedtls_pk_parse_public_key(
      &pk,
      (const unsigned char *)MANUFACTURER_PUBLIC_KEY_PEM,
      strlen(MANUFACTURER_PUBLIC_KEY_PEM) + 1);
  if (rc != 0) {
    mbedtls_pk_free(&pk);
    LOGI("[SEC] Public key parse failed (%d)", rc);
    return false;
  }
  rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, sha256, 32, sig, sigLen);
  mbedtls_pk_free(&pk);
  return rc == 0;
}

int parseImageVersionCode(const uint8_t *buf, size_t len) {
  // ESP-IDF app image: esp_image_header (24) + segment header (8) = 0x20,
  // then esp_app_desc_t { magic@0, secure_version@4, reserv@8, version@16 }.
  const size_t descOff = 0x20;
  const size_t verOff  = descOff + 16;
  if (len < verOff + 32) return -1;
  uint32_t magic = (uint32_t)buf[descOff] | ((uint32_t)buf[descOff + 1] << 8) |
                   ((uint32_t)buf[descOff + 2] << 16) | ((uint32_t)buf[descOff + 3] << 24);
  if (magic != 0xABCD5432) return -1;
  char ver[33];
  memcpy(ver, buf + verOff, 32);
  ver[32] = '\0';
  return semverToCode(ver);
}

int runningVersionCode() {
  const esp_app_desc_t *d = esp_ota_get_app_description();
  int code = d ? semverToCode(d->version) : -1;
  if (code < 0) code = FW_VERSION_CODE;   // fall back to compiled version
  return code;
}

} // namespace Security
