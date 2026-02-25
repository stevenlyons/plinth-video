/// C FFI layer for native platforms (iOS, macOS, Android).
///
/// All functions cross the FFI boundary via JSON strings to avoid complex
/// C type mappings — the same strategy used by the Wasm layer.
///
/// Ownership rules:
/// - Strings passed IN by the caller are borrowed (caller keeps ownership).
/// - Strings returned OUT are heap-allocated by Rust; the caller MUST free
///   them with `plinth_free_string` exactly once.
/// - The `Session` pointer returned by `plinth_session_new` is also
///   heap-allocated by Rust; it is freed inside `plinth_session_destroy`.
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use crate::config::Config;
use crate::event::PlayerEvent;
use crate::session::{Session, SessionMeta};

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Convert a raw C string pointer to a Rust `&str`. Returns `None` if null or
/// not valid UTF-8.
unsafe fn cstr_to_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok()
}

/// Heap-allocate a Rust string as a null-terminated C string and return its
/// raw pointer. Caller is responsible for freeing via `plinth_free_string`.
fn into_c_string(s: String) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => cs.into_raw(),
        Err(_) => CString::new("").unwrap().into_raw(),
    }
}

/// Serialize a `Vec<Beacon>` into a JSON beacon-batch string.
fn beacons_to_json(beacons: Vec<crate::beacon::Beacon>) -> String {
    let batch = crate::beacon::BeaconBatch { beacons };
    serde_json::to_string(&batch).unwrap_or_else(|_| r#"{"beacons":[]}"#.to_string())
}

// ── Public C API ──────────────────────────────────────────────────────────────

/// Create a new session.
///
/// # Parameters
/// - `config_json`: JSON string matching `Config` schema. Pass NULL for defaults.
/// - `meta_json`:   JSON string matching `SessionMeta` schema.
/// - `now_ms`:      Current wall-clock time in milliseconds.
///
/// # Returns
/// Opaque pointer to a heap-allocated `Session`, or NULL on parse error.
/// The caller owns the pointer and MUST eventually pass it to
/// `plinth_session_destroy`.
#[no_mangle]
pub unsafe extern "C" fn plinth_session_new(
    config_json: *const c_char,
    meta_json: *const c_char,
    now_ms: u64,
) -> *mut Session {
    let config: Config = if config_json.is_null() {
        Config::default()
    } else {
        match cstr_to_str(config_json).and_then(|s| serde_json::from_str(s).ok()) {
            Some(c) => c,
            None => return std::ptr::null_mut(),
        }
    };

    let meta: SessionMeta = match cstr_to_str(meta_json).and_then(|s| serde_json::from_str(s).ok()) {
        Some(m) => m,
        None => return std::ptr::null_mut(),
    };

    Box::into_raw(Box::new(Session::new(config, meta, now_ms)))
}

/// Process a player event and return any resulting beacon batch as JSON.
///
/// # Parameters
/// - `ptr`:        Session pointer from `plinth_session_new`. Must not be NULL.
/// - `event_json`: JSON string matching `PlayerEvent` schema.
/// - `now_ms`:     Current wall-clock time in milliseconds.
///
/// # Returns
/// Heap-allocated JSON string `{"beacons":[...]}`. Free with `plinth_free_string`.
#[no_mangle]
pub unsafe extern "C" fn plinth_session_process_event(
    ptr: *mut Session,
    event_json: *const c_char,
    now_ms: u64,
) -> *mut c_char {
    if ptr.is_null() {
        return into_c_string(r#"{"beacons":[]}"#.to_string());
    }

    let event: PlayerEvent = match cstr_to_str(event_json).and_then(|s| serde_json::from_str(s).ok()) {
        Some(e) => e,
        None => return into_c_string(r#"{"beacons":[]}"#.to_string()),
    };

    let beacons = (*ptr).process_event(event, now_ms);
    into_c_string(beacons_to_json(beacons))
}

/// Check whether a heartbeat beacon should be emitted.
///
/// Should be called by the platform on a regular interval (e.g. every second).
/// The core decides internally whether enough time has elapsed.
///
/// # Returns
/// Heap-allocated JSON string `{"beacons":[...]}`. Free with `plinth_free_string`.
#[no_mangle]
pub unsafe extern "C" fn plinth_session_tick(ptr: *mut Session, now_ms: u64) -> *mut c_char {
    if ptr.is_null() {
        return into_c_string(r#"{"beacons":[]}"#.to_string());
    }
    let beacons = (*ptr).tick(now_ms);
    into_c_string(beacons_to_json(beacons))
}

/// Update the platform-reported playhead position (used in heartbeat beacons).
#[no_mangle]
pub unsafe extern "C" fn plinth_session_set_playhead(ptr: *mut Session, playhead_ms: u64) {
    if ptr.is_null() {
        return;
    }
    (*ptr).set_playhead(playhead_ms);
}

/// Destroy the session, emit any final beacons, and free all associated memory.
///
/// After this call, `ptr` is invalid and must not be used again.
///
/// # Returns
/// Heap-allocated JSON string `{"beacons":[...]}` containing any final beacons.
/// Free with `plinth_free_string`.
#[no_mangle]
pub unsafe extern "C" fn plinth_session_destroy(ptr: *mut Session, now_ms: u64) -> *mut c_char {
    if ptr.is_null() {
        return into_c_string(r#"{"beacons":[]}"#.to_string());
    }
    // Reclaim the Box so Rust drops the Session when this scope ends.
    let mut session = Box::from_raw(ptr);
    let beacons = session.destroy(now_ms);
    into_c_string(beacons_to_json(beacons))
}

/// Free a string previously returned by any `plinth_session_*` function.
///
/// Passing NULL is a no-op. Must be called exactly once per returned string.
#[no_mangle]
pub unsafe extern "C" fn plinth_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}
