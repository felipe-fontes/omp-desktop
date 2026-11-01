//! Move a disposable native fork through omp's archive format. The original
//! session has a different identity and is retained independently.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

struct TransferDir(PathBuf);

impl Drop for TransferDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn args(profile: Option<&str>, operation: &str, first: &str, second: &str) -> Vec<String> {
    let mut result = Vec::with_capacity(6);
    if let Some(flag) = crate::agent::spawn::profile_flag(profile) {
        result.push(flag);
    }
    result.extend([
        "session".to_string(),
        operation.to_string(),
        first.to_string(),
    ]);
    if operation == "unpack" {
        result.push("--cwd".to_string());
    }
    result.push(second.to_string());
    result
}

fn header(path: &Path) -> Result<serde_json::Value, String> {
    let reader = BufReader::new(
        File::open(path)
            .map_err(|error| format!("cannot read session header: {error}"))?
            .take(1024 * 1024),
    );
    for line in reader.lines() {
        let line = line.map_err(|error| format!("cannot read session header: {error}"))?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if value.get("type").and_then(|field| field.as_str()) == Some("session") {
                return Ok(value);
            }
        }
    }
    Err("session has no readable header".to_string())
}

fn session_id(path: &Path) -> Result<String, String> {
    let value = header(path)?;
    value
        .get("id")
        .and_then(|field| field.as_str())
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "session has no id".to_string())
}

/// Native unpack replaces every local copy of its incoming ID. A freshly
/// forked ID must have no other copies, not just differ from the original.
pub(super) fn ensure_unique_snapshot(root: &Path, snapshot: &Path) -> Result<(), String> {
    const MAX_ENTRIES: usize = 100_000;
    let id = session_id(snapshot)?;
    let suffix = format!("_{id}.jsonl");
    if !snapshot
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(&suffix))
    {
        return Err("fork filename does not match its session identity".to_string());
    }
    let snapshot = snapshot
        .canonicalize()
        .map_err(|error| format!("cannot resolve fork snapshot: {error}"))?;
    let mut seen = 0_usize;
    for bucket in
        fs::read_dir(root).map_err(|error| format!("cannot inspect session history: {error}"))?
    {
        let bucket = bucket.map_err(|error| format!("cannot inspect session history: {error}"))?;
        seen += 1;
        if seen > MAX_ENTRIES {
            return Err("session history exceeds the safe promotion scan limit".to_string());
        }
        if !bucket.path().is_dir() {
            continue;
        }
        for entry in fs::read_dir(bucket.path())
            .map_err(|error| format!("cannot inspect session history: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("cannot inspect session history: {error}"))?;
            seen += 1;
            if seen > MAX_ENTRIES {
                return Err("session history exceeds the safe promotion scan limit".to_string());
            }
            if !entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(&suffix))
            {
                continue;
            }
            let path = entry
                .path()
                .canonicalize()
                .map_err(|error| format!("cannot inspect session copy: {error}"))?;
            if path != snapshot && session_id(&path)? == id {
                return Err(
                    "another session has the fork's identity; promotion would replace it"
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

pub(super) fn validate_fork(original: &Path, snapshot: &Path) -> Result<(), String> {
    if original == snapshot {
        return Err("promotion requires a separate fork snapshot".to_string());
    }
    let original = header(original)?;
    let snapshot = header(snapshot)?;
    let original_id = original
        .get("id")
        .and_then(|field| field.as_str())
        .filter(|id| !id.is_empty())
        .ok_or("original session has no id")?;
    let snapshot_id = snapshot
        .get("id")
        .and_then(|field| field.as_str())
        .filter(|id| !id.is_empty())
        .ok_or("fork session has no id")?;
    if snapshot_id == original_id
        || snapshot
            .get("parentSession")
            .and_then(|field| field.as_str())
            != Some(original_id)
    {
        return Err("promotion snapshot is not a distinct fork of this chat".to_string());
    }
    Ok(())
}

fn verify_cwd(session: &str, destination: &Path) -> Result<(), String> {
    let reader = BufReader::new(
        File::open(session)
            .map_err(|e| format!("cannot inspect relocated session: {e}"))?
            .take(1024 * 1024),
    );
    for line in reader.lines() {
        let line = line.map_err(|e| format!("cannot inspect relocated session: {e}"))?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("session") {
            continue;
        }
        let cwd = value
            .get("cwd")
            .and_then(|v| v.as_str())
            .ok_or("relocated session has no working directory")?;
        let cwd = Path::new(cwd)
            .canonicalize()
            .map_err(|e| format!("cannot resolve relocated session directory: {e}"))?;
        if cwd != destination {
            return Err("relocated session does not belong to the new project".to_string());
        }
        return Ok(());
    }
    Err("relocated session has no readable session header".to_string())
}

/// The callbacks let the real command use the trusted omp launcher and
/// profile-scoped session validator, while tests exercise both CLI stages.
pub(super) fn relocate(
    directory: PathBuf,
    profile: Option<&str>,
    source: &str,
    destination: &Path,
    mut run: impl FnMut(&[String], &str) -> Result<Vec<u8>, String>,
    validate: impl FnOnce(&str, Option<&str>) -> Result<Option<String>, String>,
) -> Result<String, String> {
    let transfer = TransferDir(directory);
    let result = (|| {
        let archive = transfer.0.join("chat.tar");
        let archive = archive.to_str().ok_or("transfer path is not UTF-8")?;
        let destination_str = destination.to_str().ok_or("project path is not UTF-8")?;
        run(&args(profile, "pack", source, archive), "omp session pack")?;
        if !fs::symlink_metadata(archive).is_ok_and(|m| m.is_file()) {
            return Err("omp did not create a session archive".to_string());
        }
        let output = run(
            &args(profile, "unpack", archive, destination_str),
            "omp session unpack",
        )?;
        let output = std::str::from_utf8(&output)
            .map_err(|_| "omp returned a non-UTF-8 session path")?
            .trim();
        if output.is_empty() || output.contains('\n') || output.contains('\r') {
            return Err("omp returned an invalid session path".to_string());
        }
        let path = validate(output, profile)?.ok_or("omp returned a missing session")?;
        if path == source {
            return Err(
                "omp returned the original session instead of a relocated copy".to_string(),
            );
        }
        verify_cwd(&path, destination)?;
        Ok(path)
    })();
    if let Err(cleanup) = fs::remove_dir_all(&transfer.0) {
        return Err(format!(
            "could not remove private session archive at {}: {cleanup}",
            transfer.0.display()
        ));
    }
    result
}
