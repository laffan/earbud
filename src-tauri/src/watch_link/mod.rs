//! Watch link: receiving recordings from the Earbud Apple Watch app.
//!
//! The protocol is the one from Woods Whisper (see `watch-app/README.md`):
//! the receiver shows a 5-digit code for two minutes, the Watch finds it with
//! that code and gets back the receiver's **name**, a durable secret and a
//! stable device id. From then on the Watch shows which device its
//! recordings go to and stamps the secret on every transfer.
//!
//! Transports:
//! * local network (TCP, this module, every platform);
//! * Bluetooth LE and the paired iPhone (WatchConnectivity), iOS only,
//!   implemented in Swift in `plugins/tauri-plugin-watch-link`. Those write
//!   into the same inbox; [`WatchLink::import_inbox`] turns every inbox entry
//!   into a sketch, whichever transport delivered it.
//!
//! Like the library, this module has no Tauri types, so it is tested with
//! plain `cargo test`.

pub mod inbox;
pub mod protocol;
mod server;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::library::models::{ImportRecordingArgs, Sketch};
use crate::library::Library;
use protocol::{parse_iso8601_ms, secrets_match, sketch_id_for, valid_extension, PairingResponse};
use server::Server;

/// `capture_backend` of sketches recorded on the Watch.
pub const WATCH_BACKEND: &str = "apple-watch";
pub const VIA_LOCAL_NETWORK: &str = "localNetwork";
/// How long a pairing code is accepted.
pub const PAIRING_WINDOW_MS: i64 = 120_000;
/// Wrong codes after which the pairing window closes early.
const MAX_PAIRING_FAILURES: u32 = 20;
const CONFIG_FILE: &str = "watch-link.json";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn random_secret() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn random_code() -> String {
    format!("{:05}", uuid::Uuid::new_v4().as_u128() % 100_000)
}

/// What the receiver calls itself until the user names it.
pub fn default_display_name() -> &'static str {
    if cfg!(target_os = "ios") {
        "iPhone"
    } else if cfg!(target_os = "macos") {
        "Mac"
    } else if cfg!(target_os = "windows") {
        "Windows PC"
    } else {
        "Computer"
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedWatch {
    pub name: String,
    pub via: String,
    pub paired_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    device_id: String,
    secret: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    paired_watches: Vec<PairedWatch>,
}

impl Config {
    fn new() -> Self {
        Config {
            device_id: random_secret(),
            secret: random_secret(),
            display_name: None,
            enabled: false,
            paired_watches: vec![],
        }
    }

    fn display_name(&self) -> String {
        self.display_name
            .clone()
            .unwrap_or_else(|| default_display_name().to_string())
    }
}

#[derive(Debug, Clone)]
struct PairingWindow {
    code: String,
    expires_at: i64,
    failures: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub code: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchLinkStatus {
    /// The user turned receiving on.
    pub enabled: bool,
    /// The local-network server is accepting connections.
    pub listening: bool,
    pub port: u16,
    pub display_name: String,
    /// The user has not chosen a name yet.
    pub name_is_default: bool,
    pub device_id: String,
    /// Handed to the native Bluetooth / WatchConnectivity receivers.
    pub secret: String,
    /// This device's IPv4 addresses, to check both devices share a network.
    pub addresses: Vec<String>,
    pub pairing: Option<PairingInfo>,
    pub paired_watches: Vec<PairedWatch>,
    pub error: Option<String>,
    pub inbox_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WatchLinkEvent {
    /// A watch completed pairing.
    #[serde(rename_all = "camelCase")]
    Paired { watch_name: String, via: String },
    /// A recording reached the inbox.
    #[serde(rename_all = "camelCase")]
    Received {
        name: String,
        sender: Option<String>,
        via: String,
    },
    /// Inbox entries became sketches.
    #[serde(rename_all = "camelCase")]
    Imported { sketches: Vec<Sketch> },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: Vec<Sketch>,
    /// Recordings that were already in the library (delivered twice).
    pub duplicates: usize,
    pub failed: Vec<String>,
}

pub type EventSink = Box<dyn Fn(WatchLinkEvent) + Send + Sync>;

/// State shared with the server threads.
pub(crate) struct Inner {
    config_path: PathBuf,
    inbox: PathBuf,
    config: Mutex<Config>,
    pairing: Mutex<Option<PairingWindow>>,
    error: Mutex<Option<String>>,
    events: EventSink,
    active: AtomicUsize,
}

impl Inner {
    fn emit(&self, event: WatchLinkEvent) {
        (self.events)(event);
    }

    fn set_error(&self, error: Option<String>) {
        *lock(&self.error) = error;
    }

    fn accepts_secret(&self, presented: Option<&str>) -> bool {
        secrets_match(&lock(&self.config).secret, presented)
    }

    /// Check a pairing code. On success the response carries everything but
    /// the port, which the caller knows.
    fn try_pair(&self, code: &str) -> Option<PairingResponse> {
        let mut pairing = lock(&self.pairing);
        let window = pairing.as_mut()?;
        if now_ms() > window.expires_at {
            *pairing = None;
            return None;
        }
        if !secrets_match(&window.code, Some(code)) {
            window.failures += 1;
            if window.failures >= MAX_PAIRING_FAILURES {
                *pairing = None;
            }
            return None;
        }
        let config = lock(&self.config);
        Some(PairingResponse {
            display_name: config.display_name(),
            token: config.secret.clone(),
            port: 0,
            device_id: config.device_id.clone(),
        })
    }

    /// Record a successful pairing (from any transport) and close the window.
    fn paired(&self, watch_name: &str, via: &str) {
        let name = watch_name.trim();
        let name = if name.is_empty() { "Apple Watch" } else { name };
        *lock(&self.pairing) = None;
        {
            let mut config = lock(&self.config);
            config.paired_watches.retain(|w| w.name != name);
            config.paired_watches.push(PairedWatch {
                name: name.to_string(),
                via: via.to_string(),
                paired_at: now_ms(),
            });
            let _ = save_config(&self.config_path, &config);
        }
        self.emit(WatchLinkEvent::Paired {
            watch_name: name.to_string(),
            via: via.to_string(),
        });
    }
}

fn load_config(path: &Path) -> Config {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
        .filter(|c| !c.secret.is_empty() && !c.device_id.is_empty())
        .unwrap_or_else(Config::new)
}

fn save_config(path: &Path, config: &Config) -> Result<()> {
    let tmp = path.with_extension("json.part");
    fs::write(&tmp, serde_json::to_vec_pretty(config)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub struct WatchLink {
    inner: Arc<Inner>,
    server: Mutex<Option<Server>>,
    port: u16,
}

impl WatchLink {
    /// Load (or create) the receiver's identity under `library_root`. The
    /// server is not started; call [`WatchLink::start_if_enabled`].
    pub fn open(library_root: &Path, port: u16, events: EventSink) -> Result<WatchLink> {
        fs::create_dir_all(library_root)?;
        let config_path = library_root.join(CONFIG_FILE);
        let config = load_config(&config_path);
        save_config(&config_path, &config)?;
        Ok(WatchLink {
            inner: Arc::new(Inner {
                config_path,
                inbox: library_root.join(crate::library::INBOX_DIR),
                config: Mutex::new(config),
                pairing: Mutex::new(None),
                error: Mutex::new(None),
                events,
                active: AtomicUsize::new(0),
            }),
            server: Mutex::new(None),
            port,
        })
    }

    pub fn inbox_dir(&self) -> &Path {
        &self.inner.inbox
    }

    pub fn start_if_enabled(&self) {
        if lock(&self.inner.config).enabled {
            self.restart_server();
        }
    }

    fn restart_server(&self) {
        let mut server = lock(&self.server);
        if let Some(mut old) = server.take() {
            old.stop();
        }
        match Server::start(self.inner.clone(), self.port) {
            Ok(started) => {
                *server = Some(started);
                self.inner.set_error(None);
            }
            Err(error) => {
                self.inner.set_error(Some(format!(
                    "Could not listen on port {}: {error}",
                    self.port
                )));
            }
        }
    }

    fn stop_server(&self) {
        if let Some(mut old) = lock(&self.server).take() {
            old.stop();
        }
    }

    pub fn status(&self) -> WatchLinkStatus {
        let (listening, port) = match lock(&self.server).as_ref() {
            Some(server) => (server.is_alive(), server.port),
            None => (false, self.port),
        };
        let pairing = {
            let mut pairing = lock(&self.inner.pairing);
            if pairing.as_ref().is_some_and(|w| now_ms() > w.expires_at) {
                *pairing = None;
            }
            pairing.as_ref().map(|w| PairingInfo {
                code: w.code.clone(),
                expires_at: w.expires_at,
            })
        };
        let config = lock(&self.inner.config).clone();
        WatchLinkStatus {
            enabled: config.enabled,
            listening,
            port,
            display_name: config.display_name(),
            name_is_default: config.display_name.is_none(),
            device_id: config.device_id.clone(),
            secret: config.secret.clone(),
            addresses: local_ipv4_addresses(),
            pairing,
            paired_watches: config.paired_watches.clone(),
            error: lock(&self.inner.error).clone(),
            inbox_dir: self.inner.inbox.display().to_string(),
        }
    }

    fn update_config(&self, change: impl FnOnce(&mut Config)) -> Result<()> {
        let mut config = lock(&self.inner.config);
        change(&mut config);
        save_config(&self.inner.config_path, &config)
    }

    /// Turn receiving on or off. Off also closes any pairing window.
    pub fn set_enabled(&self, enabled: bool) -> Result<WatchLinkStatus> {
        self.update_config(|c| c.enabled = enabled)?;
        if enabled {
            self.restart_server();
        } else {
            *lock(&self.inner.pairing) = None;
            self.stop_server();
            self.inner.set_error(None);
        }
        Ok(self.status())
    }

    /// Name shown on the Watch. Empty goes back to the default. Watches that
    /// are already paired learn the new name the next time they pair.
    pub fn set_display_name(&self, name: &str) -> Result<WatchLinkStatus> {
        let name: String = name.trim().chars().take(60).collect();
        self.update_config(|c| c.display_name = (!name.is_empty()).then_some(name))?;
        Ok(self.status())
    }

    /// Open a pairing window with a fresh code. Turns receiving on.
    pub fn begin_pairing(&self) -> Result<WatchLinkStatus> {
        let enabled = lock(&self.inner.config).enabled;
        let listening = lock(&self.server).as_ref().is_some_and(|s| s.is_alive());
        if !enabled || !listening {
            self.update_config(|c| c.enabled = true)?;
            self.restart_server();
        }
        *lock(&self.inner.pairing) = Some(PairingWindow {
            code: random_code(),
            expires_at: now_ms() + PAIRING_WINDOW_MS,
            failures: 0,
        });
        Ok(self.status())
    }

    pub fn end_pairing(&self) -> WatchLinkStatus {
        *lock(&self.inner.pairing) = None;
        self.status()
    }

    /// A native transport (Bluetooth) completed pairing.
    pub fn record_pairing(&self, watch_name: &str, via: &str) -> WatchLinkStatus {
        self.inner.paired(watch_name, via);
        self.status()
    }

    /// Forget every paired watch: a new secret means they must pair again.
    pub fn reset_pairing(&self) -> Result<WatchLinkStatus> {
        *lock(&self.inner.pairing) = None;
        self.update_config(|c| {
            c.secret = random_secret();
            c.paired_watches.clear();
        })?;
        Ok(self.status())
    }

    /// Call when the app returns to the foreground: iOS may have closed the
    /// listening socket while the app was suspended.
    pub fn resume(&self) -> WatchLinkStatus {
        if lock(&self.inner.config).enabled {
            self.restart_server();
        }
        self.status()
    }

    /// Turn every complete inbox entry into a sketch.
    pub fn import_inbox(&self, library: &Library) -> Result<ImportReport> {
        static IMPORT: Mutex<()> = Mutex::new(());
        let _guard = lock(&IMPORT);
        let (pending, failed) = inbox::pending(&self.inner.inbox)?;
        let mut report = ImportReport {
            failed,
            ..Default::default()
        };
        for item in pending {
            let entry = &item.entry;
            let label = if entry.name.is_empty() { entry.id.clone() } else { entry.name.clone() };
            let Some(id) = sketch_id_for(&entry.id) else {
                report.failed.push(format!("{label}: recording id is not a UUID"));
                inbox::set_aside(&item.sidecar);
                continue;
            };
            let extension = Path::new(&entry.file_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !valid_extension(&extension) || !item.audio.is_file() {
                report.failed.push(format!("{label}: audio file missing"));
                inbox::set_aside(&item.sidecar);
                continue;
            }
            let args = ImportRecordingArgs {
                id,
                title: String::new(),
                created_at: parse_iso8601_ms(&entry.created_at).unwrap_or_else(now_ms),
                duration_ms: (entry.duration > 0.0 && entry.duration.is_finite())
                    .then(|| (entry.duration * 1000.0).round() as i64),
                media_mime: if entry.mime_type.is_empty() {
                    "audio/mp4".into()
                } else {
                    entry.mime_type.clone()
                },
                media_extension: extension,
                capture_backend: WATCH_BACKEND.into(),
            };
            match library.import_recording(args, &item.audio) {
                Ok(Some(sketch)) => {
                    let _ = fs::remove_file(&item.sidecar);
                    report.imported.push(sketch);
                }
                Ok(None) => {
                    let _ = fs::remove_file(&item.audio);
                    let _ = fs::remove_file(&item.sidecar);
                    report.duplicates += 1;
                }
                Err(error) => {
                    report.failed.push(format!("{label}: {error}"));
                    inbox::set_aside(&item.sidecar);
                }
            }
        }
        Ok(report)
    }

    /// Emit an event through the sink (used by the Tauri layer).
    pub fn emit(&self, event: WatchLinkEvent) {
        self.inner.emit(event);
    }
}

impl Drop for WatchLink {
    fn drop(&mut self) {
        self.stop_server();
    }
}

/// Non-loopback, non-link-local IPv4 addresses of interfaces that are up.
#[cfg(unix)]
pub fn local_ipv4_addresses() -> Vec<String> {
    use std::net::Ipv4Addr;
    let mut out = vec![];
    // SAFETY: getifaddrs returns a linked list that stays valid until
    // freeifaddrs; we only read from it.
    unsafe {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) != 0 {
            return out;
        }
        let mut cursor = list;
        while !cursor.is_null() {
            let ifa = &*cursor;
            let flags = ifa.ifa_flags as u32;
            let up = flags & (libc::IFF_UP as u32) != 0;
            let loopback = flags & (libc::IFF_LOOPBACK as u32) != 0;
            if up && !loopback && !ifa.ifa_addr.is_null() && i32::from((*ifa.ifa_addr).sa_family) == libc::AF_INET {
                let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                if !ip.is_loopback() && !ip.is_link_local() {
                    out.push(ip.to_string());
                }
            }
            cursor = ifa.ifa_next;
        }
        libc::freeifaddrs(list);
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(not(unix))]
pub fn local_ipv4_addresses() -> Vec<String> {
    vec![]
}

impl From<inbox::InboxError> for Error {
    fn from(error: inbox::InboxError) -> Self {
        Error::Invalid(error.to_string())
    }
}

#[cfg(test)]
mod tests;
