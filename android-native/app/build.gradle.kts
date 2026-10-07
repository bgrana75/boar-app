plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "team.sopa.boar"
    compileSdk = 36

    defaultConfig {
        // The release keeps the Expo app's id and key, so it installs over v1.1.x with its models.
        applicationId = "team.sopa.aoair"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "2.0.0-dev"
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    buildTypes {
        debug {
            // Development builds install beside the current BOAR, never over it.
            applicationIdSuffix = ".native"
            versionNameSuffix = "-native"
        }
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    packaging { jniLibs { useLegacyPackaging = true } }
}

kotlin { jvmToolchain(17) }

// Data the Expo app ships in the repo's assets/, copied at build time so it stays in one place: the Portuguese name
// lexicon (assets/lexicon/pt-en.json) and the bundled corpus (assets/corpus).
val sharedAssets = layout.buildDirectory.dir("generated/sharedAssets")
val copySharedAssets by tasks.registering(Copy::class) {
    from(rootProject.file("../assets")) {
        include("lexicon/pt-en.json", "corpus/*.json")
    }
    into(sharedAssets)
}
android.sourceSets["main"].assets.srcDir(sharedAssets)
tasks.named("preBuild") { dependsOn(copySharedAssets) }

dependencies {
    implementation(project(":engine"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
}
