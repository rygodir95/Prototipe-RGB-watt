// ZoneGlow mobile transport - Node smoke tests (no framework).
//
// Runs the REAL www/transport.js under Node with a mocked fetch /
// window.Capacitor, covering the Android connection bug: the shell origin is
// http://localhost, so a plain fetch() to the Hub is cross-origin and the
// WebView blocks the response (CORS) - exactly like the TypeError case here.
// The native CapacitorHttp path must recognize the same reachable Hub as
// Connected.
//
// Run: node mobile/tests/test-transport.cjs

"use strict";

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error("FAIL: " + name);
  passed++;
  console.log("  ok - " + name);
}

function mockStorage() {
  const m = new Map();
  global.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// Fresh module instance per section (globals differ between sections).
function freshTransport() {
  delete require.cache[require.resolve(
    require("path").join(__dirname, "..", "capacitor", "www", "transport.js"))];
  return require(require("path").join(__dirname, "..", "capacitor", "www", "transport.js"));
}

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: () => Promise.resolve(body),
  };
}

const INFO = JSON.stringify({ version: "1.0.0", deviceId: "PC-SIMULATOR" });

async function rejects(p, msgPart) {
  let threw = null;
  try { await p; } catch (e) { threw = e; }
  if (!threw) throw new Error("expected rejection containing '" + msgPart + "'");
  if (msgPart && !String(threw.message || threw).includes(msgPart)) {
    throw new Error("rejection '" + threw.message + "' missing '" + msgPart + "'");
  }
  return threw;
}

(async function main() {
  // ---- normalizeUrl ----
  console.log("normalizeUrl");
  {
    const T = freshTransport();
    global.window = undefined;
    ok("adds http:// and strips trailing slashes",
      T.normalizeUrl("10.0.2.2:8080/") === "http://10.0.2.2:8080");
    ok("keeps full URL",
      T.normalizeUrl("http://192.168.1.50") === "http://192.168.1.50");
    ok("rejects non-host garbage", T.normalizeUrl("://") === "");
    ok("rejects empty", T.normalizeUrl("   ") === "");
  }

  // ---- persistence (last successful Hub address) ----
  console.log("hub address persistence");
  {
    mockStorage();
    const T = freshTransport();
    ok("default without storage", T.getUrl() === "http://zoneglow.local");
    ok("setUrl accepts emulator alias", T.setUrl("10.0.2.2:8080"));
    ok("getUrl returns stored address", T.getUrl() === "http://10.0.2.2:8080");
    ok("setUrl rejects invalid", T.setUrl("not a url") === false);
    ok("stored address survives reload", freshTransport().getUrl() === "http://10.0.2.2:8080");
  }

  // ---- probe: fetch fallback paths (mirrors the OLD buggy behavior) ----
  console.log("probe - fetch fallback");
  {
    mockStorage();
    const T = freshTransport();
    global.window = undefined;   // no Capacitor -> plain fetch

    ok("200 JSON -> Connected", await T.probe("http://10.0.2.2:8080", 500, () =>
      Promise.resolve(res(200, INFO))));
    await rejects(T.probe("http://10.0.2.2:8080", 500, () =>
      Promise.resolve(res(500, "boom"))), "HTTP 500");
    await rejects(T.probe("http://10.0.2.2:8080", 500, () =>
      Promise.resolve(res(200, "<html>router login</html>"))), "JSON object");
    // CORS-blocked response appears exactly like this in the WebView:
    await rejects(T.probe("http://10.0.2.2:8080", 500, () =>
      Promise.reject(new TypeError("Failed to fetch"))), "Failed to fetch");
    // Unreachable Hub that never answers -> hard timeout, not a hang:
    await rejects(T.probe("http://10.9.9.9:8080", 60, () =>
      new Promise(() => {})), "timed out");
  }

  // ---- probe: native CapacitorHttp path (the Android fix) ----
  console.log("probe - native CapacitorHttp");
  {
    mockStorage();
    const T = freshTransport();
    const calls = [];
    global.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          CapacitorHttp: {
            get: (opts) => {
              calls.push(opts.url);
              if (opts.url.endsWith("/api/info")) {
                return Promise.resolve({ status: 200, data: JSON.parse(INFO) });
              }
              return Promise.reject(new Error("not found"));
            },
          },
        },
      },
      location: { origin: "http://localhost" },
    };

    ok("native probe hits /api/info",
      (await T.probe("http://10.0.2.2:8080", 500)) === true &&
      calls[0] === "http://10.0.2.2:8080/api/info");
    ok("single native request, no fetch fallback", calls.length === 1);
  }
  {
    mockStorage();
    const T = freshTransport();
    global.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          CapacitorHttp: {
            get: () => Promise.resolve({ status: 404, data: "nope" }),
          },
        },
      },
    };
    await rejects(T.probe("http://10.0.2.2:8080", 500), "HTTP 404");
  }
  {
    mockStorage();
    const T = freshTransport();
    global.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          CapacitorHttp: {
            get: () => Promise.reject(new Error("java.net.ConnectException")),
          },
        },
      },
    };
    await rejects(T.probe("http://10.0.2.2:8080", 500), "ConnectException");
  }
  {
    // isNativePlatform() false (browser dev) must NOT use the plugin.
    mockStorage();
    const T = freshTransport();
    let usedNative = false;
    global.window = {
      Capacitor: {
        isNativePlatform: () => false,
        Plugins: {
          CapacitorHttp: { get: () => { usedNative = true; return Promise.resolve({}); } },
        },
      },
    };
    await T.probe("http://10.0.2.2:8080", 500, () => Promise.resolve(res(200, INFO)));
    ok("browser dev stays on fetch", !usedNative);
  }

  console.log("\nAll " + passed + " transport smoke tests passed.");
  process.exit(0);
})().catch(function (e) {
  console.error("\n" + (e && e.stack || e));
  process.exit(1);
});