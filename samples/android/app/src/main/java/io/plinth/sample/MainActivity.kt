package io.plinth.sample

import android.graphics.Color
import android.os.Bundle
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.StyledPlayerView
import io.plinth.android.BeaconBatch
import io.plinth.android.PlinthSession
import io.plinth.media3.Media3Options
import io.plinth.media3.Media3VideoMeta
import io.plinth.media3.PlinthMedia3
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Android sample app for plinth-telemetry.
 *
 * Mirrors the macOS demo: plays a test HLS stream and shows a scrolling
 * colour-coded beacon log on the right side of the screen.
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        const val HLS_URL =
            "https://stream.mux.com/GWPDeDbc011cmHckB4h4l87OofuZPGPKl.m3u8"
    }

    private var player: ExoPlayer? = null
    private var plinth: PlinthMedia3? = null

    private val logBuilder = SpannableStringBuilder()
    private var beaconCount = 0
    private val timeFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
    }

    override fun onStart() {
        super.onStart()
        initializePlayer()
    }

    override fun onStop() {
        super.onStop()
        plinth?.destroy()
        plinth = null
        player?.release()
        player = null
    }

    // ── Player setup ──────────────────────────────────────────────────────────

    private fun initializePlayer() {
        val exo = ExoPlayer.Builder(this).build()
        player = exo

        findViewById<StyledPlayerView>(R.id.playerView).player = exo

        plinth = PlinthMedia3.initialize(
            player = exo,
            videoMeta = Media3VideoMeta(id = "big-buck-bunny", title = "Big Buck Bunny"),
            options = Media3Options(
                sessionFactory = { meta, config ->
                    PlinthSession.create(
                        meta = meta,
                        config = config,
                        beaconHandler = { batch ->
                            // beaconHandler fires on the session dispatcher; hop to UI thread.
                            runOnUiThread { appendBatch(batch) }
                        },
                    )
                }
            ),
        )

        exo.setMediaItem(MediaItem.fromUri(HLS_URL))
        exo.prepare()
        exo.playWhenReady = true
    }

    // ── Beacon log ────────────────────────────────────────────────────────────

    private fun appendBatch(batch: BeaconBatch) {
        val logText   = findViewById<TextView>(R.id.logText)   ?: return
        val logScroll = findViewById<ScrollView>(R.id.logScroll) ?: return
        val logHeader = findViewById<TextView>(R.id.logHeader) ?: return

        val now = timeFormat.format(Date())

        for (beacon in batch.beacons) {
            beaconCount++
            if (logBuilder.isNotEmpty()) logBuilder.append("\n")

            // Timestamp + seq number (dim gray)
            val metaPart = "$now  #${beacon.seq}  "
            val metaStart = logBuilder.length
            logBuilder.append(metaPart)
            logBuilder.setSpan(
                ForegroundColorSpan(0xFF666666.toInt()),
                metaStart, logBuilder.length,
                Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
            )

            // Event name (colour-coded by type)
            val eventStart = logBuilder.length
            logBuilder.append(beacon.event)
            logBuilder.setSpan(
                ForegroundColorSpan(colorForEvent(beacon.event)),
                eventStart, logBuilder.length,
                Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }

        logText.text = logBuilder
        logHeader.text = "Beacon Log  ($beaconCount)"
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    /** Maps event names to display colours, mirroring [BeaconLogView] in the macOS demo. */
    private fun colorForEvent(event: String): Int = when {
        event == "session_open"      -> Color.parseColor("#4A9EFF") // blue
        event == "first_frame"       -> Color.parseColor("#4CAF50") // green
        event == "session_end"       -> Color.parseColor("#FF9800") // orange
        event == "error"             -> Color.parseColor("#F44336") // red
        event == "heartbeat"         -> Color.parseColor("#666666") // dim gray
        event.startsWith("rebuffer") -> Color.parseColor("#FFEB3B") // yellow
        event.startsWith("seek")     -> Color.parseColor("#CE93D8") // purple
        else                         -> Color.parseColor("#CCCCCC") // light gray
    }
}
