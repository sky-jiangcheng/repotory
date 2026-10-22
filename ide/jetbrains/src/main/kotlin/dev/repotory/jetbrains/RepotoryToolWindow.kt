// Knowledge-search tool window for the Repotory plugin.
//
// ADR-0027 decision 2①: notes + todos, searched through the shared
// service layer. The plugin does NOT reimplement ranking, gating or snippet
// extraction — it renders what `SearchAll` returns.
//
// ADR-0027 decision 2②: a result opens the Repotory SPA in the system
// browser, deep-linked to that result. The plugin does not embed the SPA:
// one rendering of the knowledge UI, the desktop app's.
//
// Two runtime properties this file is responsible for:
//   · typing debounces (300 ms) and every search carries a sequence number, so
//     a slow early response can never overwrite the results of a later query;
//   · nothing fails silently — a transport error, a 4xx/5xx and an unavailable
//     web UI each become visible text in the panel, never just an empty list.
package dev.repotory.jetbrains

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import java.awt.datatransfer.StringSelection
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JTextField
import javax.swing.ListSelectionModel
import javax.swing.Timer
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/** Trailing-edge debounce: the query runs 300 ms after the last keystroke. */
private const val DEBOUNCE_MS = 300

class RepotoryToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = RepotoryPanel()
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }
}

/**
 * The tool window body: a search box, a result list, a status line and an
 * "open in browser" action.
 *
 * The search runs on a background thread — the HTTP call can take up to the
 * client's read timeout, and doing that on the EDT would freeze the IDE.
 *
 * It is a JPanel (the tool window needs a Swing component) that ALSO
 * implements Disposable, so the content can be torn down with it.
 */
class RepotoryPanel : JPanel(), Disposable {
    private val model = DefaultListModel<RepotoryHit>()
    private val input = JTextField()
    private val list = JList(model)
    private val status = JBLabel(" ")
    private val openButton = JButton("Open in Repotory")
    private val startButton = JButton("Start local service")
    private var disposed = false

    /**
     * Bumped for every search that is started or invalidated. A response whose
     * sequence number no longer matches is stale and is dropped: without it, a
     * slow "dep" response could land after a fast "deploy hook" one and repaint
     * the list with older results.
     */
    private var searchSeq = 0

    /** Keystrokes restart this timer; only the last one survives to fire. */
    private val debounce = Timer(DEBOUNCE_MS) { runSearch() }

    init {
        // JPanel ships with a FlowLayout; BorderLayout has to replace it
        // before the regions are added, and removeAll() clears the
        // default layout manager's single placeholder component.
        removeAll()
        layout = BorderLayout(0, 6)
        debounce.isRepeats = false

        input.toolTipText = "Search notes and todos"
        input.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent) = scheduleSearch()
            override fun removeUpdate(e: DocumentEvent) = scheduleSearch()
            override fun changedUpdate(e: DocumentEvent) = scheduleSearch()
        })

        list.selectionMode = ListSelectionModel.SINGLE_SELECTION
        list.cellRenderer = HitRenderer()
        list.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) {
                if (e.clickCount == 2) openSelected()
            }
        })

        openButton.isEnabled = false
        openButton.addActionListener { openSelected() }
        list.addListSelectionListener { openButton.isEnabled = list.selectedIndex >= 0 }

        // Only offered when a search failed because nothing answered at the
        // configured address. Starting a local server cannot fix a 4xx from a
        // live server, so the button stays out of the way otherwise.
        startButton.isVisible = false
        startButton.addActionListener { startLocalService() }

        val buttons = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.RIGHT, 6, 0))
        buttons.add(startButton)
        buttons.add(openButton)

        val south = JPanel(BorderLayout(0, 4))
        south.add(status, BorderLayout.NORTH)
        south.add(buttons, BorderLayout.SOUTH)

        add(input, BorderLayout.NORTH)
        add(JBScrollPane(list), BorderLayout.CENTER)
        add(south, BorderLayout.SOUTH)
    }

    private fun scheduleSearch() {
        if (disposed) return
        val query = input.text?.trim().orEmpty()
        if (query.isEmpty()) {
            debounce.stop()
            // Invalidate any in-flight response: it answers a query the user
            // has already erased, and repainting the list with it would look
            // like a bug.
            searchSeq++
            model.clear()
            openButton.isEnabled = false
            startButton.isVisible = false
            status.text = " "
            return
        }
        status.text = "Typing…"
        debounce.restart()
    }

    private fun runSearch() {
        if (disposed) return
        val query = input.text?.trim().orEmpty()
        if (query.isEmpty()) return
        val seq = ++searchSeq
        val serverUrl = RepotorySettings.serverUrl()
        status.text = "Searching \"$query\"…"
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val outcome = repotoryClient.search(serverUrl, query)
            app.invokeLater {
                // A newer keystroke (or a cleared box) supersedes this response.
                if (disposed || seq != searchSeq) return@invokeLater
                when (outcome) {
                    is SearchOutcome.Hits -> {
                        model.clear()
                        outcome.hits.forEach { model.addElement(it) }
                        openButton.isEnabled = outcome.hits.isNotEmpty()
                        startButton.isVisible = false
                        status.text = if (outcome.hits.isEmpty()) {
                            "No matches for \"$query\""
                        } else {
                            "${outcome.hits.size} result(s) for \"$query\""
                        }
                    }
                    is SearchOutcome.Failure -> {
                        model.clear()
                        openButton.isEnabled = false
                        // One click to fix the most common first-run state:
                        // the plugin is installed but no service is running.
                        startButton.isVisible = outcome.offline
                        status.text = if (outcome.offline) {
                            "${outcome.message} — or start the local service."
                        } else {
                            outcome.message
                        }
                    }
                }
            }
        }
    }

    /**
     * Starts the local Repotory service and retries the query.
     *
     * The spawn waits on the binary and on /health, so it runs on a pooled
     * thread; the EDT only gets the outcome. Nothing is downloaded: when no
     * binary exists, the user is offered the file picker or the release page.
     */
    private fun startLocalService() {
        if (disposed) return
        startButton.isVisible = false
        startButton.isEnabled = false
        status.text = "Starting local service…"
        val serverUrl = RepotorySettings.serverUrl()
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val outcome = repotoryServer.start(serverUrl)
            app.invokeLater {
                if (disposed) return@invokeLater
                startButton.isEnabled = true
                when (outcome) {
                    is StartOutcome.Started -> {
                        status.text = if (outcome.webUi) {
                            "Started ${outcome.binary.file.name} on port ${outcome.port}. Searching again…"
                        } else {
                            "Started on port ${outcome.port} (API-only). Searching again…"
                        }
                        runSearch()
                    }
                    StartOutcome.AlreadyRunning -> {
                        status.text = "Service already running. Searching again…"
                        runSearch()
                    }
                    is StartOutcome.BinaryMissing -> {
                        if (offerServerBinaryHelp(outcome.searched)) {
                            startLocalService()
                        } else {
                            startButton.isVisible = true
                        }
                    }
                    is StartOutcome.Failed -> {
                        status.text = outcome.message
                        startButton.isVisible = true
                    }
                }
            }
        }
    }

    private fun openSelected() {
        val hit = list.selectedValue ?: return
        val serverUrl = RepotorySettings.serverUrl()
        val url = repotoryClient.deepLink(serverUrl, hit)
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            // Asked before every jump rather than cached: the answer is cheap
            // (one loopback GET) and it changes the moment the user restarts
            // the server with --web-dist.
            val servesUi = repotoryClient.servesWebUi(serverUrl)
            app.invokeLater {
                if (disposed) return@invokeLater
                if (servesUi) {
                    status.text = "Opened $url"
                    BrowserUtil.browse(url)
                } else {
                    status.text = "Repotory is running API-only — this link would land on a 404"
                    offerFallback(url)
                }
            }
        }
    }

    /**
     * The headless server serves its web UI only when it was started with
     * `--web-dist` (cmd/server/main.go); without it every non-/api path is a
     * 404 and the deep link goes nowhere. A server the plugin started carries
     * its sibling `web/` automatically (RepotoryServer.kt); for one the user
     * started by hand, the plugin cannot add the flag — but it can stop the
     * user from landing on a bare 404 with no explanation.
     */
    private fun offerFallback(url: String) {
        val choice = Messages.showDialog(
            "Repotory answered, but it is not serving its web UI, so this link lands on a 404 page.\n\n" +
                "Either restart the running server with:\n" +
                "  repotory-server --port 18765 --web-dist <release bundle>/web\n" +
                "or stop it and press \"Start local service\", which launches the release bundle " +
                "together with its web/ directory.\n\n" +
                "URL: $url",
            "Repotory: web UI not available",
            arrayOf("Open Anyway", "Copy URL", "Cancel"),
            2,
            Messages.getWarningIcon(),
        )
        when (choice) {
            0 -> BrowserUtil.browse(url)
            1 -> {
                CopyPasteManager.getInstance().setContents(StringSelection(url))
                status.text = "URL copied to clipboard"
            }
            else -> status.text = "Cancelled — the link would have 404ed"
        }
    }

    override fun dispose() {
        disposed = true
        debounce.stop()
    }
}

/**
 * SearchAll returns the snippet as highlighted HTML (`…<mark>sqlite</mark>…`);
 * the web UI renders it as HTML after DOMPurify. This panel is a plain JLabel,
 * so the tags would otherwise show up literally. Strip them and decode the
 * entities the server escaped, keeping the matched words in place.
 *
 * `&amp;` is decoded last: doing it first would turn `&amp;lt;` into `&lt;`
 * and then into `<`, i.e. invent a tag the server never sent.
 */
private fun plainSnippet(raw: String): String =
    raw.replace(Regex("<[^>]*>"), "")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")

/**
 * Renders one hit on a single line: the title, then the kind and a trimmed
 * snippet.
 *
 * DefaultListCellRenderer hands back an ordinary JLabel (never a
 * SimpleColoredComponent), so the body sets that label's text directly. Kotlin
 * data-class output ("RepotoryHit(type=note, id=345, …)") would otherwise leak
 * into the list.
 */
private class HitRenderer : javax.swing.DefaultListCellRenderer() {
    override fun getListCellRendererComponent(
        list: javax.swing.JList<*>?,
        value: Any?,
        index: Int,
        selected: Boolean,
        focused: Boolean,
    ): java.awt.Component {
        val component = super.getListCellRendererComponent(list, value, index, selected, focused)
        if (component is javax.swing.JLabel && value is RepotoryHit) {
            val line = StringBuilder(value.title.ifBlank { "(untitled)" })
            if (value.type.isNotBlank()) line.append("  ·  ").append(value.type)
            if (value.snippet.isNotBlank()) line.append("  ·  ").append(plainSnippet(value.snippet).take(120))
            component.text = line.toString()
            component.toolTipText = line.toString()
        }
        return component
    }
}

/** "Open in Repotory" as a toolbar action, so the tool window has a title bar button. */
class OpenRepotoryAction : AnAction(), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val toolWindow = com.intellij.openapi.wm.ex.ToolWindowManagerEx
            .getInstanceEx(project)
            .getToolWindow("Repotory") ?: return
        toolWindow.activate(null)
    }
}