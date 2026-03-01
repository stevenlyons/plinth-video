package io.plinth.android

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class SessionMeta(
    val video: VideoMetadata,
    val client: ClientMetadata,
    val sdk: SdkMetadata,
)

@Serializable
data class VideoMetadata(
    val id: String,
    val title: String? = null,
)

@Serializable
data class ClientMetadata(
    @SerialName("user_agent") val userAgent: String,
)

@Serializable
data class SdkMetadata(
    @SerialName("api_version") val apiVersion: Int,
    val core: SdkComponent,
    val framework: SdkComponent,
    val player: SdkComponent,
)

@Serializable
data class SdkComponent(
    val name: String,
    val version: String,
)
