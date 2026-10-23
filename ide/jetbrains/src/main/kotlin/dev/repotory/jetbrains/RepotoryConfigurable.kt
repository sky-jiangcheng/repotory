// Settings page for the Repotory plugin.
//
// ADR-0027 decision 2③ and its 2026-10-22 usability revision: the server
// address (default http://127.0.0.1:18765), the optional path to a local
// `repotory-server` binary, a connection health check, and a one-click start
// for that local service. Nothing here downloads or builds a server: the
// plugin only launches a binary the user already has.
package dev.repotory.jetbrains

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import java.awt.BorderLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

class RepotoryConfigurable : Configurable {
    private var serverUrlField: JBTextField? = null
    private var binaryField: JBTextField? = null
    private var statusLabel: JBLabel? = null

    override fun getDisplayName(): String = "Repotory"

    override fun createComponent(): JComponent {
        val url = JBTextField(RepotorySettings.serverUrl(), 32)
        serverUrlField = url
        val binary = JBTextField(RepotorySettings.serverBinaryPath(), 32)
        binaryField = binary
        val status = JBLabel(" ")
        statusLabel = status

        val locate = JButton("Locate…")
        locate.addActionListener {
            chooseServerBinary()?.let { binary.text = it.absolutePath }
        }
        val binaryRow = JPanel(BorderLayout(6, 0))
        binaryRow.add(binary, BorderLayout.CENTER)
        binaryRow.add(locate, BorderLayout.EAST)

        val test = JButton("Test connection")
        test.addActionListener {
            val target = url.text?.trim().orEmpty()
            // /health answering is not the same as the deployment being usable:
            // a server without --web-dist serves the API but 404s every result
            // link, so a bare "Connected" would be a green light for a broken
            // click. The probe distinguishes the two cases.
            status.text = when {
                target.isEmpty() -> "Enter a server address first."
                !repotoryClient.ping(target) -> "No response from $target. Is the Repotory server running?"
                repotoryClient.servesWebUi(target) -> "Connected: $target — API and web UI both reachable."
                else ->
                    "Connected: $target, but API-only: \"Open in Repotory\" would 404. " +
                        "Use Start local service (release bundle) or restart it with --web-dist."
            }
        }

        val start = JButton("Start local service")
        start.addActionListener {
            val target = url.text?.trim().orEmpty()
            if (target.isEmpty()) {
                status.text = "Enter a server address first."
                return@addActionListener
            }
            val override = binary.text?.trim()?.takeIf { it.isNotEmpty() }?.let { expandHome(it) }
            status.text = "Starting local service…"
            val app = ApplicationManager.getApplication()
            app.executeOnPooledThread {
                val outcome = repotoryServer.start(target, override)
                app.invokeLater { status.text = describeStart(outcome, target) }
            }
        }

        return FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Server address:"), url, 1, false)
            .addLabeledComponent(JBLabel("Server binary:"), binaryRow, 1, false)
            .addComponent(test)
            .addComponent(start)
            .addComponent(status)
            .addComponentFillVertically(JPanel(), 0)
            .panel
    }

    override fun isModified(): Boolean =
        serverUrlField?.text?.trim() != RepotorySettings.serverUrl() ||
            binaryField?.text?.trim().orEmpty() != RepotorySettings.serverBinaryPath()

    override fun apply() {
        RepotorySettings.setServerUrl(serverUrlField?.text?.trim().orEmpty())
        RepotorySettings.setServerBinaryPath(binaryField?.text?.trim().orEmpty())
    }

    override fun reset() {
        serverUrlField?.text = RepotorySettings.serverUrl()
        binaryField?.text = RepotorySettings.serverBinaryPath()
        statusLabel?.text = " "
    }

    override fun disposeUIResources() {
        serverUrlField = null
        binaryField = null
        statusLabel = null
    }

    private fun describeStart(outcome: StartOutcome, target: String): String = when (outcome) {
        is StartOutcome.Started ->
            if (outcome.webUi) {
                "Started ${outcome.binary.file.name} on port ${outcome.port} — API and web UI reachable."
            } else {
                "Started ${outcome.binary.file.name} on port ${outcome.port}, API-only " +
                    "(no sibling web/ directory): result links would 404."
            }
        StartOutcome.AlreadyRunning -> "$target already answers — reusing the running service."
        is StartOutcome.BinaryMissing ->
            "No repotory-server binary found. Use Locate… to pick one, or download a release bundle."
        is StartOutcome.Failed -> outcome.message
    }
}

/**
 * Persistent settings.
 *
 * The address is stored in the IDE's own properties store (not in Repotory's
 * database): the plugin is a client, and a client must not write into the
 * service's storage.
 */
object RepotorySettings {
    fun serverUrl(): String =
        com.intellij.openapi.application.ApplicationManager.getApplication()
            .getService(RepotorySettingsState::class.java)
            .serverUrl?.takeIf { it.isNotBlank() } ?: RepotoryClient.DEFAULT_SERVER_URL

    fun setServerUrl(value: String) {
        com.intellij.openapi.application.ApplicationManager.getApplication()
            .getService(RepotorySettingsState::class.java)
            .serverUrl = value.ifBlank { RepotoryClient.DEFAULT_SERVER_URL }
    }

    /** Empty means "auto-detect in PATH / common install directories". */
    fun serverBinaryPath(): String =
        com.intellij.openapi.application.ApplicationManager.getApplication()
            .getService(RepotorySettingsState::class.java)
            .serverBinaryPath.orEmpty()

    fun setServerBinaryPath(value: String) {
        com.intellij.openapi.application.ApplicationManager.getApplication()
            .getService(RepotorySettingsState::class.java)
            .serverBinaryPath = value.trim()
    }
}

/** The state bean behind [RepotorySettings]; IntelliJ persists it. */
@com.intellij.openapi.components.State(
    name = "RepotorySettings",
    storages = [com.intellij.openapi.components.Storage("repotory.xml")],
)
class RepotorySettingsState : com.intellij.openapi.components.BaseState() {
    // BaseState's string delegate is nullable (a state bean can be read
    // before it was ever written), so the property is declared String? and
    // RepotorySettings.serverUrl() falls back to the default.
    var serverUrl: String? by string(RepotoryClient.DEFAULT_SERVER_URL)
    var serverBinaryPath: String? by string("")
}
