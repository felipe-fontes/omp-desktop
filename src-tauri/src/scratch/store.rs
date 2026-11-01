use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use super::tree;
use crate::private_fs::{create_private_file, private_dirs, write_private_via};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    id: String,
    /// Older rows own the directory named by id; profile aliases reference it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    /// Conversation variants for different profiles share a group; an
    /// independently reopened history gets a distinct group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group_id: Option<String>,
    profile: Option<String>,
    name: Option<String>,
    session_file: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Created {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileChat {
    pub id: String,
    pub path: String,
    pub profile: Option<String>,
    pub name: Option<String>,
    pub session_file: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub path: String,
    pub profile: Option<String>,
    pub name: Option<String>,
    pub session_file: Option<String>,
    // Unknown until the explicit, bounded scratch_usage request.
    pub bytes: Option<u64>,
    pub files: Option<usize>,
    pub complete: bool,
}

pub struct Store {
    root: PathBuf,
}

fn is_real(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
    }
    #[cfg(not(windows))]
    {
        !meta.file_type().is_symlink()
    }
}

fn is_real_dir(meta: &fs::Metadata) -> bool {
    meta.is_dir() && is_real(meta)
}

fn make_private_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if is_real_dir(&meta) => {}
        Ok(_) => return Err(format!("{} is not a real directory", path.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => match private_dirs(false).create(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if !fs::symlink_metadata(path).is_ok_and(|meta| is_real_dir(&meta)) {
                    return Err(format!("{} is not a real directory", path.display()));
                }
            }
            Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
        },
        Err(e) => return Err(format!("cannot inspect {}: {e}", path.display())),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("cannot secure {}: {e}", path.display()))?;
    }
    Ok(())
}

fn nonce() -> Result<String, String> {
    let mut random = [0_u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "cannot generate a chat identifier".to_string())?;
    let mut out = String::with_capacity(32);
    for byte in random {
        write!(&mut out, "{byte:02x}").map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Store {
    /// `data_dir` is the Tauri app-data directory, never a cache or temp path.
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        private_dirs(true)
            .create(data_dir)
            .map_err(|e| format!("cannot create app data directory: {e}"))?;
        let parent = data_dir
            .canonicalize()
            .map_err(|e| format!("cannot resolve app data directory: {e}"))?;
        let root = parent.join("chats");
        make_private_dir(&root)?;
        make_private_dir(&root.join("workspaces"))?;
        make_private_dir(&root.join("metadata"))?;
        Ok(Self { root })
    }

    fn check_roots(&self) -> Result<(), String> {
        for path in [
            &self.root,
            &self.root.join("workspaces"),
            &self.root.join("metadata"),
        ] {
            if !fs::symlink_metadata(path).is_ok_and(|meta| is_real_dir(&meta)) {
                return Err(format!(
                    "{} is not a real private directory",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    fn workspace_path(&self, id: &str) -> Result<PathBuf, String> {
        self.check_roots()?;
        if !valid_id(id) {
            return Err("invalid chat identifier".to_string());
        }
        Ok(self.root.join("workspaces").join(id))
    }

    fn metadata_path(&self, id: &str) -> Result<PathBuf, String> {
        self.check_roots()?;
        if !valid_id(id) {
            return Err("invalid chat identifier".to_string());
        }
        Ok(self.root.join("metadata").join(format!("{id}.json")))
    }

    fn read_meta(&self, id: &str) -> Result<Metadata, String> {
        let path = self.metadata_path(id)?;
        let meta =
            fs::symlink_metadata(&path).map_err(|e| format!("chat metadata unavailable: {e}"))?;
        if !meta.is_file() || !is_real(&meta) || meta.len() > 32_768 {
            return Err("invalid chat metadata file".to_string());
        }
        let mut bytes = Vec::new();
        File::open(&path)
            .and_then(|f| f.take(32_769).read_to_end(&mut bytes))
            .map_err(|e| format!("cannot read chat metadata: {e}"))?;
        if bytes.len() > 32_768 {
            return Err("chat metadata is too large".to_string());
        }
        let result: Metadata =
            serde_json::from_slice(&bytes).map_err(|e| format!("invalid chat metadata: {e}"))?;
        if result.id != id
            || result
                .workspace_id
                .as_deref()
                .is_some_and(|id| !valid_id(id))
            || result.group_id.as_deref().is_some_and(|id| !valid_id(id))
            || result.profile.as_deref().is_some_and(|p| {
                crate::profiles::validate_id(p).is_err() || crate::profiles::is_default(p)
            })
        {
            return Err("invalid chat metadata identity".to_string());
        }
        Ok(result)
    }

    fn workspace_for_meta(&self, metadata: &Metadata) -> Result<PathBuf, String> {
        self.workspace_path(metadata.workspace_id.as_deref().unwrap_or(&metadata.id))
    }

    fn workspace_id(metadata: &Metadata) -> &str {
        metadata.workspace_id.as_deref().unwrap_or(&metadata.id)
    }

    fn group_id(metadata: &Metadata) -> &str {
        metadata.group_id.as_deref().unwrap_or(&metadata.id)
    }

    fn references_lock(&self) -> PathBuf {
        self.root.join("metadata").join("workspaces.lock")
    }

    pub fn workspace(&self, id: &str) -> Result<PathBuf, String> {
        let metadata = self.read_meta(id)?;
        let path = self.workspace_for_meta(&metadata)?;
        let meta =
            fs::symlink_metadata(&path).map_err(|e| format!("chat workspace unavailable: {e}"))?;
        if !is_real_dir(&meta) {
            return Err("chat workspace is not a real directory".to_string());
        }
        Ok(path)
    }

    /// Validate ownership even if a previous delete already removed the tree.
    pub fn workspace_for_delete(&self, id: &str) -> Result<PathBuf, String> {
        let metadata = self.read_meta(id)?;
        let path = self.workspace_for_meta(&metadata)?;
        match fs::symlink_metadata(&path) {
            Ok(meta) if is_real_dir(&meta) => Ok(path),
            Ok(_) => Err("chat workspace is not a real directory".to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path),
            Err(error) => Err(format!("chat workspace unavailable: {error}")),
        }
    }

    pub fn create(&self, profile: Option<String>) -> Result<Created, String> {
        if let Some(id) = profile.as_deref() {
            crate::profiles::validate_id(id)?;
            if crate::profiles::is_default(id) {
                return Err("profile must be resolved before creating a chat".to_string());
            }
        }
        for _ in 0..8 {
            let id = nonce()?;
            let path = self.workspace_path(&id)?;
            // Validate UTF-8 before creating anything; canonical_folder below
            // supplies the platform-normalized path after creation.
            if path.to_str().is_none() {
                return Err("chat path is not UTF-8".to_string());
            }
            match private_dirs(false).create(&path) {
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("cannot create chat workspace: {e}")),
                Ok(()) => {}
            }
            let shown = match crate::external_open::canonical_folder(&path) {
                Ok(shown) => shown,
                Err(error) => {
                    let _ = fs::remove_dir(&path);
                    return Err(error);
                }
            };
            // The id is also returned; profile is needed again if an
            // extraordinarily unlikely metadata-id collision forces a retry.
            let metadata = Metadata {
                id: id.clone(),
                workspace_id: None,
                group_id: None,
                profile: profile.clone(),
                name: None,
                session_file: None,
            };
            let bytes = serde_json::to_vec(&metadata).map_err(|e| e.to_string())?;
            match create_private_file(&self.metadata_path(&id)?, &bytes) {
                Ok(()) => return Ok(Created { id, path: shown }),
                Err(e) => {
                    let _ = fs::remove_dir(&path);
                    if e.kind() != io::ErrorKind::AlreadyExists {
                        return Err(format!("cannot create chat metadata: {e}"));
                    }
                }
            }
        }
        Err("could not allocate a unique chat identifier".to_string())
    }

    fn find_metadata(
        &self,
        mut matches: impl FnMut(&Metadata) -> bool,
    ) -> Result<Option<Metadata>, String> {
        self.check_roots()?;
        for entry in fs::read_dir(self.root.join("metadata"))
            .map_err(|error| format!("cannot list chats: {error}"))?
        {
            let path = entry
                .map_err(|error| format!("cannot list chats: {error}"))?
                .path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|name| name.to_str())
                .filter(|id| valid_id(id))
            else {
                continue;
            };
            let metadata = self.read_meta(id)?;
            if matches(&metadata) {
                return Ok(Some(metadata));
            }
        }
        Ok(None)
    }

    fn create_alias(
        &self,
        workspace_id: &str,
        group_id: Option<&str>,
        profile: Option<&str>,
        session: Option<&str>,
        name: Option<&str>,
    ) -> Result<Created, String> {
        if let Some(profile) = profile {
            crate::profiles::validate_id(profile)?;
            if crate::profiles::is_default(profile) {
                return Err("profile must be resolved before creating a chat".to_string());
            }
        }
        let workspace = self.workspace_path(workspace_id)?;
        let shown = crate::external_open::canonical_folder(&workspace)?;
        for _ in 0..8 {
            let id = nonce()?;
            // Metadata owns its fields; keep the borrowed inputs and returned
            // id available across the unlikely exclusive-create collision.
            let metadata = Metadata {
                id: id.clone(),
                workspace_id: Some(workspace_id.to_owned()),
                group_id: group_id.map(ToString::to_string),
                profile: profile.map(ToString::to_string),
                name: name.map(ToString::to_string),
                session_file: session.map(ToString::to_string),
            };
            let bytes = serde_json::to_vec(&metadata).map_err(|e| e.to_string())?;
            match create_private_file(&self.metadata_path(&id)?, &bytes) {
                Ok(()) => return Ok(Created { id, path: shown }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("cannot create chat metadata: {error}")),
            }
        }
        Err("could not allocate a unique chat identifier".to_string())
    }

    pub fn for_profile(&self, id: &str, profile: Option<&str>) -> Result<ProfileChat, String> {
        crate::json_store::with_lock_str(&self.references_lock(), || {
            let source = self.read_meta(id)?;
            let path = self.workspace(id)?;
            let workspace_id = Self::workspace_id(&source);
            let group_id = Self::group_id(&source);
            let existing = if let Some(existing) = self.find_metadata(|meta| {
                Self::workspace_id(meta) == workspace_id
                    && Self::group_id(meta) == group_id
                    && meta.profile.as_deref() == profile
            })? {
                existing
            } else {
                let created = self.create_alias(
                    workspace_id,
                    Some(group_id),
                    profile,
                    None,
                    Some("New chat"),
                )?;
                self.read_meta(&created.id)?
            };
            Ok(ProfileChat {
                id: existing.id,
                path: crate::external_open::canonical_folder(&path)?,
                profile: existing.profile,
                name: existing.name,
                session_file: existing.session_file,
            })
        })
    }

    fn history_workspace(&self, cwd: &str) -> Result<Option<(String, bool)>, String> {
        let cwd = Path::new(cwd);
        let Some(id) = cwd.file_name().and_then(|name| name.to_str()) else {
            return Ok(None);
        };
        if !valid_id(id) {
            return Ok(None);
        }
        let expected = self.workspace_path(id)?;
        let displayed_parent = crate::external_open::canonical_folder(
            expected.parent().ok_or("chat workspace has no parent")?,
        )?;
        if cwd.parent() != Some(Path::new(&displayed_parent)) && cwd != expected.as_path() {
            return Ok(None);
        }
        match fs::symlink_metadata(&expected) {
            Ok(meta) if is_real_dir(&meta) => Ok(Some((id.to_owned(), true))),
            Ok(_) => Err("history workspace is not a real directory".to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Ok(Some((id.to_owned(), false)))
            }
            Err(error) => Err(format!("cannot inspect chat workspace: {error}")),
        }
    }

    fn existing_session_workspace(
        &self,
        profile: Option<&str>,
        session: &str,
    ) -> Result<Option<Created>, String> {
        self.check_roots()?;
        for entry in fs::read_dir(self.root.join("metadata"))
            .map_err(|error| format!("cannot list chats: {error}"))?
        {
            let path = entry
                .map_err(|error| format!("cannot list chats: {error}"))?
                .path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|name| name.to_str())
                .filter(|id| valid_id(id))
            else {
                continue;
            };
            let metadata = self.read_meta(id)?;
            if metadata.profile.as_deref() != profile
                || metadata.session_file.as_deref() != Some(session)
            {
                continue;
            }
            let workspace = self.workspace_for_meta(&metadata)?;
            match fs::symlink_metadata(&workspace) {
                Ok(meta) if is_real_dir(&meta) => {
                    return Ok(Some(Created {
                        id: metadata.id,
                        path: crate::external_open::canonical_folder(&workspace)?,
                    }));
                }
                Ok(_) => return Err("chat workspace is not a real directory".to_string()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("cannot inspect chat workspace: {error}")),
            }
        }
        Ok(None)
    }

    /// Reattach a validated saved session to its existing private workspace,
    /// or create a new empty workspace if the original was deleted.
    pub fn restore_history(
        &self,
        cwd: &str,
        profile: Option<&str>,
        session: &str,
        name: &str,
    ) -> Result<Option<Created>, String> {
        if self.history_workspace(cwd)?.is_none() {
            return Ok(None);
        }
        let lock = self.root.join("metadata").join(format!(
            "restore-{}.lock",
            crate::json_store::hex_sha256(session.as_bytes())
        ));
        crate::json_store::with_lock_str(&self.references_lock(), || {
            crate::json_store::with_lock_str(&lock, || {
                let Some((workspace_id, exists)) = self.history_workspace(cwd)? else {
                    return Ok(None);
                };
                if let Some(existing) = self.existing_session_workspace(profile, session)? {
                    return Ok(Some(existing));
                }
                let name = (!name.is_empty() && name.len() <= 4096).then_some(name);
                if exists {
                    return self
                        .create_alias(&workspace_id, None, profile, Some(session), name)
                        .map(Some);
                }
                let created = self.create(profile.map(ToString::to_string))?;
                if let Err(error) = self.update(
                    &created.id,
                    Some(session.to_owned()),
                    name.map(ToString::to_string),
                    |validated, _| Ok(Some(validated.to_owned())),
                ) {
                    let cleanup = fs::remove_dir(&created.path).and_then(|()| {
                        fs::remove_file(self.metadata_path(&created.id).map_err(io::Error::other)?)
                    });
                    if let Err(cleanup) = cleanup {
                        return Err(format!(
                            "{error}; could not remove empty recovered chat: {cleanup}"
                        ));
                    }
                    return Err(error);
                }
                Ok(Some(created))
            })
        })
    }

    pub fn list(&self, profile: Option<&str>) -> Result<Vec<Chat>, String> {
        self.check_roots()?;
        let mut result = Vec::new();
        for entry in fs::read_dir(self.root.join("metadata"))
            .map_err(|e| format!("cannot list chats: {e}"))?
        {
            let entry = entry.map_err(|e| format!("cannot list chats: {e}"))?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|id| valid_id(id))
            else {
                continue;
            };
            let meta = self.read_meta(id)?;
            if meta.profile.as_deref() != profile {
                continue;
            }
            let workspace = self.workspace_for_meta(&meta)?;
            match fs::symlink_metadata(&workspace) {
                Ok(meta) if is_real_dir(&meta) => {}
                Ok(_) => return Err("chat workspace is not a real directory".to_string()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("chat workspace unavailable: {error}")),
            }
            result.push(Chat {
                id: meta.id,
                path: crate::external_open::canonical_folder(&workspace)?,
                profile: meta.profile,
                name: meta.name,
                session_file: meta.session_file,
                bytes: None,
                files: None,
                complete: false,
            });
        }
        result.sort_unstable_by(|a, b| a.id.cmp(&b.id));
        Ok(result)
    }

    /// None clears the session, while None for name leaves it unchanged.
    /// The validator returns None for a not-yet-created session file.
    pub fn update(
        &self,
        id: &str,
        session_file: Option<String>,
        name: Option<String>,
        validate: impl FnOnce(&str, Option<&str>) -> Result<Option<String>, String>,
    ) -> Result<bool, String> {
        let path = self.metadata_path(id)?;
        let lock = path.with_extension("lock");
        crate::json_store::with_lock_str(&lock, || {
            let mut meta = self.read_meta(id)?;
            self.workspace(id)?;
            let requested = session_file.is_some();
            let validated = match session_file.as_deref() {
                Some(file) => validate(file, meta.profile.as_deref())?,
                None => None,
            };
            let saved = !requested || validated.is_some();
            if let Some(name) = name {
                if name.len() > 4096 {
                    return Err("chat name is too long".to_string());
                }
                meta.name = Some(name);
            }
            meta.session_file = validated;
            let bytes = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
            let temp = path.with_extension(format!("{}.tmp", nonce()?));
            write_private_via(&path, &temp, &bytes)
                .map_err(|e| format!("cannot save chat metadata: {e}"))?;
            Ok(saved)
        })
    }

    pub fn delete_guarded(
        &self,
        id: &str,
        before_remove: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        let metadata = self.metadata_path(id)?;
        crate::json_store::with_lock_str(&self.references_lock(), || {
            crate::json_store::with_lock_str(&metadata.with_extension("lock"), || {
                let record = self.read_meta(id)?;
                let root = self.workspace_for_delete(id)?;
                let shared = self
                    .find_metadata(|other| {
                        other.id != id && Self::workspace_id(other) == Self::workspace_id(&record)
                    })?
                    .is_some();
                if !shared {
                    before_remove(&root)?;
                    match fs::remove_dir_all(&root) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(format!("cannot remove chat workspace: {error}")),
                    }
                }
                fs::remove_file(&metadata).map_err(|e| format!("cannot remove chat metadata: {e}"))
            })
        })
    }

    #[cfg(test)]
    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.delete_guarded(id, |_| Ok(()))
    }

    pub fn session(&self, id: &str) -> Result<(Option<String>, Option<String>), String> {
        self.workspace(id)?;
        let metadata = self.read_meta(id)?;
        Ok((metadata.profile, metadata.session_file))
    }

    pub fn transfer_dir(&self) -> Result<PathBuf, String> {
        self.check_roots()?;
        let transfers = self.root.join("transfers");
        make_private_dir(&transfers)?;
        for _ in 0..8 {
            let dir = transfers.join(nonce()?);
            match private_dirs(false).create(&dir) {
                Ok(()) => return Ok(dir),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("cannot create private transfer directory: {e}")),
            }
        }
        Err("cannot allocate private transfer directory".to_string())
    }

    pub fn files(&self, id: &str) -> Result<Vec<tree::ScratchFile>, String> {
        tree::files(&self.workspace(id)?)
    }

    pub fn usage(&self, id: &str) -> Result<tree::Usage, String> {
        let record = self.read_meta(id)?;
        let mut usage = tree::usage(&self.workspace(id)?)?;
        usage.shared = self
            .find_metadata(|other| {
                other.id != id && Self::workspace_id(other) == Self::workspace_id(&record)
            })?
            .is_some();
        Ok(usage)
    }

    pub fn export(&self, id: &str, path: &str, dest: &Path) -> Result<(), String> {
        tree::export(&self.workspace(id)?, path, dest)
    }

    pub fn promote(&self, id: &str, dest: &Path) -> Result<String, String> {
        tree::promote(&self.workspace(id)?, dest)
    }
}
