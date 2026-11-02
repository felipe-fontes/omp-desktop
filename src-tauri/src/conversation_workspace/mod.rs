//! Serializes workspace preparation with tab registration and lifecycle.
mod admission;
mod inspect;
mod naming;
pub mod process;
mod runner;
#[cfg(test)]
mod tests;

pub use admission::{Admission, WorkspaceManager};
pub use inspect::WorkspaceInfo;
pub use naming::Model;
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const HEX: &[u8; 16] = b"0123456789abcdef";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOptions {
    pub base_ref: Option<String>,
    pub base_commit: Option<String>,
    pub worktree: bool,
    pub acknowledge_shared: bool,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub branch_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FirstPrompt {
    pub text: String,
    pub model: Option<Model>,
    pub attempt: u32,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeferredResponse {
    pub workspace: Option<WorkspaceBinding>,
    pub deferred_workspace: Option<WorkspaceOptions>,
}

/// The selected source and base, distinct from the tab's actual cwd.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceBinding {
    pub project_path: String,
    pub base_ref: Option<String>,
    pub base_commit: Option<String>,
    pub worktree: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    pub approval_mode: String,
    pub path: String,
    pub workspace: Option<WorkspaceBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred_workspace: Option<WorkspaceOptions>,
}
pub struct StartContext<'a> {
    pub data: Option<&'a Path>,
    pub manager: &'a WorkspaceManager,
    pub ticket: &'a Admission,
}

pub struct FirstRequest<'a> {
    pub id: &'a str,
    pub cwd: &'a str,
    pub profile: &'a str,
    pub prompt: &'a FirstPrompt,
}

#[derive(Clone)]
pub struct Prepared {
    pub path: String,
    pub workspace: Option<WorkspaceBinding>,
    /// A source process with this plan is metadata-only.
    pub deferred_workspace: Option<WorkspaceOptions>,
    /// A completed checkout remains reserved until its first spawn succeeds.
    first_prompt: bool,
    /// Original selected cwd, including a linked-worktree subdirectory.
    deferred_source: Option<String>,
    /// Only tabs opened with a deferred plan may change their initial choice.
    changeable: bool,
    revision: u64,
    /// Resolved native profile, retained across close and session-file binding.
    pub profile: String,
    /// Catalog identity survives a missing or partially removed cwd.
    pub storage_id: Option<String>,
    default_cwd: Option<String>,
    terminal_cwd: Option<String>,
}

#[derive(Default)]
pub struct Registry {
    tabs: HashMap<String, Prepared>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub dirty: bool,
    pub owners: usize,
}

/// Metadata never acquires the lifecycle guard or scans the checkout.
pub fn inspect(path: &str) -> Result<WorkspaceInfo, String> {
    inspect::read(inspect::folder(path)?)
}

/// The scan runs outside the lifecycle guard. Ownership is advisory; startup
/// repeats both checks while holding the guard.
pub fn status(
    manager: &WorkspaceManager,
    path: &str,
    session_id: Option<&str>,
) -> Result<WorkspaceStatus, String> {
    let path = inspect::folder(path)?;
    let identity = inspect::identity(&path)?;
    let dirty = inspect::dirty(&path)?;
    let owners = manager
        .lock()
        .owners_excluding(&identity, session_id, true)?;
    Ok(WorkspaceStatus { dirty, owners })
}

impl Registry {
    pub fn get(&self, id: &str) -> Option<&Prepared> {
        self.tabs.get(id)
    }

    /// Move the rollback state while the caller retains the lifecycle guard.
    pub fn take_registration(&mut self, id: &str) -> Option<(String, Prepared)> {
        self.tabs.remove_entry(id)
    }

    /// A failed user close keeps the visible tab reserved, even when its
    /// children were already stopped before snapshot verification failed.
    pub fn retain_registration(&mut self, id: String, prepared: Prepared) {
        self.tabs.entry(id).or_insert(prepared);
    }

    pub fn set_profile(&mut self, id: &str, profile: &str) -> Result<(), String> {
        let prepared = self
            .tabs
            .get_mut(id)
            .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
        if prepared.profile != profile {
            profile.clone_into(&mut prepared.profile);
            prepared.revision = prepared.revision.wrapping_add(1);
        }
        Ok(())
    }

    pub fn set_storage_id(&mut self, id: &str, storage_id: Option<&str>) -> Result<(), String> {
        let prepared = self
            .tabs
            .get_mut(id)
            .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
        if prepared.storage_id.as_deref() != storage_id {
            prepared.storage_id = storage_id.map(str::to_owned);
        }
        Ok(())
    }

    /// Unknown ownership is an error, never permission to remove a checkout.
    pub fn owners_for_path(&self, path: &str) -> Result<usize, String> {
        self.owners(&inspect::identity(path)?)
    }

    fn owners(&self, identity: &Path) -> Result<usize, String> {
        self.owners_excluding(identity, None, false)
    }

    fn owners_excluding(
        &self,
        identity: &Path,
        excluded: Option<&str>,
        pending_only: bool,
    ) -> Result<usize, String> {
        let mut owners = 0;
        for (id, tab) in &self.tabs {
            if excluded == Some(id.as_str()) && (!pending_only || tab.deferred_workspace.is_some())
            {
                continue;
            }
            let cwd = if tab.path.is_empty() {
                tab.default_cwd.as_deref()
            } else {
                Some(tab.path.as_str())
            };
            // Re-discover the live folders: an agent may have initialized or
            // replaced a repository since its tab started. Unknown is not free.
            for folder in [cwd, tab.terminal_cwd.as_deref()].into_iter().flatten() {
                let folder = inspect::folder(folder)?;
                if inspect::identity(&folder)?.as_path() == identity {
                    owners += 1;
                    break;
                }
            }
        }
        Ok(owners)
    }

    #[cfg(test)]
    fn status(&self, path: &str) -> Result<WorkspaceStatus, String> {
        let path = inspect::folder(path)?;
        let identity = inspect::identity(&path)?;
        Ok(WorkspaceStatus {
            dirty: inspect::dirty(&path)?,
            owners: self.owners(&identity)?,
        })
    }

    pub fn release<S: AsRef<str>>(&mut self, ids: &[S]) {
        for id in ids {
            self.tabs.remove(id.as_ref());
        }
    }

    /// Include a registration even if an interrupted startup never reached
    /// terminal registration; cleanup must not strand its ownership.
    pub fn include_registered_ids(&self, ids: &mut Vec<String>) {
        for id in self.tabs.keys() {
            if !ids.contains(id) {
                // The cleanup snapshot outlives its borrow of the registry.
                ids.push(id.clone());
            }
        }
    }

    /// Register an unsent project without performing checkout or safety mutations.
    pub fn prepare_deferred(
        &mut self,
        id: &str,
        cwd: &str,
        mut options: WorkspaceOptions,
        context: StartContext<'_>,
    ) -> Result<Prepared, String> {
        context.manager.check_ticket(context.ticket)?;
        if self.tabs.contains_key(id) {
            return Err("an existing tab cannot install a new deferred workspace".into());
        }
        validate_deferred(cwd, &options)?;
        // A saved/initial plan is metadata, not renewed consent to share.
        options.acknowledge_shared = false;
        let manager = context.manager;
        let mut prepared = self.prepare_for_start(id, cwd, None, context)?;
        prepared.deferred_source = Some(prepared.path.clone());
        prepared.deferred_workspace = Some(options);
        prepared.changeable = true;
        manager.register_pending(id);
        self.tabs.insert(id.to_string(), prepared.clone());
        Ok(prepared)
    }

    /// A choice made before a task may change the plan, never the source branch.
    pub fn set_deferred(
        &mut self,
        id: &str,
        options: WorkspaceOptions,
        manager: &WorkspaceManager,
        retire_terminal: impl FnOnce() -> Result<(), String>,
    ) -> Result<DeferredResponse, String> {
        let previous = manager.begin_choice(id)?;
        let result = (|| {
            let tab = self
                .tabs
                .get(id)
                .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
            if !tab.changeable || tab.first_prompt {
                return Err("workspace cannot change after a task has started".into());
            }
            let source = tab.path.clone();
            let profile = tab.profile.clone();
            validate_deferred(&source, &options)?;
            let revision = tab.revision.wrapping_add(1);
            let mut prepared = if options.worktree {
                let mut next = tab.clone();
                next.workspace = None;
                next.deferred_workspace = Some(options);
                next
            } else {
                ensure_local_current(&source, &options)?;
                let mut next = self.prepare_selected(
                    source,
                    options,
                    None,
                    &runner::Native::default(),
                    Some(id),
                    None,
                )?;
                next.deferred_source = Some(next.path.clone());
                next.profile = profile;
                next.changeable = true;
                next
            };
            retire_terminal()?;
            prepared.revision = revision;
            let response = DeferredResponse {
                workspace: prepared.workspace.clone(),
                deferred_workspace: prepared.deferred_workspace.clone(),
            };
            self.tabs.insert(id.to_owned(), prepared);
            Ok(response)
        })();
        manager.finish_choice(
            id,
            previous,
            result
                .as_ref()
                .ok()
                .map(|response: &DeferredResponse| response.deferred_workspace.is_some()),
        );
        result
    }

    /// Snapshot before naming; rechecked under the same lifecycle guard before mutation.
    pub fn first_plan(
        &self,
        id: &str,
        cwd: &str,
        profile: &str,
        prompt: &FirstPrompt,
    ) -> Result<(Option<WorkspaceOptions>, u64), String> {
        naming::validate_prompt(prompt)?;
        let tab = self
            .tabs
            .get(id)
            .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
        if tab.profile != profile {
            return Err("conversation profile changed before workspace preparation".into());
        }
        let source = tab.deferred_source.as_deref().unwrap_or(&tab.path);
        let requested = inspect::folder(cwd)?;
        if requested != source && requested != tab.path {
            return Err("conversation workspace changed before first prompt".into());
        }
        if let Some(plan) = &tab.deferred_workspace {
            return Ok((Some(plan.clone()), tab.revision));
        }
        if tab.first_prompt {
            return Ok((None, tab.revision));
        }
        Err("conversation has no deferred first prompt".into())
    }

    pub fn semantic_slug(
        plan: &WorkspaceOptions,
        prompt: &FirstPrompt,
        profile: Option<&str>,
        context: &StartContext<'_>,
    ) -> Result<Option<String>, String> {
        if !plan.worktree {
            return Ok(None);
        }
        if let Some(branch) = &plan.branch_name {
            return naming::branch_slug(branch).map(Some);
        }
        let data = context
            .data
            .ok_or_else(|| "no durable app data folder is available for worktrees".to_string())?;
        naming::name_with_omp(data, profile, prompt, context.manager, context.ticket).map(Some)
    }

    pub fn finish_first(
        &mut self,
        request: FirstRequest<'_>,
        expected: (Option<WorkspaceOptions>, u64),
        slug: Option<&str>,
        context: StartContext<'_>,
    ) -> Result<Prepared, String> {
        context.manager.check_ticket(context.ticket)?;
        let FirstRequest {
            id,
            cwd,
            profile,
            prompt,
        } = request;
        let current = self.first_plan(id, cwd, profile, prompt)?;
        if current != expected {
            return Err("workspace choice changed during first-prompt preparation".into());
        }
        let tab = self
            .tabs
            .get(id)
            .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
        let Some(mut plan) = current.0 else {
            return Ok(tab.clone());
        };
        let source = tab.path.clone();
        plan.task.clone_from(&prompt.text);
        let directory = if plan.worktree {
            let slug = slug.ok_or_else(|| "worktree name is unavailable".to_string())?;
            naming::validate_slug(slug)?;
            let mut random = [0u8; 3];
            SystemRandom::new()
                .fill(&mut random)
                .map_err(|_| "cannot generate a unique worktree name".to_string())?;
            let mut suffix = String::with_capacity(6);
            for byte in random {
                suffix.push(char::from(HEX[usize::from(byte >> 4)]));
                suffix.push(char::from(HEX[usize::from(byte & 15)]));
            }
            let name = format!("{slug}-{suffix}");
            if plan.branch_name.is_none() {
                plan.branch_name = Some(format!("omp/{name}"));
            }
            Some(name)
        } else {
            ensure_local_current(&source, &plan)?;
            None
        };
        let native = runner::Native::for_start(context.manager, context.ticket);
        let mut next = self.prepare_selected(
            source.clone(),
            plan,
            context.data,
            &native,
            Some(id),
            directory.as_deref(),
        )?;
        next.deferred_source = Some(source);
        profile.clone_into(&mut next.profile);
        next.first_prompt = true;
        next.changeable = false;
        self.tabs.insert(id.to_owned(), next.clone());
        Ok(next)
    }

    pub fn first_spawned(&mut self, id: &str, manager: &WorkspaceManager) -> Result<(), String> {
        let tab = self
            .tabs
            .get_mut(id)
            .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
        tab.first_prompt = false;
        manager.first_spawned(id);
        Ok(())
    }

    pub fn can_respawn(&self, id: &str) -> Result<(), String> {
        if self.tabs.get(id).is_some_and(|tab| tab.first_prompt) {
            return Err("retry the first prompt to start the prepared workspace".into());
        }
        Ok(())
    }

    pub fn admit_terminal(&self, id: &str) -> Result<(), String> {
        if self
            .tabs
            .get(id)
            .is_some_and(|tab| tab.deferred_workspace.is_some() || tab.first_prompt)
        {
            return Err(
                "choose or prepare the conversation workspace before opening a terminal".into(),
            );
        }
        Ok(())
    }

    pub fn prepare_for_start(
        &mut self,
        id: &str,
        cwd: &str,
        options: Option<WorkspaceOptions>,
        context: StartContext<'_>,
    ) -> Result<Prepared, String> {
        let native = runner::Native::for_start(context.manager, context.ticket);
        self.prepare_with(id, cwd, options, context.data, &native)
    }

    #[cfg(test)]
    fn prepare(
        &mut self,
        id: &str,
        cwd: &str,
        options: Option<WorkspaceOptions>,
        data: Option<&Path>,
    ) -> Result<Prepared, String> {
        self.prepare_with(id, cwd, options, data, &runner::Native::default())
    }

    fn prepare_with(
        &mut self,
        id: &str,
        cwd: &str,
        options: Option<WorkspaceOptions>,
        data: Option<&Path>,
        runner: &impl runner::Runner,
    ) -> Result<Prepared, String> {
        if id.is_empty() {
            return Err("session id must not be empty".to_string());
        }
        let path = if cwd.is_empty() {
            String::new()
        } else {
            inspect::folder(cwd)?
        };
        if let Some(existing) = self.tabs.get(id) {
            if existing.path != path || options.is_some() {
                return Err("an existing tab cannot change its workspace".to_string());
            }
            // Return an owned response copy while the registry keeps its
            // original binding across profile/approval respawns.
            return Ok(existing.clone());
        }
        let prepared = if let Some(options) = options {
            if path.is_empty() {
                return Err("workspace requires a project folder".to_string());
            }
            self.prepare_selected(path, options, data, runner, None, None)?
        } else {
            // Pathless agents inherit the app cwd, while their terminal uses
            // home. Keep both actual folders so future ownership can be checked.
            let default_cwd = if path.is_empty() {
                let current = std::env::current_dir()
                    .map_err(|e| format!("cannot resolve default working directory: {e}"))?;
                Some(crate::external_open::canonical_folder(&current)?)
            } else {
                None
            };
            let terminal_cwd = if path.is_empty() {
                crate::widgets::config::home_dir()
                    .filter(|home| Path::new(home).is_absolute())
                    .and_then(|home| crate::external_open::canonical_folder(Path::new(&home)).ok())
            } else {
                None
            };
            Prepared {
                path,
                workspace: None,
                deferred_workspace: None,
                first_prompt: false,
                deferred_source: None,
                changeable: false,
                revision: 0,
                profile: crate::profiles::DEFAULT_PROFILE_ID.to_string(),
                storage_id: None,
                default_cwd,
                terminal_cwd,
            }
        };
        // Both the response and the registry own a binding: the latter must
        // outlive the start response until the tab and its children are closed.
        self.tabs.insert(id.to_string(), prepared.clone());
        Ok(prepared)
    }

    fn prepare_selected(
        &self,
        path: String,
        options: WorkspaceOptions,
        data: Option<&Path>,
        runner: &impl runner::Runner,
        excluded: Option<&str>,
        directory: Option<&str>,
    ) -> Result<Prepared, String> {
        if options.branch_name.is_some() && (!options.worktree || options.task.trim().is_empty()) {
            return Err("creating a branch requires a task and a worktree".to_string());
        }
        let mut info = inspect::read(path)?;
        let identity = PathBuf::from(info.repo_root.as_deref().unwrap_or(&info.path));
        let project_path = std::mem::take(&mut info.project_path);
        let actual = if info.repo_root.is_some() {
            let owners = if options.worktree {
                0
            } else {
                self.owners_excluding(&identity, excluded, false)?
            };
            selected_repo(info, &options, owners, data, runner, directory)?
        } else {
            if options.worktree || options.base_ref.is_some() || options.base_commit.is_some() {
                return Err("a non-git folder has no branch or worktree".to_string());
            }
            if self.owners_excluding(&identity, excluded, false)? > 0 && !options.acknowledge_shared
            {
                return Err("acknowledge sharing the already owned workspace".to_string());
            }
            info.path
        };
        Ok(Prepared {
            path: actual,
            deferred_workspace: None,
            first_prompt: false,
            deferred_source: None,
            changeable: false,
            revision: 0,
            profile: crate::profiles::DEFAULT_PROFILE_ID.to_string(),
            storage_id: None,
            workspace: Some(WorkspaceBinding {
                project_path,
                base_ref: options.base_ref,
                base_commit: options.base_commit,
                worktree: options.worktree,
            }),
            default_cwd: None,
            terminal_cwd: None,
        })
    }
}

fn validate_deferred(path: &str, options: &WorkspaceOptions) -> Result<(), String> {
    let info = inspect::read(inspect::folder(path)?)?;
    if info.repo_root.is_none() {
        return Err("a deferred workspace requires a Git project".into());
    }
    if !options.worktree && options.branch_name.is_some() {
        return Err("creating a branch requires a worktree".into());
    }
    if options.task.len() > 32768
        || options.branch_name.as_ref().is_some_and(|s| s.len() > 1024)
        || options.base_ref.as_ref().is_some_and(|s| s.len() > 1024)
        || options.base_commit.as_ref().is_some_and(|s| s.len() > 128)
    {
        return Err("workspace selection is too long".into());
    }
    Ok(())
}

fn ensure_local_current(path: &str, options: &WorkspaceOptions) -> Result<(), String> {
    let info = inspect::read(inspect::folder(path)?)?;
    let same = match (options.base_ref.as_deref(), options.base_commit.as_deref()) {
        (None, None) => info.head.is_none(),
        (Some("HEAD"), Some(commit)) => {
            info.current_branch.is_none() && info.head.as_deref() == Some(commit)
        }
        (Some(reference), Some(commit)) => info.branches.iter().any(|branch| {
            !branch.remote
                && branch.ref_name == reference
                && branch.commit == commit
                && info.current_branch.as_deref() == Some(branch.name.as_str())
        }),
        _ => false,
    };
    if !same {
        return Err("Local must use the current branch; inspect the folder again".into());
    }
    Ok(())
}

fn selected_repo(
    info: WorkspaceInfo,
    options: &WorkspaceOptions,
    owners: usize,
    data: Option<&Path>,
    runner: &impl runner::Runner,
    directory: Option<&str>,
) -> Result<String, String> {
    let root = Path::new(
        info.repo_root
            .as_deref()
            .ok_or_else(|| "repository has no working folder".to_string())?,
    );
    let (selected, commit) = match (options.base_ref.as_deref(), options.base_commit.as_deref()) {
        (None, None) if info.head.is_none() => (None, None),
        (Some("HEAD"), Some(commit))
            if info.current_branch.is_none() && info.head.as_deref() == Some(commit) =>
        {
            (None, Some(commit))
        }
        (Some(reference), Some(commit)) => {
            let branch = info
                .branches
                .iter()
                .find(|branch| branch.ref_name == reference && branch.commit == commit)
                .ok_or_else(|| {
                    "selected branch or commit changed; inspect the folder again".to_string()
                })?;
            (Some(branch), Some(commit))
        }
        _ => return Err("selected branch or commit changed; inspect the folder again".to_string()),
    };
    if options.worktree {
        let commit = commit.ok_or_else(|| "a worktree requires a committed base".to_string())?;
        if let Some(name) = options.branch_name.as_deref() {
            validate_new_branch(root, name, runner)?;
        }
        return create_worktree(
            &info,
            root,
            data,
            commit,
            options.branch_name.as_deref(),
            directory,
            runner,
        );
    }
    let same = selected.is_none_or(|branch| {
        !branch.remote && info.current_branch.as_deref() == Some(branch.name.as_str())
    });
    if selected.is_some_and(|branch| branch.remote) {
        return Err("remote branches require a worktree".to_string());
    }
    let dirty = inspect::dirty(&info.path)?;
    if same {
        if (dirty || owners > 0) && !options.acknowledge_shared {
            return Err("acknowledge sharing the dirty or already owned workspace".to_string());
        }
    } else {
        if options.task.trim().is_empty() {
            return Err("switching branches requires a task".to_string());
        }
        if dirty || owners > 0 {
            return Err("cannot switch a dirty or owned workspace; use a worktree".to_string());
        }
        let branch = selected.ok_or_else(|| "invalid branch selection".to_string())?;
        runner.switch(root, &branch.name).map_err(|e| {
            format!(
                "{e}. The source checkout may have changed at {}",
                root.display()
            )
        })?;
        let after = inspect::read(info.path).map_err(|e| {
            format!(
                "branch was switched in {} but the selected folder is unavailable: {e}",
                root.display()
            )
        })?;
        if after.current_branch.as_deref() != Some(branch.name.as_str())
            || after.head.as_deref() != commit
        {
            return Err(format!(
                "branch or commit changed while switching {}; inspect it again",
                root.display()
            ));
        }
        return Ok(after.path);
    }
    Ok(info.path)
}

fn validate_new_branch(
    root: &Path,
    name: &str,
    runner: &impl runner::Runner,
) -> Result<(), String> {
    runner.validate_branch(root, name)?;
    let _gate = crate::spawn_gate::shared();
    #[allow(clippy::disallowed_methods)] // gix subprocesses hold the spawn gate
    let repo = gix::discover(root).map_err(|e| format!("cannot inspect repository: {e}"))?;
    let platform = repo
        .references()
        .map_err(|e| format!("cannot read refs: {e}"))?;
    let refs = platform
        .all()
        .map_err(|e| format!("cannot read refs: {e}"))?;
    let full = format!("refs/heads/{name}");
    for reference in refs {
        let reference = reference.map_err(|e| format!("cannot read ref: {e}"))?;
        let existing = reference.name().as_bstr();
        let existing: &[u8] = existing.as_ref();
        let wanted = full.as_bytes();
        if existing == wanted
            || (existing.starts_with(wanted) && existing.get(wanted.len()) == Some(&b'/'))
            || (wanted.starts_with(existing) && wanted.get(existing.len()) == Some(&b'/'))
        {
            return Err("branch name conflicts with an existing local branch".to_string());
        }
    }
    Ok(())
}

fn create_worktree(
    info: &WorkspaceInfo,
    root: &Path,
    data: Option<&Path>,
    commit: &str,
    branch: Option<&str>,
    directory: Option<&str>,
    runner: &impl runner::Runner,
) -> Result<String, String> {
    let data = data
        .filter(|p| p.is_absolute())
        .ok_or_else(|| "no durable app data folder is available for worktrees".to_string())?;
    let worktrees = data.join("conversation-worktrees");
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("cannot resolve source repository: {e}"))?;
    let resolved = crate::workspace::weakly_canonicalize(&worktrees)
        .map_err(|e| format!("cannot resolve worktree folder: {e}"))?;
    if resolved.starts_with(&canonical_root) {
        return Err("the app data worktree folder is inside the source repository".to_string());
    }
    crate::private_fs::private_dirs(true)
        .create(&worktrees)
        .map_err(|e| format!("cannot create worktree folder {}: {e}", worktrees.display()))?;
    let worktrees = std::fs::canonicalize(worktrees)
        .map_err(|e| format!("cannot resolve worktree folder: {e}"))?;
    if worktrees.starts_with(&canonical_root) {
        return Err("the app data worktree folder is inside the source repository".to_string());
    }
    // Drop Windows' verbatim prefix before passing the destination to Git.
    let worktrees = PathBuf::from(crate::external_open::canonical_folder(&worktrees)?);
    let dest = if let Some(directory) = directory {
        worktrees.join(format!("conversation-{directory}"))
    } else {
        let mut random = [0u8; 16];
        SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| "cannot generate a unique worktree name".to_string())?;
        let mut suffix = String::with_capacity(random.len() * 2);
        for byte in random {
            suffix.push(char::from(HEX[usize::from(byte >> 4)]));
            suffix.push(char::from(HEX[usize::from(byte & 15)]));
        }
        worktrees.join(format!("conversation-{suffix}"))
    };
    if dest.exists() {
        return Err("generated worktree folder already exists; try again".to_string());
    }
    let artifacts = |error: String| {
        branch.map_or_else(
            || format!("{error}. Worktree artifacts, if created, were retained at {}", dest.display()),
            |name| format!("{error}. Worktree artifacts, if created, were retained at {} and branch {name}", dest.display()),
        )
    };
    runner
        .worktree(root, branch, &dest, commit)
        .map_err(artifacts)?;
    let dest_text = inspect::folder(
        dest.to_str()
            .ok_or_else(|| artifacts("worktree path is not UTF-8".to_string()))?,
    )
    .map_err(artifacts)?;
    let actual_root = inspect::repo_root(Path::new(&dest_text)).map_err(artifacts)?;
    if actual_root.as_deref() != Some(dest_text.as_str()) {
        return Err(artifacts(
            "native command did not create an independent worktree".to_string(),
        ));
    }
    let actual = inspect::read(dest_text).map_err(artifacts)?;
    if actual.head.as_deref() != Some(commit) || actual.current_branch.as_deref() != branch {
        return Err(artifacts(
            "native worktree has an unexpected branch or commit".to_string(),
        ));
    }
    let relative = Path::new(&info.path)
        .strip_prefix(root)
        .map_err(|_| artifacts("selected folder is outside its repository".to_string()))?;
    let folder = Path::new(&actual.path).join(relative);
    let mapped = inspect::folder(
        folder
            .to_str()
            .ok_or_else(|| artifacts("mapped folder is not UTF-8".to_string()))?,
    )
    .map_err(artifacts)?;
    if !Path::new(&mapped).starts_with(&actual.path) {
        return Err(artifacts(
            "mapped project folder escapes the worktree".to_string(),
        ));
    }
    Ok(mapped)
}
