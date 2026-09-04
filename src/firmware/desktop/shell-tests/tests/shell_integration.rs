// Integration tests for the ZoneGlow desktop shell server.
//
// They drive the REAL shell server (src-tauri/src/server.rs, included verbatim
// via #[path]) against a mock backend that mirrors the PC simulator's exact
// wire behaviour (HTTP/1.0 + Content-Length, connection closed after the
// response, plain WebSocket upgrade).
//
// Regression coverage for the Windows desktop runtime bug where the zone
// editors stayed empty and telemetry never connected:
//   * /api/config (with the full zone data) must reach the bundled UI exactly
//     as it reaches the browser,
//   * the /ws tunnel must complete the WebSocket handshake and relay frames,
//   * an offline backend must not kill startup: the held config request must
//     resolve the moment the backend appears,
//   * the bundled UI must be served byte-identically,
//   * a missing bundled UI must produce a visible notice, not a silent exit.

#[path = "../../src-tauri/src/transport.rs"]
mod transport;
#[path = "../../src-tauri/src/server.rs"]
mod server;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use transport::BackendTransport;

/// Config payload shaped exactly like the simulator's /api/config for
/// FTP 221 W (7 power zones) and Max HR 190 BPM (5 HR zones). Fixture only -
/// the real values always come from the backend.
const CONFIG_JSON: &str = r##"{"ftp":221,"zoneCount":7,"hrMax":190,"controlSource":"power","zones":[{"name":"Recovery","min":0,"max":124,"color":"#005aff"},{"name":"Endurance","min":124,"max":168,"color":"#00c8c8"},{"name":"Tempo","min":168,"max":201,"color":"#00dc46"},{"name":"Threshold","min":201,"max":234,"color":"#ffdc00"},{"name":"VO2 Max","min":234,"max":267,"color":"#ff7800"},{"name":"Anaerobic","min":267,"max":334,"color":"#ff1900"},{"name":"Neuromuscular","min":334,"max":-1,"color":"#960000"}],"hrZones":[{"name":"Recovery","min":95,"max":114,"color":"#7878ff"},{"name":"Endurance","min":115,"max":133,"color":"#00beff"},{"name":"Tempo","min":134,"max":152,"color":"#00e678"},{"name":"Threshold","min":153,"max":171,"color":"#ffc800"},{"name":"Maximum","min":172,"max":190,"color":"#ff2828"}]}"##;

// ---- mock backend: the simulator's wire behaviour, std only ----

fn serve_mock(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    // Read until the request head terminates. A correct HTTP request always
    // ends with a blank line - if the shell drops it, this read never
    // completes and the WebSocket regression below fails.
    let mut buf: Vec<u8> = Vec::new();
    let head_end = loop {
        if let Some(p) = find_blank_line(&buf) {
            break p;
        }
        let mut chunk = [0u8; 2048];
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => return,
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();

    if path == "/ws" {
        // Simulator-style upgrade, then one unmasked server text frame.
        let resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
        if stream.write_all(resp.as_bytes()).is_err() {
            return;
        }
        let frame = [0x81u8, 0x03, b'1', b'2', b'3'];
        let _ = stream.write_all(&frame);
        return;
    }
    let (body, ctype): (&[u8], &str) = if path == "/api/config" {
        (CONFIG_JSON.as_bytes(), "application/json")
    } else if path == "/api/info" {
        (br#"{"version":"mock"}"#, "application/json")
    } else {
        (b"Not found", "text/plain")
    };
    let resp = format!(
        "HTTP/1.0 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\n\r\n",
        ctype,
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.write_all(body);
}

fn find_blank_line(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn start_mock_backend(port: u16) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let bound = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            match conn {
                Ok(s) => {
                    std::thread::spawn(move || serve_mock(s));
                }
                Err(_) => break,
            }
        }
    });
    bound
}

// ---- helpers ----

fn fixture_web_root() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zoneglow-shell-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), b"<html><body>ZoneGlow fixture</body></html>").unwrap();
    std::fs::write(dir.join("app.js"), b"console.log('fixture ui');").unwrap();
    // The bundled default config the offline UI bootstraps from (fixture:
    // the real file is generated from the simulator's authoritative
    // defaults at staging time; parity is enforced by CI and by the jsdom
    // offline-ui regression test).
    std::fs::write(dir.join("default-config.json"), CONFIG_JSON.as_bytes()).unwrap();
    dir
}

fn spawn_shell(web_root: Option<PathBuf>, backend_port: u16) -> u16 {
    let backend = Arc::new(transport::SimulatorTransport::new("127.0.0.1", backend_port));
    server::spawn(web_root, backend).unwrap()
}

/// Send a raw request to the shell server. Returns (response bytes, timed_out).
fn shell_request(port: u16, raw: &str, timeout: Duration) -> (Vec<u8>, bool) {
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    stream.write_all(raw.as_bytes()).unwrap();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let mut chunk = [0u8; 4096];
        match stream.read(&mut chunk) {
            Ok(0) => return (buf, false),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if Instant::now() >= deadline {
                    return (buf, true);
                }
            }
            Err(_) => return (buf, false),
        }
    }
}

fn body_of(resp: &[u8]) -> String {
    let text = String::from_utf8_lossy(resp).into_owned();
    text.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
}

const GET_CONFIG: &str = "GET /api/config HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: */*\r\n\r\n";

// ---- scenarios ----

#[test]
fn shell_suite() {
    let web_root = fixture_web_root();

    // 1. Bundled UI is served byte-identically.
    {
        let backend_port = start_mock_backend(0);
        let shell_port = spawn_shell(Some(web_root.clone()), backend_port);
        let (resp, timed_out) = shell_request(shell_port, "GET /app.js HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", Duration::from_secs(5));
        assert!(!timed_out, "static request timed out");
        assert_eq!(body_of(&resp), "console.log('fixture ui');", "bundled app.js must be served byte-identically");
    }

    // 2. /api/config with the full zone data reaches the UI exactly as in the browser.
    {
        let backend_port = start_mock_backend(0);
        let shell_port = spawn_shell(Some(web_root.clone()), backend_port);
        let (resp, timed_out) = shell_request(shell_port, GET_CONFIG, Duration::from_secs(5));
        assert!(!timed_out, "config request timed out");
        let body = body_of(&resp);
        assert_eq!(body, CONFIG_JSON, "config must be relayed verbatim - the UI must receive exactly the same JSON as the browser");
        assert!(body.contains(r#""ftp":221"#), "FTP value missing");
        assert!(body.contains(r#""hrMax":190"#), "Max HR value missing");
        assert!(body.contains(r#""zones""#), "power zones missing");
        assert!(body.contains(r#""hrZones""#), "heart rate zones missing");
        assert!(body.contains("Neuromuscular"), "power zone rows missing");
        assert!(body.contains(r#""min":172,"max":190"#), "HR zone 5 range missing");
    }

    // 3. WebSocket tunnel completes the handshake and relays telemetry.
    {
        let backend_port = start_mock_backend(0);
        let shell_port = spawn_shell(Some(web_root.clone()), backend_port);
        let ws = "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
        let (resp, timed_out) = shell_request(shell_port, ws, Duration::from_secs(5));
        assert!(
            !timed_out,
            "WebSocket handshake through the shell timed out - the terminating blank line is likely dropped again"
        );
        let text = String::from_utf8_lossy(&resp).into_owned();
        assert!(
            text.contains("101 Switching Protocols"),
            "expected the WebSocket upgrade response, got: {}",
            &text[..text.len().min(200)]
        );
        assert!(
            resp.windows(3).any(|w| w == b"123"),
            "telemetry frame did not reach the client through the tunnel"
        );
    }

    // 4. Offline startup: config long-polls and resolves when the backend appears.
    {
        // reserve a currently-dead port
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let dead_port = probe.local_addr().unwrap().port();
        drop(probe);

        let shell_port = spawn_shell(Some(web_root.clone()), dead_port);
        let (resp, timed_out) = shell_request(shell_port, GET_CONFIG, Duration::from_millis(1200));
        assert!(timed_out, "config must be held (long-poll) while the backend is offline");
        assert!(resp.is_empty(), "no partial response expected while offline");

        // backend comes up -> a new config request must resolve with the zone data
        let _ = start_mock_backend(dead_port);
        let (resp, timed_out) = shell_request(shell_port, GET_CONFIG, Duration::from_secs(5));
        assert!(!timed_out, "config request did not recover after the backend appeared");
        let body = body_of(&resp);
        assert_eq!(body, CONFIG_JSON, "recovered config must still carry the zone data verbatim");
    }

    // 5. Missing bundled UI -> visible notice page instead of a silent failure.
    {
        let backend_port = start_mock_backend(0);
        let shell_port = spawn_shell(None, backend_port);
        let (resp, timed_out) = shell_request(shell_port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", Duration::from_secs(5));
        assert!(!timed_out, "request timed out");
        let text = String::from_utf8_lossy(&resp).into_owned();
        assert!(text.contains("200"), "notice page must be served with 200, got: {}", &text[..text.len().min(120)]);
        assert!(text.contains("bundled"), "notice page must explain the missing bundled UI");
    }

    // 6. Offline startup: the bundled default config is served with NO
    //    backend, /api/config stays held, and the backend's real config
    //    takes over once the backend appears (the frontend swap from the
    //    bundled defaults to the backend config is covered end-to-end by
    //    the jsdom offline-ui regression test).
    {
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let dead_port = probe.local_addr().unwrap().port();
        drop(probe);
        let shell_port = spawn_shell(Some(web_root.clone()), dead_port);

        // The bundled defaults are a static file: they must load immediately,
        // with no backend, so the offline UI has a complete config to render.
        let (resp6, timed_out6) = shell_request(
            shell_port,
            "GET /default-config.json HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            Duration::from_secs(5),
        );
        assert!(!timed_out6, "default-config.json request timed out - the offline UI has no config to render");
        let body6 = body_of(&resp6);
        assert_eq!(body6, CONFIG_JSON, "bundled default config must be served verbatim while the backend is offline");
        assert!(body6.contains(r#""ftp":221"#), "default FTP missing from the bundled config");
        assert!(body6.contains(r#""hrMax":190"#), "default Max HR missing from the bundled config");
        assert!(body6.contains("Neuromuscular"), "default power zones missing from the bundled config");
        assert!(body6.contains(r#""max":190"#), "default HR zone 5 boundary missing from the bundled config");

        // /api/config must stay held while offline: the UI must never
        // mistake the offline state for a backend answer.
        let (held6, timed_out6b) = shell_request(shell_port, GET_CONFIG, Duration::from_millis(1000));
        assert!(timed_out6b, "config must stay held while the backend is offline");
        assert!(held6.is_empty(), "no partial response expected while offline");

        // Backend appears: the request resolves with the BACKEND's config.
        let _ = start_mock_backend(dead_port);
        let (resp6b, timed_out6c) = shell_request(shell_port, GET_CONFIG, Duration::from_secs(5));
        assert!(!timed_out6c, "config request did not recover after the backend appeared");
        assert_eq!(body_of(&resp6b), CONFIG_JSON, "the backend's authoritative config must take over from the offline defaults");
    }
}
