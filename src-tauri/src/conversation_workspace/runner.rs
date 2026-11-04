use super::{process, Admission, WorkspaceManager};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const CHECKOUT_TIMEOUT: Duration = Duration::from_secs(300);

/// The branch a new worktree checks out.
#[derive(Clone, Copy)]
pub(super) enum WorktreeBranch<'a> {
    Detached,
    /// Created at the commit (`-b`), never an existing name.
    New(&'a str),
    /// An existing local branch whose tip is the commit.
    Existing(&'a str),
}

impl<'a> WorktreeBranch<'a> {
    pub(super) const fn name(self) -> Option<&'a str> {
        match self {
            Self::Detached => None,
            Self::New(name) | Self::Existing(name) => Some(name),
        }
    }
}

pub(super) trait Runner {
    fn validate_branch(&self, root: &Path, name: &str) -> Result<(), String> {
        validate_branch(root, name, || false)
    }
    fn switch(&self, root: &Path, branch: &str) -> Result<(), String>;
    fn worktree(
        &self,
        root: &Path,
        branch: WorktreeBranch<'_>,
        dest: &Path,
        commit: &str,
    ) -> Result<(), String>;
}

#[derive(Default)]
pub(super) struct Native<'a> {
    cancellation: Option<(&'a WorkspaceManager, &'a Admission)>,
}

impl<'a> Native<'a> {
    pub const fn for_start(manager: &'a WorkspaceManager, ticket: &'a Admission) -> Self {
        Self {
            cancellation: Some((manager, ticket)),
        }
    }

    fn execute(&self, command: &mut Command, label: &str) -> Result<(), String> {
        let output = process::run(
            command,
            || {
                self.cancellation
                    .is_some_and(|(manager, ticket)| manager.check_ticket(ticket).is_err())
            },
            CHECKOUT_TIMEOUT,
        )?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "{label} failed (including any checkout hook failure): {} {}",
            String::from_utf8_lossy(&output.stderr).trim(),
            String::from_utf8_lossy(&output.stdout).trim()
        ))
    }
}

impl Runner for Native<'_> {
    fn validate_branch(&self, root: &Path, name: &str) -> Result<(), String> {
        validate_branch(root, name, || {
            self.cancellation
                .is_some_and(|(manager, ticket)| manager.check_ticket(ticket).is_err())
        })
    }

    fn switch(&self, root: &Path, branch: &str) -> Result<(), String> {
        let mut command = git(root)?;
        command.args([
            "--no-optional-locks",
            "switch",
            "--no-guess",
            "--no-overwrite-ignore",
            "--no-recurse-submodules",
            "--",
            branch,
        ]);
        self.execute(&mut command, "git switch")
    }

    fn worktree(
        &self,
        root: &Path,
        branch: WorktreeBranch<'_>,
        dest: &Path,
        commit: &str,
    ) -> Result<(), String> {
        let mut command = git(root)?;
        // This is an explicit checkout mutation: Git's normal checkout filters
        // and post-checkout hook still run, just as with an in-place switch.
        command.args(["worktree", "add"]);
        let start = match branch {
            WorktreeBranch::New(name) => {
                command.args(["-b", name]);
                commit
            }
            WorktreeBranch::Detached => {
                command.arg("--detach");
                commit
            }
            // Git refuses a branch already checked out elsewhere; the caller
            // verifies the checked-out branch and commit afterwards.
            WorktreeBranch::Existing(name) => name,
        };
        command.arg("--").arg(dest).arg(start);
        self.execute(&mut command, "git worktree add")
    }
}

fn validate_branch(root: &Path, name: &str, cancelled: impl Fn() -> bool) -> Result<(), String> {
    // Git's --branch form accepts previous-checkout expressions. Those expand
    // to another name and are not an explicit branch name.
    if name.is_empty() || name.starts_with("@{-") || name.starts_with("refs/heads/") {
        return Err("invalid branch name".to_string());
    }
    let mut command = git(root)?;
    command.args(["check-ref-format", "--branch", name]);
    let output = process::run(&mut command, cancelled, CHECKOUT_TIMEOUT)?;
    if !output.status.success() {
        return Err("invalid branch name".to_string());
    }
    Ok(())
}

fn git(root: &Path) -> Result<Command, String> {
    let program = crate::child_path::locate_program(&crate::child_path::child_path_dirs(), "git")?;
    let mut command = Command::new(program.binary);
    command.env("PATH", program.path).current_dir(root);
    // Inherited Git settings can redirect the repository, index, object store,
    // or configuration away from the checkout we inspected.
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(name);
        }
    }
    Ok(command)
}
