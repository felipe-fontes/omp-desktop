//! Per-session Git metadata watcher.
//!
//! The worktree Git directory, common Git directory and common refs tree are
//! watched separately, without watching objects or working-tree files.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
};

use notify::{RecursiveMode, Watcher as _};
use tauri::{AppHandle, Emitter as _};

/// Holds one metadata watcher per session.
pub struct GitWatcherState {
    watchers: Mutex<HashMap<String, MetadataWatcher>>,
}

impl GitWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Watch HEAD, index, packed refs and loose refs for a session.
    ///
    /// Each relevant change emits the current branch, including `None` for
    /// detached HEAD. Widget branch triggers run only for HEAD/ref changes.
    pub fn start(
        &self,
        session_id: &str,
        repo_path: &Path,
        head_path: PathBuf,
        app: AppHandle,
    ) -> Result<(), String> {
        let paths = MetadataPaths::discover(repo_path, &head_path)?;
        let repo = repo_path.to_owned();
        let sid = session_id.to_owned();
        let watcher = MetadataWatcher::start(paths, move |change| {
            let branch = crate::git::probe(&repo).branch;
            let _ = app.emit(&format!("git://branch/{sid}"), branch);
            if change.branch {
                crate::widgets::notify_branch(&app, &sid);
            }
        })?;

        self.watchers.lock().map_or_else(
            |_| Err("git watcher state poisoned".to_owned()),
            |mut map| {
                map.insert(session_id.to_owned(), watcher);
                Ok(())
            },
        )
    }

    /// Stop watching for `session_id`. No-op if no watcher is registered.
    pub fn stop(&self, session_id: &str) {
        if let Ok(mut map) = self.watchers.lock() {
            map.remove(session_id);
        }
    }
}

impl Default for GitWatcherState {
    fn default() -> Self {
        Self::new()
    }
}

struct MetadataPaths {
    git_dir: PathBuf,
    common_dir: PathBuf,
    refs: PathBuf,
    head: PathBuf,
    index: PathBuf,
    packed_refs: PathBuf,
}

impl MetadataPaths {
    fn discover(repo_path: &Path, head_path: &Path) -> Result<Self, String> {
        let git_dir = head_path
            .parent()
            .ok_or("HEAD path has no parent")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        // gix discovery can spawn git to locate its installation config.
        let (_gate, repo) = crate::spawn_gate::discover(repo_path)?;
        let common_dir = repo
            .common_dir()
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let refs = common_dir.join("refs");
        let head = git_dir.join("HEAD");
        let index = git_dir.join("index");
        let packed_refs = common_dir.join("packed-refs");
        Ok(Self {
            git_dir,
            common_dir,
            refs,
            head,
            index,
            packed_refs,
        })
    }

    fn classify(&self, event: &notify::Event) -> Change {
        let mut change = Change::default();
        // A probe opens HEAD and refs; reacting to access would loop forever.
        if event.kind.is_access() {
            return change;
        }
        for path in &event.paths {
            if path == &self.head || path == &self.packed_refs {
                change.branch = true;
            } else if path == &self.index {
                change.index = true;
            } else if path.starts_with(&self.refs)
                && !path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().ends_with(".lock"))
            {
                change.branch = true;
                if path == &self.refs {
                    change.refs_root = true;
                }
            }
        }
        change
    }
}

#[derive(Clone, Copy, Default, Debug)]
struct Change {
    branch: bool,
    index: bool,
    refs_root: bool,
}

enum Message {
    Event(Change),
    Stop,
}

/// The worker owns the notify watcher, so it can re-arm the refs tree if its
/// root is replaced. Dropping this handle stops and joins the worker.
struct MetadataWatcher {
    sender: mpsc::Sender<Message>,
    worker: Option<JoinHandle<()>>,
    stopping: Arc<AtomicBool>,
}

impl MetadataWatcher {
    fn start(
        paths: MetadataPaths,
        on_change: impl Fn(Change) + Send + 'static,
    ) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let paths = Arc::new(paths);
        // The callback owns a channel handle while the returned watcher keeps
        // another to stop the worker during teardown.
        let event_sender = sender.clone();
        let event_paths = Arc::clone(&paths);
        let mut watcher = notify::RecommendedWatcher::new(
            move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    let change = event_paths.classify(&event);
                    if change.branch || change.index {
                        let _ = event_sender.send(Message::Event(change));
                    }
                }
            },
            notify::Config::default().with_follow_symlinks(false),
        )
        .map_err(|e| e.to_string())?;

        // Directory watches survive atomic HEAD/index/packed-refs renames.
        watcher
            .watch(&paths.git_dir, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        if paths.common_dir != paths.git_dir {
            watcher
                .watch(&paths.common_dir, RecursiveMode::NonRecursive)
                .map_err(|e| e.to_string())?;
        }
        if paths
            .refs
            .symlink_metadata()
            .is_ok_and(|meta| meta.is_dir())
        {
            watcher
                .watch(&paths.refs, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())?;
        }

        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = Arc::clone(&stopping);
        let worker = thread::Builder::new()
            .name("git-metadata-watch".into())
            .spawn(move || {
                while let Ok(message) = receiver.recv() {
                    match message {
                        Message::Stop => break,
                        Message::Event(change) => {
                            if worker_stopping.load(Ordering::Acquire) {
                                break;
                            }
                            if change.refs_root {
                                // A refs directory can itself be deleted/recreated.
                                // This runs outside notify's callback thread.
                                let _ = watcher.unwatch(&paths.refs);
                                if paths
                                    .refs
                                    .symlink_metadata()
                                    .is_ok_and(|meta| meta.is_dir())
                                {
                                    let _ = watcher.watch(&paths.refs, RecursiveMode::Recursive);
                                }
                            }
                            on_change(change);
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            sender,
            worker: Some(worker),
            stopping,
        })
    }
}

impl Drop for MetadataWatcher {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.sender.send(Message::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Change, MetadataPaths, MetadataWatcher};
    use crate::git_browser::fixture;
    use notify::event::{AccessKind, AccessMode, EventKind, ModifyKind, RenameMode};
    use notify::Event;
    use std::{
        path::{Path, PathBuf},
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn paths() -> MetadataPaths {
        let git_dir = PathBuf::from("/repo/.git");
        MetadataPaths {
            refs: git_dir.join("refs"),
            head: git_dir.join("HEAD"),
            index: git_dir.join("index"),
            packed_refs: git_dir.join("packed-refs"),
            // This fixture models a primary checkout whose two Git roots coincide.
            common_dir: git_dir.clone(),
            git_dir,
        }
    }

    #[test]
    fn access_events_and_lock_files_do_not_trigger_probes() {
        let paths = paths();
        for path in [
            "/repo/.git/HEAD",
            "/repo/.git/index",
            "/repo/.git/refs/heads/main",
        ] {
            let open = Event::new(EventKind::Access(AccessKind::Open(AccessMode::Any)))
                .add_path(path.into());
            let change = paths.classify(&open);
            assert!(!change.branch && !change.index);
        }
        for path in [
            "/repo/.git/HEAD.lock",
            "/repo/.git/index.lock",
            "/repo/.git/packed-refs.lock",
            "/repo/.git/refs/heads/main.lock",
            "/repo/.git/objects/anything",
        ] {
            let lock = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                .add_path(path.into());
            let change = paths.classify(&lock);
            assert!(!change.branch && !change.index);
        }
    }

    #[test]
    fn metadata_renames_are_classified_by_destination() {
        let paths = paths();
        for path in [
            "/repo/.git/HEAD",
            "/repo/.git/packed-refs",
            "/repo/.git/refs/heads/main",
        ] {
            let rename = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
                .add_path(path.into());
            let change = paths.classify(&rename);
            assert!(change.branch && !change.index);
        }
        let index = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
            .add_path("/repo/.git/index".into());
        let change = paths.classify(&index);
        assert!(change.index && !change.branch);
    }

    type Observation = (Change, Option<String>);

    fn watch(path: &Path) -> (MetadataWatcher, mpsc::Receiver<Observation>) {
        let head = crate::git::probe(path).head.expect("repository HEAD");
        let paths = MetadataPaths::discover(path, &head).unwrap();
        let repo = path.to_owned();
        let (sender, receiver) = mpsc::channel();
        let watcher = MetadataWatcher::start(paths, move |change| {
            let branch = crate::git::probe(&repo).branch;
            let _ = sender.send((change, branch));
        })
        .unwrap();
        (watcher, receiver)
    }

    fn wait_for(
        receiver: &mpsc::Receiver<Observation>,
        expected: Option<&str>,
        branch_event: bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let (change, branch) = receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("timed out waiting for Git metadata observation");
            if branch.as_deref() == expected
                && if branch_event {
                    change.branch
                } else {
                    change.index && !change.branch
                }
            {
                return;
            }
        }
    }

    fn settle(receiver: &mpsc::Receiver<Observation>) {
        // Drain duplicate OS notifications before making the next change.
        // A self-triggering probe would fail to become quiet.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(Instant::now() < deadline, "watcher did not become quiet");
            if receiver.recv_timeout(Duration::from_millis(300)).is_err() {
                return;
            }
        }
    }

    #[test]
    fn real_git_switch_detach_commit_and_index_remain_live() {
        let Some(repo) = fixture::init("watch-metadata") else {
            return;
        };
        repo.commit("initial", 1_700_000_000);
        let (watcher, observations) = watch(repo.path());

        repo.git(&["checkout", "-q", "-b", "topic"]);
        wait_for(&observations, Some("topic"), true);
        settle(&observations);
        repo.git(&["checkout", "-q", "--detach"]);
        wait_for(&observations, None, true);
        settle(&observations);
        repo.git(&["checkout", "-q", "main"]);
        wait_for(&observations, Some("main"), true);
        settle(&observations);

        repo.commit("same branch", 1_700_000_001);
        wait_for(&observations, Some("main"), true);
        settle(&observations);
        repo.write("staged.txt", "staged\n");
        assert!(
            observations
                .recv_timeout(Duration::from_millis(300))
                .is_err(),
            "working-tree writes must not trigger the metadata watcher"
        );
        repo.git(&["add", "staged.txt"]);
        wait_for(&observations, Some("main"), false);
        settle(&observations);

        // Further atomic HEAD replacements must still be observed.
        repo.git(&["checkout", "-q", "topic"]);
        wait_for(&observations, Some("topic"), true);
        settle(&observations);
        drop(watcher);
        assert!(observations.recv_timeout(Duration::from_secs(2)).is_err());
    }

    #[test]
    fn linked_worktree_observes_common_loose_and_packed_refs() {
        let Some(repo) = fixture::init("watch-linked") else {
            return;
        };
        repo.commit("initial", 1_700_000_000);
        repo.commit("second", 1_700_000_001);
        let linked = repo.path().join("linked");
        repo.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ]);
        let (_watcher, observations) = watch(&linked);

        repo.git(&["update-ref", "refs/heads/external", "HEAD^"]);
        wait_for(&observations, Some("linked"), true);
        settle(&observations);
        repo.git(&["pack-refs", "--all"]);
        wait_for(&observations, Some("linked"), true);
        settle(&observations);
        // The loose ref may have been removed by packing; creating it again
        // still needs to reach the recursive common-refs watcher.
        repo.git(&["update-ref", "refs/heads/external", "HEAD"]);
        wait_for(&observations, Some("linked"), true);
        settle(&observations);
    }

    #[cfg(unix)]
    #[test]
    fn recursive_refs_watches_do_not_follow_directory_symlinks() {
        let Some(repo) = fixture::init("watch-refs-symlink") else {
            return;
        };
        repo.commit("initial", 1_700_000_000);
        let outside = crate::test_support::TempDir::new("git-watcher", "outside-refs");
        std::os::unix::fs::symlink(outside.path(), repo.path().join(".git/refs/unrelated"))
            .unwrap();
        let (_watcher, observations) = watch(repo.path());
        repo.git(&["checkout", "-q", "-b", "topic"]);
        wait_for(&observations, Some("topic"), true);
        settle(&observations);
        std::fs::write(outside.path().join("outside-data"), "not Git metadata").unwrap();
        assert!(
            observations.recv_timeout(Duration::from_secs(2)).is_err(),
            "a refs symlink must not expand the metadata watch into unrelated directories"
        );
    }
}
