//! Tool-free, bounded naming using the conversation's resolved omp profile.
//! The same request reports the task's explicit Git instructions.
use super::git_intent::{self, GitIntent};
use super::{process, Admission, FirstPrompt, WorkspaceManager};
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub provider: String,
    pub id: String,
}

pub(super) fn validate_prompt(prompt: &FirstPrompt) -> Result<(), String> {
    if prompt.attempt == 0 {
        return Err("first-prompt attempt must be positive".into());
    }
    if prompt.text.trim().is_empty() {
        return Err("first prompt must be nonempty".into());
    }
    if let Some(model) = &prompt.model {
        for value in [&model.provider, &model.id] {
            if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err("invalid first-prompt model".into());
            }
        }
    }
    Ok(())
}

pub(super) fn validate_slug(slug: &str) -> Result<(), String> {
    let bytes = slug.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 48
        || !bytes[0].is_ascii_lowercase()
        || !bytes[bytes.len() - 1].is_ascii_alphanumeric()
        || bytes
            .iter()
            .any(|b| !b.is_ascii_lowercase() && !b.is_ascii_digit() && *b != b'-')
        || slug.contains("--")
    {
        return Err("naming model returned an invalid worktree slug".into());
    }
    Ok(())
}

/// Manual branch names remain exact. The directory uses only their safe text.
pub(super) fn branch_slug(branch: &str) -> Result<String, String> {
    let mut slug = String::new();
    for c in branch.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_digit() && slug.is_empty() {
            slug.push_str("branch-");
        }
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if slug.len() < 48 {
                slug.push(c);
            }
        } else if !slug.is_empty() && !slug.ends_with('-') && slug.len() < 48 {
            slug.push('-');
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        let first = branch
            .chars()
            .next()
            .ok_or_else(|| "branch name is empty".to_string())?;
        slug = format!("branch-u{:x}", u32::from(first));
    }
    validate_slug(&slug)
        .map_err(|_| "branch name cannot produce a safe worktree directory".to_string())?;
    Ok(slug)
}

pub(super) fn name_with_omp(
    data: &Path,
    profile: Option<&str>,
    prompt: &FirstPrompt,
    manager: &WorkspaceManager,
    ticket: &Admission,
) -> Result<GitIntent, String> {
    validate_prompt(prompt)?;
    if !data.is_absolute() {
        return Err("no durable app data folder is available for worktrees".into());
    }
    crate::private_fs::private_dirs(true)
        .create(data)
        .map_err(|e| format!("cannot create app data folder: {e}"))?;
    let mut cmd = crate::agent::spawn::omp_command()?;
    cmd.current_dir(data).args([
        "--print",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-context-files",
        "--no-session",
        "--no-title",
        "--no-lsp",
        "--no-pty",
        "--thinking=off",
    ]);
    cmd.arg(format!("--system-prompt={}", git_intent::SYSTEM_PROMPT));
    if let Some(flag) = crate::agent::spawn::profile_flag(profile) {
        cmd.arg(flag);
    }
    if let Some(model) = &prompt.model {
        cmd.arg(format!("--provider={}", model.provider))
            .arg(format!("--model={}", model.id));
    }
    let task = prompt.text.trim();
    let mut end = task.len().min(8192);
    while !task.is_char_boundary(end) {
        end -= 1;
    }
    cmd.arg(format!("Task: {}", &task[..end]));
    run_naming(&mut cmd, manager, ticket, &task[..end])
}

fn run_naming(
    cmd: &mut std::process::Command,
    manager: &WorkspaceManager,
    ticket: &Admission,
    task: &str,
) -> Result<GitIntent, String> {
    let output = process::run(
        cmd,
        || manager.check_ticket(ticket).is_err(),
        Duration::from_secs(60),
    )
    .map_err(|e| format!("worktree naming failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "worktree naming failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout_truncated {
        return Err("naming model output exceeded the limit".into());
    }
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| "naming model returned non-UTF-8 output")?;
    git_intent::parse(text, task)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const TASK: &str = "Fix the parser from develop";

    #[test]
    fn naming_process_refuses_failures_bad_output_and_cancellation() {
        let manager = WorkspaceManager::default();
        let ticket = manager.ticket("naming").unwrap();
        let mut failure = crate::test_support::shell("echo failed >&2; exit 1");
        assert!(run_naming(&mut failure, &manager, &ticket, TASK).is_err());
        let mut invalid = crate::test_support::shell("printf '{\"slug\":\"../bad\"}\\n'");
        assert!(run_naming(&mut invalid, &manager, &ticket, TASK).is_err());
        let mut valid = crate::test_support::shell(
            "printf '{\"slug\":\"fix-parser\",\"base\":\"develop\"}\\n'",
        );
        let intent = run_naming(&mut valid, &manager, &ticket, TASK).unwrap();
        assert_eq!(
            (intent.slug.as_str(), intent.base.as_deref()),
            ("fix-parser", Some("develop"))
        );
        let mut oversized = crate::test_support::shell("i=0; while [ \"$i\" -lt 4200 ]; do printf x; i=$((i + 1)); done; printf '\\nvalid-slug\\n'");
        assert!(run_naming(&mut oversized, &manager, &ticket, TASK).is_err());
        manager.cancel_pending(&["naming"]);
        let mut cancelled = crate::test_support::shell("printf '{\"slug\":\"valid-slug\"}'");
        assert!(run_naming(&mut cancelled, &manager, &ticket, TASK).is_err());
    }

    #[test]
    fn closing_a_tab_terminates_an_inflight_naming_process() {
        let manager = WorkspaceManager::default();
        let ticket = manager.ticket("naming").unwrap();
        let dir = crate::test_support::TempDir::new("workspace-naming", "cancel");
        let marker = dir.path().join("started");
        let script = format!(
            "printf started > {:?}; exec sleep 30",
            marker.to_str().unwrap()
        );
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let mut command = crate::test_support::shell(&script);
                run_naming(&mut command, &manager, &ticket, TASK)
            });
            let started =
                crate::test_support::wait_until(Duration::from_secs(5), || marker.exists());
            manager.cancel_pending(&["naming"]);
            let result = worker.join().unwrap();
            assert!(started);
            assert!(result.unwrap_err().contains("cancel"));
        });
    }

    #[test]
    fn cancelling_blocked_first_prompt_keeps_source_unmodified_and_pending() {
        use crate::conversation_workspace::{FirstRequest, StartContext, WorkspaceOptions};
        use crate::git_browser::fixture;

        let Some(repo) = fixture::init("cancel-blocked-first-prompt") else {
            return;
        };
        repo.write("file.txt", "base\n");
        repo.git(&["add", "."]);
        repo.commit("base", 1_700_000_000);
        repo.write("file.txt", "source edit\n");
        let source = crate::external_open::canonical_folder(repo.path()).unwrap();
        let before = repo.git(&["worktree", "list", "--porcelain"]);
        let data = crate::test_support::TempDir::new("workspace-naming", "cancel-first");
        let marker = data.path().join("started");
        let manager = WorkspaceManager::default();
        let registration = manager.ticket("tab").unwrap();
        let prompt = FirstPrompt {
            text: "Repair authentication".into(),
            model: None,
            attempt: 1,
        };
        let snapshot = {
            let mut registry = manager.lock();
            registry
                .prepare_deferred(
                    "tab",
                    &source,
                    WorkspaceOptions {
                        base_ref: None,
                        base_commit: None,
                        worktree: true,
                        acknowledge_shared: false,
                        task: String::new(),
                        branch_name: None,
                    },
                    StartContext {
                        data: Some(data.path()),
                        manager: &manager,
                        ticket: &registration,
                    },
                )
                .unwrap();
            registry
                .first_plan("tab", &source, "default", &prompt)
                .unwrap()
        };
        drop(registration);
        let ticket = manager.first_ticket("tab", 1).unwrap();
        let context = || StartContext {
            data: Some(data.path()),
            manager: &manager,
            ticket: &ticket,
        };
        let script = format!(
            "printf started > {:?}; exec sleep 30",
            marker.to_str().unwrap()
        );
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let admission = manager.begin_naming(&ticket).unwrap();
                let mut command = crate::test_support::shell(&script);
                let result = run_naming(&mut command, &manager, &ticket, TASK);
                drop(admission);
                result
            });
            let started =
                crate::test_support::wait_until(Duration::from_secs(5), || marker.exists());
            manager.cancel_first("tab", 1).unwrap();
            let result = worker.join().unwrap();
            assert!(started);
            assert!(result.unwrap_err().contains("cancel"));
        });
        let mut registry = manager.lock();
        assert!(registry
            .finish_first(
                FirstRequest {
                    id: "tab",
                    cwd: &source,
                    profile: "default",
                    prompt: &prompt,
                },
                snapshot,
                Some(git_intent::named("repair-authentication")),
                context()
            )
            .is_err());
        assert!(registry.get("tab").unwrap().deferred_workspace.is_some());
        drop(registry);
        assert!(manager.admit_command("tab", true).is_err());
        assert!(!data.path().join("conversation-worktrees").exists());
        assert_eq!(repo.git(&["worktree", "list", "--porcelain"]), before);
        assert_eq!(
            std::fs::read_to_string(repo.path().join("file.txt")).unwrap(),
            "source edit\n"
        );
    }

    #[test]
    fn shutdown_waits_for_the_naming_process_to_be_killed_and_reaped() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let manager = WorkspaceManager::default();
        let ticket = manager.ticket("naming-shutdown").unwrap();
        let dir = crate::test_support::TempDir::new("workspace-naming", "shutdown-barrier");
        let marker = dir.path().join("pid");
        let script = format!(
            "printf '%s' $$ > {:?}; exec sleep 30",
            marker.to_str().unwrap()
        );
        let finished = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let admission = manager.begin_naming(&ticket).unwrap();
                let mut command = crate::test_support::shell(&script);
                let result = run_naming(&mut command, &manager, &ticket, TASK);
                finished.store(true, Ordering::SeqCst);
                drop(admission);
                result
            });
            let pid = crate::test_support::eventually(Duration::from_secs(5), || {
                std::fs::read_to_string(&marker).ok()?.parse::<i32>().ok()
            });
            manager.shutdown();
            assert!(
                finished.load(Ordering::SeqCst),
                "shutdown returned before the naming worker settled"
            );
            let pid = pid.expect("naming child did not start");
            // The supervisor reaps its child before releasing admission.
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert!(manager.begin_naming(&ticket).is_err());
            assert!(worker.join().unwrap().unwrap_err().contains("cancel"));
        });
    }
}
