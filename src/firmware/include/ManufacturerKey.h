#pragma once

// ============================================================================
//  Manufacturer firmware-signing PUBLIC key (ECDSA P-256 / SHA-256).
//
//  This PUBLIC key is safe to embed and distribute. It is used at runtime to
//  verify the signature of firmware images before a (production) OTA update is
//  accepted.
//
//  The corresponding PRIVATE key MUST NEVER be committed to this repository,
//  the firmware, flash, or the web UI. It is generated and stored offline by
//  the manufacturer (see tools/production/).
//
//  The key below is a DEVELOPMENT DEFAULT. Replace it with your real
//  manufacturer public key for production by running:
//      python3 tools/production/embed_pubkey.py path/to/signing_pub.pem
// ============================================================================

static const char MANUFACTURER_PUBLIC_KEY_PEM[] = R"PEM(
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGmryhr1sr958m/2UoWVRqtyP4RuB
0EzjZLUkFXe5CmTqy7q07xn8K5QmvOLRCHyDKbyIifTqLbvt1WCnFN+BfA==
-----END PUBLIC KEY-----
)PEM";
