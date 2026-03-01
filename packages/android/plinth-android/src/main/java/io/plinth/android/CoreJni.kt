package io.plinth.android

/**
 * Abstraction over the JNI boundary to the Rust plinth-core library.
 * Production code uses [PlinthCoreJni]; tests inject a [FakeCoreJni].
 */
internal interface CoreJni {
    fun sessionNew(configJson: String?, metaJson: String, nowMs: Long): Long
    fun sessionProcessEvent(ptr: Long, eventJson: String, nowMs: Long): String
    fun sessionTick(ptr: Long, nowMs: Long): String
    fun sessionSetPlayhead(ptr: Long, playheadMs: Long)
    fun sessionDestroy(ptr: Long, nowMs: Long): String
}
