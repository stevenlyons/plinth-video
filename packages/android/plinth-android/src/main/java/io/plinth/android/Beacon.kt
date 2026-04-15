package io.plinth.android

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class BeaconBatch(
    val beacons: List<Beacon>,
)

@Serializable
data class Beacon(
    val seq: Int,
    @SerialName("play_id") val playId: String,
    val ts: Long,
    val event: String,
    // State and metrics — present on all beacons except session_open.
    val state: String? = null,
    val metrics: Metrics? = null,
    // session_open fields.
    val video: VideoMetadata? = null,
    val client: ClientMetadata? = null,
    val sdk: SdkMetadata? = null,
    // heartbeat field.
    @SerialName("playhead_ms") val playheadMs: Long? = null,
    // seek fields.
    @SerialName("seek_from_ms") val seekFromMs: Long? = null,
    @SerialName("seek_to_ms") val seekToMs: Long? = null,
    // quality_change field.
    val quality: QualityLevel? = null,
    // error field.
    val error: PlayerError? = null,
)

@Serializable
data class Metrics(
    @SerialName("vst_ms") val vstMs: Long?,
    @SerialName("played_ms") val playedMs: Long,
    @SerialName("rebuffer_ms") val rebufferMs: Long,
    @SerialName("watched_ms") val watchedMs: Long,
    @SerialName("rebuffer_count") val rebufferCount: Int,
    @SerialName("error_count") val errorCount: Int,
    @SerialName("seek_buffer_ms") val seekBufferMs: Long,
    @SerialName("seek_buffer_count") val seekBufferCount: Int,
    @SerialName("seek_count") val seekCount: Int,
)

@Serializable
data class QualityLevel(
    @SerialName("bitrate_bps") val bitrateBps: Int? = null,
    val width: Int? = null,
    val height: Int? = null,
    val framerate: Double? = null,
    val codec: String? = null,
)

@Serializable
data class PlayerError(
    val code: String,
    val message: String? = null,
    val fatal: Boolean,
)
