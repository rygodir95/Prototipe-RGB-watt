// ZoneGlow desktop shell server.
//
// A tiny localhost-only HTTP server running inside ZoneGlow.exe:
//   * serves the locally staged ZoneGlow web UI (src-tauri/generated-web/,
//     a build-time copy of the firmware's data/web/ - never edited by hand),
//   * forwards /api/* REST calls to the configured backend transport
//     (GET /api/config long-polls while the backend is offline, so the UI's
//     startup completes the moment the backend returns),
//   * tunnels the /ws telemetry WebSocket to the backend verbatim.
//
// The web UI keeps using the same relative REST/WS URLs it uses when served
// by the ESP32, so data/web stays the single source of truth and stays
// unmodified. Everything here is std-only (no extra crates).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::transport::BackendTransport;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
const CONFIG_RETRY_DELAY: Duration = Duration::from_millis(1000);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Locate the staged web UI. Order: explicit override (tests), bundled
/// resources (packaged ZoneGlow.exe), dev fallbacks (`tauri dev` runs cargo
/// from src-tauri/).
pub fn resolve_web_root(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ZONEGLOW_WEB_ROOT") {
        let p = PathBuf::from(p);
        if p.join("index.html").is_file() {
            return Some(p);
        }
    }
    if let Some(dir) = resource_dir {
        let p = dir.join("web");
        if p.join("index.html").is_file() {
            return Some(p);
        }
    }
    for cand in ["generated-web", "src-tauri/generated-web", "../src-tauri/generated-web"] {
        let p = PathBuf::from(cand);
        if p.join("index.html").is_file() {
            return Some(p);
        }
    }
    None
}

/// Bind 127.0.0.1:8787 (falling back through 8797) and serve in the
/// background. Returns the bound port (the window URL needs it).
pub fn spawn(web_root: PathBuf, backend: Arc<dyn BackendTransport>) -> std::io::Result<u16> {
    let (listener, port) = bind_local()?;
    println!(
        "[shell] ZoneGlow UI on http://127.0.0.1:{}/ -> backend: {}",
        port,
        backend.label()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(client) => {
                    let root = web_root.clone();
                    let b = Arc::clone(&backend);
                    std::thread::spawn(move || handle(client, root, b));
                }
                Err(_) => continue,
            }
        }
    });
    Ok(port)
}

fn bind_local() -> std::io::Result<(TcpListener, u16)> {
    for port in 8787..=8797u16 {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => return Ok((l, port)),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AddrInUse,
        "no free port in 8787-8797",
    ))
}

fn handle(mut client: TcpStream, web_root: PathBuf, backend: Arc<dyn BackendTransport>) {
    let _ = client.set_read_timeout(Some(IO_TIMEOUT));
    let _ = client.set_write_timeout(Some(IO_TIMEOUT));

    // ---- read the request head (terminated by \r\n\r\n) ----
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let head_end = loop {
        if let Some(pos) = find_head_end(&buf) {
            break pos;
        }
        if buf.len() > MAX_HEAD_BYTES {
            respond(&mut client, 431, "text/plain", b"request head too large");
            return;
        }
        let mut chunk = [0u8; 4096];
        match client.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut body: Vec<u8> = buf[(head_end + 4).min(buf.len())..].to_vec();

    // ---- parse request line + Content-Length ----
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let raw_path = parts.next().unwrap_or("/").to_string();
    let path_only = raw_path.split('?').next().unwrap_or("/").to_string();

    let mut content_length = 0usize;
    for line in head.split("\r\n").skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    if content_length > MAX_BODY_BYTES {
        respond(&mut client, 413, "text/plain", b"request body too large");
        return;
    }
    let mut chunk = [0u8; 16384];
    while body.len() < content_length {
        match client.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }

    // ---- dispatch ----
    if path_only == "/ws" {
        ws_tunnel(client, head, body, backend);
        return;
    }
    if path_only.starts_with("/api/") {
        proxy_api(client, &method, &raw_path, &head, body, backend);
        return;
    }
    serve_static(client, &path_only, &web_root);
}

/// Serve a file from the staged web UI (index.html for "/"). Path traversal is
/// rejected; unknown paths 404 (including /dev/ - the Developer Panel is not
/// part of the desktop app).
fn serve_static(mut client: TcpStream, path: &str, root: &Path) {
    let rel = if path == "/" || path == "/index.html" {
        "index.html"
    } else {
        match path.strip_prefix('/') {
            Some(r) => r,
            None => {
                respond(&mut client, 400, "text/plain", b"bad request");
                return;
            }
        }
    };
    if rel.is_empty()
        || rel.split('/')
            .any(|seg| seg == ".." || seg == "." || seg.contains('\\'))
    {
        respond(&mut client, 404, "text/plain", b"not found");
        return;
    }
    let full = root.join(rel);
    if !full.is_file() {
        respond(&mut client, 404, "text/plain", b"not found");
        return;
    }
    let data = match std::fs::read(&full) {
        Ok(d) => d,
        Err(_) => {
            respond(&mut client, 500, "text/plain", b"read error");
            return;
        }
    };
    let ctype = match full.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };
    respond(&mut client, 200, ctype, &data);
}

/// Forward an /api/* request to the backend. The request is rebuilt with
/// `Connection: close` so read-to-EOF delimits the response (works for both
/// the simulator's HTTP/1.0 and the ESP32's HTTP/1.1).
///
/// `GET /api/config` long-polls while the backend is unreachable: the UI's
/// startup awaits its config, so holding the request keeps the UI intact
/// offline and lets it finish initializing the instant the backend returns.
/// Every other call fails fast with 502.
fn proxy_api(
    mut client: TcpStream,
    method: &str,
    raw_path: &str,
    head: &str,
    body: Vec<u8>,
    backend: Arc<dyn BackendTransport>,
) {
    let is_config_get = method == "GET" && raw_path.split('?').next() == Some("/api/config");

    let mut request = format!("{} {} HTTP/1.1\r\n", method, raw_path);
    for line in head.split("\r\n").skip(1) {
        if line.is_empty() {
            continue;
        }
        let name = line.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "host" | "connection" | "keep-alive" | "proxy-connection" | "upgrade"
        ) {
            continue;
        }
        request.push_str(line);
        request.push_str("\r\n");
    }
    request.push_str("Connection: close\r\n\r\n");

    loop {
        let mut upstream = match backend.connect(CONNECT_TIMEOUT) {
            Ok(s) => s,
            Err(_) => {
                if is_config_get {
                    std::thread::sleep(CONFIG_RETRY_DELAY);
                    continue;
                }
                respond(&mut client, 502, "text/plain", b"backend unreachable");
                return;
            }
        };
        let _ = upstream.set_read_timeout(Some(IO_TIMEOUT));
        let _ = upstream.set_write_timeout(Some(IO_TIMEOUT));
        if upstream.write_all(request.as_bytes()).is_err()
            || (!body.is_empty() && upstream.write_all(&body).is_err())
        {
            if is_config_get {
                std::thread::sleep(CONFIG_RETRY_DELAY);
                continue;
            }
            respond(&mut client, 502, "text/plain", b"backend unreachable");
            return;
        }
        let mut response: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 16384];
        loop {
            match upstream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => response.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }
        if response.is_empty() {
            // Backend accepted the connection but produced no response (e.g.
            // still starting up). Same policy as unreachable.
            if is_config_get {
                std::thread::sleep(CONFIG_RETRY_DELAY);
                continue;
            }
            respond(&mut client, 502, "text/plain", b"backend closed connection");
            return;
        }
        let _ = client.write_all(&response);
        let _ = client.flush();
        return;
    }
}

/// WebSocket tunnel: forward the original handshake verbatim (the backend
/// computes Sec-WebSocket-Accept from the same Sec-WebSocket-Key the client
/// sent), then pipe bytes blindly in both directions. Client->server frames
/// are already masked (valid as-is) and server->client frames are unmasked
/// (valid as-is), so no frame is ever rewritten. When either side closes, the
/// whole tunnel is torn down - the UI's app.js then retries on its own.
fn ws_tunnel(mut client: TcpStream, head: String, early: Vec<u8>, backend: Arc<dyn BackendTransport>) {
    let mut upstream = match backend.connect(CONNECT_TIMEOUT) {
        Ok(s) => s,
        Err(_) => {
            let _ = client.write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
    };
    let up_write = match upstream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let cl_read = match client.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    if upstream.write_all(head.as_bytes()).is_err()
        || (!early.is_empty() && upstream.write_all(&early).is_err())
    {
        let _ = client.write_all(
            b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    }

    let mut up_read = upstream;
    let mut cl_write = client;
    let pump = std::thread::spawn(move || {
        let mut cl_read = cl_read;
        let mut up_write = up_write;
        let _ = std::io::copy(&mut cl_read, &mut up_write);
        let _ = up_write.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut up_read, &mut cl_write);
    // Either side ended: tear the tunnel down completely.
    let _ = cl_write.shutdown(std::net::Shutdown::Both);
    let _ = up_read.shutdown(std::net::Shutdown::Both);
    let _ = pump.join();
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn respond(client: &mut TcpStream, status: u16, ctype: &str, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let _ = write!(
        client,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason,
        ctype,
        body.len()
    );
    let _ = client.write_all(body);
    let _ = client.flush();
}