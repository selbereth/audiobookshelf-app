package com.audiobookshelf.app.debug

import com.audiobookshelf.app.debug.DebugLogRules.LogFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugLogRulesTest {
  private val day = 24L * 60 * 60 * 1000
  private val now = 1_800_000_000_000L

  // ---- Redaction ---------------------------------------------------------------------------------------------------

  @Test fun redactsBearerToken() {
    assertEquals("Authorization: <redacted>", DebugLogRules.redact("Authorization: Bearer eyJhbGci.abc-DEF_1"))
    assertEquals("request Bearer <redacted> ok", DebugLogRules.redact("request Bearer abc.def ok"))
  }

  @Test fun redactsJsonFields() {
    assertEquals("""{"accessToken":"<redacted>","user":"x"}""", DebugLogRules.redact("""{"accessToken":"abc123","user":"x"}"""))
    assertEquals("""{"refreshToken": "<redacted>"}""", DebugLogRules.redact("""{"refreshToken": "r-1"}"""))
    assertEquals("""{"api_key": "<redacted>"}""", DebugLogRules.redact("""{"api_key": "k1"}"""))
    assertEquals("""{"password":"<redacted>"}""", DebugLogRules.redact("""{"password":"hunter2"}"""))
  }

  @Test fun redactsQueryStrings() {
    assertEquals("GET /api/items?token=<redacted>&limit=2", DebugLogRules.redact("GET /api/items?token=abc.def&limit=2"))
    assertEquals("x?api_key=<redacted>", DebugLogRules.redact("x?api_key=123"))
  }

  @Test fun redactsPlainPairsAndCookies() {
    assertEquals("login password=<redacted> ok", DebugLogRules.redact("login password=hunter2 ok"))
    assertEquals("Cookie: <redacted>", DebugLogRules.redact("Cookie: session=abc; other=1"))
    assertEquals("Set-Cookie: <redacted>", DebugLogRules.redact("Set-Cookie: sid=9; Path=/"))
  }

  @Test fun leavesOrdinaryLinesAlone() {
    val line = "10-10 12:00:00.000  1234  1234 I Capacitor/Console: [core] ping ok (book The Hobbit)"
    assertEquals(line, DebugLogRules.redact(line))
  }

  // ---- Repeats -----------------------------------------------------------------------------------------------------

  private fun tick(ms: Int, msg: String = "I Tick: sleep 10 s left") =
    "10-10 12:00:%02d.%03d  1234  1234 %s".format(ms / 1000, ms % 1000, msg)

  @Test fun keepsTheFirstTwentyRepeatsAndCountsTheRest() {
    val c = DebugLogRules.RepeatCollapser()
    val written = mutableListOf<String>()
    for (i in 0 until 25) written += c.offer(tick(i * 1000))
    assertEquals(20, written.size)
    written += c.offer("10-10 12:01:00.000  1234  1234 I Other: next")
    assertEquals("10-10 12:00:24.000 ... repeated 5 times", written[20])
    assertEquals("10-10 12:01:00.000  1234  1234 I Other: next", written[21])
    assertEquals(22, written.size)
  }

  @Test fun twentyRepeatsAreNotCollapsed() {
    val c = DebugLogRules.RepeatCollapser()
    val written = mutableListOf<String>()
    for (i in 0 until 20) written += c.offer(tick(i * 1000))
    written += c.offer("10-10 12:01:00.000  1234  1234 I Other: next")
    assertEquals(21, written.size)
    assertTrue(written.none { it.contains("repeated") })
  }

  @Test fun differentMessageBreaksTheRun() {
    val c = DebugLogRules.RepeatCollapser()
    val written = mutableListOf<String>()
    for (i in 0 until 30) written += c.offer(tick(i * 1000, "I Tick: other"))
    written += c.offer(tick(31_000, "I Tick: sleep 10 s left"))
    assertEquals("10-10 12:00:29.000 ... repeated 10 times", written[20])
    assertEquals(tick(31_000, "I Tick: sleep 10 s left"), written.last())
  }

  @Test fun flushWritesThePendingSummaryOnce() {
    val c = DebugLogRules.RepeatCollapser()
    for (i in 0 until 23) c.offer(tick(i * 1000))
    assertEquals(listOf("10-10 12:00:22.000 ... repeated 3 times"), c.flush())
    assertEquals(emptyList<String>(), c.flush())
  }

  @Test fun timestampAndBodyKey() {
    assertEquals("10-10 12:00:01.500", DebugLogRules.timestampOf("10-10 12:00:01.500  1 1 I T: m"))
    assertEquals("", DebugLogRules.timestampOf("no timestamp"))
    assertEquals("I T: m", DebugLogRules.bodyKey("10-10 12:00:01.500  1234  99 I T: m"))
  }

  // ---- File names and day arithmetic --------------------------------------------------------------------------------

  @Test fun dailyNameAndParsing() {
    assertEquals("abs-2026-11-10.log", DebugLogRules.dailyFileName("2026-11-10"))
    assertEquals("2026-11-10", DebugLogRules.ymdFromName("abs-2026-11-10.log"))
    assertEquals("2026-11-10", DebugLogRules.ymdFromName("abs-2026-11-10.log.gz"))
    assertNull(DebugLogRules.ymdFromName("abs-2026-11-10.log.gz.tmp"))
    assertNull(DebugLogRules.ymdFromName(".last-exit-ts"))
    assertEquals("2026-01-05", DebugLogRules.ymdOf(2026, 1, 5))
  }

  @Test fun dayArithmetic() {
    assertEquals(1L, DebugLogRules.dayNumber("1970-01-02"))
    assertEquals(0L, DebugLogRules.dayNumber("1970-01-01"))
    assertEquals(7L, DebugLogRules.ageDays("2026-11-03", "2026-11-10"))
    assertEquals(0L, DebugLogRules.ageDays("2026-02-28", "2026-02-28"))
    assertEquals(365L, DebugLogRules.ageDays("2024-03-01", "2025-03-01"))
    assertEquals(1L, DebugLogRules.ageDays("2026-02-28", "2026-03-01"))
  }

  // ---- Retention ---------------------------------------------------------------------------------------------------

  @Test fun keepsSevenDaysAndDeletesOlder() {
    val files = listOf(
      LogFile("abs-2026-11-03.log", 1, 0), // 7 days old: kept
      LogFile("abs-2026-11-02.log.gz", 1, 0), // 8 days old: deleted
      LogFile("abs-2026-10-01.log.gz", 1, 0),
      LogFile("abs-2026-11-10.log", 1, 0)
    )
    assertEquals(listOf("abs-2026-11-02.log.gz", "abs-2026-10-01.log.gz"), DebugLogRules.planAge(files, "2026-11-10"))
  }

  @Test fun gzipsOnlyFinishedPlainDays() {
    assertTrue(DebugLogRules.shouldGzip("abs-2026-11-09.log", "2026-11-10"))
    assertFalse(DebugLogRules.shouldGzip("abs-2026-11-10.log", "2026-11-10"))
    assertFalse(DebugLogRules.shouldGzip("abs-2026-11-09.log.gz", "2026-11-10"))
    assertFalse(DebugLogRules.shouldGzip(".last-exit-ts", "2026-11-10"))
  }

  @Test fun capDeletesOldestFirst() {
    val mb = 1024L * 1024
    val files = listOf(
      LogFile("abs-2026-11-01.log.gz", 60 * mb, now - 9 * day),
      LogFile("abs-2026-11-02.log.gz", 60 * mb, now - 8 * day),
      LogFile("abs-2026-11-03.log.gz", 60 * mb, now - 7 * day),
      LogFile("abs-2026-11-09.log.gz", 10 * mb, now - 2 * day),
      LogFile("abs-2026-11-10.log", 10 * mb, now - 1000)
    )
    // total 200 MB: deleting the oldest (60 MB) brings it to 140 MB, which is enough
    assertEquals(listOf("abs-2026-11-01.log.gz"), DebugLogRules.planCap(files, "2026-11-10", now))
  }

  @Test fun capNeverDeletesTheLast24Hours() {
    val mb = 1024L * 1024
    val files = listOf(
      LogFile("abs-2026-11-08.log.gz", 100 * mb, now - 2 * day),
      LogFile("abs-2026-11-09.log.gz", 100 * mb, now - 3 * 60 * 60 * 1000L), // written 3 h ago: protected
      LogFile("abs-2026-11-10.log", 1 * mb, now - 1000)
    )
    // only the 2026-11-08 file can go; it is enough to get under 150 MB
    assertEquals(listOf("abs-2026-11-08.log.gz"), DebugLogRules.planCap(files, "2026-11-10", now))
  }

  @Test fun capLeavesUnderLimitAlone() {
    val files = listOf(LogFile("abs-2026-11-01.log.gz", 1000, now - 9 * day))
    assertEquals(emptyList<String>(), DebugLogRules.planCap(files, "2026-11-10", now))
  }

  @Test fun capKeepsProtectedFilesWhenTheyAloneExceedTheLimit() {
    val mb = 1024L * 1024
    val files = listOf(LogFile("abs-2026-11-10.log", 200 * mb, now - 1000))
    assertEquals(emptyList<String>(), DebugLogRules.planCap(files, "2026-11-10", now))
  }

}
