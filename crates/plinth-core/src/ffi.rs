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

use crate::beacon::BeaconBatch;
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
    miniserde::json::to_string(&BeaconBatch::new(beacons))
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
        match cstr_to_str(config_json).and_then(|s| miniserde::json::from_str(s).ok()) {
            Some(c) => c,
            None => return std::ptr::null_mut(),
        }
    };

    let meta: SessionMeta = match cstr_to_str(meta_json).and_then(|s| miniserde::json::from_str(s).ok()) {
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

    let event: PlayerEvent = match cstr_to_str(event_json).and_then(|s| miniserde::json::from_str(s).ok()) {
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

/// Return the last playhead position reported by the platform, in milliseconds.
///
/// Returns 0 if `ptr` is NULL.
#[no_mangle]
pub unsafe extern "C" fn plinth_session_get_playhead(ptr: *const Session) -> u64 {
    if ptr.is_null() {
        return 0;
    }
    (*ptr).get_playhead()
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn valid_meta_cstr() -> CString {
        CString::new(concat!(
            r#"{"video":{"id":"v1","title":"Test"},"#,
            r#""client":{"user_agent":"UA/1.0"},"#,
            r#""sdk":{"api_version":1,"#,
            r#""core":{"name":"plinth-core","version":"0.1.0"},"#,
            r#""framework":{"name":"plinth-js","version":"0.1.0"},"#,
            r#""player":{"name":"plinth-hlsjs","version":"0.1.0"}}}"#,
        ))
        .unwrap()
    }

    fn valid_config_cstr() -> CString {
        CString::new(
            r#"{"endpoint":"http://localhost:3000/beacon","project_key":"p123456789","heartbeat_interval_ms":10000}"#,
        )
        .unwrap()
    }

    /// Read a C string returned by the FFI, free it, and return it as a Rust String.
    unsafe fn take_c_string(ptr: *mut c_char) -> String {
        let s = CStr::from_ptr(ptr).to_str().unwrap().to_string();
        plinth_free_string(ptr);
        s
    }

    // ── session_new ───────────────────────────────────────────────────────────

    #[test]
    fn session_new_null_config_uses_defaults() {
        let meta = valid_meta_cstr();
        unsafe {
            let ptr = plinth_session_new(std::ptr::null(), meta.as_ptr(), 0);
            assert!(!ptr.is_null());
            plinth_free_string(plinth_session_destroy(ptr, 0));
        }
    }

    #[test]
    fn session_new_null_meta_returns_null() {
        unsafe {
            let ptr = plinth_session_new(std::ptr::null(), std::ptr::null(), 0);
            assert!(ptr.is_null());
        }
    }

    #[test]
    fn session_new_malformed_meta_returns_null() {
        let bad = CString::new("not valid json").unwrap();
        unsafe {
            let ptr = plinth_session_new(std::ptr::null(), bad.as_ptr(), 0);
            assert!(ptr.is_null());
        }
    }

    #[test]
    fn session_new_malformed_config_returns_null() {
        let meta = valid_meta_cstr();
        let bad_config = CString::new("{bad json}").unwrap();
        unsafe {
            let ptr = plinth_session_new(bad_config.as_ptr(), meta.as_ptr(), 0);
            assert!(ptr.is_null());
        }
    }

    #[test]
    fn session_new_valid_returns_non_null() {
        let meta = valid_meta_cstr();
        let config = valid_config_cstr();
        unsafe {
            let ptr = plinth_session_new(config.as_ptr(), meta.as_ptr(), 0);
            assert!(!ptr.is_null());
            plinth_free_string(plinth_session_destroy(ptr, 0));
        }
    }

    // ── process_event ─────────────────────────────────────────────────────────

    #[test]
    fn process_event_null_ptr_returns_empty_batch() {
        let event = CString::new(r#"{"type":"play"}"#).unwrap();
        unsafe {
            let result = take_c_string(plinth_session_process_event(
                std::ptr::null_mut(),
                event.as_ptr(),
                0,
            ));
            assert_eq!(result, r#"{"beacons":[]}"#);
        }
    }

    #[test]
    fn process_event_malformed_json_returns_empty_batch() {
        let meta = valid_meta_cstr();
        let bad_event = CString::new("not valid json").unwrap();
        unsafe {
            let ptr = plinth_session_new(std::ptr::null(), meta.as_ptr(), 0);
            assert!(!ptr.is_null());
            let result =
                take_c_string(plinth_session_process_event(ptr, bad_event.as_ptr(), 0));
            plinth_free_string(plinth_session_destroy(ptr, 0));
            assert_eq!(result, r#"{"beacons":[]}"#);
        }
    }

    // ── tick ──────────────────────────────────────────────────────────────────

    #[test]
    fn tick_null_ptr_returns_empty_batch() {
        unsafe {
            let result = take_c_string(plinth_session_tick(std::ptr::null_mut(), 0));
            assert_eq!(result, r#"{"beacons":[]}"#);
        }
    }

    // ── set_playhead / get_playhead ───────────────────────────────────────────

    #[test]
    fn set_playhead_null_ptr_is_no_op() {
        // Must not crash
        unsafe {
            plinth_session_set_playhead(std::ptr::null_mut(), 5_000);
        }
    }

    #[test]
    fn get_playhead_null_ptr_returns_zero() {
        unsafe {
            assert_eq!(plinth_session_get_playhead(std::ptr::null()), 0);
        }
    }

    #[test]
    fn get_playhead_returns_set_value() {
        let meta = valid_meta_cstr();
        unsafe {
            let ptr = plinth_session_new(std::ptr::null(), meta.as_ptr(), 0);
            assert!(!ptr.is_null());
            plinth_session_set_playhead(ptr, 30_000);
            assert_eq!(plinth_session_get_playhead(ptr), 30_000);
            plinth_free_string(plinth_session_destroy(ptr, 0));
        }
    }

    // ── destroy ───────────────────────────────────────────────────────────────

    #[test]
    fn destroy_null_ptr_returns_empty_batch() {
        unsafe {
            let result = take_c_string(plinth_session_destroy(std::ptr::null_mut(), 0));
            assert_eq!(result, r#"{"beacons":[]}"#);
        }
    }

    // ── free_string ───────────────────────────────────────────────────────────

    #[test]
    fn free_string_null_is_no_op() {
        // Must not crash
        unsafe {
            plinth_free_string(std::ptr::null_mut());
        }
    }

    // ── Full lifecycle ────────────────────────────────────────────────────────

    #[test]
    fn full_lifecycle_new_process_tick_destroy() {
        let meta = valid_meta_cstr();
        let load = CString::new(r#"{"type":"load","src":"http://example.com/v.m3u8"}"#).unwrap();
        let can_play = CString::new(r#"{"type":"can_play"}"#).unwrap();
        let play = CString::new(r#"{"type":"play"}"#).unwrap();
        let first_frame = CString::new(r#"{"type":"first_frame"}"#).unwrap();

        unsafe {
            let ptr = plinth_session_new(std::ptr::null(), meta.as_ptr(), 0);
            assert!(!ptr.is_null());

            let r1 = take_c_string(plinth_session_process_event(ptr, load.as_ptr(), 0));
            assert!(r1.contains("beacons"));

            let r2 = take_c_string(plinth_session_process_event(ptr, can_play.as_ptr(), 100));
            assert!(r2.contains("beacons"));

            // Play → PlayAttempt: emits play beacon (session open)
            let r3 = take_c_string(plinth_session_process_event(ptr, play.as_ptr(), 200));
            assert!(r3.contains("\"play\""));

            // FirstFrame → Playing: emits first_frame
            let r4 =
                take_c_string(plinth_session_process_event(ptr, first_frame.as_ptr(), 1_200));
            assert!(r4.contains("first_frame"));

            // Tick before interval elapses — empty
            let r5 = take_c_string(plinth_session_tick(ptr, 2_000));
            assert!(r5.contains("beacons"));

            // Destroy from Playing — emits ended
            let r6 = take_c_string(plinth_session_destroy(ptr, 5_000));
            assert!(r6.contains("\"ended\""));
        }
    }

    #[test]
    fn returned_strings_are_valid_json() {
        let meta = valid_meta_cstr();
        let play = CString::new(r#"{"type":"play"}"#).unwrap();

        unsafe {
            // null-ptr process_event
            let s = take_c_string(plinth_session_process_event(
                std::ptr::null_mut(),
                play.as_ptr(),
                0,
            ));
            assert!(s.starts_with('{') && s.contains("\"beacons\""));

            // null-ptr tick
            let s = take_c_string(plinth_session_tick(std::ptr::null_mut(), 0));
            assert!(s.starts_with('{') && s.contains("\"beacons\""));

            // null-ptr destroy
            let s = take_c_string(plinth_session_destroy(std::ptr::null_mut(), 0));
            assert!(s.starts_with('{') && s.contains("\"beacons\""));

            // valid session destroy from Idle — empty beacons array
            let ptr = plinth_session_new(std::ptr::null(), meta.as_ptr(), 0);
            assert!(!ptr.is_null());
            let s = take_c_string(plinth_session_destroy(ptr, 0));
            assert!(s.starts_with('{') && s.contains("\"beacons\""));
        }
    }
}
