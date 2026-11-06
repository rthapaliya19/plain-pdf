// Plain PDF's Android screen. Copied over the generated one by scripts/android-setup.mjs.
//
// When another app hands over a PDF ("Open with" from Google Drive, Files or
// email, or the Share menu), it's copied into the app's private cache folder,
// where the app picks it up (see take_opened_files in src-tauri/src/lib.rs).
//
// Printing: the app's screen can't print by itself, so the web app hands the
// finished PDF to Android's own print screen through `PlainPdfPrinter` (see
// src/platform/android-print.ts). The file stays on the phone, in the app's
// private cache, and is deleted once the print screen closes.
package io.github.rthapaliya19.plainpdf

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentAdapter.LayoutResultCallback
import android.print.PrintDocumentAdapter.WriteResultCallback
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    receivePdf(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receivePdf(intent)
  }

  // Runs before the app's page loads, so `window.PlainPdfPrinter` is there from the start.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(Printer(), "PlainPdfPrinter")
  }

  private fun receivePdf(intent: Intent?) {
    val uri: Uri = when (intent?.action) {
      Intent.ACTION_VIEW -> intent.data
      Intent.ACTION_SEND ->
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
      else -> null
    } ?: return
    try {
      var name = "document.pdf"
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0)?.let { name = it }
      }
      name = safeName(name)
      val inbox = File(cacheDir, "opened").apply { mkdirs() }
      contentResolver.openInputStream(uri)?.use { input ->
        File(inbox, name).outputStream().use { output -> input.copyTo(output) }
      }
    } catch (e: Exception) {
      Log.w("PlainPDF", "Couldn't receive the PDF", e)
    }
    // Don't receive the same file again (for example after the screen turns).
    intent?.action = null
  }

  /**
   * What the web app calls to print: begin(), then add() with the PDF in
   * pieces (base64 text), then print() with the document's name. Each returns
   * false if something went wrong.
   */
  inner class Printer {
    private var file: File? = null
    private var out: FileOutputStream? = null

    @JavascriptInterface
    fun begin(): Boolean = try {
      out?.close()
      val folder = File(cacheDir, "print").apply { mkdirs() }
      folder.listFiles()?.forEach { it.delete() } // anything left from an earlier printout
      val f = File(folder, "printout-${System.currentTimeMillis()}.pdf")
      file = f
      out = FileOutputStream(f)
      true
    } catch (e: Exception) {
      Log.w("PlainPDF", "Couldn't start printing", e)
      false
    }

    @JavascriptInterface
    fun add(base64: String): Boolean = try {
      val o = out ?: throw IllegalStateException("begin() wasn't called")
      o.write(Base64.decode(base64, Base64.DEFAULT))
      true
    } catch (e: Exception) {
      Log.w("PlainPDF", "Couldn't prepare the printout", e)
      false
    }

    @JavascriptInterface
    fun print(name: String): Boolean = try {
      out?.close()
      out = null
      val f = file ?: throw IllegalStateException("begin() wasn't called")
      file = null
      val jobName = safeName(name)
      runOnUiThread {
        try {
          val printManager = getSystemService(Context.PRINT_SERVICE) as PrintManager
          printManager.print(jobName, PdfFileAdapter(f, jobName), null)
        } catch (e: Exception) {
          Log.w("PlainPDF", "Couldn't open the print screen", e)
          f.delete()
        }
      }
      true
    } catch (e: Exception) {
      Log.w("PlainPDF", "Couldn't print", e)
      false
    }
  }

  /** Hands a finished PDF file to Android's print screen, as is. */
  private class PdfFileAdapter(private val file: File, private val name: String) : PrintDocumentAdapter() {
    override fun onLayout(
      oldAttributes: PrintAttributes?,
      newAttributes: PrintAttributes?,
      cancellationSignal: CancellationSignal?,
      callback: LayoutResultCallback,
      extras: Bundle?,
    ) {
      if (cancellationSignal?.isCanceled == true) {
        callback.onLayoutCancelled()
        return
      }
      val info = PrintDocumentInfo.Builder(name)
        .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
        .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
        .build()
      callback.onLayoutFinished(info, true)
    }

    override fun onWrite(
      pages: Array<out PageRange>?,
      destination: ParcelFileDescriptor,
      cancellationSignal: CancellationSignal?,
      callback: WriteResultCallback,
    ) {
      try {
        FileInputStream(file).use { input ->
          FileOutputStream(destination.fileDescriptor).use { output -> input.copyTo(output) }
        }
        if (cancellationSignal?.isCanceled == true) callback.onWriteCancelled()
        else callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
      } catch (e: Exception) {
        Log.w("PlainPDF", "Couldn't send the printout", e)
        callback.onWriteFailed(e.message)
      }
    }

    // The print screen closed (printed, saved or cancelled): the copy isn't needed any more.
    override fun onFinish() {
      file.delete()
    }
  }
}

/** A file name without characters Android doesn't allow, ending in ".pdf". */
private fun safeName(name: String): String {
  var n = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "document.pdf" }
  if (!n.lowercase().endsWith(".pdf")) n += ".pdf"
  return n
}
