// Knowledge-search tool window for the Repotory plugin.
//
// ADR-0027 decision 2①: notes + wiki pages, searched through the shared
// service layer. The plugin does NOT reimplement ranking, gating or snippet
// extraction — it renders what `SearchAll` returns.
//
// ADR-0027 decision 2②: a result opens the Repotory SPA in the system
// browser, deep-linked to that result. The plugin does not embed the SPA:
// one rendering of the knowledge UI, the desktop app's.
package dev.repotory.jetbrains

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import java.awt.BorderLayout
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JTextField
import javax.swing.ListSelectionModel
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

class RepotoryToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = RepotoryPanel()
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }
}

/**
 * The tool window body: a search box, a result list, and an "open in browser"
 * action.
 *
 * The search runs on a background thread — the HTTP call can take up to the
 * client's read timeout, and doing that on the EDT would freeze the IDE.
 *
 * It is a JPanel (the tool window needs a Swing component) that ALSO
 * implements Disposable, so the content can be torn down with it.
 */
class RepotoryPanel : JPanel(), com.intellij.openapi.Disposable {
    private val model = DefaultListModel<RepotoryHit>()
    private val input = JTextField()
    private val list = JList(model)
    private val openButton = JButton("Open in Repotory")
    private var disposed = false

    init {
        // JPanel ships with a FlowLayout; BorderLayout has to replace it
        // before the three regions are added, and removeAll() clears the
        // default layout manager's single placeholder component.
        removeAll()
        layout = BorderLayout(0, 6)

        input.toolTipText = "Search notes and wiki pages"
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

        add(input, BorderLayout.NORTH)
        add(JBScrollPane(list), BorderLayout.CENTER)
        add(openButton, BorderLayout.SOUTH)
    }

    private fun scheduleSearch() {
        val query = input.text?.trim().orEmpty()
        if (query.isEmpty()) {
            model.clear()
            openButton.isEnabled = false
            return
        }
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            val hits = repotoryClient.search(RepotorySettings.serverUrl(), query)
            if (disposed) return@executeOnPooledThread
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                if (disposed) return@invokeLater
                model.clear()
                hits.forEach { model.addElement(it) }
                openButton.isEnabled = !hits.isEmpty()
            }
        }
    }

    private fun openSelected() {
        val hit = list.selectedValue ?: return
        val url = repotoryClient.deepLink(RepotorySettings.serverUrl(), hit)
        BrowserUtil.browse(url)
    }

    override fun dispose() {
        disposed = true
    }
}

/** Renders one hit: the title, then the kind and a trimmed snippet. */
private class HitRenderer : javax.swing.DefaultListCellRenderer() {
    override fun getListCellRendererComponent(
        list: javax.swing.JList<*>?,
        value: Any?,
        index: Int,
        selected: Boolean,
        focused: Boolean,
    ): java.awt.Component {
        val component = super.getListCellRendererComponent(list, value, index, selected, focused)
        if (component is SimpleColoredComponent && value is RepotoryHit) {
            component.clear()
            component.append(value.title.ifBlank { "(untitled)" }, SimpleTextAttributes.REGULAR_ATTRIBUTES)
            component.append("  ${value.type}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            if (value.snippet.isNotBlank()) {
                component.append("  ${value.snippet.take(120)}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
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
