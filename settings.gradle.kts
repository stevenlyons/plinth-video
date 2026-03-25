pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "plinth-telemetry"

include(":plinth-android")
project(":plinth-android").projectDir = file("packages/android/plinth-android")

include(":plinth-media3")
project(":plinth-media3").projectDir = file("packages/android/plinth-media3")

include(":android-sample:app")
project(":android-sample:app").projectDir = file("samples/android/app")
