package io.plinth.android

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class PlinthConfig(
    val endpoint: String = "http://localhost:3000/beacon",
    @SerialName("project_key") val projectKey: String = "p123456789",
    @SerialName("heartbeat_interval_ms") val heartbeatIntervalMs: Long = 10_000L,
)
