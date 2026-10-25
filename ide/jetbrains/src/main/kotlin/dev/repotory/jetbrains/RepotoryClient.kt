// Repotory for JetBrains — thin client over the Repotory headless service.
//
// ADR-0027 (Accepted 2026-10-22): the plugin is a THIN SHELL. Everything it
// shows comes from the shared service layer over the loopback HTTP API
// (`/api/rpc`); the plugin holds no retrieval logic of its own. That is the
// whole point of the thin-client discipline (ADR-0009, ADR-0017): the desktop
// app, the VS Code extension and this plugin must not drift apart, because
// none of them owns the search implementation.
//
// MVP scope (ADR-0027 decision 2):
//   ① knowledge-search tool window — notes + todos, via SearchAll
//   ② result jump — open the Repotory SPA in the system browser, deep-linked
//   ③ settings page — server address + a health check
//
// Explicitly NOT in the MVP (per the 2026-10-22 decisions): session capture.
// Server lifecycle: connect to a running instance, or start a LOCAL one with
// one click (2026-10-22 usability revision of decision 4); this plugin never
// manages a remote server and never auto-downloads anything.
package dev.repotory.jetbrains

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets

private const val LOG = "dev.repotory.jetbrains"

/** One search result, as the plugin needs it: what it is and where it lives. */
data class RepotoryHit(
    val type: String,
    val id: Long,
    val projectId: Long,
    val title: String,
    val snippet: String,
    /** The SPA route this hit opens, e.g. "/project/12?noteId=345". */
    val route: String,
)

/**
 * What a search produced.
 *
 * It is a sealed outcome rather than a plain list because the UI has to tell
 * "nothing matched" from "the search never ran": both used to arrive as an
 * empty list, so an unreachable service rendered exactly like a clean miss —
 * the failure that teaches users to distrust a working query.
 */
sealed interface SearchOutcome {
    /** Hits, possibly empty (an empty list is a real "nothing matched"). */
    data class Hits(val hits: List<RepotoryHit>) : SearchOutcome

    /**
     * The search could not be carried out; [message] says why, for the UI.
     * [offline] marks a transport failure (nothing answered at the address),
     * which is the one case where offering "start the local service" makes
     * sense; a 4xx/5xx from a live server is not something a restart fixes.
     */
    data class Failure(val message: String, val offline: Boolean = false) : SearchOutcome
}

/** Raised when an RPC call yields no payload; the message is user-presentable. */
class RepotoryRpcException(message: String) : Exception(message)

/**
 * One note's full content, as the reader pane needs it.
 *
 * A search hit carries only the matched excerpt (SearchHit.snippet); the
 * detail pane expands a hit into the note itself, which is what the
 * GetNote binding returns. `kind` and `pinned` ride along because the
 * editor round-trips them: a draft that lost the kind would silently
 * re-file a knowledge note as "other" on the next save, and one that lost
 * `pinned` would unpin it — data loss disguised as a metadata default.
 */
data class NoteDetail(
    val id: Long,
    val title: String,
    val body: String,
    val updatedAt: String,
    val tags: String,
    val kind: String = "",
    val projectId: Long = 0,
    val pinned: Boolean = false,
)

/** One project as the editor's project dropdown needs it. */
data class ProjectOption(val id: Long, val name: String)

/**
 * The AI tidying proposal for one note (internal/service/note_organize.go).
 * A PROPOSAL, never a write: the editor opens with it and the user's save
 * is what lands it. `warning` carries non-fatal caveats (a truncated reply,
 * a model that ignored the output protocol) shown next to the draft.
 */
data class NoteOrganizeResult(
    val noteId: Long,
    val title: String,
    val content: String,
    val tags: String,
    val warning: String = "",
)

/** The editable fields of a note draft, as the editor dialog holds them. */
data class NoteDraft(
    /** 0 = a new note under `projectId`. */
    val id: Long,
    val projectId: Long,
    val title: String,
    val tags: String,
    val kind: String,
    val content: String,
    val pinned: Boolean = false,
)

/**
 * Thin HTTP client for the Repotory headless service.
 *
 * Two endpoints only:
 *   GET  /health    — liveness (the settings page "test connection" button)
 *   POST /api/rpc   — the generic binding bridge, the SAME one the web
 *                      frontend and the VS Code extension use
 *
 * The service is loopback-only by design, so the address is a loopback URL and
 * no authentication is involved. The timeouts are deliberately short: the
 * plugin must never hang the IDE's UI thread on a service that is not running.
 */
@Service(Service.Level.APP)
class RepotoryClient {
    companion object {
        const val DEFAULT_SERVER_URL = "http://127.0.0.1:18765"
        private const val CONNECT_TIMEOUT_MS = 1500
        private const val READ_TIMEOUT_MS = 4000
        // The AI tidy call is the one RPC that legitimately takes minutes
        // (the service allows the model up to five), so it opts into a long
        // read timeout. Every other call keeps the short one: the plugin
        // must never hang the IDE on a service that is not answering.
        private const val READ_TIMEOUT_AI_MS = 330_000
        private val GSON = Gson()
    }

    /** Health probe. True when the service answers /health with 200. */
    fun ping(serverUrl: String): Boolean = try {
        val conn = open(serverUrl, "/health", "GET")
        val code = try {
            conn.responseCode
        } finally {
            conn.disconnect()
        }
        code == 200
    } catch (e: Exception) {
        Logger.getInstance(LOG).debug("repotory ping failed: ${e.message}")
        false
    }

    /**
     * True when the running server also serves the Repotory web UI, i.e. it was
     * started with `--web-dist` (see cmd/server/main.go: without it the process
     * is API-only and every non-/api path 404s).
     *
     * Results deep-link into that UI, so a plain API-only server answers the API
     * but turns every "Open in Repotory" click into a 404. The plugin starts its
     * own local server with the sibling `web/` directory when the release bundle
     * ships one (see RepotoryServer.kt); for a server the user started, the
     * plugin asks this question and says the answer out loud.
     */
    fun servesWebUi(serverUrl: String): Boolean = try {
        val conn = open(serverUrl, "/", "GET")
        try {
            // The SPA root is index.html (serveIndex in cmd/server/main.go). A
            // 404 from the API mux, or any non-HTML answer, means no web UI here.
            conn.responseCode == 200 && (conn.contentType ?: "").contains("text/html", ignoreCase = true)
        } finally {
            conn.disconnect()
        }
    } catch (e: Exception) {
        Logger.getInstance(LOG).debug("repotory web-ui probe failed: ${e.message}")
        false
    }

    /**
     * Searches notes AND todos in one call.
     *
     * `SearchAll` is the binding the web frontend's knowledge search uses
     * (web/src/api/endpoints.ts), so the plugin inherits exactly the ranking
     * the desktop app serves — FTS5 bm25 with a LIKE fallback
     * (internal/db/search.go) — and reimplements none of it (ADR-0027
     * decision 2①). Its scope is notes + todos: wiki pages are not reachable
     * through this binding, and the plugin does not pretend they are.
     *
     * Returns [SearchOutcome], never a bare list: a transport failure and an
     * empty result set must stay distinguishable all the way to the UI.
     */
    fun search(serverUrl: String, query: String): SearchOutcome {
        if (query.isBlank()) return SearchOutcome.Hits(emptyList())
        return try {
            val result = rpc(serverUrl, "SearchAll", listOf(query))
            val array = result as? JsonArray
                ?: return SearchOutcome.Failure("Repotory returned an unexpected SearchAll payload")
            SearchOutcome.Hits(array.mapNotNull { parseHit(it) })
        } catch (e: RepotoryRpcException) {
            SearchOutcome.Failure(e.message ?: "SearchAll failed")
        } catch (e: Exception) {
            // IOException and friends: the service is not running, or not answering.
            SearchOutcome.Failure(
                "Cannot reach ${serverUrl.trimEnd('/')} — ${e.message ?: e.javaClass.simpleName}",
                offline = true,
            )
        }
    }

    /**
     * Calls one binding over the generic JSON-RPC bridge.
     *
     * The bridge is the same one the desktop Wails app is bound to, so the
     * plugin can reach ANY binding without a hand-written REST route per
     * method — and without the plugin growing its own API surface.
     *
     * Throws [RepotoryRpcException] when the call produced no payload: a
     * non-200 status, an `error` envelope, or a body that is not an object.
     * Returning null instead would make every failure indistinguishable from a
     * successful call that legitimately carries no result — the caller could
     * not tell "the server said no" from "the server said nothing".
     */
    @Throws(RepotoryRpcException::class)
    fun rpc(serverUrl: String, method: String, args: List<Any?>): Any? =
        rpc(serverUrl, method, args, READ_TIMEOUT_MS)

    /**
     * Calls one binding over the generic JSON-RPC bridge, with an explicit
     * read timeout for calls that legitimately take minutes (the AI tidy).
     *
     * The bridge is the same one the desktop Wails app is bound to, so the
     * plugin can reach ANY binding without a hand-written REST route per
     * method — and without the plugin growing its own API surface.
     *
     * Throws [RepotoryRpcException] when the call produced no payload: a
     * non-200 status, an `error` envelope, or a body that is not an object.
     * Returning null instead would make every failure indistinguishable from a
     * successful call that legitimately carries no result — the caller could
     * not tell "the server said no" from "the server said nothing".
     */
    @Throws(RepotoryRpcException::class)
    fun rpc(serverUrl: String, method: String, args: List<Any?>, readTimeoutMs: Int): Any? {
        val payload = JsonObject()
        payload.addProperty("method", method)
        val arr = JsonArray()
        args.forEach { arr.add(GSON.toJsonTree(it)) }
        payload.add("args", arr)

        val conn = open(serverUrl, "/api/rpc", "POST", readTimeoutMs)
        try {
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.outputStream.use { it.write(payload.toString().toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            if (code != 200) {
                // Failures come back as 4xx/5xx with an {"error":…} body
                // (internal/httpapi/rpc.go); read it so the UI can say what
                // went wrong instead of only that something did.
                val detail = conn.errorStream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
                val reason = try {
                    JsonParser.parseString(detail).asJsonObject.get("error")?.takeIf { it.isJsonPrimitive }?.asString
                } catch (e: Exception) {
                    if (detail.isBlank()) null else detail.trim().take(200)
                }
                Logger.getInstance(LOG).warn("repotory rpc $method -> HTTP $code ${reason ?: ""}")
                throw RepotoryRpcException(
                    "Repotory answered HTTP $code for $method" + (if (reason.isNullOrBlank()) "" else ": $reason"),
                )
            }
            val body = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).readText()
            val envelope = JsonParser.parseString(body)
            if (!envelope.isJsonObject) {
                throw RepotoryRpcException("Repotory returned a non-object response for $method")
            }
            val obj = envelope.asJsonObject
            if (obj.has("error") && !obj.get("error").isJsonNull) {
                val reason = obj.get("error").toString()
                Logger.getInstance(LOG).warn("repotory rpc $method -> $reason")
                throw RepotoryRpcException("Repotory refused $method: $reason")
            }
            return if (obj.has("result")) obj.get("result") else null
        } finally {
            conn.disconnect()
        }
    }

    /** The SPA URL a hit opens in the browser. */
    fun deepLink(serverUrl: String, hit: RepotoryHit): String {
        val base = serverUrl.trimEnd('/')
        return "$base${hit.route}"
    }

    /**
     * Reads one note by ID over the RPC bridge (the GetNote binding).
     *
     * Returns null when the note does not exist or the call fails: the
     * caller falls back to the matched excerpt, because a pane that shows
     * nothing is worse than one that shows the excerpt and says so.
     * Todos have no note row — their excerpt IS the whole item the search
     * contract returns.
     */
    fun note(serverUrl: String, id: Long): NoteDetail? {
        return try {
            val result = rpc(serverUrl, "GetNote", listOf(id)) as? JsonObject ?: return null
            NoteDetail(
                id = result.get("id")?.takeIf { it.isJsonPrimitive }?.asLong ?: id,
                title = result.get("title")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
                body = result.get("content")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
                updatedAt = result.get("updated_at")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
                tags = result.get("tags")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
                kind = result.get("kind")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
                projectId = result.get("project_id")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0,
                pinned = result.get("pinned")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
            )
        } catch (e: RepotoryRpcException) {
            Logger.getInstance(LOG).debug("repotory GetNote($id) failed: ${e.message}")
            null
        } catch (e: Exception) {
            Logger.getInstance(LOG).debug("repotory GetNote($id) failed", e)
            null
        }
    }

    // ------------------------------------------------------------- writes
    //
    // The maintenance actions of the reader. All of them are human-pressed
    // button paths over the same RPC bridge the reads use — the plugin holds
    // no write logic of its own, exactly as it holds no search logic.

    /** The project list for the editor's project dropdown. */
    fun projects(serverUrl: String): List<ProjectOption> {
        return try {
            val result = rpc(serverUrl, "GetProjects", listOf("", false)) as? JsonArray ?: return emptyList()
            result.mapNotNull { el ->
                if (!el.isJsonObject) return@mapNotNull null
                val obj = el.asJsonObject
                val id = obj.get("id")?.takeIf { it.isJsonPrimitive }?.asLong ?: return@mapNotNull null
                val name = obj.get("name")?.takeIf { it.isJsonPrimitive }?.asString ?: "project $id"
                ProjectOption(id, name)
            }
        } catch (e: Exception) {
            Logger.getInstance(LOG).debug("repotory GetProjects failed: ${e.message}")
            emptyList()
        }
    }

    /**
     * Runs the AI tidy over one note and returns the PROPOSAL.
     *
     * The service writes nothing; the caller opens the editor with the
     * result and the user's save lands it. Throws [RepotoryRpcException]
     * with a user-presentable message (including the "configure the endpoint
     * in Settings → AI" case) so the pane can say why it did not run.
     */
    @Throws(RepotoryRpcException::class)
    fun organizeNote(serverUrl: String, id: Long): NoteOrganizeResult {
        val result = rpc(serverUrl, "OrganizeNote", listOf(id), READ_TIMEOUT_AI_MS) as? JsonObject
            ?: throw RepotoryRpcException("整理失败：服务未返回提案")
        val content = result.get("content")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty()
        if (content.isBlank()) {
            throw RepotoryRpcException("整理失败：提案为空")
        }
        return NoteOrganizeResult(
            noteId = result.get("note_id")?.takeIf { it.isJsonPrimitive }?.asLong ?: id,
            title = result.get("title")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
            content = content,
            tags = result.get("tags")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
            warning = result.get("warning")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
        )
    }

    /** Saves one existing note's content and metadata in a single call. */
    @Throws(RepotoryRpcException::class)
    fun updateNote(serverUrl: String, draft: NoteDraft) {
        rpc(
            serverUrl,
            "UpdateNoteFull",
            listOf(draft.id, draft.content, draft.title, draft.tags, draft.kind, draft.pinned),
        )
    }

    /** Creates a note under a project and returns it as stored. */
    @Throws(RepotoryRpcException::class)
    fun createNote(serverUrl: String, draft: NoteDraft): NoteDetail {
        val result = rpc(
            serverUrl,
            "CreateNoteWithMeta",
            listOf(draft.projectId, draft.title, draft.content, draft.tags, draft.kind, "jetbrains"),
        ) as? JsonObject ?: throw RepotoryRpcException("创建失败：服务未返回新笔记")
        return NoteDetail(
            id = result.get("id")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0,
            title = result.get("title")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
            body = result.get("content")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
            updatedAt = result.get("updated_at")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
            tags = result.get("tags")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
            kind = result.get("kind")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
            projectId = result.get("project_id")?.takeIf { it.isJsonPrimitive }?.asLong ?: draft.projectId,
            pinned = result.get("pinned")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
        )
    }

    /** Re-files a note under a different project (the project change). */
    @Throws(RepotoryRpcException::class)
    fun moveNote(serverUrl: String, noteId: Long, projectId: Long) {
        rpc(serverUrl, "MoveNote", listOf(noteId, projectId))
    }

    private fun parseHit(raw: Any?): RepotoryHit? {
        if (raw !is com.google.gson.JsonElement || !raw.isJsonObject) return null
        val obj = raw.asJsonObject
        val type = obj.get("type")?.takeIf { it.isJsonPrimitive }?.asString ?: return null
        val id = obj.get("id")?.takeIf { it.isJsonPrimitive }?.asLong ?: return null
        val projectId = obj.get("project_id")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0
        val title = obj.get("title")?.takeIf { it.isJsonPrimitive }?.asString ?: ""
        val snippet = obj.get("snippet")?.takeIf { it.isJsonPrimitive }?.asString ?: ""
        // The SPA routes (web/src/App.tsx): a note opens the project page on
        // the notes tab with ?noteId= (ProjectDetail reads `noteId`, not
        // `note`); a todo opens the project's todo tab. The route vocabulary
        // belongs to the frontend, so it is read from the frontend's contract
        // rather than invented here.
        val route = when (type) {
            "note" -> "/project/$projectId?noteId=$id"
            "todo" -> "/project/$projectId?tab=todos"
            else -> "/project/$projectId"
        }
        return RepotoryHit(type, id, projectId, title, snippet, route)
    }

    private fun open(serverUrl: String, path: String, method: String, readTimeoutMs: Int = READ_TIMEOUT_MS): HttpURLConnection {
        // URI.create, not URL(String): the latter is deprecated in Java 20+,
        // and URI is what URL.toURI() would hand back anyway.
        val url = URI.create(serverUrl.trimEnd('/') + path).toURL()
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = readTimeoutMs
        // The service is loopback-only; redirects elsewhere would be a bug, not
        // a feature. Following them blindly would let a hostile local process
        // bounce the plugin's request elsewhere.
        conn.instanceFollowRedirects = false
        return conn
    }
}

/** Convenience accessor for the application-level client. */
val repotoryClient: RepotoryClient
    get() = service()
