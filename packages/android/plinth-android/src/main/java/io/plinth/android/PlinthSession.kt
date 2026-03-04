package io.plinth.android

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Platform framework for plinth-video on Android.
 *
 * Wraps the Rust core via JNI, drives a repeating coroutine for heartbeats,
 * and posts beacon batches via an injected handler.
 *
 * All JNI calls are serialised through a single-threaded dispatcher so the
 * non-thread-safe Rust [Session] is never accessed concurrently.
 *
 * Usage:
 * ```kotlin
 * val session = PlinthSession.create(meta) ?: error("failed")
 * session.processEvent("""{"type":"load","src":"https://..."}""")
 * // …
 * session.destroy()
 * ```
 */
class PlinthSession private constructor(
    private val ptr: Long,
    private val config: PlinthConfig,
    private val beaconHandler: (BeaconBatch) -> Unit,
    externalScope: CoroutineScope,
    private val jni: CoreJni,
    sessionDispatcher: CoroutineDispatcher,
) {

    private val sessionDispatcher: CoroutineDispatcher = sessionDispatcher

    // Own scope so we can cancel it independently of the caller's scope.
    private val scope = CoroutineScope(externalScope.coroutineContext + SupervisorJob())

    @Volatile private var isDestroyed = false
    private var heartbeatJob: Job? = null

    // ── Factory ───────────────────────────────────────────────────────────────

    companion object {

        internal val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }

        /**
         * Create a new session and start the heartbeat timer.
         *
         * @param meta          Session metadata (video, client, SDK identifiers).
         * @param config        Optional config; defaults to localhost:3000 / p123456789.
         * @param scope         Coroutine scope for the heartbeat and event dispatch.
         * @param beaconHandler Called on the session dispatcher with each non-empty
         *                      [BeaconBatch]. Defaults to a fire-and-forget OkHttp POST.
         *                      Inject a handler in tests to capture beacons without HTTP.
         * @return A ready [PlinthSession], or null if JSON encoding or JNI init fails.
         */
        fun create(
            meta: SessionMeta,
            config: PlinthConfig = PlinthConfig(),
            scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
            beaconHandler: ((BeaconBatch) -> Unit)? = null,
        ): PlinthSession? = createInternal(
            meta = meta,
            config = config,
            scope = scope,
            beaconHandler = beaconHandler,
            jni = PlinthCoreJni,
            dispatcher = Dispatchers.IO.limitedParallelism(1),
        )

        /**
         * Internal factory used by tests to inject a [CoreJni] stub and a
         * controllable [CoroutineDispatcher] without loading the native library.
         */
        internal fun createInternal(
            meta: SessionMeta,
            config: PlinthConfig = PlinthConfig(),
            scope: CoroutineScope,
            beaconHandler: ((BeaconBatch) -> Unit)? = null,
            jni: CoreJni,
            dispatcher: CoroutineDispatcher,
        ): PlinthSession? {
            val metaJson = runCatching { json.encodeToString(meta) }.getOrNull() ?: return null
            val configJson = runCatching { json.encodeToString(config) }.getOrNull() ?: return null
            val ptr = jni.sessionNew(configJson, metaJson, System.currentTimeMillis())
            if (ptr == 0L) return null

            val handler = beaconHandler ?: defaultPoster(config)
            return PlinthSession(ptr, config, handler, scope, jni, dispatcher)
                .also { it.startHeartbeat() }
        }

        private fun defaultPoster(config: PlinthConfig): (BeaconBatch) -> Unit {
            val client = OkHttpClient()
            val mediaType = "application/json".toMediaType()
            return { batch ->
                CoroutineScope(Dispatchers.IO).launch {
                    runCatching {
                        val body = json.encodeToString(batch).toRequestBody(mediaType)
                        val request = Request.Builder()
                            .url(config.endpoint)
                            .header("Content-Type", "application/json")
                            .header("X-Project-Key", config.projectKey)
                            .post(body)
                            .build()
                        client.newCall(request).execute().close()
                    }
                }
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Send a player event JSON string to the state machine.
     *
     * The call is dispatched asynchronously to the session dispatcher and
     * returns immediately. Any resulting beacons are delivered to [beaconHandler].
     *
     * @param eventJson JSON object matching the Rust `PlayerEvent` schema,
     *                  e.g. `{"type":"load","src":"https://..."}`.
     */
    fun processEvent(eventJson: String) {
        if (isDestroyed) return
        scope.launch(sessionDispatcher) {
            if (isDestroyed) return@launch
            emit(jni.sessionProcessEvent(ptr, eventJson, System.currentTimeMillis()))
        }
    }

    /**
     * Update the platform-reported playhead position used in heartbeat beacons.
     *
     * Called frequently (e.g. every 500 ms) by the player integration.
     */
    fun setPlayhead(ms: Long) {
        if (isDestroyed) return
        scope.launch(sessionDispatcher) {
            if (isDestroyed) return@launch
            jni.sessionSetPlayhead(ptr, ms)
        }
    }

    /**
     * Return the last playhead position reported by the platform, in milliseconds.
     *
     * Blocks briefly on the session dispatcher to safely read the value.
     * Returns 0 if the session has been destroyed.
     */
    fun getPlayhead(): Long {
        if (isDestroyed) return 0L
        return runBlocking(sessionDispatcher) {
            if (isDestroyed) 0L else jni.sessionGetPlayhead(ptr)
        }
    }

    /**
     * Tear down the session. Stops the heartbeat, posts any final beacons, and
     * frees Rust memory. Idempotent — safe to call more than once.
     */
    fun destroy() {
        if (isDestroyed) return
        isDestroyed = true
        heartbeatJob?.cancel()
        scope.launch(sessionDispatcher) {
            emit(jni.sessionDestroy(ptr, System.currentTimeMillis()))
            scope.cancel()
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private fun startHeartbeat() {
        heartbeatJob = scope.launch(sessionDispatcher) {
            while (isActive) {
                delay(config.heartbeatIntervalMs)
                if (!isDestroyed) {
                    emit(jni.sessionTick(ptr, System.currentTimeMillis()))
                }
            }
        }
    }

    /** Decode a beacon-batch JSON string and invoke [beaconHandler] if non-empty. */
    private fun emit(batchJson: String) {
        val batch = runCatching { json.decodeFromString<BeaconBatch>(batchJson) }.getOrNull()
            ?: return
        if (batch.beacons.isNotEmpty()) beaconHandler(batch)
    }
}
