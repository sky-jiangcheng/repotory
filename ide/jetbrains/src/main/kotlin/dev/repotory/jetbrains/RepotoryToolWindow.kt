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

        val south = JPanel(BorderLayout(0, 4))
        south.add(status, BorderLayout.NORTH)
        south.add(openButton, BorderLayout.SOUTH)

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
                        status.text = if (outcome.hits.isEmpty()) {
                            "No matches for \"$query\""
                        } else {
                            "${outcome.hits.size} result(s) for \"$query\""
                        }
                    }
                    is SearchOutcome.Failure -> {
                        model.clear()
                        openButton.isEnabled = false
                        status.text = outcome.message
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
     * 404 and the deep link goes nowhere. The plugin only CONNECTS to a server
     * (ADR-0027 decision 4), so it cannot fix the deployment — but it can stop
     * the user from landing on a bare 404 with no explanation.
     */
    private fun offerFallback(url: String) {
        val choice = Messages.showDialog(
            "Repotory answered, but it is not serving its web UI, so this link lands on a 404 page.\n\n" +
                "Start the server with the web UI:\n" +
                "  repotory-server --port 18765 --web-dist <path to the built web dist>\n\n" +
                "or open the Repotory desktop app, which serves the same UI.\n\n" +
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
            if (value.snippet.isNotBlank()) line.append("  ·  ").append(value.snippet.take(120))
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