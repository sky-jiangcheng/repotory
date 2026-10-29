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
// Layout (2026-10-23 revision) — a T-shape, same reader the VS Code
// extension ships:
//
//   ┌───────────────────────────────────────────────────┐
//   │ brand header: mark · wordmark · tagline · local-only│  ← identity & promo
//   ├────────────────────────┬──────────────────────────┤
//   │ search box             │ detail pane (HTML)       │
//   │ thumbnail list         │ first hit selected by    │
//   │ (kind · title · excerpt)│ default, full body      │
//   ├────────────────────────┴──────────────────────────┤
//   │ status line (wraps, full width — its own row)     │
//   │ Edit · New · AI Tidy · Copy · Open … (own row)     │
//   └───────────────────────────────────────────────────┘
//
// The full body of a note is fetched on selection (GetNote over the same
// RPC bridge); todos carry their whole content in the excerpt, and a note
// whose read fails falls back to the excerpt with a label that says so.
//
// The action row is the maintenance surface (2026-10-23): Edit and New open
// the shared NoteEditorDialog, AI Tidy asks the service for a reorganization
// PROPOSAL that opens the SAME dialog — machine-generated wording is never
// saved silently; the user's save is the gate.
//
// Three runtime properties this file is responsible for:
//   · typing debounces (300 ms) and every search carries a sequence number, so
//     a slow early response can never overwrite the results of a later query;
//   · nothing fails silently — a transport error, a 4xx/5xx and an unavailable
//     web UI each become visible text in the panel, never just an empty list;
//   · the EDT never waits on the network: search and note reads run on
//     pooled threads, the pane is repainted from invokeLater.
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
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import com.intellij.openapi.wm.ex.ToolWindowManagerEx
import com.intellij.ui.content.ContentFactory
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.Font
import java.awt.GridLayout
import java.awt.datatransfer.StringSelection
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.image.BufferedImage
import javax.imageio.ImageIO
import javax.swing.BorderFactory
import javax.swing.DefaultListModel
import javax.swing.ImageIcon
import javax.swing.JButton
import javax.swing.JEditorPane
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.JToggleButton
import javax.swing.ListSelectionModel
import javax.swing.Timer
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener
import kotlin.math.ceil

/** Trailing-edge debounce: the query runs 300 ms after the last keystroke. */
private const val DEBOUNCE_MS = 300

/** Fixed width of the thumbnail column; the detail pane takes the rest. */
private val LIST_WIDTH = JBUI.scale(280)

/** The brand surfaces are FIXED, not themed: the cream card and ink type are the mark. */
private val BRAND_FIELD = Color(0xF5, 0xF0, 0xE4)
private val BRAND_INK = Color(0x1B, 0x1B, 0x1B)
private val BRAND_INK_SOFT = Color(0x55, 0x55, 0x55)
private val BRAND_INK_FAINT = Color(0x6A, 0x6A, 0x6A)

/** Kind badge colours, paired light/dark so they follow the IDE theme. */
private val BADGE_NOTE = JBColor(Color(0x1D, 0x4E, 0xD8), Color(0x60, 0xA5, 0xFA))
private val BADGE_TODO = JBColor(Color(0x8B, 0x6F, 0x3A), Color(0xD9, 0xB7, 0x73))
private val BADGE_WIKI = JBColor(Color(0x6F, 0x42, 0xC1), Color(0xD2, 0xA8, 0xFF))

/**
 * The knowledge spaces the reader searches.
 *
 * Notes/todos and wiki pages have INDEPENDENT id sequences, so the two are
 * never mixed in one result list: a row saying "12" would be ambiguous, and
 * the deep link would open the wrong thing. One space on screen at a time.
 */
private enum class Source(val label: String, val hint: String) {
    NOTES("Notes & todos", "Search notes and todos"),
    WIKI("Wiki pages", "Search the approved knowledge pages"),
}

class RepotoryToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = RepotoryPanel()
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }
}

class RepotoryPanel : JPanel(), Disposable {
    private val model = DefaultListModel<RepotoryHit>()
    private val input = JTextField()
    private val list = JList(model)
    private val detail = JEditorPane()
    private val status = StatusField()
    private val editButton = JButton("Edit")
    private val newButton = JButton("New note")
    private val organizeButton = JButton("AI Tidy")
    private val openButton = JButton("Open in Repotory")
    private val copyButton = JButton("Copy")
    private val startButton = JButton("Start service")
    private val sourceNotes = JToggleButton(Source.NOTES.label)
    private val sourceWiki = JToggleButton(Source.WIKI.label)
    private var source = Source.NOTES
    private var disposed = false

    /**
     * Bumped for every search that is started or invalidated. A response whose
     * sequence number no longer matches is stale and is dropped: without it, a
     * slow "dep" response could land after a fast "deploy hook" one and repaint
     * the list with older results.
     */
    private var searchSeq = 0

    /** Same guard for the detail pane: a slow note read must not overwrite a newer selection. */
    private var detailSeq = 0

    /** Keystrokes restart this timer; only the last one survives to fire. */
    private val debounce = Timer(DEBOUNCE_MS) { runSearch() }

    init {
        // JPanel ships with a FlowLayout; BorderLayout has to replace it
        // before the regions are added, and removeAll() clears the
        // default layout manager's single placeholder component.
        removeAll()
        layout = java.awt.BorderLayout(0, 0)
        debounce.isRepeats = false

        add(brandHeader(), java.awt.BorderLayout.NORTH)
        add(readerBody(), java.awt.BorderLayout.CENTER)
        add(statusBar(), java.awt.BorderLayout.SOUTH)
    }

    // ------------------------------------------------------------- brand header

    /**
     * The top band: the mark, the wordmark, the one-line pitch and the
     * local-only chip. Fixed cream field in both themes — it is a printed
     * card, not a themed surface, which is what makes the window feel like
     * a product rather than a panel.
     */
    private fun brandHeader(): JPanel {
        val header = JPanel(java.awt.BorderLayout(JBUI.scale(12), 0))
        header.background = BRAND_FIELD
        header.border = JBUI.Borders.empty(10, 12)

        val mark = markLabel(JBUI.scale(44))
        val text = JPanel(GridLayout(0, 1))
        text.isOpaque = false
        val name = JLabel("Repotory")
        name.font = name.font.deriveFont(Font.BOLD, JBUI.scale(15f))
        name.foreground = BRAND_INK
        val tagline = ElidingLabel("The local-first memory layer for AI coding agents")
        tagline.font = tagline.font.deriveFont(JBUI.scale(11f))
        tagline.foreground = BRAND_INK_SOFT
        text.add(name)
        text.add(tagline)

        val chip = JLabel("local-only")
        chip.font = chip.font.deriveFont(JBUI.scale(10f))
        chip.foreground = BRAND_INK_FAINT
        chip.border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(BRAND_INK, 1),
            JBUI.Borders.empty(2, 6),
        )

        if (mark != null) header.add(mark, java.awt.BorderLayout.WEST)
        header.add(text, java.awt.BorderLayout.CENTER)
        header.add(chip, java.awt.BorderLayout.EAST)
        return header
    }

    /** The brand mark as an ImageIcon, scaled from the bundled PNG (Swing has no SVG). */
    private fun markLabel(size: Int): JLabel? {
        val stream = javaClass.getResourceAsStream("/icons/repotory-mark.png") ?: return null
        val image: BufferedImage = ImageIO.read(stream) ?: return null
        val scaled = image.getScaledInstance(size, size, java.awt.Image.SCALE_SMOOTH)
        return JLabel(ImageIcon(scaled))
    }

    // ------------------------------------------------------------- reader body

    /** Left: source switch + search box + thumbnails. Right: the expanded knowledge. */
    private fun readerBody(): JPanel {
        val body = JPanel(java.awt.BorderLayout())

        val left = JPanel(java.awt.BorderLayout(0, 0))
        input.toolTipText = Source.NOTES.hint
        input.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent) = scheduleSearch()
            override fun removeUpdate(e: DocumentEvent) = scheduleSearch()
            override fun changedUpdate(e: DocumentEvent) = scheduleSearch()
        })
        val top = JPanel(java.awt.BorderLayout(0, JBUI.scale(4)))
        top.isOpaque = false
        top.add(sourceRow(), java.awt.BorderLayout.NORTH)
        top.add(input, java.awt.BorderLayout.SOUTH)
        left.add(top, java.awt.BorderLayout.NORTH)

        list.selectionMode = ListSelectionModel.SINGLE_SELECTION
        list.cellRenderer = ThumbRenderer()
        list.fixedCellHeight = JBUI.scale(64)
        list.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) {
                if (e.clickCount == 2) openSelected()
            }
        })
        list.addListSelectionListener { event ->
            if (event.valueIsAdjusting) return@addListSelectionListener
            val has = list.selectedValue != null
            val isNote = list.selectedValue?.type == "note"
            openButton.isEnabled = has
            copyButton.isEnabled = has
            editButton.isEnabled = isNote
            newButton.isEnabled = isNote
            organizeButton.isEnabled = isNote
            showDetail(list.selectedValue)
        }
        left.add(JBScrollPane(list), java.awt.BorderLayout.CENTER)
        left.preferredSize = Dimension(LIST_WIDTH, 0)
        left.minimumSize = Dimension(JBUI.scale(200), 0)

        detail.contentType = "text/html"
        detail.isEditable = false
        detail.editorKit = detailHtmlKit()
        detail.text = promoHtml()
        detail.border = JBUI.Borders.empty(10, 14)

        body.add(left, java.awt.BorderLayout.WEST)
        body.add(JBScrollPane(detail), java.awt.BorderLayout.CENTER)
        return body
    }

    /**
     * The source switch: notes & todos on one side, approved wiki pages on the
     * other.
     *
     * Two toggles rather than one combined list, because the two spaces have
     * independent id sequences — a merged list would make "page 12" ambiguous.
     * The selection is set here rather than through a ButtonGroup so that
     * exactly one of them is lit even when the user clicks the lit one (a
     * toggle would otherwise switch itself off and leave the reader with no
     * source at all).
     */
    private fun sourceRow(): JPanel {
        val row = JPanel(java.awt.GridLayout(1, 2, JBUI.scale(4), 0))
        row.isOpaque = false
        for (button in listOf(sourceNotes, sourceWiki)) {
            button.isOpaque = false
            button.font = button.font.deriveFont(JBUI.scaleFontSize(11f))
        }
        sourceNotes.toolTipText = Source.NOTES.hint
        sourceWiki.toolTipText = Source.WIKI.hint
        sourceNotes.isSelected = true
        sourceWiki.isSelected = false
        sourceNotes.addActionListener { switchSource(Source.NOTES) }
        sourceWiki.addActionListener { switchSource(Source.WIKI) }
        row.add(sourceNotes)
        row.add(sourceWiki)
        return row
    }

    /**
     * Switches the space the reader searches.
     *
     * The rows on screen belong to the other space's id sequence, so they are
     * cleared before the new query runs — leaving them on screen next to a
     * result list of a different kind of thing is how "id 12" becomes
     * ambiguous.
     */
    private fun switchSource(next: Source) {
        sourceNotes.isSelected = next == Source.NOTES
        sourceWiki.isSelected = next == Source.WIKI
        if (source == next) return
        source = next
        model.clear()
        // Both in-flight answers answer the OTHER space: they must not land.
        searchSeq++
        detailSeq++
        detail.text = promoHtml()
        detail.caretPosition = 0
        status.text = " "
        startButton.isVisible = false
        input.toolTipText = next.hint
        val query = input.text?.trim().orEmpty()
        if (query.isNotEmpty()) runSearch()
    }

    // ------------------------------------------------------------- status bar

    private fun statusBar(): JPanel {
        // Stacked, NOT side by side. The message used to sit in the WEST of a
        // BorderLayout and the action buttons in the EAST: a long message
        // ("Cannot reach http://127.0.0.1:18765 — Connection refused — or
        // start the local service.") asked for more width than the whole
        // tool window, so BorderLayout pushed the buttons into negative
        // space and painted them straight over the text. One row for the
        // message, one row for the buttons: they cannot overlap any more.
        val bar = JPanel(java.awt.BorderLayout(0, JBUI.scale(4)))
        bar.border = JBUI.Borders.empty(6, 10)

        openButton.isEnabled = false
        openButton.addActionListener { openSelected() }
        copyButton.isEnabled = false
        copyButton.addActionListener { copySelected() }

        // Maintenance: only meaningful for a note (a todo has no note row to
        // edit), so they stay disabled until one is selected.
        editButton.isEnabled = false
        editButton.addActionListener { editSelected() }
        newButton.isEnabled = false
        newButton.addActionListener { newNoteUnderSelectedProject() }
        organizeButton.isEnabled = false
        organizeButton.toolTipText = "Let the AI restructure this note — review the proposal, then save"
        organizeButton.addActionListener { organizeSelected() }

        // Only offered when a search failed because nothing answered at the
        // configured address. Starting a local server cannot fix a 4xx from a
        // live server, so the button stays out of the way otherwise.
        startButton.isVisible = false
        startButton.toolTipText = "Start the local Repotory service"
        startButton.addActionListener { startLocalService() }

        val buttons = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.RIGHT, JBUI.scale(6), 0))
        buttons.add(startButton)
        buttons.add(editButton)
        buttons.add(newButton)
        buttons.add(organizeButton)
        buttons.add(copyButton)
        buttons.add(openButton)

        bar.add(status, java.awt.BorderLayout.NORTH)
        bar.add(buttons, java.awt.BorderLayout.SOUTH)
        return bar
    }

    /**
     * A label that shortens its text with an ellipsis instead of cutting it.
     *
     * The brand header puts the wordmark and the tagline in the middle of a
     * BorderLayout, so the tagline gets whatever width is left after the
     * mark and the "local-only" chip. In a narrow tool window that is not
     * enough for the full sentence, and a plain JLabel simply draws past its
     * own bounds — the words are chopped mid-word with no sign that
     * something was cut. An ellipsis says "there is more" instead.
     */
    private class ElidingLabel(full: String) : JLabel() {
        private var fullText: String = full

        init {
            text = full
        }

        override fun setSize(w: Int, h: Int) {
            super.setSize(w, h)
            elide()
        }

        private fun elide() {
            if (width <= 0) return
            val metrics = getFontMetrics(font)
            if (metrics.stringWidth(fullText) <= width) {
                if (text != fullText) text = fullText
                return
            }
            var cut = fullText
            while (cut.isNotEmpty() && metrics.stringWidth(cut + "…") > width) {
                cut = cut.dropLast(1)
            }
            val elided = if (cut.isEmpty()) "…" else "$cut…"
            if (text != elided) text = elided
        }
    }

    /**
     * The status line's text field.
     *
     * It was a JLabel: a label cannot wrap, so a long message was either
     * clipped or — worse — claimed the whole width of a BorderLayout row
     * and pushed the buttons off the panel. This field wraps instead, and
     * it grows to fit the text it holds.
     *
     * JTextArea does not size itself to its content, so the row count is
     * derived from the text and the current width, and recomputed whenever
     * the panel is resized (a narrower tool window wraps into more lines).
     */
    private class StatusField : JTextArea() {
        init {
            isEditable = false
            isOpaque = false
            isFocusable = false
            lineWrap = true
            wrapStyleWord = true
            border = JBUI.Borders.empty(0)
            // The panel's other text is JLabel text; the default JTextArea
            // font would be the editor font (monospace) and look foreign.
            font = JBLabel().font
            rows = 1
            addComponentListener(object : ComponentAdapter() {
                override fun componentResized(e: ComponentEvent) {
                    fit()
                }
            })
        }

        override fun setText(t: String?) {
            super.setText(t)
            fit()
        }

        /** Rows the wrapped text needs at the width this field currently has. */
        private fun fit() {
            val needed = rowsFor(text)
            if (needed != rows) rows = needed
        }

        private fun rowsFor(value: String): Int {
            if (value.isBlank()) return 1
            // ~6px per character at the label font. Before the first layout
            // the width is still zero, so a scaled guess stands in.
            val usable = if (width > 0) width else JBUI.scale(280)
            val perLine = maxOf(16, usable / 6)
            return ceil(value.length.toDouble() / perLine).toInt().coerceIn(1, 8)
        }
    }

    // ------------------------------------------------------------- search

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
        // Captured before the request goes out: the answer belongs to the
        // space it was asked for, and a switch in between must not relabel it.
        val space = source
        status.text = "Searching \"$query\"…"
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val outcome = if (space == Source.WIKI) {
                repotoryClient.searchWiki(serverUrl, query)
            } else {
                repotoryClient.search(serverUrl, query)
            }
            app.invokeLater {
                // A newer keystroke (or a cleared box) supersedes this response.
                if (disposed || seq != searchSeq) return@invokeLater
                when (outcome) {
                    is SearchOutcome.Hits -> {
                        model.clear()
                        outcome.hits.forEach { model.addElement(it) }
                        // Default selection: the first hit, so the detail pane
                        // is never empty while results are on screen.
                        if (outcome.hits.isNotEmpty()) list.selectedIndex = 0
                        startButton.isVisible = false
                        status.text = if (outcome.hits.isEmpty()) {
                            "No matches for \"$query\""
                        } else {
                            "${outcome.hits.size} result(s) for \"$query\""
                        }
                    }
                    is SearchOutcome.Failure -> {
                        model.clear()
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

    // ------------------------------------------------------------- detail pane

    /**
     * Expands the selected hit. Notes get their full body over GetNote;
     * wiki pages over GetWikiPage; todos (and failed reads) show the matched
     * excerpt, labelled.
     *
     * The pane shows the excerpt immediately — a reader that blanks out
     * while the note loads reads as a bug — and swaps in the full body when
     * it arrives. detailSeq drops a read that a newer selection overtook.
     */
    private fun showDetail(hit: RepotoryHit?) {
        val seq = ++detailSeq
        if (hit == null) {
            detail.text = promoHtml()
            detail.caretPosition = 0
            return
        }
        detail.text = loadingHtml(hit)
        detail.caretPosition = 0
        if (hit.type == "wiki") {
            // An approved page: the body plus the graph around it (ADR-0032).
            val serverUrl = RepotorySettings.serverUrl()
            val app = ApplicationManager.getApplication()
            app.executeOnPooledThread {
                val page = repotoryClient.wikiPage(serverUrl, hit.id)
                app.invokeLater {
                    if (disposed || seq != detailSeq) return@invokeLater
                    detail.text = if (page != null) wikiPageHtml(page) else excerptHtml(hit, full = true)
                    detail.caretPosition = 0
                }
            }
            return
        }
        if (hit.type != "note") {
            detail.text = excerptHtml(hit)
            return
        }
        val serverUrl = RepotorySettings.serverUrl()
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val note = repotoryClient.note(serverUrl, hit.id)
            app.invokeLater {
                if (disposed || seq != detailSeq) return@invokeLater
                detail.text = if (note != null) noteHtml(note) else excerptHtml(hit, full = true)
                detail.caretPosition = 0
            }
        }
    }

    // ------------------------------------------------------------- actions

    private fun copySelected() {
        val hit = list.selectedValue ?: return
        val serverUrl = RepotorySettings.serverUrl()
        val app = ApplicationManager.getApplication()
        // The full body is one loopback call away, but the EDT must not wait
        // for it: copy on a pooled thread, then report on the EDT.
        app.executeOnPooledThread {
            val body = when (hit.type) {
                "note" -> repotoryClient.note(serverUrl, hit.id)?.body
                "wiki" -> repotoryClient.wikiPage(serverUrl, hit.id)?.content
                else -> null
            }
            val text = buildString {
                appendLine(hit.title.ifBlank { "(untitled)" })
                appendLine()
                append(body ?: hit.snippet)
            }
            app.invokeLater {
                if (disposed) return@invokeLater
                CopyPasteManager.getInstance().setContents(StringSelection(text))
                status.text = "Copied to clipboard"
            }
        }
    }

    // ------------------------------------------------------- maintenance

    /**
     * Edit the selected note. The hit is re-read (it carries only the
     * excerpt), the shared editor dialog opens, and an OK saves fields first
     * and the project change second — a failed move must not lose the
     * edit the user just made.
     */
    private fun editSelected() {
        val hit = list.selectedValue?.takeIf { it.type == "note" } ?: return
        val serverUrl = RepotorySettings.serverUrl()
        status.text = "Loading note #${hit.id}…"
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val note = repotoryClient.note(serverUrl, hit.id)
            val projects = repotoryClient.projects(serverUrl)
            app.invokeLater {
                if (disposed) return@invokeLater
                if (note == null) {
                    status.text = "Note #${hit.id} could not be read — nothing to edit"
                    return@invokeLater
                }
                openEditor(
                    NoteDraft(
                        id = note.id,
                        projectId = note.projectId,
                        title = note.title,
                        tags = note.tags,
                        kind = note.kind.ifBlank { "knowledge" },
                        content = note.body,
                        pinned = note.pinned,
                    ),
                    projects, proposal = false, warning = "",
                )
            }
        }
    }

    /** New note under the SAME project as the selected note. */
    private fun newNoteUnderSelectedProject() {
        val hit = list.selectedValue?.takeIf { it.type == "note" } ?: return
        val serverUrl = RepotorySettings.serverUrl()
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val projects = repotoryClient.projects(serverUrl)
            app.invokeLater {
                if (disposed) return@invokeLater
                openEditor(
                    NoteDraft(id = 0, projectId = hit.projectId, title = "", tags = "", kind = "knowledge", content = ""),
                    projects, proposal = false, warning = "",
                )
            }
        }
    }

    /**
     * AI tidy: ask the service for a reorganization PROPOSAL and open the
     * SAME editor with it. Nothing is written by the service; the user's save
     * is the gate. The stored note is re-read so kind and pinned carry into
     * the draft (the proposal covers title/tags/content only).
     */
    private fun organizeSelected() {
        val hit = list.selectedValue?.takeIf { it.type == "note" } ?: return
        val serverUrl = RepotorySettings.serverUrl()
        organizeButton.isEnabled = false
        status.text = "AI tidying note #${hit.id}… (this can take a while)"
        val app = ApplicationManager.getApplication()
        val reportFailure = { message: String ->
            app.invokeLater {
                if (disposed) return@invokeLater
                organizeButton.isEnabled = true
                status.text = message
            }
        }
        app.executeOnPooledThread {
            val proposal = try {
                repotoryClient.organizeNote(serverUrl, hit.id)
            } catch (e: RepotoryRpcException) {
                reportFailure(e.message ?: "整理失败")
                return@executeOnPooledThread
            } catch (e: Exception) {
                reportFailure("整理失败：${e.message ?: e.javaClass.simpleName}")
                return@executeOnPooledThread
            }
            val note = repotoryClient.note(serverUrl, hit.id)
            val projects = repotoryClient.projects(serverUrl)
            app.invokeLater {
                if (disposed) return@invokeLater
                organizeButton.isEnabled = true
                openEditor(
                    NoteDraft(
                        id = if (proposal.noteId > 0) proposal.noteId else hit.id,
                        projectId = note?.projectId ?: hit.projectId,
                        title = proposal.title,
                        tags = proposal.tags,
                        kind = note?.kind?.ifBlank { "knowledge" } ?: "knowledge",
                        content = proposal.content,
                        pinned = note?.pinned ?: false,
                    ),
                    projects, proposal = true, warning = proposal.warning,
                )
            }
        }
    }

    /** Opens the shared editor; an OK saves through [saveDraft]. */
    private fun openEditor(
        original: NoteDraft,
        projects: List<ProjectOption>,
        proposal: Boolean,
        warning: String,
    ) {
        val dialog = NoteEditorDialog(null, original, projects, proposal, warning)
        if (!dialog.showAndGet()) {
            status.text = "Edit cancelled — nothing saved"
            return
        }
        saveDraft(original, dialog.editedDraft())
    }

    /**
     * Persists an edited draft: UpdateNoteFull, then MoveNote when the project
     * changed. The detail pane is repainted from the freshly stored note, so
     * what is on screen is what is in the database.
     */
    private fun saveDraft(original: NoteDraft, edited: NoteDraft) {
        val serverUrl = RepotorySettings.serverUrl()
        status.text = if (edited.id == 0L) "Creating note…" else "Saving note #${edited.id}…"
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            if (edited.id == 0L) {
                val created = try {
                    repotoryClient.createNote(serverUrl, edited)
                } catch (e: Exception) {
                    app.invokeLater {
                        if (disposed) return@invokeLater
                        status.text = "Create failed: ${e.message ?: e.javaClass.simpleName}"
                    }
                    return@executeOnPooledThread
                }
                app.invokeLater {
                    if (disposed) return@invokeLater
                    // The new note is not in the current result list; show it
                    // in full so the user sees exactly what was stored.
                    status.text = "Created note #${created.id}"
                    detail.text = noteHtml(created)
                    detail.caretPosition = 0
                }
                return@executeOnPooledThread
            }
            try {
                repotoryClient.updateNote(serverUrl, edited)
            } catch (e: Exception) {
                app.invokeLater {
                    if (disposed) return@invokeLater
                    status.text = "Save failed: ${e.message ?: e.javaClass.simpleName}"
                }
                return@executeOnPooledThread
            }
            val moveError = if (original.projectId != 0L && edited.projectId != original.projectId) {
                try {
                    repotoryClient.moveNote(serverUrl, edited.id, edited.projectId)
                    null
                } catch (e: Exception) {
                    e.message ?: e.javaClass.simpleName
                }
            } else {
                null
            }
            val fresh = repotoryClient.note(serverUrl, edited.id)
            app.invokeLater {
                if (disposed) return@invokeLater
                status.text = moveError?.let { "Fields saved, but the project move failed: $it" }
                    ?: "Saved note #${edited.id}"
                if (fresh != null) {
                    detail.text = noteHtml(fresh)
                    detail.caretPosition = 0
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
     * `--web-dist` (cmd/server/main.go); without it every non-/api path is
     * a 404 and the deep link goes nowhere. A server the plugin started carries
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
 * One thumbnail: kind badge, title, matched excerpt.
 *
 * A JPanel (not a JLabel) so the badge and the title sit on one row with
 * different colours; opaque, because a transparent renderer shows the
 * list's own stripes through the card. Selection colours come from the
 * JList, so the row follows the IDE theme.
 */
private class ThumbRenderer : JPanel(java.awt.BorderLayout(JBUI.scale(6), 0)), javax.swing.ListCellRenderer<RepotoryHit> {
    private val badge = JLabel()
    private val title = JLabel()
    private val snippet = JLabel()

    init {
        isOpaque = true
        border = JBUI.Borders.empty(8, 10)
        val row = JPanel(java.awt.BorderLayout(JBUI.scale(6), 0))
        row.isOpaque = false
        badge.font = badge.font.deriveFont(JBUI.scale(9f))
        badge.border = JBUI.Borders.empty(1, 4)
        row.add(badge, java.awt.BorderLayout.WEST)
        title.font = title.font.deriveFont(Font.BOLD, JBUI.scale(12f))
        row.add(title, java.awt.BorderLayout.CENTER)
        add(row, java.awt.BorderLayout.NORTH)
        snippet.font = snippet.font.deriveFont(JBUI.scale(11f))
        add(snippet, java.awt.BorderLayout.CENTER)
    }

    override fun getListCellRendererComponent(
        list: javax.swing.JList<out RepotoryHit>?,
        value: RepotoryHit?,
        index: Int,
        isSelected: Boolean,
        cellHasFocus: Boolean,
    ): Component {
        val hit = value
        if (hit == null) {
            title.text = ""
            return this
        }
        badge.text = badgeLabel(hit).uppercase()
        badge.foreground = when (hit.type) {
            "todo" -> BADGE_TODO
            "wiki" -> BADGE_WIKI
            else -> BADGE_NOTE
        }
        badge.border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(badge.foreground, 1),
            JBUI.Borders.empty(1, 4),
        )
        title.text = hit.title.ifBlank { "(untitled)" }
        title.toolTipText = hit.title
        snippet.text = if (hit.snippet.isBlank()) " " else excerptOf(hit.snippet, 110)
        snippet.toolTipText = hit.snippet

        if (isSelected) {
            background = list?.selectionBackground
            foreground = list?.selectionForeground
            title.foreground = list?.selectionForeground
            snippet.foreground = list?.selectionForeground
        } else {
            background = list?.background
            foreground = list?.foreground
            title.foreground = list?.foreground
            snippet.foreground = JBColor(Color(0x6A, 0x6A, 0x6A), Color(0x94, 0x94, 0x94))
        }
        return this
    }

    /** Two lines' worth of excerpt at the column's width; the tooltip carries the rest. */
    private fun excerptOf(text: String, max: Int): String {
        val flat = text.replace(Regex("\\s+"), " ").trim()
        return if (flat.length <= max) flat else flat.take(max - 1) + "…"
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
        val toolWindow = ToolWindowManagerEx
            .getInstanceEx(project)
            .getToolWindow("Repotory") ?: return
        toolWindow.activate(null)
    }
}
