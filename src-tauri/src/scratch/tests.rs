use super::{require_closed, store::Store, tree};
use crate::test_support::TempDir;
use std::fs;
use std::path::Path;

fn fixture(name: &str) -> (TempDir, Store) {
    let tmp = TempDir::new("chat-workspaces", name);
    let store = Store::new(&tmp.path().join("data")).unwrap();
    (tmp, store)
}

#[test]
fn creates_isolated_empty_private_workspaces_and_reopens_metadata() {
    let (tmp, store) = fixture("create");
    let first = store.create(None).unwrap();
    let second = store.create(Some("work".into())).unwrap();
    assert_ne!(first.id, second.id);
    assert_ne!(first.path, second.path);
    let workspace_parent =
        crate::external_open::canonical_folder(&tmp.path().join("data/chats/workspaces")).unwrap();
    assert!(Path::new(&first.path).starts_with(workspace_parent));
    assert_eq!(fs::read_dir(&first.path).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&second.path).unwrap().count(), 0);
    assert!(store.create(Some("../bad".into())).is_err());

    let reopened = Store::new(&tmp.path().join("data")).unwrap();
    let default = reopened.list(None).unwrap();
    let work = reopened.list(Some("work")).unwrap();
    assert_eq!(default.len(), 1);
    assert_eq!(default[0].id, first.id);
    assert_eq!(default[0].path, first.path);
    assert!(default[0].bytes.is_none());
    assert!(!default[0].complete);
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].id, second.id);
    assert_eq!(work[0].profile.as_deref(), Some("work"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(Path::new(&first.path)), 0o700);
        assert_eq!(mode(&tmp.path().join("data/chats")), 0o700);
        assert_eq!(mode(&tmp.path().join("data/chats/metadata")), 0o700);
    }
}

#[test]
fn update_persists_name_and_validated_session_and_clears_missing_or_new_session() {
    let (tmp, store) = fixture("metadata");
    let chat = store.create(Some("work".into())).unwrap();
    let session = tmp.path().join("session.jsonl");
    fs::write(&session, b"session\n").unwrap();
    let session = session.to_str().unwrap().to_owned();
    assert!(store
        .update(
            &chat.id,
            Some(session.clone()),
            Some("My chat".into()),
            |path, profile| {
                assert_eq!(profile, Some("work"));
                Ok(Some(path.to_owned()))
            }
        )
        .unwrap());
    let reopened = Store::new(&tmp.path().join("data")).unwrap();
    let list = reopened.list(Some("work")).unwrap();
    assert_eq!(list[0].name.as_deref(), Some("My chat"));
    assert_eq!(list[0].session_file.as_deref(), Some(session.as_str()));

    assert!(reopened
        .update(
            &chat.id,
            Some("bad".into()),
            Some("Should not persist".into()),
            |_, _| Err("wrong profile".into())
        )
        .is_err());
    let list = reopened.list(Some("work")).unwrap();
    assert_eq!(list[0].name.as_deref(), Some("My chat"));
    assert_eq!(list[0].session_file.as_deref(), Some(session.as_str()));

    assert!(!reopened
        .update(
            &chat.id,
            Some("missing".into()),
            Some("Renamed".into()),
            |_, _| Ok(None)
        )
        .unwrap());
    let list = reopened.list(Some("work")).unwrap();
    assert_eq!(list[0].name.as_deref(), Some("Renamed"));
    assert!(list[0].session_file.is_none());
    assert!(reopened
        .update(&chat.id, None, None, |_, _| panic!(
            "a cleared session is not validated"
        ))
        .unwrap());
    assert_eq!(
        reopened.list(Some("work")).unwrap()[0].name.as_deref(),
        Some("Renamed")
    );
}

#[test]
fn lists_nested_hidden_files_and_reports_bounded_measurement() {
    let (_tmp, store) = fixture("files");
    let chat = store.create(None).unwrap();
    let root = Path::new(&chat.path);
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/a.txt"), b"abc").unwrap();
    fs::write(root.join(".hidden"), b"12345").unwrap();
    let files = store.files(&chat.id).unwrap();
    assert_eq!(
        files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        [".hidden", "nested/a.txt"]
    );
    let usage = store.usage(&chat.id).unwrap();
    assert_eq!((usage.files, usage.bytes, usage.complete), (2, 8, true));
    let limited = tree::usage_with_cap(root, 1).unwrap();
    assert!(!limited.complete);
    assert!(limited.files <= 1);
}

#[test]
fn export_is_relative_regular_file_only_and_never_overwrites() {
    let (tmp, store) = fixture("export");
    let chat = store.create(None).unwrap();
    let root = Path::new(&chat.path);
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/a.txt"), b"hello").unwrap();
    let dest = tmp.path().join("saved.txt");
    store.export(&chat.id, "nested/a.txt", &dest).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"hello");
    assert!(store.export(&chat.id, "nested/a.txt", &dest).is_err());
    assert_eq!(fs::read(&dest).unwrap(), b"hello");
    assert!(store
        .export(&chat.id, "../saved.txt", &tmp.path().join("outside.txt"))
        .is_err());
    assert!(store
        .export(&chat.id, "/etc/passwd", &tmp.path().join("absolute.txt"))
        .is_err());
    assert!(store
        .export(&chat.id, "nested", &tmp.path().join("directory.txt"))
        .is_err());
}

#[test]
fn promotion_copies_complete_tree_keeps_source_and_never_replaces_destination() {
    let (tmp, store) = fixture("promote");
    let chat = store.create(None).unwrap();
    let root = Path::new(&chat.path);
    fs::create_dir(root.join("nested")).unwrap();
    fs::create_dir(root.join("empty")).unwrap();
    fs::write(root.join("nested/file"), b"data").unwrap();
    fs::write(root.join(".config"), b"dotfile").unwrap();
    let dest = tmp.path().join("new-project");
    assert_eq!(
        store.promote(&chat.id, &dest).unwrap(),
        crate::external_open::canonical_folder(&dest).unwrap()
    );
    assert_eq!(fs::read(dest.join("nested/file")).unwrap(), b"data");
    assert_eq!(fs::read(dest.join(".config")).unwrap(), b"dotfile");
    assert!(dest.join("empty").is_dir());
    assert_eq!(fs::read(root.join("nested/file")).unwrap(), b"data");
    assert!(store.promote(&chat.id, &dest).is_err());
    assert_eq!(fs::read(dest.join("nested/file")).unwrap(), b"data");
    assert!(store.promote(&chat.id, &root.join("inside")).is_err());
    assert!(!root.join("inside").exists());
}

#[test]
fn failed_promotion_removes_partial_copy_but_not_existing_directory() {
    let (tmp, _store) = fixture("rollback");
    let dest = tmp.path().join("partial");
    assert!(tree::copy_new_directory(&dest, || {
        fs::write(dest.join("partial.txt"), b"partial").unwrap();
        Err("copy failed".to_string())
    })
    .is_err());
    assert!(!dest.exists());
    fs::create_dir(&dest).unwrap();
    fs::write(dest.join("original"), b"preserved").unwrap();
    assert!(
        tree::copy_new_directory(&dest, || panic!("must not copy into an existing directory"))
            .is_err()
    );
    assert_eq!(fs::read(dest.join("original")).unwrap(), b"preserved");
}

#[test]
fn closed_tab_guard_and_private_id_validation() {
    let (_tmp, store) = fixture("guard");
    let chat = store.create(None).unwrap();
    let terminal = crate::terminal::TerminalManager::new(None);
    terminal.register_tab("tab", Some(Path::new(&chat.path)));
    assert!(require_closed(&terminal, Path::new(&chat.path)).is_err());
    let child = Path::new(&chat.path).join("nested");
    fs::create_dir(&child).unwrap();
    terminal.register_tab("nested", Some(&child));
    let other = crate::terminal::TerminalManager::new(None);
    other.register_tab("nested", Some(&child));
    assert!(require_closed(&other, Path::new(&chat.path)).is_err());
    assert!(store.workspace("../outside").is_err());
    assert!(store.delete("../outside").is_err());
    store.delete(&chat.id).unwrap();
    assert!(!Path::new(&chat.path).exists());
    assert!(store.list(None).unwrap().is_empty());
}

#[test]
fn session_transfer_uses_profiled_native_archive_and_cleans_up() {
    let (tmp, store) = fixture("session-transfer");
    let dest = tmp.path().join("project");
    fs::create_dir(&dest).unwrap();
    let dest = dest.canonicalize().unwrap();
    let source = tmp.path().join("original.jsonl");
    fs::write(&source, b"original").unwrap();
    let imported = tmp.path().join("imported.jsonl");
    let source = source.to_str().unwrap();
    let dir = store.transfer_dir().unwrap();
    let mut calls = Vec::new();
    let result = super::transfer::relocate(
        dir.clone(),
        Some("work"),
        source,
        &dest,
        |args, _label| {
            calls.push(args.to_vec());
            if args[2] == "pack" {
                fs::write(&args[4], b"archive").unwrap();
                Ok(Vec::new())
            } else {
                fs::write(
                    &imported,
                    format!("{}\n", serde_json::json!({"type":"session","cwd":dest})),
                )
                .unwrap();
                Ok(format!("{}\n", imported.display()).into_bytes())
            }
        },
        |path, profile| {
            assert_eq!(profile, Some("work"));
            Ok(Some(path.to_owned()))
        },
    )
    .unwrap();
    assert_eq!(result, imported.to_str().unwrap());
    assert_eq!(&calls[0][..3], ["--profile=work", "session", "pack"]);
    assert_eq!(&calls[1][..3], ["--profile=work", "session", "unpack"]);
    assert_eq!(&calls[1][4], "--cwd");
    assert_eq!(&calls[1][5], dest.to_str().unwrap());
    assert!(!dir.exists());
    assert_eq!(fs::read(source).unwrap(), b"original");
}

#[test]
fn session_transfer_failure_keeps_original_and_cleans_private_archive() {
    let (tmp, store) = fixture("session-transfer-error");
    let dest = tmp.path().join("project");
    fs::create_dir(&dest).unwrap();
    let dest = dest.canonicalize().unwrap();
    let source = tmp.path().join("original.jsonl");
    fs::write(&source, b"original").unwrap();
    let dir = store.transfer_dir().unwrap();
    let result = super::transfer::relocate(
        dir.clone(),
        None,
        source.to_str().unwrap(),
        &dest,
        |args, _| {
            fs::write(&args[3], b"partial archive").unwrap();
            Err("pack unsupported".to_string())
        },
        |_, _| panic!("unpack must not run"),
    );
    assert!(result.unwrap_err().contains("unsupported"));
    assert!(!dir.exists());
    assert_eq!(fs::read(source).unwrap(), b"original");
}

#[test]
fn session_transfer_rejects_output_with_wrong_cwd() {
    let (tmp, store) = fixture("session-transfer-cwd");
    let dest = tmp.path().join("project");
    fs::create_dir(&dest).unwrap();
    let dest = dest.canonicalize().unwrap();
    let original = tmp.path().join("original.jsonl");
    fs::write(&original, b"original").unwrap();
    let imported = tmp.path().join("imported.jsonl");
    fs::write(
        &imported,
        format!(
            "{}\n",
            serde_json::json!({"type":"session","cwd":tmp.path()})
        ),
    )
    .unwrap();
    let dir = store.transfer_dir().unwrap();
    let result = super::transfer::relocate(
        dir.clone(),
        None,
        original.to_str().unwrap(),
        &dest,
        |args, _| {
            if args[1] == "pack" {
                fs::write(&args[3], b"archive").unwrap();
                Ok(Vec::new())
            } else {
                Ok(format!("{}\n", imported.display()).into_bytes())
            }
        },
        |path, _| Ok(Some(path.to_owned())),
    );
    assert!(result.unwrap_err().contains("does not belong"));
    assert!(!dir.exists());
    assert_eq!(fs::read(original).unwrap(), b"original");
}

#[cfg(unix)]
#[test]
fn symlinks_are_not_exported_followed_promoted_or_deleted_as_workspace_roots() {
    use std::os::unix::fs::symlink;
    let (tmp, store) = fixture("links");
    let chat = store.create(None).unwrap();
    let root = Path::new(&chat.path);
    let outside = tmp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), b"secret").unwrap();
    symlink(&outside, root.join("link")).unwrap();
    assert!(store.files(&chat.id).unwrap().is_empty());
    assert!(store
        .export(&chat.id, "link/secret", &tmp.path().join("leaked"))
        .is_err());
    let destination = tmp.path().join("project");
    assert!(store
        .promote(&chat.id, &destination)
        .unwrap_err()
        .contains("symbolic links"));
    assert!(!destination.exists());
    fs::remove_file(root.join("link")).unwrap();
    let saved = tmp.path().join("actual-workspace");
    fs::rename(root, &saved).unwrap();
    symlink(&outside, root).unwrap();
    assert!(store.delete(&chat.id).is_err());
    assert_eq!(fs::read(outside.join("secret")).unwrap(), b"secret");
}

#[cfg(unix)]
#[test]
fn promotion_refuses_special_files_without_blocking() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (tmp, store) = fixture("fifo");
    let chat = store.create(None).unwrap();
    let fifo = Path::new(&chat.path).join("pipe");
    let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // SAFETY: name is NUL terminated and remains live for mkfifo.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(store
        .export(&chat.id, "pipe", &tmp.path().join("export"))
        .is_err());
    assert!(store
        .promote(&chat.id, &tmp.path().join("project"))
        .unwrap_err()
        .contains("special files"));
}

#[test]
fn profile_variants_share_files_but_keep_independent_history_and_groups() {
    let (_tmp, store) = fixture("profile-variants");
    let first = store.create(None).unwrap();
    fs::write(Path::new(&first.path).join("shared"), b"workspace").unwrap();
    store
        .update(
            &first.id,
            Some("history-a".into()),
            Some("Original".into()),
            |path, _| Ok(Some(path.to_owned())),
        )
        .unwrap();
    let work = store.for_profile(&first.id, Some("work")).unwrap();
    assert_ne!(first.id, work.id);
    assert_eq!(first.path, work.path);
    assert!(work.session_file.is_none());
    assert!(store.usage(&first.id).unwrap().shared);
    store
        .update(
            &work.id,
            Some("history-b".into()),
            Some("Work".into()),
            |path, _| Ok(Some(path.to_owned())),
        )
        .unwrap();
    let back = store.for_profile(&work.id, None).unwrap();
    assert_eq!(back.id, first.id);
    assert_eq!(back.session_file.as_deref(), Some("history-a"));
    let again = store.for_profile(&first.id, Some("work")).unwrap();
    assert_eq!(again.id, work.id);
    assert_eq!(again.session_file.as_deref(), Some("history-b"));

    // Older history sharing the workspace is a distinct group, not the
    // currently selected conversation for the original group.
    let older = store
        .restore_history(&first.path, None, "history-old", "Old")
        .unwrap()
        .unwrap();
    assert_ne!(older.id, first.id);
    assert_eq!(older.path, first.path);
    let old_work = store.for_profile(&older.id, Some("work")).unwrap();
    assert_ne!(old_work.id, work.id);
    assert!(old_work.session_file.is_none());
    assert_eq!(
        store.for_profile(&older.id, Some("work")).unwrap().id,
        old_work.id
    );
    assert_eq!(
        store
            .restore_history(&first.path, None, "history-old", "Old")
            .unwrap()
            .unwrap()
            .id,
        older.id
    );

    // A non-last alias can be removed while another profile's tab is open.
    store
        .delete_guarded(&first.id, |_| {
            panic!("shared workspace must not be deleted")
        })
        .unwrap();
    assert_eq!(
        fs::read(Path::new(&first.path).join("shared")).unwrap(),
        b"workspace"
    );
    store.delete(&work.id).unwrap();
    store.delete(&older.id).unwrap();
    assert!(!store.usage(&old_work.id).unwrap().shared);
    assert!(store
        .delete_guarded(&old_work.id, |_| Err("workspace in use".into()))
        .is_err());
    assert!(Path::new(&first.path).exists());
    store.delete_guarded(&old_work.id, |_| Ok(())).unwrap();
    assert!(!Path::new(&first.path).exists());
}

#[test]
fn history_recovery_is_confined_and_reuses_an_empty_private_workspace() {
    let (tmp, store) = fixture("history-recovery");
    let old = store.create(None).unwrap();
    fs::write(Path::new(&old.path).join("discarded"), b"data").unwrap();
    let session = tmp.path().join("history.jsonl");
    fs::write(
        &session,
        format!(
            "{}\n",
            serde_json::json!({
                "type":"session", "id":"a", "timestamp":"2026-01-01", "cwd":old.path,
            })
        ),
    )
    .unwrap();
    let parsed = crate::saved_sessions::parse_session_file(&session).unwrap();
    store.delete(&old.id).unwrap();
    let session = session.to_str().unwrap();
    let recovered = store
        .restore_history(&parsed.cwd, None, session, "Saved")
        .unwrap()
        .unwrap();
    assert_ne!(recovered.id, old.id);
    assert_eq!(fs::read_dir(&recovered.path).unwrap().count(), 0);
    let reopened = Store::new(&tmp.path().join("data")).unwrap();
    let rows = reopened.list(None).unwrap();
    assert_eq!(rows[0].session_file.as_deref(), Some(session));
    assert_eq!(rows[0].name.as_deref(), Some("Saved"));
    assert_eq!(
        reopened
            .restore_history(&parsed.cwd, None, session, "Saved")
            .unwrap()
            .unwrap()
            .id,
        recovered.id
    );

    let outside = tmp.path().join("0123456789abcdef0123456789abcdef");
    assert!(reopened
        .restore_history(outside.to_str().unwrap(), None, session, "Saved")
        .unwrap()
        .is_none());
    let invalid = Path::new(&old.path).parent().unwrap().join("../outside");
    assert!(reopened
        .restore_history(invalid.to_str().unwrap(), None, session, "Saved")
        .unwrap()
        .is_none());
}

#[test]
fn interrupted_deletion_does_not_hide_other_chats_and_can_finish() {
    let (_tmp, store) = fixture("orphaned-metadata");
    let missing = store.create(None).unwrap();
    let live = store.create(None).unwrap();
    fs::remove_dir(&missing.path).unwrap();
    let list = store.list(None).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, live.id);
    store.delete(&missing.id).unwrap();
    assert_eq!(store.list(None).unwrap().len(), 1);
    assert!(Path::new(&live.path).is_dir());
}

#[test]
fn promotion_snapshot_must_be_a_distinct_native_fork_with_complete_artifacts() {
    let (tmp, _store) = fixture("fork-snapshot");
    let original = tmp.path().join("original.jsonl");
    let fork = tmp.path().join("fork.jsonl");
    fs::write(
        &original,
        format!(
            "{}\n",
            serde_json::json!({"type":"session","id":"original"})
        ),
    )
    .unwrap();
    fs::write(
        &fork,
        format!(
            "{}\n",
            serde_json::json!({"type":"session","id":"fork","parentSession":"original"})
        ),
    )
    .unwrap();
    super::transfer::validate_fork(&original, &fork).unwrap();
    assert!(super::transfer::validate_fork(&original, &original).is_err());
    fs::create_dir(original.with_extension("")).unwrap();
    fs::create_dir(fork.with_extension("")).unwrap();
    fs::write(original.with_extension("").join("a"), b"artifact").unwrap();
    assert!(tree::verify_fork_artifacts(&original, &fork).is_err());
    fs::write(fork.with_extension("").join("a"), b"artifact").unwrap();
    tree::verify_fork_artifacts(&original, &fork).unwrap();
    fs::write(fork.with_extension("").join("a"), b"changed!").unwrap();
    assert!(tree::verify_fork_artifacts(&original, &fork).is_err());
    fs::write(
        &fork,
        format!(
            "{}\n",
            serde_json::json!({"type":"session","id":"other","parentSession":"wrong"})
        ),
    )
    .unwrap();
    assert!(super::transfer::validate_fork(&original, &fork).is_err());
}

#[test]
fn native_unpack_is_refused_when_another_copy_has_the_fork_identity() {
    let (tmp, _store) = fixture("fork-collision");
    let root = tmp.path().join("sessions");
    let first = root.join("first");
    let second = root.join("second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let id = "01234567-89ab-cdef-0123-456789abcdef";
    let fork = first.join(format!("date_{id}.jsonl"));
    let body = format!("{}\n", serde_json::json!({"type":"session","id":id}));
    fs::write(&fork, &body).unwrap();
    super::transfer::ensure_unique_snapshot(&root, &fork).unwrap();
    fs::write(second.join(format!("other_{id}.jsonl")), body).unwrap();
    assert!(super::transfer::ensure_unique_snapshot(&root, &fork)
        .unwrap_err()
        .contains("another session"));
}
