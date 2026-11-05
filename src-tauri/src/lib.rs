//! The native part of Plain PDF: a window showing the web app, plus the
//! files the system asks it to open (double-clicking a PDF, "Open with").
//! Everything else (viewing, drawing, saving) happens in the web app.

use std::sync::Mutex;

/// PDFs the system asked to open that the web app hasn't picked up yet.
#[derive(Default)]
struct OpenedFiles(Mutex<Vec<String>>);

/// The web app calls this when it starts (and when told files arrived).
#[tauri::command]
fn take_opened_files(state: tauri::State<OpenedFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
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
