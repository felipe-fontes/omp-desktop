//! Feature-branch instructions for the agent's explicitly selected workspace.
//!
//! Only Local conversations get them. A pending source process is
//! metadata-only and runs no task; a managed worktree's branch is created
//! natively on the first prompt, so the agent must not create a second one.

use std::path::Path;

pub(super) fn for_launch(
    cwd: Option<&str>,
    metadata_only: bool,
    managed_worktree: bool,
) -> Option<&'static str> {
    if metadata_only || managed_worktree {
        return None;
    }
    for_workspace(cwd)
}

/// No selected working tree means no branch-policy text reaches the agent.
fn for_workspace(cwd: Option<&str>) -> Option<&'static str> {
    let path = Path::new(cwd?);
    if !path.is_absolute() {
        return None;
    }
    let (_gate, repo) = crate::spawn_gate::discover(path).ok()?;
    repo.workdir().map(|_| include_str!("branch-policy.txt"))
}

#[cfg(test)]
mod tests {
    use super::{for_launch, for_workspace};
    use crate::git_browser::fixture;
    use crate::test_support::TempDir;

    #[test]
    fn only_a_full_local_process_receives_branch_instructions() {
        let Some(repo) = fixture::init("branch-policy-launch") else {
            return;
        };
        let cwd = repo.path().to_str();
        assert!(for_launch(cwd, false, false).is_some());
        // The native manager already created this worktree's branch.
        assert!(for_launch(cwd, false, true).is_none());
        // A pending source process may not run tasks at all.
        assert!(for_launch(cwd, true, false).is_none());
        assert!(for_launch(cwd, true, true).is_none());
    }

    #[test]
    fn non_git_workspace_receives_no_branch_instructions() {
        let folder = TempDir::new("branch-policy", "non-git");
        assert!(for_workspace(folder.path().to_str()).is_none());
        assert!(!folder.path().join(".git").exists());
    }

    #[test]
    fn no_workspace_does_not_inherit_the_apps_repository() {
        assert!(for_workspace(None).is_none());
        assert!(for_workspace(Some("")).is_none());
        assert!(for_workspace(Some(".")).is_none());
    }

    #[test]
    fn an_unborn_working_tree_receives_branch_instructions() {
        let Some(repo) = fixture::init("branch-policy-unborn") else {
            return;
        };
        assert!(for_workspace(repo.path().to_str()).is_some());
    }

    #[test]
    fn a_repository_subfolder_receives_branch_instructions() {
        let Some(repo) = fixture::init("branch-policy-subfolder") else {
            return;
        };
        repo.write("src/nested/file.txt", "fixture\n");
        assert!(for_workspace(repo.path().join("src/nested").to_str()).is_some());
    }

    #[test]
    fn a_detached_linked_worktree_receives_branch_instructions() {
        let Some(repo) = fixture::init("branch-policy-linked") else {
            return;
        };
        repo.commit("base", 1_700_000_000);
        let folder = TempDir::new("branch-policy", "linked");
        let checkout = folder.path().join("checkout");
        repo.git(&[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            checkout.to_str().expect("UTF-8 fixture path"),
            "HEAD",
        ]);
        assert!(checkout.join(".git").is_file());
        assert!(for_workspace(checkout.to_str()).is_some());
    }

    #[test]
    fn a_bare_repository_receives_no_branch_instructions() {
        if !fixture::git_available() {
            return;
        }
        let bare = fixture::Repo(crate::test_support::tempdir("branch-policy", "bare"));
        bare.git(&["init", "--quiet", "--bare"]);
        assert!(for_workspace(bare.path().to_str()).is_none());
    }

    #[test]
    fn an_empty_git_marker_is_not_a_repository() {
        let folder = TempDir::new("branch-policy", "invalid-marker");
        std::fs::create_dir(folder.path().join(".git")).expect("create invalid marker");
        assert!(for_workspace(folder.path().to_str()).is_none());
        assert!(!folder.path().join(".git/HEAD").exists());
    }

    #[test]
    fn a_missing_workspace_receives_no_branch_instructions() {
        let folder = TempDir::new("branch-policy", "missing");
        assert!(for_workspace(folder.path().join("absent").to_str()).is_none());
    }
}
