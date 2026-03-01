package io.plinth.android

/**
 * Internal JNI bridge to the Rust plinth-core shared library.
 *
 * All functions cross the JNI boundary via JSON strings — the same strategy
 * used by the Wasm and C FFI layers. The session is represented as a [Long]
 * holding the raw pointer returned by the Rust allocator.
 *
 * Memory rules:
 * - [sessionNew] heap-allocates a Session in Rust and returns its address.
 * - [sessionDestroy] frees that memory. It must be called exactly once.
 * - Returned JSON strings are JVM-managed; no explicit free is required.
 */
internal object PlinthCoreJni : CoreJni {

    init {
        System.loadLibrary("plinth_core")
    }

    /**
     * Create a new session.
     *
     * @param configJson JSON matching the Rust `Config` struct, or null for defaults.
     * @param metaJson   JSON matching the Rust `SessionMeta` struct.
     * @param nowMs      Current wall-clock time in milliseconds.
     * @return Opaque session pointer as [Long], or 0 on parse error.
     */
    external override fun sessionNew(configJson: String?, metaJson: String, nowMs: Long): Long

    /**
     * Process a player event and return any resulting beacons.
     *
     * @param ptr       Session handle from [sessionNew].
     * @param eventJson JSON matching the Rust `PlayerEvent` enum.
     * @param nowMs     Current wall-clock time in milliseconds.
     * @return JSON string `{"beacons":[...]}`.
     */
    external override fun sessionProcessEvent(ptr: Long, eventJson: String, nowMs: Long): String

    /**
     * Check whether a heartbeat beacon should be emitted.
     *
     * @param ptr   Session handle from [sessionNew].
     * @param nowMs Current wall-clock time in milliseconds.
     * @return JSON string `{"beacons":[...]}`.
     */
    external override fun sessionTick(ptr: Long, nowMs: Long): String

    /**
     * Update the platform-reported playhead position used in heartbeat beacons.
     *
     * @param ptr        Session handle from [sessionNew].
     * @param playheadMs Current playhead position in milliseconds.
     */
    external override fun sessionSetPlayhead(ptr: Long, playheadMs: Long)

    /**
     * Destroy the session, emit any final beacons, and free Rust memory.
     *
     * After this call [ptr] is invalid. Must be called exactly once.
     *
     * @param ptr   Session handle from [sessionNew].
     * @param nowMs Current wall-clock time in milliseconds.
     * @return JSON string `{"beacons":[...]}` containing any final beacons.
     */
    external override fun sessionDestroy(ptr: Long, nowMs: Long): String
}
