package io.plinth.media3

import android.os.Build
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import io.plinth.android.ClientMetadata
import io.plinth.android.PlinthConfig
import io.plinth.android.PlinthSession
import io.plinth.android.SdkComponent
import io.plinth.android.SdkMetadata
import io.plinth.android.SessionMeta
import io.plinth.android.VideoMetadata
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

// ── Event DTOs ────────────────────────────────────────────────────────────────

@Serializable
internal sealed class PlayerEventDto

@Serializable @SerialName("load")
internal data class LoadEvent(val src: String) : PlayerEventDto()

@Serializable @SerialName("can_play")
internal object CanPlayEvent : PlayerEventDto()

@Serializable @SerialName("play")
internal object PlayEvent : PlayerEventDto()

@Serializable @SerialName("waiting")
internal object WaitingEvent : PlayerEventDto()

@Serializable @SerialName("first_frame")
internal object FirstFrameEvent : PlayerEventDto()

@Serializable @SerialName("can_play_through")
internal object CanPlayThroughEvent : PlayerEventDto()

@Serializable @SerialName("pause")
internal object PauseEvent : PlayerEventDto()

@Serializable @SerialName("ended")
internal object EndedEvent : PlayerEventDto()

@Serializable @SerialName("seek_start")
internal data class SeekStartEvent(
    @SerialName("from_ms") val fromMs: Long,
) : PlayerEventDto()

@Serializable @SerialName("seek_end")
internal data class SeekEndEvent(
    @SerialName("to_ms") val toMs: Long,
    @SerialName("buffer_ready") val bufferReady: Boolean,
) : PlayerEventDto()

@Serializable @SerialName("error")
internal data class ErrorEvent(
    val code: String,
    val message: String? = null,
    val fatal: Boolean,
) : PlayerEventDto()

@Serializable @SerialName("quality_change")
internal data class QualityChangeEvent(
    val quality: QualityDto,
) : PlayerEventDto()

@Serializable
internal data class QualityDto(
    @SerialName("bitrate_bps") val bitrateBps: Int? = null,
    val width: Int? = null,
    val height: Int? = null,
)

// ── PlinthMedia3 ──────────────────────────────────────────────────────────────

/**
 * Layer-3 Media3 integration for plinth-video.
 *
 * Maps [Player.Listener] callbacks to [PlinthSession] events.
 *
 * **Seek tracking:** Call [seekTo] on this instance instead of on the player
 * directly. This lets the SDK record `seek_start`/`seek_end` accurately.
 *
 * **Lifecycle:**
 * ```kotlin
 * val plinth = PlinthMedia3.initialize(player, Media3VideoMeta("my-video"))
 * // play, pause, plinth.seekTo(positionMs) …
 * plinth.destroy()  // call before releasing the player
 * ```
 */
class PlinthMedia3 private constructor(
    private val player: Player,
    private val scope: CoroutineScope,
) : Player.Listener {

    internal var session: PlinthSession? = null

    /** Test seam: receives every serialized event JSON string before it reaches the session. */
    internal var eventSink: ((String) -> Unit)? = null

    private var isDestroyed = false
    private var hasFiredFirstFrame = false
    private var isHandlingProgrammaticSeek = false
    private var isEndingNaturally = false
    private var lastPlayheadMs: Long = 0L
    private var playheadJob: Job? = null

    // ── Factory ───────────────────────────────────────────────────────────────

    companion object {

        private val eventJson = Json { explicitNulls = false }

        /**
         * Initialize the SDK for the given player.
         *
         * @param player    The [Player] instance to monitor.
         * @param videoMeta Metadata about the video being played.
         * @param options   Optional config and session factory overrides.
         * @return A configured [PlinthMedia3] with the listener attached.
         */
        fun initialize(
            player: Player,
            videoMeta: Media3VideoMeta,
            options: Media3Options = Media3Options(),
        ): PlinthMedia3 = initializeInternal(
            player = player,
            videoMeta = videoMeta,
            options = options,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )

        /**
         * Internal factory that accepts an injected [CoroutineScope] for testing.
         */
        internal fun initializeInternal(
            player: Player,
            videoMeta: Media3VideoMeta,
            options: Media3Options = Media3Options(),
            scope: CoroutineScope,
        ): PlinthMedia3 {
            val factory: (SessionMeta, PlinthConfig) -> PlinthSession? =
                options.sessionFactory ?: { meta, cfg -> PlinthSession.create(meta, cfg) }

            val userAgent = "${Build.MANUFACTURER} ${Build.MODEL}; Android ${Build.VERSION.RELEASE}"
            val meta = SessionMeta(
                video = VideoMetadata(id = videoMeta.id, title = videoMeta.title),
                client = ClientMetadata(userAgent = userAgent),
                sdk = SdkMetadata(
                    apiVersion = 1,
                    core = SdkComponent(name = "plinth-core", version = "0.1.0"),
                    framework = SdkComponent(name = "plinth-android", version = "0.1.0"),
                    player = SdkComponent(name = "plinth-media3", version = "0.1.0"),
                ),
            )

            val instance = PlinthMedia3(player, scope)
            instance.session = factory(meta, options.config)
            player.addListener(instance)

            // If the player already has a media item loaded, emit load immediately.
            player.currentMediaItem?.let { item ->
                val src = item.localConfiguration?.uri?.toString() ?: return@let
                instance.handleLoad(src)
            }

            return instance
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Seek the player to [positionMs], emitting `seek_start` and `seek_end` events.
     *
     * Use this instead of calling [player.seekTo] directly to ensure accurate seek metrics.
     * The `seek_end` event is emitted once [onPositionDiscontinuity] fires after the seek commits.
     */
    fun seekTo(positionMs: Long) {
        if (isDestroyed) return
        val fromMs = lastPlayheadMs
        isHandlingProgrammaticSeek = true
        sendEvent(SeekStartEvent(fromMs = fromMs))
        player.seekTo(positionMs)
    }

    /**
     * Tear down all listeners and post any final beacons. Idempotent.
     */
    fun destroy() {
        if (isDestroyed) return
        isDestroyed = true
        playheadJob?.cancel()
        player.removeListener(this)
        session?.destroy()
        session = null
        scope.cancel()
    }

    // ── Internal event handlers (also called directly in tests) ───────────────

    internal fun handleLoad(src: String) {
        hasFiredFirstFrame = false
        isEndingNaturally = false
        sendEvent(LoadEvent(src = src))
    }

    internal fun handleCanPlay() = sendEvent(CanPlayEvent)
    internal fun handlePlay() = sendEvent(PlayEvent)
    internal fun handleWaiting() = sendEvent(WaitingEvent)
    internal fun handleFirstFrame() {
        hasFiredFirstFrame = true
        sendEvent(FirstFrameEvent)
    }
    internal fun handleCanPlayThrough() = sendEvent(CanPlayThroughEvent)
    internal fun handlePause() = sendEvent(PauseEvent)
    internal fun handleEnded() {
        isEndingNaturally = true
        sendEvent(EndedEvent)
    }
    internal fun handleError(code: String, message: String?, fatal: Boolean) =
        sendEvent(ErrorEvent(code = code, message = message, fatal = fatal))

    // ── Player.Listener overrides ─────────────────────────────────────────────

    override fun onPlaybackStateChanged(playbackState: Int) {
        when (playbackState) {
            Player.STATE_BUFFERING -> if (!hasFiredFirstFrame) handleWaiting()
            Player.STATE_READY -> if (!hasFiredFirstFrame) handleCanPlay()
            Player.STATE_ENDED -> handleEnded()
            else -> {}
        }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) {
            if (!hasFiredFirstFrame) handlePlay() else handleCanPlayThrough()
            startPlayheadTracking()
        } else {
            playheadJob?.cancel()
            playheadJob = null
            if (!isEndingNaturally && player.playbackState != Player.STATE_ENDED) {
                if (player.playbackState == Player.STATE_BUFFERING && hasFiredFirstFrame) {
                    // Mid-play rebuffering stall — emit waiting to trigger Rebuffering state
                    handleWaiting()
                } else {
                    handlePause()
                }
            }
        }
    }

    override fun onRenderedFirstFrame() {
        if (!hasFiredFirstFrame) handleFirstFrame()
    }

    override fun onPlayerError(error: PlaybackException) {
        handleError(
            code = error.errorCodeName ?: "UNKNOWN",
            message = error.message,
            fatal = true,
        )
    }

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        val src = mediaItem?.localConfiguration?.uri?.toString() ?: return
        handleLoad(src)
    }

    override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
    ) {
        if (reason != Player.DISCONTINUITY_REASON_SEEK) return
        val toMs = newPosition.positionMs
        val bufferReady = player.playbackState == Player.STATE_READY
        if (isHandlingProgrammaticSeek) {
            isHandlingProgrammaticSeek = false
            sendEvent(SeekEndEvent(toMs = toMs, bufferReady = bufferReady))
        } else {
            val fromMs = oldPosition.positionMs
            sendEvent(SeekStartEvent(fromMs = fromMs))
            sendEvent(SeekEndEvent(toMs = toMs, bufferReady = bufferReady))
        }
        lastPlayheadMs = toMs
    }

    override fun onVideoSizeChanged(videoSize: VideoSize) {
        val w = videoSize.width.takeIf { it > 0 }
        val h = videoSize.height.takeIf { it > 0 }
        if (w == null && h == null) return
        sendEvent(QualityChangeEvent(quality = QualityDto(width = w, height = h)))
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private fun startPlayheadTracking() {
        playheadJob?.cancel()
        playheadJob = scope.launch {
            while (isActive) {
                delay(500)
                val ms = player.currentPosition
                lastPlayheadMs = ms
                session?.setPlayhead(ms)
            }
        }
    }

    private fun sendEvent(event: PlayerEventDto) {
        val json = eventJson.encodeToString(event)
        eventSink?.invoke(json)
        session?.processEvent(json)
    }
}
