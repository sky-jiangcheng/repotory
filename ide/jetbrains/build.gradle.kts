// Repotory for JetBrains — Gradle build.
//
// ADR-0027 decision 3: Kotlin + Gradle (IntelliJ Platform Plugin), an
// INDEPENDENT code base. The double maintenance surface ADR-0009 warned about
// is knowingly accepted, with the thin-client discipline pressing the
// maintenance cost down to the API layer.
//
// The IntelliJ Platform Gradle plugin (2.x) is the standard toolchain for
// building a plugin that installs into any IntelliJ-family IDE.
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("java")
    id("org.jetbrains.intellij.platform") version "2.1.0"
    // Kotlin 2.2.x is required by IDEA 2025.2: the platform's own classes are
    // compiled with Kotlin 2.2.0 metadata, and an older compiler aborts with
    // "Module was compiled with an incompatible version of Kotlin" plus an
    // internal compiler error. The compiler must be at least as new as the
    // metadata it reads.
    id("org.jetbrains.kotlin.jvm") version "2.2.0"
}

group = "dev.repotory"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Platform-level only (ADR-0027 decision 1: "com.intellij.modules.platform",
        // IDEA CE first but the same build installs into the whole family).
        // The plugin uses no product-specific API, so there is no per-product
        // dependency to fork.
        create("IC", "2025.2")
        instrumentationTools()
        // The Plugin Verifier CLI is what `verifyPlugin` runs: it checks the
        // built plugin against a real IDE for API misuse and for binary
        // compatibility with the declared since/until range. Without it the
        // task silently has nothing to run.
        pluginVerifier()
    }
}

intellijPlatform {
    // 242 = 2024.2+, covering the owner's 2024.3 and current 2025.2 with
    // headroom (2026-10-22 decision 1).
    //
    // The verifier warns that sinceBuild (242) is lower than the platform it
    // is built against (252). That gap is the POINT: the build target is the
    // newest IDE the owner uses, while the declared floor is what the plugin
    // claims to support. A plugin built against 252 APIs but declaring 242
    // would be a lie — so the plugin must stay on platform APIs that exist in
    // 242 (it uses only the tool window, the settings page, Swing and
    // java.net), and the Plugin Verifier is what proves that.
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "242"
            // Until 243.* so the plugin stays installable on 2024.2 as well.
            untilBuild = "243.*"
        }
    }
    pluginVerification {
        ides {
            // The owner's daily IDE: IntelliJ IDEA CE. Verification against
            // the family is not needed — the plugin declares only platform APIs.
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2025.2")
        }
    }
}

kotlin {
    jvmToolchain(21)
}

tasks {
    buildSearchableOptions {
        // The plugin has no options that need to be indexed at runtime; the
        // search index build adds minutes to every packaging run.
        enabled = false
    }
}
