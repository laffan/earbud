//! Local-network receiver: a small threaded TCP server (std::net, so it runs
//! unchanged on iOS, macOS, Windows and Linux).
//!
//! On iOS, accepting incoming TCP connections does not need the Local Network
//! permission (TN3179); only outgoing connections and Bonjour do, and this
//! server uses neither.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::inbox;
use super::protocol::*;
use super::{Inner, WatchLinkEvent, VIA_LOCAL_NETWORK};

const POLL: Duration = Duration::from_millis(150);
/// Per read; the Watch writes a recording in one go, so a stall this long
/// means the connection is gone.
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: usize = 8;
/// Consecutive accept errors after which the listener is considered dead
/// (for example when iOS reclaimed the socket while the app was suspended).
const MAX_ACCEPT_ERRORS: u32 = 40;

pub(super) struct Server {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    pub port: u16,
    alive: Arc<AtomicBool>,
}

impl Server {
    pub fn start(inner: Arc<Inner>, port: u16) -> io::Result<Server> {
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let thread = {
            let (stop, alive) = (stop.clone(), alive.clone());
            thread::Builder::new()
                .name("watch-link-accept".into())
                .spawn(move || {
                    accept_loop(&listener, &inner, &stop, port);
                    alive.store(false, Ordering::SeqCst);
                })?
        };
        Ok(Server {
            stop,
            thread: Some(thread),
            port,
            alive,
        })
    }

    /// Whether the accept loop is still running.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept_loop(listener: &TcpListener, inner: &Arc<Inner>, stop: &AtomicBool, port: u16) {
    let mut errors = 0u32;
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _peer)) => {
                errors = 0;
                if inner.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    inner.active.fetch_sub(1, Ordering::SeqCst);
                    continue; // dropping the stream closes it
                }
                let worker = inner.clone();
                let spawned = thread::Builder::new()
                    .name("watch-link-connection".into())
                    .spawn(move || {
                        let _ = handle(&worker, stream, port);
                        worker.active.fetch_sub(1, Ordering::SeqCst);
                    });
                if spawned.is_err() {
                    inner.active.fetch_sub(1, Ordering::SeqCst);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(POLL),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => {
                errors += 1;
                if errors >= MAX_ACCEPT_ERRORS {
                    let message = format!("Stopped listening for the Watch: {e}");
                    inner.set_error(Some(message.clone()));
                    inner.emit(WatchLinkEvent::Error { message });
                    return;
                }
                thread::sleep(POLL);
            }
        }
    }
}

fn handle(inner: &Inner, mut stream: TcpStream, port: u16) -> io::Result<()> {
    // Accepted sockets inherit non-blocking mode on BSD-derived systems.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let _ = stream.set_nodelay(true);
    let mut kind = [0u8; 1];
    stream.read_exact(&mut kind)?;
    match kind[0] {
        MSG_RECORDING => handle_recording(inner, &mut stream),
        MSG_PAIRING => handle_pairing(inner, &mut stream, port),
        _ => Ok(()),
    }
}

/// `[u32 BE length][payload]`, or `None` if the length is 0 or above `max`.
fn read_frame(stream: &mut TcpStream, max: u32) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len);
    if len == 0 || len > max {
        return Ok(None);
    }
    let mut payload = vec![0u8; len as usize];
    stream.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn reply(stream: &mut TcpStream, accepted: bool) -> io::Result<()> {
    stream.write_all(&[u8::from(accepted)])?;
    stream.flush()
}

fn handle_recording(inner: &Inner, stream: &mut TcpStream) -> io::Result<()> {
    let Some(header) = read_frame(stream, MAX_HEADER_BYTES)? else {
        return reply(stream, false);
    };
    let Ok(transfer) = serde_json::from_slice::<RecordingTransfer>(&header) else {
        return reply(stream, false);
    };
    if !inner.accepts_secret(transfer.pairing_secret.as_deref()) {
        inner.emit(WatchLinkEvent::Error {
            message: format!(
                "Refused a recording from {}: it is not paired with this device.",
                transfer.sender_name.as_deref().unwrap_or("a watch")
            ),
        });
        return reply(stream, false);
    }
    if transfer.byte_count > MAX_AUDIO_BYTES {
        return reply(stream, false);
    }
    match inbox::receive(&inner.inbox, &transfer, VIA_LOCAL_NETWORK, &mut *stream) {
        Ok(entry) => {
            reply(stream, true)?;
            inner.emit(WatchLinkEvent::Received {
                name: entry.name,
                sender: entry.sender,
                via: VIA_LOCAL_NETWORK.into(),
            });
            Ok(())
        }
        Err(error) => {
            inner.emit(WatchLinkEvent::Error {
                message: format!("A recording from the Watch did not arrive: {error}"),
            });
            reply(stream, false)
        }
    }
}

fn handle_pairing(inner: &Inner, stream: &mut TcpStream, port: u16) -> io::Result<()> {
    let Some(body) = read_frame(stream, MAX_PAIRING_BYTES)? else {
        return reply(stream, false);
    };
    let Ok(request) = serde_json::from_slice::<PairingRequest>(&body) else {
        return reply(stream, false);
    };
    let Some(mut response) = inner.try_pair(&request.code) else {
        return reply(stream, false);
    };
    response.port = port;
    let json = serde_json::to_vec(&response).map_err(io::Error::other)?;
    let mut out = vec![1u8];
    out.extend_from_slice(&length_prefixed(&json));
    stream.write_all(&out)?;
    stream.flush()?;
    inner.paired(&request.device_name, VIA_LOCAL_NETWORK);
    Ok(())
}
