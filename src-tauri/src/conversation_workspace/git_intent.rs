//! Explicit Git instructions in a Worktree conversation's first prompt.
//!
//! The tool-free naming request reports them beside the slug. Rust accepts
//! only text that occurs in the task and settles conflicts before any Git
//! mutation, so the coding agent never receives a task whose branch or
//! worktree contradicts it.
use super::inspect::WorkspaceInfo;
use super::WorkspaceOptions;

pub(super) const SYSTEM_PROMPT: &str = "Reply with one JSON object and nothing else: \
{\"slug\":\"...\"} plus only the optional fields the task explicitly asks for. slug: a short \
lowercase kebab-case Git branch slug describing the task (1-48 ASCII lowercase letters, digits \
and single hyphens; start with a letter, end with a letter or digit). Optional fields, each \
copied exactly from the task text: branch (an exact new branch name to create), prefix (a \
requested branch-name prefix), base (the branch to start from), existingBranch (an existing \
branch to work on), noNewBranch (the words asking not to create a branch), noWorktree (the words \
asking not to use a worktree or separate checkout). Never infer, translate or invent them.";

/// The naming model's reply: every field but `slug` is absent or task text.
#[derive(Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitIntent {
    pub slug: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub existing_branch: Option<String>,
    /// The task's words asking for no new branch.
    #[serde(default)]
    pub no_new_branch: Option<String>,
    /// The task's words asking for no worktree.
    #[serde(default)]
    pub no_worktree: Option<String>,
}

/// How the first-prompt checkout gets its branch.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Branch {
    /// `<prefix><slug>-<suffix>`; `omp/` unless the task named a prefix.
    Generated(String),
    /// An exact new branch named in setup or the task.
    Exact(String),
    /// An existing local branch, checked out without creating one.
    Existing(String),
    /// The task asked for no new branch: a detached checkout.
    Detached,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Resolved {
    pub branch: Branch,
    /// A start point the task named; resolved against the source's branches.
    pub base: Option<String>,
    pub slug: String,
}

/// The checkout folder name and whether its branch already exists.
pub(super) struct Checkout {
    pub directory: String,
    pub existing: bool,
}

const UNCONFIRMED: &str = "could not confirm this message's Git instructions; nothing was \
created. Send it again, quoting branch names exactly";

/// Accept one JSON object whose instructions all occur in the task.
pub(super) fn parse(reply: &str, task: &str) -> Result<GitIntent, String> {
    let json = match (reply.find('{'), reply.rfind('}')) {
        (Some(start), Some(end)) if start < end => &reply[start..=end],
        _ => return Err("naming model returned no Git intent".into()),
    };
    let mut intent: GitIntent = serde_json::from_str(json)
        .map_err(|_| "naming model returned an unreadable Git intent".to_string())?;
    super::naming::validate_slug(&intent.slug)?;
    for name in [
        &mut intent.branch,
        &mut intent.prefix,
        &mut intent.base,
        &mut intent.existing_branch,
    ] {
        normalize(name, &['`', '"', '\'', ' ']);
        // Git names are case-sensitive and must be the user's own text.
        if name.as_deref().is_some_and(|text| !task.contains(text)) {
            return Err(UNCONFIRMED.into());
        }
    }
    let lowered = task.to_lowercase();
    for quote in [&mut intent.no_new_branch, &mut intent.no_worktree] {
        normalize(quote, &[' ']);
        if quote
            .as_deref()
            .is_some_and(|text| !lowered.contains(&text.to_lowercase()))
        {
            return Err(UNCONFIRMED.into());
        }
    }
    Ok(intent)
}

fn normalize(field: &mut Option<String>, wrappers: &[char]) {
    if let Some(text) = field.as_mut() {
        let trimmed = text.trim().trim_matches(wrappers);
        if trimmed.len() != text.len() {
            *text = trimmed.to_owned();
        }
    }
    if field.as_deref().is_some_and(str::is_empty) {
        *field = None;
    }
}

fn conflict(what: &str) -> String {
    format!(
        "This message asks for {what}. These Git instructions conflict, so nothing was \
         created; edit the message and send it again"
    )
}

/// Settle setup and task instructions. Explicit instructions win over the
/// generated default; incompatible ones are surfaced, never dropped.
pub(super) fn resolve(setup: Option<String>, intent: GitIntent) -> Result<Resolved, String> {
    let GitIntent {
        slug,
        branch,
        prefix,
        base,
        existing_branch,
        no_new_branch,
        no_worktree,
    } = intent;
    if let Some(quote) = no_worktree {
        return Err(format!(
            "This conversation is set to Worktree, but the message says “{quote}”. Nothing was \
             created; choose Local or edit the message, then send it again"
        ));
    }
    if let (Some(setup), Some(task)) = (setup.as_deref(), branch.as_deref()) {
        if setup != task {
            return Err(conflict(&format!(
                "branch “{task}” while setup names “{setup}”"
            )));
        }
    }
    let setup_named = setup.is_some();
    let named = setup.or(branch);
    if let Some(existing) = existing_branch {
        if setup_named || named.as_deref().is_some_and(|name| name != existing) {
            let name = named.unwrap_or_default();
            return Err(conflict(&format!(
                "a new branch “{name}” and the existing branch “{existing}”"
            )));
        }
        if prefix.is_some() || base.is_some() {
            return Err(conflict(&format!(
                "the existing branch “{existing}” with a new prefix or base"
            )));
        }
        return Ok(Resolved {
            branch: Branch::Existing(existing),
            base: None,
            slug,
        });
    }
    if let Some(quote) = no_new_branch {
        if named.is_some() || prefix.is_some() {
            return Err(conflict(&format!(
                "a branch name or prefix and also “{quote}”"
            )));
        }
        return Ok(Resolved {
            branch: Branch::Detached,
            base,
            slug,
        });
    }
    let branch = match (named, prefix) {
        (Some(name), Some(prefix)) if !name.starts_with(&prefix) => {
            return Err(conflict(&format!(
                "branch “{name}” and the prefix “{prefix}”"
            )));
        }
        (Some(name), _) => Branch::Exact(name),
        (None, Some(mut prefix)) => {
            if !prefix.ends_with(['/', '-', '_']) {
                prefix.push('/');
            }
            Branch::Generated(prefix)
        }
        (None, None) => Branch::Generated("omp/".into()),
    };
    Ok(Resolved { branch, base, slug })
}

/// Point the plan at the resolved base or existing branch and name the
/// checkout. Only branches this inspection read can be selected.
pub(super) fn apply(
    info: WorkspaceInfo,
    plan: &mut WorkspaceOptions,
    resolved: Resolved,
    suffix: &str,
) -> Result<Checkout, String> {
    let Resolved { branch, base, slug } = resolved;
    let current = info.current_branch;
    let mut branches = info.branches;
    let mut take = |matches: &dyn Fn(&super::inspect::Branch) -> bool| {
        let index = branches.iter().position(matches)?;
        Some(branches.swap_remove(index))
    };
    if let Some(base) = base {
        // Local branches sort first, so `main` prefers `main` to a remote.
        let found =
            take(&|branch| branch.name == base || branch.ref_name == base).ok_or_else(|| {
                format!(
                    "The message's base “{base}” is not a local or remote-tracking branch \
                     here; nothing was created"
                )
            })?;
        plan.base_ref = Some(found.ref_name);
        plan.base_commit = Some(found.commit);
    }
    let (directory, existing) = match branch {
        Branch::Existing(name) => {
            if current.as_deref() == Some(name.as_str()) {
                return Err(format!(
                    "“{name}” is checked out in the source folder; choose Local to work on it \
                     there. Nothing was created"
                ));
            }
            let found = take(&|branch| !branch.remote && branch.name == name).ok_or_else(|| {
                format!("The message's branch “{name}” does not exist locally; nothing was created")
            })?;
            plan.base_ref = Some(found.ref_name);
            plan.base_commit = Some(found.commit);
            let directory = super::naming::branch_slug(&name)?;
            plan.branch_name = Some(name);
            (directory, true)
        }
        Branch::Exact(name) => {
            let directory = super::naming::branch_slug(&name)?;
            plan.branch_name = Some(name);
            (directory, false)
        }
        Branch::Generated(prefix) => {
            plan.branch_name = Some(format!("{prefix}{slug}-{suffix}"));
            (slug, false)
        }
        Branch::Detached => {
            plan.branch_name = None;
            (slug, false)
        }
    };
    Ok(Checkout {
        directory: format!("{directory}-{suffix}"),
        existing,
    })
}

/// A reply naming the task with no explicit Git instructions.
#[cfg(test)]
pub(super) fn named(slug: &str) -> GitIntent {
    GitIntent {
        slug: slug.into(),
        ..GitIntent::default()
    }
}

#[cfg(test)]
mod tests {
    use super::{named as intent, parse, resolve, Branch, Resolved};

    #[test]
    fn replies_must_be_strict_json_with_a_safe_slug() {
        let task = "Fix the parser";
        assert_eq!(
            parse("```json\n{\"slug\":\"fix-parser\"}\n```", task).unwrap(),
            intent("fix-parser")
        );
        assert!(parse("fix-parser", task).is_err());
        assert!(parse(r#"{"slug":"../bad"}"#, task).is_err());
        assert!(parse(r#"{"slug":"fix-parser","extra":1}"#, task).is_err());
        let nulls = r#"{"slug":"fix-parser","branch":null,"noWorktree":"  "}"#;
        assert_eq!(parse(nulls, task).unwrap(), intent("fix-parser"));
    }

    #[test]
    fn every_instruction_must_be_copied_from_the_task() {
        let task = "Fix login on branch `feat/Login-Fix` from develop. Don't create a worktree.";
        let reply = r#"{"slug":"fix-login","branch":"`feat/Login-Fix`","base":"develop",
            "noWorktree":"don't create a worktree"}"#;
        let parsed = parse(reply, task).unwrap();
        assert_eq!(parsed.branch.as_deref(), Some("feat/Login-Fix"));
        assert_eq!(
            parsed.no_worktree.as_deref(),
            Some("don't create a worktree")
        );
        // A changed case or an invented name is not the user's instruction.
        assert!(parse(r#"{"slug":"fix-login","branch":"feat/login-fix"}"#, task).is_err());
        assert!(parse(r#"{"slug":"fix-login","base":"main"}"#, task).is_err());
        assert!(parse(r#"{"slug":"fix-login","noNewBranch":"no branch"}"#, task).is_err());
    }

    #[test]
    fn defaults_and_explicit_names_resolve_without_conflict() {
        assert_eq!(
            resolve(None, intent("fix-parser")).unwrap(),
            Resolved {
                branch: Branch::Generated("omp/".into()),
                base: None,
                slug: "fix-parser".into()
            }
        );
        let mut named = intent("fix-parser");
        named.branch = Some("feat/parser".into());
        named.prefix = Some("feat/".into());
        named.base = Some("develop".into());
        let resolved = resolve(Some("feat/parser".into()), named).unwrap();
        assert_eq!(resolved.branch, Branch::Exact("feat/parser".into()));
        assert_eq!(resolved.base.as_deref(), Some("develop"));
        let mut prefixed = intent("fix-parser");
        prefixed.prefix = Some("felipe".into());
        assert_eq!(
            resolve(None, prefixed).unwrap().branch,
            Branch::Generated("felipe/".into())
        );
        let mut detached = intent("fix-parser");
        detached.no_new_branch = Some("no new branch".into());
        assert_eq!(resolve(None, detached).unwrap().branch, Branch::Detached);
        let mut existing = intent("fix-parser");
        existing.existing_branch = Some("feat/old".into());
        existing.branch = Some("feat/old".into());
        existing.no_new_branch = Some("keep using it".into());
        assert_eq!(
            resolve(None, existing).unwrap().branch,
            Branch::Existing("feat/old".into())
        );
    }

    #[test]
    fn incompatible_instructions_are_surfaced_not_dropped() {
        let mut no_worktree = intent("fix");
        no_worktree.no_worktree = Some("work in this checkout".into());
        assert!(resolve(None, no_worktree)
            .unwrap_err()
            .contains("work in this checkout"));
        let mut renamed = intent("fix");
        renamed.branch = Some("feat/b".into());
        assert!(resolve(Some("feat/a".into()), renamed).is_err());
        let mut setup_existing = intent("fix");
        setup_existing.existing_branch = Some("feat/a".into());
        assert!(resolve(Some("feat/a".into()), setup_existing).is_err());
        let mut existing_base = intent("fix");
        existing_base.existing_branch = Some("feat/a".into());
        existing_base.base = Some("main".into());
        assert!(resolve(None, existing_base).is_err());
        let mut detached_named = intent("fix");
        detached_named.no_new_branch = Some("no branch".into());
        assert!(resolve(Some("feat/a".into()), detached_named).is_err());
        let mut wrong_prefix = intent("fix");
        wrong_prefix.branch = Some("feat/a".into());
        wrong_prefix.prefix = Some("fix/".into());
        assert!(resolve(None, wrong_prefix).is_err());
    }
}
