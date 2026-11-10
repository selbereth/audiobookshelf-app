package com.audiobookshelf.app.debug

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import com.audiobookshelf.app.BuildConfig
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.zip.GZIPOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Persistent app log files (abs-YYYY-MM-DD.log), in debug and release builds, switched by a setting ("Enable debug logs").
 *
 * Lines come from `logcat --pid=<own pid>` (every Log.* line of the app, the Capacitor console of the UI web view, the
 * [core] and Pebble hub lines), plus direct writes: the process-start header with ApplicationExitInfo of the previous
 * processes, uncaught exceptions, onTrimMemory and the console of the UI web view in release (see [console]).
 *
 * Storage: getExternalFilesDir(null)/logs, or filesDir/logs when external storage is not available.
 * Keeps 7 days, gzips finished days, 150 MB total cap (never the last 24 h), 40 MB per day. Rules: [DebugLogRules].
 *
 * The setting is a SharedPreferences flag read at process start (default: on in debug, off in release).
 */
object DebugLog {
  private const val TAG = "DebugLog"
  private const val PREFS = "debug_log"
  private const val KEY_ENABLED = "enabled"
  private const val EXIT_MARKER = ".last-exit-ts"
  private const val TICK_MS = 5000L
  private const val MAX_BACKOFF_MS = 60_000L
  private const val EXIT_RECORDS = 16

  private val lock = Any()
  private var logDirectory: File? = null  // guarded by lock
  private var writer: DailyWriter? = null  // guarded by lock
  private var collapser = DebugLogRules.RepeatCollapser()  // guarded by lock
  @Volatile private var running = false
  @Volatile private var generation = 0
  @Volatile private var logcat: java.lang.Process? = null
  @Volatile private var initialized = false

  data class Stats(val enabled: Boolean, val days: Int, val bytes: Long)

  /** Where the files are: app-specific external dir if available, else internal filesDir. */
  fun logDir(context: Context): File {
    val base = context.getExternalFilesDir(null) ?: context.filesDir
    return File(base, "logs").apply { mkdirs() }
  }

  fun isEnabled(context: Context): Boolean =
    try {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, BuildConfig.DEBUG)
    } catch (e: Exception) {
      BuildConfig.DEBUG
    }

  /** Called from DebugApplication.onCreate: installs the crash handler and starts logging when the setting is on. */
  fun init(application: Application) {
    if (initialized) return
    initialized = true
    synchronized(lock) { logDirectory = logDir(application) }
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, e ->
      try {
        val sw = StringWriter()
        e.printStackTrace(PrintWriter(sw))
        writeDirect(listOf("FATAL uncaught exception on thread '${thread.name}' at ${timeNow()}") + sw.toString().lines())
      } catch (_: Throwable) {
        // never block the crash itself
      }
      previous?.uncaughtException(thread, e)
    }
    if (isEnabled(application)) start(application, "process start")
  }

  /** The settings switch. Takes effect now: no restart needed. Files already written stay until retention deletes them. */
  fun setEnabled(context: Context, on: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, on).apply()
    if (on) start(context.applicationContext, "enabled in settings") else stop()
  }

  /** The Log line of the activity manager's memory trim levels (from DebugApplication.onTrimMemory). */
  fun trimMemory(level: Int) {
    if (running) Log.i(TAG, "onTrimMemory level=$level")
  }

  /** Console message of the UI web view. In debug builds Capacitor already logs it to logcat, so only release writes it. */
  fun console(message: String, source: String, line: Int) {
    if (BuildConfig.DEBUG || !running) return
    val text = message.replace('\n', ' ')
    val formatted = "${timestamp()} ${Process.myPid()} 0 I Capacitor/Console: $text ($source:$line)"
    synchronized(lock) {
      if (running) appendLocked(collapser.offer(DebugLogRules.redact(formatted)))
    }
  }

  private fun start(context: Context, reason: String) {
    val dir: File
    val gen: Int
    synchronized(lock) {
      if (running) return
      running = true
      generation++
      gen = generation
      dir = logDirectory ?: logDir(context).also { logDirectory = it }
    }
    Thread({
      try {
        writeDirect(header(context, dir, reason))
      } catch (e: Exception) {
        Log.w(TAG, "header failed: ${e.message}")
      }
      logcatLoop(dir, gen)
    }, "DebugLog-logcat").apply { isDaemon = true }.start()
    Thread({ timerLoop(dir, gen) }, "DebugLog-timer").apply { isDaemon = true }.start()
  }

  private fun stop() {
    synchronized(lock) {
      appendLocked(collapser.flush())
      running = false
      generation++
      writer?.close()
      writer = null
    }
    logcat?.destroy()
  }

  private fun isCurrent(gen: Int) = running && gen == generation

  // ---- Lines in --------------------------------------------------------------------------------------------------------

  /**
   * Reads `logcat --pid=<own pid>`. If logcat exits, it is started again after a backoff (1 s doubling to 60 s), and it
   * resumes from the last line written (-T), so no line is lost in between.
   */
  private fun logcatLoop(dir: File, gen: Int) {
    var backoff = 1000L
    var last: String? = null
    while (isCurrent(gen)) {
      val startedAt = System.currentTimeMillis()
      try {
        val cmd = mutableListOf("logcat", "-v", "threadtime", "--pid=${Process.myPid()}")
        val lastTs = last?.let { DebugLogRules.timestampOf(it) }.orEmpty()
        if (lastTs.isNotEmpty()) cmd += listOf("-T", lastTs)
        val process = ProcessBuilder(cmd).redirectErrorStream(true).start()
        logcat = process
        BufferedReader(InputStreamReader(process.inputStream, Charsets.UTF_8)).use { reader ->
          var resuming = last != null
          while (isCurrent(gen)) {
            val line = reader.readLine() ?: break
            if (resuming) {
              // logcat -T repeats the lines from the last timestamp on: skip them until the last one written
              val ts = DebugLogRules.timestampOf(line)
              if (line == last || ts <= lastTs) continue
              resuming = false
            }
            last = line
            backoff = 1000L
            synchronized(lock) {
              if (isCurrent(gen)) appendLocked(collapser.offer(DebugLogRules.redact(line)))
            }
          }
        }
        process.destroy()
      } catch (e: Exception) {
        writeDirect(listOf("${timestamp()} logcat failed: ${e.message}"), gen)
      }
      if (!isCurrent(gen)) break
      val ranLong = System.currentTimeMillis() - startedAt > 30_000L
      if (ranLong) backoff = 1000L
      writeDirect(listOf("${timestamp()} logcat ended, restarting in $backoff ms"), gen)
      try {
        Thread.sleep(backoff)
      } catch (_: InterruptedException) {
      }
      backoff = minOf(backoff * 2, MAX_BACKOFF_MS)
    }
  }

  /** Every few seconds: writes the summary of collapsed repeats, and once a day the retention pass. */
  private fun timerLoop(dir: File, gen: Int) {
    var maintainedFor: String? = null
    while (isCurrent(gen)) {
      try {
        Thread.sleep(TICK_MS)
      } catch (_: InterruptedException) {
      }
      if (!isCurrent(gen)) break
      synchronized(lock) {
        if (isCurrent(gen)) appendLocked(collapser.flush())
      }
      val today = todayYmd()
      if (maintainedFor != today) {
        try {
          maintain(dir, today)
          maintainedFor = today
        } catch (e: Exception) {
          writeDirect(listOf("${timestamp()} retention failed: ${e.message}"), gen)
        }
      }
    }
  }

  // ---- Writing ---------------------------------------------------------------------------------------------------------

  /** Direct lines (header, crash, notes). Not collapsed, written in order after pending repeats. */
  private fun writeDirect(lines: List<String>, gen: Int? = null) {
    synchronized(lock) {
      if (!running || (gen != null && gen != generation)) return
      appendLocked(collapser.flush())
      appendLocked(lines.map { DebugLogRules.redact(it) })
    }
  }

  /** Guarded by lock. Appends to today's file. */
  private fun appendLocked(lines: List<String>) {
    if (lines.isEmpty()) return
    val dir = logDirectory ?: return
    val w = writer ?: DailyWriter(dir).also { writer = it }
    w.append(lines, todayYmd())
  }

  /** Appends lines to the day's file; stops after [DebugLogRules.DAY_CAP_BYTES] with one "log cap reached" line. */
  private class DailyWriter(private val dir: File) {
    private var day: String? = null
    private var out: OutputStream? = null
    private var bytes = 0L
    private var capped = false

    fun append(lines: List<String>, today: String) {
      try {
        if (today != day || out == null) open(today)
        val stream = out ?: return
        for (line in lines) {
          if (capped) break
          val data = (line + "\n").toByteArray(Charsets.UTF_8)
          if (bytes + data.size > DebugLogRules.DAY_CAP_BYTES) {
            capped = true
            val note = (DebugLogRules.CAP_LINE + "\n").toByteArray(Charsets.UTF_8)
            stream.write(note)
            bytes += note.size
            break
          }
          stream.write(data)
          bytes += data.size
        }
        stream.flush()
      } catch (e: Exception) {
        // A failed write must not crash the app: drop the stream, the next call opens it again
        close()
        Log.w(TAG, "write failed: ${e.message}")
      }
    }

    private fun open(today: String) {
      close()
      val file = File(dir, DebugLogRules.dailyFileName(today))
      bytes = if (file.exists()) file.length() else 0L
      capped = bytes >= DebugLogRules.DAY_CAP_BYTES
      day = today
      out = BufferedOutputStream(FileOutputStream(file, true))
    }

    fun close() {
      try {
        out?.close()
      } catch (_: Exception) {
      }
      out = null
      day = null
    }
  }

  // ---- Header and exits ------------------------------------------------------------------------------------------------

  private fun header(context: Context, dir: File, reason: String): List<String> {
    val lines = mutableListOf(
      "===== process start ${timeNow()} ($reason) =====",
      "app=${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) git=${BuildConfig.GIT_HASH} debugBuild=${BuildConfig.DEBUG}",
      "device=${Build.MANUFACTURER} ${Build.MODEL} android=${Build.VERSION.RELEASE} sdk=${Build.VERSION.SDK_INT} pid=${Process.myPid()}"
    )
    lines += exitLines(context, dir)
    return lines
  }

  /** ApplicationExitInfo (Android 11+) of the earlier processes, each one written once (marker file in the log dir). */
  private fun exitLines(context: Context, dir: File): List<String> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return listOf("previous process exits: not available before Android 11")
    val am = context.getSystemService(ActivityManager::class.java) ?: return listOf("previous process exits: no ActivityManager")
    val marker = File(dir, EXIT_MARKER)
    val seen = try {
      marker.readText().trim().toLong()
    } catch (e: Exception) {
      0L
    }
    val exits = am.getHistoricalProcessExitReasons(context.packageName, 0, EXIT_RECORDS).sortedBy { it.timestamp }
    val fresh = exits.filter { it.timestamp > seen }
    if (fresh.isNotEmpty()) marker.writeText(fresh.last().timestamp.toString())
    return listOf("previous process exits (ApplicationExitInfo): ${fresh.size} new") +
      fresh.map { e ->
        "  ${formatMs(e.timestamp)} reason=${reasonName(e.reason)} importance=${e.importance} status=${e.status} " +
          "pid=${e.pid} process=${e.processName} desc=${e.description}"
      }
  }

  private fun reasonName(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_ANR -> "ANR"
    ApplicationExitInfo.REASON_CRASH -> "CRASH"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
    ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
    ApplicationExitInfo.REASON_FREEZER -> "FREEZER"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
    ApplicationExitInfo.REASON_OTHER -> "OTHER"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
    ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
    ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
    else -> "UNKNOWN($reason)"
  }

  // ---- Retention -------------------------------------------------------------------------------------------------------

  /** Deletes old days, gzips finished days, applies the total cap. Under lock, so no line is written to a file being packed. */
  private fun maintain(dir: File, today: String) {
    synchronized(lock) {
      writer?.close()
      writer = null
      dir.listFiles()?.filter { it.name.endsWith(".gz.tmp") }?.forEach { it.delete() }
      DebugLogRules.planAge(listFiles(dir), today).forEach { File(dir, it).delete() }
      listFiles(dir).map { it.name }.filter { DebugLogRules.shouldGzip(it, today) }.forEach { gzip(dir, it) }
      DebugLogRules.planCap(listFiles(dir), today, System.currentTimeMillis()).forEach { File(dir, it).delete() }
    }
  }

  private fun listFiles(dir: File): List<DebugLogRules.LogFile> =
    dir.listFiles()
      ?.filter { DebugLogRules.ymdFromName(it.name) != null }
      ?.map { DebugLogRules.LogFile(it.name, it.length(), it.lastModified()) }
      ?: emptyList()

  private fun gzip(dir: File, name: String) {
    val src = File(dir, name)
    val tmp = File(dir, "$name.gz.tmp")
    val target = File(dir, "$name.gz")
    try {
      GZIPOutputStream(BufferedOutputStream(FileOutputStream(tmp))).use { gz ->
        BufferedInputStream(src.inputStream()).use { it.copyTo(gz) }
      }
      if (tmp.renameTo(target)) src.delete() else tmp.delete()
    } catch (e: Exception) {
      tmp.delete()
      Log.w(TAG, "gzip $name failed: ${e.message}")
    }
  }

  // ---- For the settings page and the debug receiver --------------------------------------------------------------------

  fun stats(context: Context): Stats {
    val files = listFiles(logDir(context))
    val days = files.mapNotNull { DebugLogRules.ymdFromName(it.name) }.distinct().size
    return Stats(isEnabled(context), days, files.sumOf { it.sizeBytes })
  }

  /** Zips the daily files into the cache dir (only that folder is shared through the FileProvider). Null when there are none. */
  fun buildShareZip(context: Context): File? {
    val dir = logDir(context)
    synchronized(lock) {
      val names = listFiles(dir).map { it.name }.sorted()
      if (names.isEmpty()) return null
      val outDir = File(context.cacheDir, SHARE_DIR).apply { mkdirs() }
      outDir.listFiles()?.forEach { it.delete() }
      val zip = File(outDir, "abs-debug-logs-${todayYmd()}-${System.currentTimeMillis() % 100000}.zip")
      ZipOutputStream(BufferedOutputStream(FileOutputStream(zip))).use { z ->
        for (name in names) {
          z.putNextEntry(ZipEntry(name))
          BufferedInputStream(File(dir, name).inputStream()).use { it.copyTo(z) }
          z.closeEntry()
        }
      }
      return zip
    }
  }

  const val SHARE_DIR = "debug-logs"

  /** The debug receiver's "logs" action: the directory, each file, the total. Tag DebugLog. */
  fun describe(context: Context) {
    val dir = logDir(context)
    val files = listFiles(dir).sortedBy { it.name }
    Log.i(TAG, "log dir: ${dir.absolutePath} enabled=${isEnabled(context)} running=$running")
    files.forEach { Log.i(TAG, "  ${it.name} ${it.sizeBytes} bytes ${formatMs(dir.resolve(it.name).lastModified())}") }
    Log.i(TAG, "total: ${files.size} files, ${files.sumOf { it.sizeBytes }} bytes (cap ${DebugLogRules.TOTAL_CAP_BYTES} bytes)")
  }

  // ---- Helpers ---------------------------------------------------------------------------------------------------------

  private fun todayYmd(): String {
    val c = Calendar.getInstance()
    return DebugLogRules.ymdOf(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
  }

  private fun timestamp(): String = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US).format(Date())

  private fun timeNow(): String = formatMs(System.currentTimeMillis())

  private fun formatMs(ms: Long): String = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date(ms))
}
