package io.plinth.android

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PlinthSessionTest {

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun testMeta(videoId: String = "v1") = SessionMeta(
        video = VideoMetadata(id = videoId, title = "Test Video"),
        client = ClientMetadata(userAgent = "TestAgent/1.0"),
        sdk = SdkMetadata(
            apiVersion = 1,
            core = SdkComponent(name = "plinth-core", version = "0.1.0"),
            framework = SdkComponent(name = "plinth-android", version = "0.1.0"),
            player = SdkComponent(name = "plinth-media3", version = "0.1.0"),
        ),
    )

    private fun beaconJson(event: String, seq: Int = 0) =
        """{"beacons":[{"seq":$seq,"play_id":"00000000-0000-0000-0000-000000000001","ts":1000,"event":"$event"}]}"""

    private fun emptyBatch() = """{"beacons":[]}"""

    /** Create a session with an [UnconfinedTestDispatcher] so coroutines run eagerly. */
    private fun TestScope.makeSession(
        fake: FakeCoreJni,
        config: PlinthConfig = PlinthConfig(heartbeatIntervalMs = 1_000L),
        captured: MutableList<BeaconBatch> = mutableListOf(),
    ): PlinthSession = PlinthSession.createInternal(
        meta = testMeta(),
        config = config,
        scope = this,
        beaconHandler = { captured.add(it) },
        jni = fake,
        dispatcher = UnconfinedTestDispatcher(testScheduler),
    )!!

    // ── Session creation ──────────────────────────────────────────────────────

    @Test fun `create returns non-null when jni succeeds`() = runTest {
        val fake = FakeCoreJni()
        val session = makeSession(fake)
        assertThat(session).isNotNull()
    }

    @Test fun `create returns null when jni returns zero pointer`() = runTest {
        val fake = FakeCoreJni(sessionNewResult = 0L)
        val session = PlinthSession.createInternal(
            meta = testMeta(),
            config = PlinthConfig(),
            scope = this,
            beaconHandler = null,
            jni = fake,
            dispatcher = UnconfinedTestDispatcher(testScheduler),
        )
        assertThat(session).isNull()
    }

    // ── processEvent ──────────────────────────────────────────────────────────

    @Test fun `processEvent calls jni with the event json`() = runTest {
        val fake = FakeCoreJni()
        val session = makeSession(fake)
        val eventJson = """{"type":"load","src":"https://example.com/v.m3u8"}"""

        session.processEvent(eventJson)
        advanceUntilIdle()

        assertThat(fake.processEventCalls).hasSize(1)
        assertThat(fake.processEventCalls[0]).isEqualTo(eventJson)
    }

    @Test fun `beaconHandler is called when jni returns non-empty batch`() = runTest {
        val fake = FakeCoreJni()
        fake.processEventResponses.add(beaconJson("session_open"))
        val captured = mutableListOf<BeaconBatch>()
        val session = makeSession(fake, captured = captured)

        session.processEvent("""{"type":"play"}""")
        advanceUntilIdle()

        assertThat(captured).hasSize(1)
        assertThat(captured[0].beacons[0].event).isEqualTo("session_open")
    }

    @Test fun `beaconHandler is NOT called when jni returns empty batch`() = runTest {
        val fake = FakeCoreJni() // default response is empty
        val captured = mutableListOf<BeaconBatch>()
        val session = makeSession(fake, captured = captured)

        session.processEvent("""{"type":"load","src":"x"}""")
        advanceUntilIdle()

        assertThat(captured).isEmpty()
    }

    @Test fun `processEvent after destroy is silently dropped`() = runTest {
        val fake = FakeCoreJni()
        fake.processEventResponses.add(beaconJson("session_open"))
        val captured = mutableListOf<BeaconBatch>()
        val session = makeSession(fake, captured = captured)

        session.destroy()
        advanceUntilIdle()
        val countAfterDestroy = fake.processEventCalls.size

        session.processEvent("""{"type":"play"}""")
        advanceUntilIdle()

        assertThat(fake.processEventCalls).hasSize(countAfterDestroy)
    }

    // ── setPlayhead ───────────────────────────────────────────────────────────

    @Test fun `setPlayhead calls jni`() = runTest {
        val fake = FakeCoreJni()
        val session = makeSession(fake)

        session.setPlayhead(30_000L)
        advanceUntilIdle()

        assertThat(fake.setPlayheadCalls).containsExactly(30_000L)
    }

    @Test fun `setPlayhead after destroy is silently dropped`() = runTest {
        val fake = FakeCoreJni()
        val session = makeSession(fake)

        session.destroy()
        advanceUntilIdle()
        session.setPlayhead(30_000L)
        advanceUntilIdle()

        assertThat(fake.setPlayheadCalls).isEmpty()
    }

    // ── destroy ───────────────────────────────────────────────────────────────

    @Test fun `destroy calls sessionDestroy on jni`() = runTest {
        val fake = FakeCoreJni()
        val session = makeSession(fake)

        session.destroy()
        advanceUntilIdle()

        assertThat(fake.destroyCalled).isTrue()
    }

    @Test fun `destroy posts final beacons from jni`() = runTest {
        val fake = FakeCoreJni()
        fake.destroyResponse = beaconJson("session_end")
        val captured = mutableListOf<BeaconBatch>()
        val session = makeSession(fake, captured = captured)

        session.destroy()
        advanceUntilIdle()

        assertThat(captured).hasSize(1)
        assertThat(captured[0].beacons[0].event).isEqualTo("session_end")
    }

    @Test fun `destroy is idempotent — second call is a no-op`() = runTest {
        val fake = FakeCoreJni()
        fake.destroyResponse = beaconJson("session_end")
        val captured = mutableListOf<BeaconBatch>()
        val session = makeSession(fake, captured = captured)

        session.destroy()
        advanceUntilIdle()
        val countAfterFirst = captured.size

        session.destroy()
        advanceUntilIdle()

        // No additional beacons and sessionDestroy called exactly once.
        assertThat(captured).hasSize(countAfterFirst)
        assertThat(fake.destroyCallCount).isEqualTo(1)
    }

    @Test fun `destroy from idle emits nothing`() = runTest {
        val fake = FakeCoreJni() // destroyResponse stays empty
        val captured = mutableListOf<BeaconBatch>()
        val session = makeSession(fake, captured = captured)

        session.destroy()
        advanceUntilIdle()

        assertThat(captured).isEmpty()
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────────

    @Test fun `heartbeat fires tick after configured interval`() = runTest(StandardTestDispatcher()) {
        val fake = FakeCoreJni()
        fake.tickResponses.add(beaconJson("heartbeat", seq = 1))
        val captured = mutableListOf<BeaconBatch>()
        val session = PlinthSession.createInternal(
            meta = testMeta(),
            config = PlinthConfig(heartbeatIntervalMs = 1_000L),
            scope = this,
            beaconHandler = { captured.add(it) },
            jni = fake,
            dispatcher = StandardTestDispatcher(testScheduler),
        )!!

        advanceTimeBy(1_001L)
        advanceUntilIdle()

        assertThat(fake.tickCalls).isNotEmpty()
        assertThat(captured.flatMap { it.beacons }.map { it.event }).contains("heartbeat")
    }

    @Test fun `heartbeat does not fire before interval elapses`() = runTest(StandardTestDispatcher()) {
        val fake = FakeCoreJni()
        PlinthSession.createInternal(
            meta = testMeta(),
            config = PlinthConfig(heartbeatIntervalMs = 1_000L),
            scope = this,
            beaconHandler = {},
            jni = fake,
            dispatcher = StandardTestDispatcher(testScheduler),
        )!!

        advanceTimeBy(500L)
        advanceUntilIdle()

        assertThat(fake.tickCalls).isEmpty()
    }

    @Test fun `heartbeat stops after destroy`() = runTest(StandardTestDispatcher()) {
        val fake = FakeCoreJni()
        val session = PlinthSession.createInternal(
            meta = testMeta(),
            config = PlinthConfig(heartbeatIntervalMs = 1_000L),
            scope = this,
            beaconHandler = {},
            jni = fake,
            dispatcher = StandardTestDispatcher(testScheduler),
        )!!

        session.destroy()
        advanceUntilIdle()
        val ticksAtDestroy = fake.tickCalls.size

        advanceTimeBy(5_000L)
        advanceUntilIdle()

        assertThat(fake.tickCalls).hasSize(ticksAtDestroy)
    }

    // ── JSON serialization ────────────────────────────────────────────────────

    @Test fun `PlinthConfig serializes to snake_case keys`() {
        val config = PlinthConfig(
            endpoint = "http://example.com/beacon",
            projectKey = "pABC",
            heartbeatIntervalMs = 5_000L,
        )
        val json = Json.parseToJsonElement(PlinthSession.json.encodeToString(config)).jsonObject
        assertThat(json["endpoint"]!!.jsonPrimitive.content).isEqualTo("http://example.com/beacon")
        assertThat(json["project_key"]!!.jsonPrimitive.content).isEqualTo("pABC")
        assertThat(json["heartbeat_interval_ms"]!!.jsonPrimitive.content).isEqualTo("5000")
    }

    @Test fun `SessionMeta serializes to correct snake_case keys`() {
        val meta = testMeta()
        val json = Json.parseToJsonElement(PlinthSession.json.encodeToString(meta)).jsonObject
        // client.user_agent
        val client = json["client"]!!.jsonObject
        assertThat(client["user_agent"]!!.jsonPrimitive.content).isEqualTo("TestAgent/1.0")
        // sdk.api_version
        val sdk = json["sdk"]!!.jsonObject
        assertThat(sdk["api_version"]!!.jsonPrimitive.content).isEqualTo("1")
    }

    @Test fun `BeaconBatch deserializes all typed fields`() {
        val raw = """
            {"beacons":[{
                "seq":1,
                "play_id":"abc-123",
                "ts":9999,
                "event":"heartbeat",
                "state":"playing",
                "metrics":{"vst_ms":500,"played_ms":1000,"rebuffer_ms":0,"watched_ms":1500,"rebuffer_count":0,"error_count":0},
                "playhead_ms":1234
            }]}
        """.trimIndent()

        val batch = PlinthSession.json.decodeFromString<BeaconBatch>(raw)
        val b = batch.beacons[0]

        assertThat(b.seq).isEqualTo(1)
        assertThat(b.playId).isEqualTo("abc-123")
        assertThat(b.event).isEqualTo("heartbeat")
        assertThat(b.state).isEqualTo("playing")
        assertThat(b.playheadMs).isEqualTo(1234L)
        assertThat(b.metrics!!.vstMs).isEqualTo(500L)
        assertThat(b.metrics!!.playedMs).isEqualTo(1000L)
        assertThat(b.metrics!!.rebufferCount).isEqualTo(0)
    }

    @Test fun `BeaconBatch with null vst_ms deserializes correctly`() {
        val raw = """
            {"beacons":[{
                "seq":0,"play_id":"x","ts":1,"event":"session_open",
                "video":{"id":"v1"},"client":{"user_agent":"UA"},"sdk":{"api_version":1,"core":{"name":"c","version":"0.1"},"framework":{"name":"f","version":"0.1"},"player":{"name":"p","version":"0.1"}}
            }]}
        """.trimIndent()

        val batch = PlinthSession.json.decodeFromString<BeaconBatch>(raw)
        val b = batch.beacons[0]

        assertThat(b.event).isEqualTo("session_open")
        assertThat(b.metrics).isNull()
        assertThat(b.video!!.id).isEqualTo("v1")
    }

    @Test fun `Beacon with seek fields deserializes seek_from_ms and seek_to_ms`() {
        val raw = """
            {"beacons":[{"seq":2,"play_id":"x","ts":1,"event":"seek_end",
             "state":"playing","metrics":{"vst_ms":100,"played_ms":500,"rebuffer_ms":0,"watched_ms":600,"rebuffer_count":0,"error_count":0},
             "seek_from_ms":1000,"seek_to_ms":5000}]}
        """.trimIndent()

        val b = PlinthSession.json.decodeFromString<BeaconBatch>(raw).beacons[0]

        assertThat(b.seekFromMs).isEqualTo(1000L)
        assertThat(b.seekToMs).isEqualTo(5000L)
    }
}

// ── Fake JNI ─────────────────────────────────────────────────────────────────

/** Test double for [CoreJni]. Returns configurable JSON responses without loading native code. */
class FakeCoreJni(val sessionNewResult: Long = 1L) : CoreJni {

    val processEventCalls = mutableListOf<String>()
    val tickCalls = mutableListOf<Long>()
    val setPlayheadCalls = mutableListOf<Long>()
    var destroyCalled = false
    var destroyCallCount = 0

    val processEventResponses = ArrayDeque<String>()
    val tickResponses = ArrayDeque<String>()
    var destroyResponse = """{"beacons":[]}"""

    override fun sessionNew(configJson: String?, metaJson: String, nowMs: Long): Long =
        sessionNewResult

    override fun sessionProcessEvent(ptr: Long, eventJson: String, nowMs: Long): String {
        processEventCalls.add(eventJson)
        return processEventResponses.removeFirstOrNull() ?: """{"beacons":[]}"""
    }

    override fun sessionTick(ptr: Long, nowMs: Long): String {
        tickCalls.add(nowMs)
        return tickResponses.removeFirstOrNull() ?: """{"beacons":[]}"""
    }

    override fun sessionSetPlayhead(ptr: Long, playheadMs: Long) {
        setPlayheadCalls.add(playheadMs)
    }

    override fun sessionDestroy(ptr: Long, nowMs: Long): String {
        destroyCalled = true
        destroyCallCount++
        return destroyResponse
    }
}
