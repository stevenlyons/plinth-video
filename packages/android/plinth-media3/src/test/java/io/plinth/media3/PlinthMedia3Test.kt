package io.plinth.media3

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import androidx.media3.common.Player
import androidx.media3.common.VideoSize

/**
 * JVM unit tests for [PlinthMedia3].
 *
 * Events are verified as JSON strings via the internal [PlinthMedia3.eventSink] seam.
 * No real [Player], [PlinthSession], or native library is required.
 *
 * - [Player] is mocked with Mockito (it is a Java interface).
 * - [PlinthMedia3.initializeInternal] injects an [Dispatchers.Unconfined] scope so
 *   coroutines are effectively synchronous in tests.
 * - [Media3Options.sessionFactory] returns null; events reach [eventSink] only.
 */
class PlinthMedia3Test {

    // ── Test state ─────────────────────────────────────────────────────────────

    private val capturedEvents = mutableListOf<String>()
    private lateinit var fakePlayer: Player
    private lateinit var plinth: PlinthMedia3

    @Before fun setUp() {
        capturedEvents.clear()
        fakePlayer = mock(Player::class.java)
        `when`(fakePlayer.currentMediaItem).thenReturn(null)
        `when`(fakePlayer.playbackState).thenReturn(Player.STATE_IDLE)
        `when`(fakePlayer.currentPosition).thenReturn(0L)

        plinth = PlinthMedia3.initializeInternal(
            player = fakePlayer,
            videoMeta = Media3VideoMeta(id = "v1", title = "Test Video"),
            options = Media3Options(sessionFactory = { _, _ -> null }),
            scope = CoroutineScope(Dispatchers.Unconfined),
        )
        plinth.eventSink = { capturedEvents.add(it) }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private fun String.jsonType(): String =
        Json.parseToJsonElement(this).jsonObject["type"]!!.jsonPrimitive.content

    private fun List<String>.eventTypes(): List<String> = map { it.jsonType() }

    /** Drive the instance to Playing state (mirrors [reachPlaying] in AVPlayer tests). */
    private fun reachPlaying() {
        plinth.handleLoad("https://example.com/video.m3u8")
        plinth.handleCanPlay()
        plinth.handlePlay()
        plinth.handleFirstFrame()
    }

    // ── handleLoad ────────────────────────────────────────────────────────────

    @Test fun `handleLoad sends load event with correct type`() {
        plinth.handleLoad("https://example.com/v.m3u8")
        assertThat(capturedEvents).hasSize(1)
        assertThat(capturedEvents[0].jsonType()).isEqualTo("load")
    }

    @Test fun `handleLoad serializes src URL without corruption`() {
        val url = "https://example.com/video?key=value&other=123"
        plinth.handleLoad(url)
        val obj = Json.parseToJsonElement(capturedEvents[0]).jsonObject
        assertThat(obj["src"]!!.jsonPrimitive.content).isEqualTo(url)
    }

    @Test fun `handleLoad resets hasFiredFirstFrame so play sequence restarts`() {
        reachPlaying()
        plinth.handleLoad("https://example.com/v2.m3u8")
        capturedEvents.clear()
        // After reload, play should emit play (not can_play_through)
        plinth.handlePlay()
        assertThat(capturedEvents[0].jsonType()).isEqualTo("play")
    }

    // ── Individual handleXxx events ───────────────────────────────────────────

    @Test fun `handleCanPlay sends can_play`() {
        plinth.handleCanPlay()
        assertThat(capturedEvents[0].jsonType()).isEqualTo("can_play")
    }

    @Test fun `handlePlay sends play`() {
        plinth.handlePlay()
        assertThat(capturedEvents[0].jsonType()).isEqualTo("play")
    }

    @Test fun `handleWaiting sends waiting`() {
        plinth.handleWaiting()
        assertThat(capturedEvents[0].jsonType()).isEqualTo("waiting")
    }

    @Test fun `handleFirstFrame sends first_frame`() {
        plinth.handleFirstFrame()
        assertThat(capturedEvents[0].jsonType()).isEqualTo("first_frame")
    }

    @Test fun `handleCanPlayThrough sends can_play_through`() {
        plinth.handleCanPlayThrough()
        assertThat(capturedEvents[0].jsonType()).isEqualTo("can_play_through")
    }

    @Test fun `handlePause sends pause`() {
        plinth.handlePause()
        assertThat(capturedEvents[0].jsonType()).isEqualTo("pause")
    }

    @Test fun `handleEnded sends ended`() {
        plinth.handleEnded()
        assertThat(capturedEvents[0].jsonType()).isEqualTo("ended")
    }

    @Test fun `handleError sends error event with code and fatal flag`() {
        plinth.handleError(code = "NET_ERR", message = "timeout", fatal = true)
        val obj = Json.parseToJsonElement(capturedEvents[0]).jsonObject
        assertThat(obj["type"]!!.jsonPrimitive.content).isEqualTo("error")
        assertThat(obj["code"]!!.jsonPrimitive.content).isEqualTo("NET_ERR")
        assertThat(obj["fatal"]!!.jsonPrimitive.boolean).isTrue()
    }

    @Test fun `handleError with null message omits message field`() {
        plinth.handleError(code = "ERR", message = null, fatal = true)
        val obj = Json.parseToJsonElement(capturedEvents[0]).jsonObject
        assertThat(obj.containsKey("message")).isFalse()
    }

    // ── Play sequence ─────────────────────────────────────────────────────────

    @Test fun `full play sequence sends events in order`() {
        plinth.handleLoad("https://example.com/video.m3u8")
        plinth.handleCanPlay()
        plinth.handlePlay()
        plinth.handleFirstFrame()
        assertThat(capturedEvents.eventTypes())
            .containsExactly("load", "can_play", "play", "first_frame")
            .inOrder()
    }

    @Test fun `pause after playing sends pause`() {
        reachPlaying()
        plinth.handlePause()
        assertThat(capturedEvents.last().jsonType()).isEqualTo("pause")
    }

    @Test fun `resume after pause sends can_play_through (not play)`() {
        reachPlaying()
        plinth.handlePause()
        capturedEvents.clear()
        plinth.handleCanPlayThrough()
        assertThat(capturedEvents.eventTypes()).containsExactly("can_play_through")
    }

    // ── onPlaybackStateChanged routing ────────────────────────────────────────

    @Test fun `STATE_BUFFERING before first frame sends waiting`() {
        plinth.onPlaybackStateChanged(Player.STATE_BUFFERING)
        assertThat(capturedEvents[0].jsonType()).isEqualTo("waiting")
    }

    @Test fun `STATE_BUFFERING after first frame sends nothing`() {
        plinth.handleFirstFrame()
        capturedEvents.clear()
        plinth.onPlaybackStateChanged(Player.STATE_BUFFERING)
        assertThat(capturedEvents).isEmpty()
    }

    @Test fun `STATE_READY before first frame sends can_play`() {
        plinth.onPlaybackStateChanged(Player.STATE_READY)
        assertThat(capturedEvents[0].jsonType()).isEqualTo("can_play")
    }

    @Test fun `STATE_READY after first frame sends nothing`() {
        plinth.handleFirstFrame()
        capturedEvents.clear()
        plinth.onPlaybackStateChanged(Player.STATE_READY)
        assertThat(capturedEvents).isEmpty()
    }

    @Test fun `STATE_ENDED sends ended`() {
        plinth.onPlaybackStateChanged(Player.STATE_ENDED)
        assertThat(capturedEvents[0].jsonType()).isEqualTo("ended")
    }

    // ── onIsPlayingChanged routing ────────────────────────────────────────────

    @Test fun `onIsPlayingChanged true before first frame sends play`() {
        plinth.onIsPlayingChanged(true)
        assertThat(capturedEvents[0].jsonType()).isEqualTo("play")
    }

    @Test fun `onIsPlayingChanged true after first frame sends can_play_through`() {
        plinth.handleFirstFrame()
        capturedEvents.clear()
        plinth.onIsPlayingChanged(true)
        assertThat(capturedEvents[0].jsonType()).isEqualTo("can_play_through")
    }

    @Test fun `onIsPlayingChanged false when not buffering sends pause`() {
        `when`(fakePlayer.playbackState).thenReturn(Player.STATE_READY)
        plinth.onIsPlayingChanged(false)
        assertThat(capturedEvents[0].jsonType()).isEqualTo("pause")
    }

    @Test fun `onIsPlayingChanged false when buffering after first frame sends waiting (rebuffering)`() {
        plinth.handleFirstFrame()
        capturedEvents.clear()
        `when`(fakePlayer.playbackState).thenReturn(Player.STATE_BUFFERING)
        plinth.onIsPlayingChanged(false)
        assertThat(capturedEvents[0].jsonType()).isEqualTo("waiting")
    }

    @Test fun `onIsPlayingChanged false when buffering before first frame sends pause`() {
        // Before first frame, STATE_BUFFERING + isPlaying=false is a pause (not rebuffering)
        `when`(fakePlayer.playbackState).thenReturn(Player.STATE_BUFFERING)
        plinth.onIsPlayingChanged(false)
        assertThat(capturedEvents[0].jsonType()).isEqualTo("pause")
    }

    @Test fun `natural end — ended suppresses spurious pause`() {
        reachPlaying()
        `when`(fakePlayer.playbackState).thenReturn(Player.STATE_ENDED)
        capturedEvents.clear()
        plinth.handleEnded()            // sets isEndingNaturally = true
        plinth.onIsPlayingChanged(false) // should NOT emit pause
        assertThat(capturedEvents.eventTypes()).containsExactly("ended")
    }

    // ── Seek handling ─────────────────────────────────────────────────────────

    @Test fun `user seek via onPositionDiscontinuity sends seek_start then seek_end`() {
        reachPlaying()
        capturedEvents.clear()
        `when`(fakePlayer.playbackState).thenReturn(Player.STATE_READY)

        val oldPos = Player.PositionInfo(null, 0, null, null, 0, 5_000L, 5_000L, -1, -1)
        val newPos = Player.PositionInfo(null, 0, null, null, 0, 60_000L, 60_000L, -1, -1)
        plinth.onPositionDiscontinuity(oldPos, newPos, Player.DISCONTINUITY_REASON_SEEK)

        assertThat(capturedEvents.eventTypes()).containsExactly("seek_start", "seek_end").inOrder()
        val seekStart = Json.parseToJsonElement(capturedEvents[0]).jsonObject
        assertThat(seekStart["from_ms"]!!.jsonPrimitive.long).isEqualTo(5_000L)
        val seekEnd = Json.parseToJsonElement(capturedEvents[1]).jsonObject
        assertThat(seekEnd["to_ms"]!!.jsonPrimitive.long).isEqualTo(60_000L)
        assertThat(seekEnd["buffer_ready"]!!.jsonPrimitive.boolean).isTrue()
    }

    @Test fun `non-seek discontinuity is ignored`() {
        reachPlaying()
        capturedEvents.clear()
        val oldPos = Player.PositionInfo(null, 0, null, null, 0, 0L, 0L, -1, -1)
        val newPos = Player.PositionInfo(null, 0, null, null, 0, 0L, 0L, -1, -1)
        plinth.onPositionDiscontinuity(oldPos, newPos, Player.DISCONTINUITY_REASON_AUTO_TRANSITION)
        assertThat(capturedEvents).isEmpty()
    }

    @Test fun `programmatic seekTo sends seek_start and seek_end without double seek_start`() {
        reachPlaying()
        capturedEvents.clear()
        `when`(fakePlayer.playbackState).thenReturn(Player.STATE_READY)

        // Programmatic seek: seekTo emits seek_start, then onPositionDiscontinuity emits seek_end
        plinth.seekTo(30_000L)
        val oldPos = Player.PositionInfo(null, 0, null, null, 0, 0L, 0L, -1, -1)
        val newPos = Player.PositionInfo(null, 0, null, null, 0, 30_000L, 30_000L, -1, -1)
        plinth.onPositionDiscontinuity(oldPos, newPos, Player.DISCONTINUITY_REASON_SEEK)

        assertThat(capturedEvents.eventTypes()).containsExactly("seek_start", "seek_end").inOrder()
        val seekEnd = Json.parseToJsonElement(capturedEvents[1]).jsonObject
        assertThat(seekEnd["to_ms"]!!.jsonPrimitive.long).isEqualTo(30_000L)
    }

    @Test fun `seekTo uses lastPlayheadMs as from_ms`() {
        reachPlaying()
        // Simulate a user seek that updates lastPlayheadMs to 10 000
        val oldPos = Player.PositionInfo(null, 0, null, null, 0, 0L, 0L, -1, -1)
        val newPos = Player.PositionInfo(null, 0, null, null, 0, 10_000L, 10_000L, -1, -1)
        plinth.onPositionDiscontinuity(oldPos, newPos, Player.DISCONTINUITY_REASON_SEEK)

        capturedEvents.clear()
        plinth.seekTo(50_000L)

        val seekStart = Json.parseToJsonElement(capturedEvents[0]).jsonObject
        assertThat(seekStart["from_ms"]!!.jsonPrimitive.long).isEqualTo(10_000L)
    }

    // ── Video size / quality ──────────────────────────────────────────────────

    @Test fun `onVideoSizeChanged with valid dimensions sends quality_change`() {
        plinth.onVideoSizeChanged(VideoSize(1920, 1080))
        val obj = Json.parseToJsonElement(capturedEvents[0]).jsonObject
        assertThat(obj["type"]!!.jsonPrimitive.content).isEqualTo("quality_change")
        val quality = obj["quality"]!!.jsonObject
        assertThat(quality["width"]!!.jsonPrimitive.int).isEqualTo(1920)
        assertThat(quality["height"]!!.jsonPrimitive.int).isEqualTo(1080)
    }

    @Test fun `onVideoSizeChanged with zero dimensions sends nothing`() {
        plinth.onVideoSizeChanged(VideoSize(0, 0))
        assertThat(capturedEvents).isEmpty()
    }

    // ── onMediaItemTransition ─────────────────────────────────────────────────

    @Test fun `onMediaItemTransition with null media item sends nothing`() {
        plinth.onMediaItemTransition(null, Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT)
        assertThat(capturedEvents).isEmpty()
    }

    // ── destroy ───────────────────────────────────────────────────────────────

    @Test fun `destroy removes listener from player`() {
        plinth.destroy()
        verify(fakePlayer).removeListener(plinth)
    }

    @Test fun `destroy is idempotent — second call is no-op`() {
        plinth.destroy()
        plinth.destroy()
        verify(fakePlayer, times(1)).removeListener(plinth)
    }

    @Test fun `seekTo after destroy is silently dropped`() {
        plinth.destroy()
        plinth.seekTo(10_000L)
        assertThat(capturedEvents).isEmpty()
    }

    // ── onRenderedFirstFrame ──────────────────────────────────────────────────

    @Test fun `onRenderedFirstFrame sends first_frame only once`() {
        plinth.onRenderedFirstFrame()
        plinth.onRenderedFirstFrame()
        assertThat(capturedEvents.eventTypes()).containsExactly("first_frame")
    }
}
