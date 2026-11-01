//! Durable, app-private chat workspaces. Conversation history remains in
//! omp's profile-owned session store; deleting a workspace never deletes it.

mod store;
mod transfer;
mod tree;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

// Picked destinations and completed copies are tied to the chat id and this
// app run; IPC cannot nominate an arbitrary filesystem destination.
struct Promotion {
    destination: String,
    snapshot: Option<String>,
}

static PICKS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
static PROMOTIONS: OnceLock<Mutex<HashMap<String, Promotion>>> = OnceLock::new();

fn picks() -> &'static Mutex<HashMap<String, PathBuf>> {
    PICKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn promotions() -> &'static Mutex<HashMap<String, Promotion>> {
    PROMOTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data directory unavailable: {e}"))
}

fn store(app: &AppHandle) -> Result<store::Store, String> {
    store::Store::new(&data_dir(app)?)
}

fn validated_session(
    app: &AppHandle,
    file: &str,
    profile: Option<&str>,
) -> Result<Option<String>, String> {
    let path = Path::new(file);
    if !path.is_absolute() || path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err("chat session must be an absolute .jsonl path".to_string());
    }
    let canonical = match path.canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot resolve chat session: {e}")),
    };
    if !canonical.is_file() {
        return Err("chat session is not a regular file".to_string());
    }
    let path = canonical.to_str().ok_or("chat session path is not UTF-8")?;
    crate::saved_sessions::validate_resume(app, path, profile)?;
    Ok(Some(crate::external_open::strip_verbatim(path.to_owned())))
}

// A registered tab is enough to refuse deletion/promotion, even when its
// shell is idle: omp or a terminal could otherwise start writing to it.
fn require_closed(
    terminal: &crate::terminal::TerminalManager,
    workspace: &Path,
) -> Result<(), String> {
    let canonical = match workspace.canonicalize() {
        Ok(path) => Some(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("cannot resolve chat workspace: {error}")),
    };
    let displayed = crate::external_open::strip_verbatim(workspace.to_string_lossy().into_owned());
    for id in terminal.tab_ids() {
        if let Some(folder) = terminal.folder(&id) {
            if folder.starts_with(workspace)
                || folder.starts_with(Path::new(&displayed))
                || canonical.as_ref().is_some_and(|root| {
                    folder
                        .canonicalize()
                        .is_ok_and(|folder| folder.starts_with(root))
                })
            {
                return Err(
                    "Close the chat tab before deleting or promoting its workspace".to_string(),
                );
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn scratch_create(
    profile: Option<String>,
    profiles: State<'_, Arc<crate::profiles::ProfileStore>>,
    app: AppHandle,
) -> Result<store::Created, String> {
    let profile = profiles.resolve_owned(profile)?;
    crate::off_ipc(move || store(&app)?.create(profile)).await?
}

#[tauri::command]
pub async fn scratch_list(
    profile: Option<String>,
    profiles: State<'_, Arc<crate::profiles::ProfileStore>>,
    app: AppHandle,
) -> Result<Vec<store::Chat>, String> {
    let profile = profiles.resolve_owned(profile)?;
    crate::off_ipc(move || store(&app)?.list(profile.as_deref())).await?
}

#[tauri::command]
pub async fn scratch_for_profile(
    id: String,
    profile: Option<String>,
    profiles: State<'_, Arc<crate::profiles::ProfileStore>>,
    app: AppHandle,
) -> Result<store::ProfileChat, String> {
    let profile = profiles.resolve_owned(profile)?;
    crate::off_ipc(move || store(&app)?.for_profile(&id, profile.as_deref())).await?
}

#[tauri::command]
pub async fn scratch_restore_history(
    session_file: String,
    profile: Option<String>,
    profiles: State<'_, Arc<crate::profiles::ProfileStore>>,
    app: AppHandle,
) -> Result<Option<store::Created>, String> {
    let profile = profiles.resolve_owned(profile)?;
    crate::off_ipc(move || {
        let session_file = validated_session(&app, &session_file, profile.as_deref())?
            .ok_or("the saved session no longer exists")?;
        let history = crate::saved_sessions::parse_session_file(Path::new(&session_file))
            .ok_or("cannot read the saved session")?;
        store(&app)?.restore_history(
            &history.cwd,
            profile.as_deref(),
            &session_file,
            &history.title,
        )
    })
    .await?
}

#[tauri::command]
pub async fn scratch_update(
    id: String,
    session_file: Option<String>,
    name: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    crate::off_ipc(move || {
        store(&app)?.update(&id, session_file, name, |file, profile| {
            validated_session(&app, file, profile)
        })
    })
    .await?
}

#[tauri::command]
pub async fn scratch_files(id: String, app: AppHandle) -> Result<Vec<tree::ScratchFile>, String> {
    crate::off_ipc(move || store(&app)?.files(&id)).await?
}

#[tauri::command]
pub async fn scratch_usage(id: String, app: AppHandle) -> Result<tree::Usage, String> {
    crate::off_ipc(move || store(&app)?.usage(&id)).await?
}

#[tauri::command]
pub async fn scratch_export(id: String, path: String, app: AppHandle) -> Result<bool, String> {
    let suggested = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("chat-file")
        .to_owned();
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Export Chat File")
        .set_file_name(suggested)
        .save_file(move |result| {
            let _ = tx.send(result);
        });
    crate::off_ipc(move || {
        let Some(picked) = rx
            .recv()
            .map_err(|e| format!("dialog channel error: {e}"))?
        else {
            return Ok(false);
        };
        let dest = picked
            .into_path()
            .map_err(|e| format!("invalid export destination: {e}"))?;
        store(&app)?.export(&id, &path, &dest)?;
        Ok(true)
    })
    .await?
}

/// Choose the destination before the chat or its editor state is disturbed.
#[tauri::command]
pub async fn scratch_pick_project(id: String, app: AppHandle) -> Result<bool, String> {
    picks()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&id);
    promotions()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&id);
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Create Project from Chat")
        .set_file_name("Chat Project")
        .save_file(move |result| {
            let _ = tx.send(result);
        });
    crate::off_ipc(move || {
        let Some(picked) = rx
            .recv()
            .map_err(|e| format!("dialog channel error: {e}"))?
        else {
            return Ok(false);
        };
        let destination = picked
            .into_path()
            .map_err(|e| format!("invalid project destination: {e}"))?;
        store(&app)?.workspace(&id)?;
        picks()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id, destination);
        Ok(true)
    })
    .await?
}

fn checked_fork(
    app: &AppHandle,
    store: &store::Store,
    profiles: &crate::profiles::ProfileStore,
    id: &str,
    snapshot: Option<&str>,
) -> Result<Option<(Option<String>, String, String)>, String> {
    let (profile, session) = store.session(id)?;
    profiles.resolve(profile.as_deref())?;
    let (original, snapshot) = match (session, snapshot) {
        (None, None) => return Ok(None),
        (Some(original), Some(snapshot)) => (original, snapshot),
        _ => return Err("a saved chat requires a separate fork snapshot".to_string()),
    };
    let original = validated_session(app, &original, profile.as_deref())?
        .ok_or("the chat's saved session no longer exists")?;
    let snapshot = validated_session(app, snapshot, profile.as_deref())?
        .ok_or("the fork snapshot no longer exists")?;
    transfer::validate_fork(Path::new(&original), Path::new(&snapshot))?;
    Ok(Some((profile, original, snapshot)))
}

#[tauri::command]
pub async fn scratch_promote(
    id: String,
    snapshot: Option<String>,
    profiles: State<'_, Arc<crate::profiles::ProfileStore>>,
    terminal: State<'_, Arc<crate::terminal::TerminalManager>>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let profiles = Arc::clone(profiles.inner());
    let terminal = Arc::clone(terminal.inner());
    crate::off_ipc(move || {
        let result = (|| {
            let dest = picks()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&id)
                .ok_or("no project destination was selected")?;
            let store = store(&app)?;
            require_closed(&terminal, &store.workspace(&id)?)?;
            let fork = checked_fork(&app, &store, &profiles, &id, snapshot.as_deref())?;
            let destination = store.promote(&id, &dest)?;
            // The caller needs the same destination that the single-use
            // receipt owns for the subsequent validated session transfer.
            let receipt = Promotion {
                destination: destination.clone(),
                snapshot: fork.map(|(_, _, snapshot)| snapshot),
            };
            promotions()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(id, receipt);
            Ok(Some(destination))
        })();
        result.map_err(|error: String| match snapshot {
            Some(snapshot) => format!("{error}; fork snapshot retained at {snapshot}"),
            None => error,
        })
    })
    .await?
}

#[tauri::command]
pub async fn scratch_promote_session(
    id: String,
    destination: String,
    profiles: State<'_, Arc<crate::profiles::ProfileStore>>,
    terminal: State<'_, Arc<crate::terminal::TerminalManager>>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let profiles = Arc::clone(profiles.inner());
    let terminal = Arc::clone(terminal.inner());
    crate::off_ipc(move || {
        // Consume before running omp: an ambiguous failure must never retry
        // an unpack into the same destination and risk replacing history.
        let receipt = promotions()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id)
            .ok_or("no unused project promotion exists for this chat")?;
        let dest = Path::new(&destination)
            .canonicalize()
            .map_err(|e| format!("cannot resolve promoted project: {e}"))?;
        let expected = Path::new(&receipt.destination)
            .canonicalize()
            .map_err(|e| format!("cannot resolve promoted project: {e}"))?;
        if !dest.is_dir() || dest != expected {
            return Err("project destination does not match this chat's promotion".to_string());
        }
        let store = store(&app)?;
        require_closed(&terminal, &store.workspace(&id)?)?;
        let Some((profile, original, snapshot)) =
            checked_fork(&app, &store, &profiles, &id, receipt.snapshot.as_deref())?
        else {
            return Ok(None);
        };
        tree::verify_fork_artifacts(Path::new(&original), Path::new(&snapshot))?;
        let sessions_root = crate::saved_sessions::sessions_root_dir(&app, profile.as_deref())
            .ok_or("cannot resolve the profile's session history")?;
        transfer::ensure_unique_snapshot(&sessions_root, Path::new(&snapshot))?;
        let directory = store.transfer_dir()?;
        transfer::relocate(
            directory,
            profile.as_deref(),
            &snapshot,
            &dest,
            crate::omp_cli::run,
            |file, profile| validated_session(&app, file, profile),
        )
        .map(Some)
    })
    .await?
}

#[tauri::command]
pub async fn scratch_delete(
    id: String,
    terminal: State<'_, Arc<crate::terminal::TerminalManager>>,
    app: AppHandle,
) -> Result<(), String> {
    let terminal = Arc::clone(terminal.inner());
    crate::off_ipc(move || {
        let store = store(&app)?;
        store.delete_guarded(&id, |root| require_closed(&terminal, root))?;
        picks()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
        promotions()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
        Ok(())
    })
    .await?
}

#[cfg(test)]
mod tests;
