// Settings page for the Repotory plugin.
//
// ADR-0027 decision 2③: the server address (default http://127.0.0.1:18765)
// plus a connection health check. The plugin only CONNECTS to an instance the
// user already runs — it does not start, stop or supervise one (2026-10-22
// decision 4: server lifecycle = "connect only"; lifecycle hosting is left
// to the desktop app and the dsh-plugin practice, per ADR-0009).
package dev.repotory.jetbrains

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

class RepotoryConfigurable : Configurable {
    private var serverUrlField: JBTextField? = null
    private var statusLabel: JBLabel? = null

    override fun getDisplayName(): String = "Repotory"

    override fun createComponent(): JComponent {
        val url = JBTextField(RepotorySettings.serverUrl(), 32)
        serverUrlField = url
        val status = JBLabel(" ")
        statusLabel = status

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
                        "Restart it with --web-dist, or use the desktop app."
            }
        }

        return FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Server address:"), url, 1, false)
            .addComponent(test)
            .addComponent(status)
            .addComponentFillVertically(JPanel(), 0)
            .panel
    }

    override fun isModified(): Boolean =
        serverUrlField?.text?.trim() != RepotorySettings.serverUrl()

    override fun apply() {
        RepotorySettings.setServerUrl(serverUrlField?.text?.trim().orEmpty())
    }

    override fun reset() {
        serverUrlField?.text = RepotorySettings.serverUrl()
        statusLabel?.text = " "
    }

    override fun disposeUIResources() {
        serverUrlField = null
        statusLabel = null
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
    private const val KEY = "repotory.serverUrl"

    fun serverUrl(): String =
        com.intellij.openapi.application.ApplicationManager.getApplication()
            .getService(RepotorySettingsState::class.java)
            .serverUrl?.takeIf { it.isNotBlank() } ?: RepotoryClient.DEFAULT_SERVER_URL

    fun setServerUrl(value: String) {
        com.intellij.openapi.application.ApplicationManager.getApplication()
            .getService(RepotorySettingsState::class.java)
            .serverUrl = value.ifBlank { RepotoryClient.DEFAULT_SERVER_URL }
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
}
