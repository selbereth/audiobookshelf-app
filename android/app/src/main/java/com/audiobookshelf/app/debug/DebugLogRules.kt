package com.audiobookshelf.app.debug

/**
 * Pure rules for the debug log files: redaction, repeat collapsing, file names, retention and gzip choice.
 * No Android imports, so these run as JVM unit tests (android/app/src/test).
 */
object DebugLogRules {
  /** Files older than this many days (by file date) are deleted. A file of day today-7 is kept. */
  const val KEEP_DAYS = 7L
  const val TOTAL_CAP_BYTES = 150L * 1024 * 1024
  const val DAY_CAP_BYTES = 40L * 1024 * 1024
  /** Files written in the last 24 hours are never deleted by the size cap. */
  const val FLOOR_MS = 24L * 60 * 60 * 1000
  /** A line repeated more than this many times in a row is collapsed. */
  const val REPEAT_KEEP = 20
  const val CAP_LINE = "log cap reached: today's file is full (40 MB), further lines of today are not written"

  data class LogFile(val name: String, val sizeBytes: Long, val lastModifiedMs: Long)

  private val DAILY = Regex("""abs-(\d{4})-(\d{2})-(\d{2})\.log(\.gz)?""")

  /** Daily file name for a local date "YYYY-MM-DD". */
  fun dailyFileName(ymd: String): String = "abs-$ymd.log"

  fun ymdOf(year: Int, month1to12: Int, day: Int): String = "%04d-%02d-%02d".format(year, month1to12, day)

  /** "YYYY-MM-DD" of a daily file name (abs-YYYY-MM-DD.log or .log.gz), or null for other names. */
  fun ymdFromName(name: String): String? =
    DAILY.matchEntire(name)?.let { "${it.groupValues[1]}-${it.groupValues[2]}-${it.groupValues[3]}" }

  /** Days since 1970-01-01 of a "YYYY-MM-DD" date (proleptic Gregorian). Works on API 24, where java.time is missing. */
  fun dayNumber(ymd: String): Long {
    val y0 = ymd.substring(0, 4).toLong()
    val m = ymd.substring(5, 7).toLong()
    val d = ymd.substring(8, 10).toLong()
    val y = if (m <= 2) y0 - 1 else y0
    val era = (if (y >= 0) y else y - 399) / 400
    val yoe = y - era * 400
    val mp = (m + 9) % 12
    val doy = (153 * mp + 2) / 5 + d - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
  }

  /** Whole days from [ymd] to [today] (0 = same day). */
  fun ageDays(ymd: String, today: String): Long = dayNumber(today) - dayNumber(ymd)

  /** A finished day (older than today) that is still a plain .log is compressed to .log.gz. */
  fun shouldGzip(name: String, today: String): Boolean {
    val ymd = ymdFromName(name) ?: return false
    return name.endsWith(".log") && ymd < today
  }

  /** Names of daily files older than [KEEP_DAYS] days. */
  fun planAge(files: List<LogFile>, today: String): List<String> =
    files.filter { f -> ymdFromName(f.name)?.let { ageDays(it, today) > KEEP_DAYS } ?: false }.map { it.name }

  /**
   * Names to delete, oldest first, until the daily files fit [capBytes]. Never deletes today's file, nor any file
   * modified in the last 24 hours. If those alone exceed the cap, the total stays above the cap.
   */
  fun planCap(files: List<LogFile>, today: String, nowMs: Long, capBytes: Long = TOTAL_CAP_BYTES): List<String> {
    val daily = files.filter { ymdFromName(it.name) != null }
    var total = daily.sumOf { it.sizeBytes }
    if (total <= capBytes) return emptyList()
    val candidates = daily
      .filter { f -> ymdFromName(f.name)!! != today && f.lastModifiedMs < nowMs - FLOOR_MS }
      .sortedWith(compareBy({ ymdFromName(it.name)!! }, { it.name }))
    val delete = mutableListOf<String>()
    for (f in candidates) {
      if (total <= capBytes) break
      delete.add(f.name)
      total -= f.sizeBytes
    }
    return delete
  }

  // ---- Redaction -------------------------------------------------------------------------------------------------

  private val BEARER = Regex("""(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+""")
  private val AUTHORIZATION = Regex("""(?i)(authorization["']?\s*[:=]\s*["']?)[^\r\n"']*""")
  private val COOKIE = Regex("""(?i)((?:set-)?cookie["']?\s*[:=]\s*["']?)[^\r\n"']*""")
  private val SECRET_KEY = Regex(
    """(?i)((?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|api[_-]?key|client[_-]?secret|secret)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,&;}\]"']+)"""
  )

  /**
   * Replaces the values of secrets with `<redacted>`: Bearer tokens, Authorization and Cookie headers, and
   * `token`, `accessToken`, `refreshToken`, `password`, `api_key` ... as JSON fields, headers or query strings.
   */
  fun redact(line: String): String {
    var out = BEARER.replace(line) { "${it.groupValues[1]}<redacted>" }
    out = AUTHORIZATION.replace(out) { "${it.groupValues[1]}<redacted>" }
    out = COOKIE.replace(out) { "${it.groupValues[1]}<redacted>" }
    out = SECRET_KEY.replace(out) { m ->
      val value = m.groupValues[2]
      val replacement = when (value.firstOrNull()) {
        '"' -> "\"<redacted>\""
        '\'' -> "'<redacted>'"
        else -> "<redacted>"
      }
      m.groupValues[1] + replacement
    }
    return out
  }

  // ---- Repeats -----------------------------------------------------------------------------------------------------

  private val TIMESTAMP = Regex("""^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+""")
  private val PID_TID = Regex("""^\s*\d+\s+\d+\s+""")

  /** The leading "MM-dd HH:mm:ss.SSS" of a threadtime line, or "" when the line has none. */
  fun timestampOf(line: String): String = TIMESTAMP.find(line)?.groupValues?.get(1) ?: ""

  /** A threadtime line without its timestamp, pid and tid: "LEVEL TAG: message". Equal keys are repeats. */
  fun bodyKey(line: String): String = PID_TID.replaceFirst(TIMESTAMP.replaceFirst(line, ""), "")

  /**
   * Collapses identical lines (same [bodyKey]) that repeat in a row. The first [REPEAT_KEEP] repeats are written
   * as they come; further ones are counted and written as one "... repeated N times" line when the run ends, or
   * when [flush] is called (the periodic flush keeps a long run visible). Nothing is dropped without a summary.
   */
  class RepeatCollapser(private val keep: Int = REPEAT_KEEP) {
    private var key: String? = null
    private var run = 0
    private var suppressed = 0
    private var lastLine = ""

    /** Lines to write for [line], in order. */
    fun offer(line: String): List<String> {
      val k = bodyKey(line)
      if (k == key) {
        run++
        lastLine = line
        if (run <= keep) return listOf(line)
        suppressed++
        return emptyList()
      }
      val out = flush().toMutableList()
      key = k
      run = 1
      lastLine = line
      out.add(line)
      return out
    }

    /** The summary of lines suppressed since the last summary, or nothing. */
    fun flush(): List<String> {
      if (suppressed == 0) return emptyList()
      val summary = "${timestampOf(lastLine)} ... repeated $suppressed times".trimStart()
      suppressed = 0
      return listOf(summary)
    }
  }
}
