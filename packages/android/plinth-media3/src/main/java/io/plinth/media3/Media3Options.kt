package io.plinth.media3

import io.plinth.android.PlinthConfig
import io.plinth.android.PlinthSession
import io.plinth.android.SessionMeta

data class Media3Options(
    val config: PlinthConfig = PlinthConfig(),
    /** Test seam: replace [PlinthSession.create] with a custom factory. */
    val sessionFactory: ((SessionMeta, PlinthConfig) -> PlinthSession?)? = null,
)
