#[path = "../../zg-fix/src/firmware/desktop/src-tauri/src/transport.rs"]
mod transport;
#[path = "../../zg-fix/src/firmware/desktop/src-tauri/src/server.rs"]
mod server;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;
use transport::BackendTransport;

fn serve_mock(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf: Vec<u8> = Vec::new();
    let head_end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break p; }
        let mut chunk = [0u8; 2048];
        match stream.read(&mut chunk) { Ok(0) => return, Ok(n) => buf.extend_from_slice(&chunk[..n]), Err(e) => { eprintln!("[mock] read err: {e}"); return; } }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    eprintln!("[mock] got head ({} bytes): {:?}", head.len(), head);
    let path = head.split_whitespace().nth(1).unwrap_or("/");
    if path == "/ws" {
        let resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
        let frame = [0x81u8, 0x03, b'1', b'2', b'3'];
        stream.write_all(resp.as_bytes()).unwrap();
        stream.write_all(&frame).unwrap();
        eprintln!("[mock] wrote 101 + frame, closing");
    }
}

fn start_mock() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || { for c in listener.incoming() { if let Ok(s) = c { std::thread::spawn(move || serve_mock(s)); } } });
    port
}

fn probe(label: &str, port: u16, raw: &str) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    match s.read(&mut chunk) {
        Ok(n) => { buf.extend_from_slice(&chunk[..n]); let mut c2 = [0u8; 4096]; if let Ok(n2) = s.read(&mut c2) { buf.extend_from_slice(&c2[..n2]); } }
        Err(e) => eprintln!("[{label}] read err: {e}"),
    }
    println!("[{label}] {} bytes: {:?}", buf.len(), String::from_utf8_lossy(&buf));
}

fn main() {
    let ws_req = "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
    let mock_port = start_mock();
    probe("direct-to-mock", mock_port, ws_req);
    let backend = Arc::new(transport::SimulatorTransport::new("127.0.0.1", mock_port));
    let shell_port = server::spawn(None, backend).unwrap();
    println!("shell_port={shell_port}");
    probe("via-shell", shell_port, ws_req);
    std::thread::sleep(Duration::from_millis(300));
}
