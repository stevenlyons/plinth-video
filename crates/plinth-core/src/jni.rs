/// Android JNI layer for plinth-core.
///
/// Mirrors `ffi.rs` but uses JNI calling convention instead of plain C FFI.
/// The session pointer is passed as `jlong` (i64) across the boundary.
///
/// Memory model:
/// - Session is heap-allocated by Rust; its address is returned as `jlong`.
///   The Kotlin side treats this as an opaque handle and must call
///   `sessionDestroy` exactly once to free it.
/// - Strings returned to Kotlin are JVM-managed — the GC frees them.
///   No `free_string` equivalent is needed.
use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};
use jni::JNIEnv;

use crate::beacon::BeaconBatch;
use crate::config::Config;
use crate::event::PlayerEvent;
use crate::session::{Session, SessionMeta};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn jstring_to_string(env: &mut JNIEnv, s: JString) -> Option<String> {
    env.get_string(&s).ok().map(|js| js.into())
}

fn to_jstring(env: &mut JNIEnv, s: String) -> jstring {
    env.new_string(s)
        .unwrap_or_else(|_| env.new_string("").unwrap())
        .into_raw()
}

fn empty_batch_jstring(env: &mut JNIEnv) -> jstring {
    to_jstring(env, r#"{"beacons":[]}"#.to_string())
}

fn beacons_to_json(beacons: Vec<crate::beacon::Beacon>) -> String {
    miniserde::json::to_string(&BeaconBatch::new(beacons))
}

// ── Public JNI API ────────────────────────────────────────────────────────────

/// Create a new session.
///
/// # Parameters
/// - `config_json`: JSON string matching `Config` schema, or null for defaults.
/// - `meta_json`:   JSON string matching `SessionMeta` schema.
/// - `now_ms`:      Current wall-clock time in milliseconds.
///
/// # Returns
/// Opaque session pointer as `jlong`. Returns 0 on parse error.
/// The Kotlin side owns this handle and MUST eventually call `sessionDestroy`.
#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionNew(
    mut env: JNIEnv,
    _class: JClass,
    config_json: JString,
    meta_json: JString,
    now_ms: jlong,
) -> jlong {
    let config: Config = if config_json.is_null() {
        Config::default()
    } else {
        match jstring_to_string(&mut env, config_json)
            .and_then(|s| miniserde::json::from_str(&s).ok())
        {
            Some(c) => c,
            None => return 0,
        }
    };

    let meta: SessionMeta = match jstring_to_string(&mut env, meta_json)
        .and_then(|s| miniserde::json::from_str(&s).ok())
    {
        Some(m) => m,
        None => return 0,
    };

    let session = Session::new(config, meta, now_ms as u64);
    Box::into_raw(Box::new(session)) as jlong
}

/// Process a player event and return any resulting beacon batch as JSON.
///
/// # Parameters
/// - `ptr`:        Session handle from `sessionNew`. Must not be 0.
/// - `event_json`: JSON string matching `PlayerEvent` schema.
/// - `now_ms`:     Current wall-clock time in milliseconds.
///
/// # Returns
/// JSON string `{"beacons":[...]}`.
#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionProcessEvent(
    mut env: JNIEnv,
    _class: JClass,
    ptr: jlong,
    event_json: JString,
    now_ms: jlong,
) -> jstring {
    if ptr == 0 {
        return empty_batch_jstring(&mut env);
    }
    let event: PlayerEvent = match jstring_to_string(&mut env, event_json)
        .and_then(|s| miniserde::json::from_str(&s).ok())
    {
        Some(e) => e,
        None => return empty_batch_jstring(&mut env),
    };
    let session = unsafe { &mut *(ptr as *mut Session) };
    let beacons = session.process_event(event, now_ms as u64);
    to_jstring(&mut env, beacons_to_json(beacons))
}

/// Check whether a heartbeat beacon should be emitted.
///
/// Should be called by the platform on a regular interval (e.g. every second).
///
/// # Returns
/// JSON string `{"beacons":[...]}`.
#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionTick(
    mut env: JNIEnv,
    _class: JClass,
    ptr: jlong,
    now_ms: jlong,
) -> jstring {
    if ptr == 0 {
        return empty_batch_jstring(&mut env);
    }
    let session = unsafe { &mut *(ptr as *mut Session) };
    let beacons = session.tick(now_ms as u64);
    to_jstring(&mut env, beacons_to_json(beacons))
}

/// Update the platform-reported playhead position (used in heartbeat beacons).
#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionSetPlayhead(
    _env: JNIEnv,
    _class: JClass,
    ptr: jlong,
    playhead_ms: jlong,
) {
    if ptr == 0 {
        return;
    }
    let session = unsafe { &mut *(ptr as *mut Session) };
    session.set_playhead(playhead_ms as u64);
}

/// Return the last playhead position reported by the platform, in milliseconds.
///
/// Returns 0 if `ptr` is 0.
#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionGetPlayhead(
    _env: JNIEnv,
    _class: JClass,
    ptr: jlong,
) -> jlong {
    if ptr == 0 {
        return 0;
    }
    let session = unsafe { &*(ptr as *const Session) };
    session.get_playhead() as jlong
}

/// Destroy the session, emit any final beacons, and free all associated memory.
///
/// After this call, `ptr` is invalid and must not be used again.
///
/// # Returns
/// JSON string `{"beacons":[...]}` containing any final beacons.
#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionDestroy(
    mut env: JNIEnv,
    _class: JClass,
    ptr: jlong,
    now_ms: jlong,
) -> jstring {
    if ptr == 0 {
        return empty_batch_jstring(&mut env);
    }
    let mut session = unsafe { Box::from_raw(ptr as *mut Session) };
    let beacons = session.destroy(now_ms as u64);
    to_jstring(&mut env, beacons_to_json(beacons))
}
