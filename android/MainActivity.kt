// Plain PDF's Android screen. Copied over the generated one by scripts/android-setup.mjs.
//
// When another app hands over a PDF ("Open with" from Google Drive, Files or
// email, or the Share menu), it's copied into the app's private cache folder,
// where the app picks it up (see take_opened_files in src-tauri/src/lib.rs).
package io.github.rthapaliya19.plainpdf

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    receivePdf(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receivePdf(intent)
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
      name = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
      if (!name.lowercase().endsWith(".pdf")) name += ".pdf"
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
}
