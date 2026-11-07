package com.audiobookshelf.app.core

import android.os.Looper
import com.audiobookshelf.app.models.DownloadItemPart
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/**
 * Asks the core for the download decisions of Phase 8 slice 1 (utils/core/modules/downloads.js: the part step, the retry and
 * auth counts, the free-space check). Used only while CoreSwitch.coreDownload is on. Native applies the answer; it does not decide.
 *
 * The call blocks the calling thread until the core answers or the timeout passes, so it must never run on the main thread
 * (the callers are the download watcher and the transfer threads). A null result means no answer: the caller then runs its
 * own rule, as before the switch.
 */
object DownloadCore {
  private const val TIMEOUT_MS = 3000L

  data class RetryAnswer(val count: Int, val terminal: Boolean)

  private fun ask(method: String, args: JSONObject): JSONObject? {
    if (Looper.myLooper() == Looper.getMainLooper()) return null // never block the main thread
    val latch = CountDownLatch(1)
    val answer = AtomicReference<JSONObject?>(null)
    CoreHost.callUp("downloads", method, args, TIMEOUT_MS) { ok, json ->
      if (ok) answer.set(try { JSONObject(json) } catch (e: Exception) { null })
      latch.countDown()
    }
    latch.await(TIMEOUT_MS + 2000L, TimeUnit.MILLISECONDS)
    return answer.get()
  }

  /** `downloads.partStep`: the action for one active part (wait, stalled, failed, finalizeInternal, moveSaf, gone) */
  fun partStep(part: DownloadItemPart, hasItem: Boolean): String? {
    val args =
            JSONObject()
                    .put("nowMs", System.currentTimeMillis())
                    .put("lastUpdateMs", part.lastUpdateTime ?: JSONObject.NULL)
                    .put("hasItem", hasItem)
                    .put("completed", part.completed)
                    .put("failed", part.failed)
                    .put("isInternal", part.isInternalStorage)
    return ask("partStep", args)?.optString("action", "")?.takeIf { it.isNotEmpty() }
  }

  /** `downloads.retryOutcome`: the new count and whether the part is now terminal. kind is "transfer" or "auth" */
  fun retry(kind: String, count: Int): RetryAnswer? {
    val answer = ask("retryOutcome", JSONObject().put("kind", kind).put("count", count)) ?: return null
    if (!answer.has("count") || !answer.has("terminal")) return null
    return RetryAnswer(answer.getInt("count"), answer.getBoolean("terminal"))
  }

  /** `downloads.hasSpace`: null when the core did not answer */
  fun hasSpace(availableBytes: Long, totalBytes: Long): Boolean? =
          ask("hasSpace", JSONObject().put("availableBytes", availableBytes).put("totalBytes", totalBytes))
                  ?.takeIf { it.has("ok") }
                  ?.getBoolean("ok")
}
