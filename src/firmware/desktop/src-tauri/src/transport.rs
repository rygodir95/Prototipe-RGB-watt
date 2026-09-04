// ZoneGlow desktop - BackendTransport abstraction.
//
// The shell server (server.rs) talks to the configured ZoneGlow backend over
// plain TCP (REST + WebSocket). Both possible backends expose the exact same
// REST API and telemetry WebSocket, so a transport is just "where to connect":
//
//   SimulatorTransport - the PC simulator, development default
//                       (http://localhost:8080, override with ZONEGLOW_BACKEND_URL).
//   Esp32Transport    - the real ESP32 controller. Placeholder ONLY: per the
//                       desktop milestone requirements, real ESP32 communication
//                       is intentionally NOT implemented yet. Enabling it later
//                       is just selecting this transport with the controller's
//                       LAN address - the UI, REST paths and WebSocket are
//                       identical.
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub trait BackendTransport: Send + Sync {
    fn label(&self) -> String;
    fn connect(&self, timeout: Duration) -> io::Result<TcpStream>;
}

pub struct SimulatorTransport {
    host: String,
    port: u16,
}

impl SimulatorTransport {
    /// Direct construction (used by the shell integration tests).
    pub fn new(host: &str, port: u16) -> Self {
        Self { host: host.to_string(), port }
    }

    pub fn from_env_or_default() -> Self {
        // Accepts "http://localhost:8080", "localhost:8080", "192.168.1.50" ...
        let raw = std::env::var("ZONEGLOW_BACKEND_URL")
            .unwrap_or_else(|_| "http://localhost:8080".to_string());
        let s = raw
            .trim()
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_end_matches('/')
            .trim();
        let (host, port) = match s.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().unwrap_or(8080)),
            None => (s.to_string(), 8080),
        };
        Self { host, port }
    }
}

impl BackendTransport for SimulatorTransport {
    fn label(&self) -> String {
        format!("PC Simulator ({}:{})", self.host, self.port)
    }
    fn connect(&self, timeout: Duration) -> io::Result<TcpStream> {
        connect_to(&self.host, self.port, timeout)
    }
}

/// Future production backend. Deliberately not selectable and not implemented
/// in this milestone - declared here so the transport seam already exists.
#[allow(dead_code)]
pub struct Esp32Transport {
    host: String, // future: the controller's LAN address
    port: u16,
}

fn connect_to(host: &str, port: u16, timeout: Duration) -> io::Result<TcpStream> {
    let mut last: Option<io::Error> = None;
    for addr in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(s) => return Ok(s),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::new(io::ErrorKind::Other, "no addresses resolved")))
}