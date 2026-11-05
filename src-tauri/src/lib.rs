//! The native part of Plain PDF: a window showing the web app, plus the
//! files the system asks it to open (double-clicking a PDF, "Open with").
//! Everything else (viewing, drawing, saving) happens in the web app.

use std::sync::Mutex;

/// PDFs the system asked to open that the web app hasn't picked up yet.
#[derive(Default)]
struct OpenedFiles(Mutex<Vec<String>>);

/// The web app calls this when it starts (and when told files arrived).
#[tauri::command]
#[allow(unused_variables)]
fn take_opened_files(app: tauri::AppHandle, state: tauri::State<OpenedFiles>) -> Vec<String> {
    #[allow(unused_mut)]
    let mut files = std::mem::take(&mut *state.0.lock().unwrap());
    #[cfg(target_os = "android")]
    files.extend(android_inbox::take(&app));
    files
}

/// On Android, the main screen (android/MainActivity.kt) copies PDFs handed
/// over by other apps into an "opened" folder in the app's private cache.
#[cfg(target_os = "android")]
mod android_inbox {
    use std::path::PathBuf;
    use tauri::Manager;

    fn cache_folders(app: &tauri::AppHandle) -> Vec<PathBuf> {
        let mut folders = Vec::new();
        if let Ok(p) = app.path().app_cache_dir() {
            folders.push(p);
        }
        if let Ok(p) = app.path().cache_dir() {
            folders.push(p);
        }
        folders.dedup();
        folders
    }

    /// Moves waiting PDFs to a "taken" folder (so each is opened once) and returns their paths.
    pub fn take(app: &tauri::AppHandle) -> Vec<String> {
        let mut taken = Vec::new();
        for cache in cache_folders(app) {
            let inbox = cache.join("opened");
            let done = cache.join("taken");
            let Ok(entries) = std::fs::read_dir(&inbox) else { continue };
            let _ = std::fs::create_dir_all(&done);
            for entry in entries.flatten() {
                let target = done.join(entry.file_name());
                if std::fs::rename(entry.path(), &target).is_ok() {
                    taken.push(target.to_string_lossy().into_owned());
                }
            }
        }
        taken
    }

    /// Clears files handed over in earlier sessions.
    pub fn clean(app: &tauri::AppHandle) {
        for cache in cache_folders(app) {
            let _ = std::fs::remove_dir_all(cache.join("taken"));
        }
    }
}

/// On Windows (and Linux), a double-clicked PDF arrives as a program argument.
fn pdfs_from_arguments() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-') && a.to_lowercase().ends_with(".pdf"))
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(OpenedFiles(Mutex::new(pdfs_from_arguments())))
        .invoke_handler(tauri::generate_handler![take_opened_files])
        .setup(|_app| {
            #[cfg(target_os = "android")]
            android_inbox::clean(_app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Plain PDF could not start")
        .run(|app, event| {
            // On macOS, a double-clicked PDF arrives as an "opened" event instead.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                use tauri::{Emitter, Manager};
                let paths = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned());
                if let Some(state) = app.try_state::<OpenedFiles>() {
                    state.0.lock().unwrap().extend(paths);
                }
                let _ = app.emit("files-opened", ());
            }
            let _ = (app, event);
        });
}
