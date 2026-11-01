use super::*;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// A sessions root with one cwd-slug directory, removed on drop.
struct Fixture {
    root: PathBuf,
    dir: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir()
            .join(format!("omp_tree_{name}_{nanos}"))
            .join("sessions");
        let dir = root.join("--work-proj--");
        fs::create_dir_all(&dir).unwrap();
        Self { root, dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn put(&self, name: &str, lines: &[Value]) -> PathBuf {
        let text = lines.iter().fold(String::new(), |mut text, line| {
            text.push_str(&line.to_string());
            text.push('\n');
            text
        });
        self.put_raw(name, &text)
    }

    fn put_raw(&self, name: &str, text: &str) -> PathBuf {
        let path = self.path(name);
        fs::write(&path, text).unwrap();
        path
    }

    fn tree(&self, current: &Path) -> ConversationTree {
        build(&self.root, current).expect("tree built")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.root.parent().unwrap());
    }
}

fn header(parent: Option<&Path>) -> [Value; 2] {
    let mut session = json!({"type":"session","version":3,"id":"s","timestamp":"2026-10-04T09:00:00.000Z","cwd":"/work/proj"});
    if let Some(parent) = parent {
        session["parentSession"] = json!(parent.to_string_lossy());
    }
    [
        json!({"type":"title","v":1,"title":"","updatedAt":"2026-10-04T09:00:00.000Z"}),
        session,
    ]
}

fn with_header(parent: Option<&Path>, entries: Vec<Value>) -> Vec<Value> {
    header(parent).into_iter().chain(entries).collect()
}

fn user(id: &str, parent: Option<&str>, text: &str, ts: i64) -> Value {
    json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:00.000Z",
        "message":{"role":"user","content":[{"type":"text","text":text}],"timestamp":ts}})
}

fn assistant(id: &str, parent: Option<&str>, text: &str, ts: i64) -> Value {
    json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:05.000Z",
        "message":{"role":"assistant","provider":"anthropic","model":"opus",
            "content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":text}],
            "usage":{"input":3,"output":7,"cacheRead":100,"cacheWrite":50,"totalTokens":160,
                "cost":{"cacheRead":0.01,"cacheWrite":0.2,"total":0.5},
                "cttl":{"ephemeral1h":50}},
            "timestamp":ts}})
}

fn tool_result(id: &str, parent: Option<&str>) -> Value {
    json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:06.000Z",
        "message":{"role":"toolResult","content":[{"type":"text","text":"x".repeat(5000)}],"timestamp":1}})
}

fn other(kind: &str, id: &str, parent: Option<&str>) -> Value {
    json!({"type":kind,"id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:07.000Z"})
}

fn entry<'a>(tree: &'a ConversationTree, id: &str) -> &'a TreeEntry {
    tree.entries
        .iter()
        .find(|e| e.id == id)
        .unwrap_or_else(|| panic!("entry {id} missing"))
}

fn names(tree: &ConversationTree) -> Vec<String> {
    tree.files
        .iter()
        .map(|f| f.path.rsplit(['/', '\\']).next().unwrap().to_string())
        .collect()
}

#[test]
fn family_is_the_parent_session_component_of_one_directory() {
    let fx = Fixture::new("family");
    let a = fx.put(
        "2026-10-04T09-00-00-000Z_a.jsonl",
        &with_header(None, vec![user("u1", None, "hi", 1)]),
    );
    let b = fx.put(
        "2026-10-04T10-00-00-000Z_b.jsonl",
        &with_header(Some(&a), vec![user("u1", None, "hi", 1)]),
    );
    // A fork written with a Windows-style parent path still links by name.
    let c_header = json!({"type":"session","version":3,"id":"c","timestamp":"2026-10-04T11:00:00.000Z",
        "cwd":"/work/proj","parentSession":format!("C:\\elsewhere\\{}", b.file_name().unwrap().to_str().unwrap())});
    let c = fx.put("2026-10-04T11-00-00-000Z_c.jsonl", &[c_header]);
    fx.put(
        "2026-10-04T12-00-00-000Z_unrelated.jsonl",
        &with_header(None, vec![user("z1", None, "other", 1)]),
    );
    let sub = fx.dir.join("2026-10-04T09-00-00-000Z_a");
    fs::create_dir_all(&sub).unwrap();
    fs::write(
        sub.join("0-Explore.jsonl"),
        format!("{}\n{}\n", header(Some(&a))[0], header(Some(&a))[1]),
    )
    .unwrap();

    let tree = fx.tree(&c);
    assert_eq!(
        names(&tree),
        [
            "2026-10-04T11-00-00-000Z_c.jsonl",
            "2026-10-04T09-00-00-000Z_a.jsonl",
            "2026-10-04T10-00-00-000Z_b.jsonl",
        ]
    );
    assert_eq!(
        tree.files.iter().map(|f| f.current).collect::<Vec<_>>(),
        [true, false, false]
    );
    // The same family from the root file's side.
    assert_eq!(fx.tree(&a).files.len(), 3);
}

#[test]
fn family_is_capped_nearest_files_first() {
    let fx = Fixture::new("cap");
    let mut prev: Option<PathBuf> = None;
    for i in 0..40 {
        let path = fx.path(&format!("f{i:02}.jsonl"));
        let lines = with_header(
            prev.as_deref(),
            vec![user(&format!("u{i:02}"), None, "x", 1)],
        );
        fx.put(&format!("f{i:02}.jsonl"), &lines);
        prev = Some(path);
    }
    let tree = fx.tree(&fx.path("f00.jsonl"));
    assert_eq!(tree.files.len(), 32);
    assert_eq!(names(&tree)[0], "f00.jsonl");
    assert_eq!(names(&tree)[31], "f31.jsonl");
}

#[test]
fn non_kept_entries_collapse_into_their_nearest_kept_ancestor() {
    let fx = Fixture::new("collapse");
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                other("model_change", "m0", None),
                user("u1", Some("m0"), "first", 10),
                assistant("a1", Some("u1"), "calling", 20),
                tool_result("t1", Some("a1")),
                other("custom", "c1", Some("t1")),
                other("custom_message", "c2", Some("c1")),
                other("model_change", "m1", Some("c2")),
                user("u2", Some("m1"), "second", 30),
            ],
        ),
    );
    let tree = fx.tree(&file);
    let ids: Vec<_> = tree.entries.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, ["u1", "a1", "u2"]);
    assert_eq!(entry(&tree, "u1").parent_id, None);
    assert_eq!(entry(&tree, "a1").parent_id.as_deref(), Some("u1"));
    assert_eq!(entry(&tree, "u2").parent_id.as_deref(), Some("a1"));
    let u1 = entry(&tree, "u1");
    assert_eq!(u1.kind, Kind::User);
    assert_eq!(u1.ts.as_ref().and_then(Number::as_i64), Some(10));
    assert_eq!(u1.at.as_deref(), Some("2026-10-04T10:00:00.000Z"));
}

#[test]
fn warm_records_and_compactions_are_kept_other_model_usage_is_not() {
    let fx = Fixture::new("warm");
    let warm = json!({"type":"model_usage","id":"w1","parentId":"a1","timestamp":"2026-10-04T10:05:00.000Z","purpose":"cache-warm"});
    let memory = json!({"type":"model_usage","id":"w2","parentId":"w1","timestamp":"2026-10-04T10:06:00.000Z","purpose":"memory"});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                warm,
                memory,
                other("compaction", "k1", Some("w2")),
            ],
        ),
    );
    let tree = fx.tree(&file);
    let kinds: Vec<_> = tree
        .entries
        .iter()
        .map(|e| (e.id.as_str(), e.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            ("u1", Kind::User),
            ("a1", Kind::Assistant),
            ("w1", Kind::Warm),
            ("k1", Kind::Compaction)
        ]
    );
    assert_eq!(entry(&tree, "k1").parent_id.as_deref(), Some("w1"));
    assert_eq!(
        entry(&tree, "w1").at.as_deref(),
        Some("2026-10-04T10:05:00.000Z")
    );
}

#[test]
fn shared_prefix_merges_by_id_and_in_current_follows_the_current_file() {
    let fx = Fixture::new("merge");
    let a = fx.put(
        "a.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "one", 1),
                assistant("a1", Some("u1"), "r1", 2),
                user("u2", Some("a1"), "two", 3),
                assistant("a2", Some("u2"), "r2", 4),
            ],
        ),
    );
    let b = fx.put(
        "b.jsonl",
        &with_header(
            Some(&a),
            vec![
                user("u1", None, "one", 1),
                assistant("a1", Some("u1"), "r1", 2),
                user("u3", Some("a1"), "three", 5),
            ],
        ),
    );
    let tree = fx.tree(&b);
    let mut ids: Vec<_> = tree.entries.iter().map(|e| e.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["a1", "a2", "u1", "u2", "u3"]);
    let current: Vec<_> = tree
        .entries
        .iter()
        .filter(|e| e.in_current)
        .map(|e| e.id.as_str())
        .collect();
    assert_eq!(current, ["u1", "a1", "u3"]);
    assert_eq!(entry(&tree, "u3").parent_id.as_deref(), Some("a1"));
    assert_eq!(entry(&tree, "u2").parent_id.as_deref(), Some("a1"));
    // Every parent precedes its children.
    for (i, e) in tree.entries.iter().enumerate() {
        if let Some(p) = &e.parent_id {
            assert!(
                tree.entries[..i].iter().any(|x| &x.id == p),
                "{p} after {}",
                e.id
            );
        }
    }
}

#[test]
fn leaf_is_the_last_entry_mapped_to_its_kept_ancestor() {
    let fx = Fixture::new("leaf");
    let a = fx.put(
        "a.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                tool_result("t1", Some("a1")),
                other("custom", "c1", Some("t1")),
            ],
        ),
    );
    let b = fx.put(
        "b.jsonl",
        &with_header(
            Some(&a),
            vec![user("u1", None, "q", 1), user("u9", Some("u1"), "w", 3)],
        ),
    );
    let tree = fx.tree(&a);
    let leaf = |name: &str| {
        tree.files
            .iter()
            .find(|f| f.path.ends_with(name))
            .unwrap()
            .leaf_id
            .as_deref()
    };
    assert_eq!(leaf("a.jsonl"), Some("a1"));
    assert_eq!(leaf("b.jsonl"), Some("u9"));
    assert!(b.exists());
}

#[test]
fn ttl_and_costs_come_from_cttl_and_cost() {
    let fx = Fixture::new("ttl");
    let plain = |id: &str, parent: &str, usage: Value| {
        json!({"type":"message","id":id,"parentId":parent,"timestamp":"t",
            "message":{"role":"assistant","content":[],"usage":usage,"timestamp":9}})
    };
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("one", Some("u1"), "h", 2),
                plain("five", "one", json!({"input":1,"output":2,"cacheRead":3,"cacheWrite":4,
                    "cost":{"cacheRead":0.5,"cacheWrite":0.25},"cttl":{"ephemeral5m":9,"ephemeral1h":0}})),
                plain("none", "five", json!({"input":1,"output":2,"cacheRead":0,"cacheWrite":0})),
            ],
        ),
    );
    let tree = fx.tree(&file);
    let one = entry(&tree, "one").usage.as_ref().unwrap();
    assert_eq!(
        (one.ttl, one.cost_read, one.cost_write),
        (Some(3600), Some(0.01), Some(0.2))
    );
    assert_eq!(
        (one.input, one.output, one.cache_read, one.cache_write),
        (3, 7, 100, 50)
    );
    let minutes = entry(&tree, "five").usage.as_ref().unwrap();
    assert_eq!(
        (minutes.ttl, minutes.cost_read, minutes.cost_write),
        (Some(300), Some(0.5), Some(0.25))
    );
    let none = entry(&tree, "none").usage.as_ref().unwrap();
    assert_eq!(
        (none.ttl, none.cost_read, none.cost_write),
        (None, None, None)
    );
    assert!(entry(&tree, "u1").usage.is_none());
}

#[test]
fn text_is_trimmed_first_non_empty_and_cut_on_a_char_boundary() {
    let fx = Fixture::new("text");
    let long = format!("a{}", "é".repeat(400));
    let blocks = json!({"type":"message","id":"a1","parentId":"u1","timestamp":"t",
        "message":{"role":"assistant","content":[
            {"type":"text","text":"  \n "},{"type":"toolCall","name":"x","arguments":{"text":"nope"}},
            {"type":"text","text":"\n  the answer  "}],"timestamp":2}});
    let string_content = json!({"type":"message","id":"u2","parentId":"a1","timestamp":"t",
        "message":{"role":"user","content":"  plain string  ","timestamp":3}});
    let agent = json!({"type":"message","id":"u3","parentId":"u2","timestamp":"t",
        "message":{"role":"user","attribution":"agent","content":[{"type":"text","text":"nudge"}],"timestamp":4}});
    let synthetic = json!({"type":"message","id":"u4","parentId":"u3","timestamp":"t",
        "message":{"role":"user","synthetic":true,"content":[{"type":"text","text":"gen"}],"timestamp":5}});
    let image_only = json!({"type":"message","id":"u5","parentId":"u4","timestamp":"t",
        "message":{"role":"user","content":[{"type":"image","data":"AAAA"}],"timestamp":6}});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, &long, 1),
                blocks,
                string_content,
                agent,
                synthetic,
                image_only,
            ],
        ),
    );
    let tree = fx.tree(&file);
    let u1 = entry(&tree, "u1").text.as_deref().unwrap();
    assert_eq!(u1.chars().count(), 300);
    assert!(u1.starts_with("aéé"));
    assert_eq!(entry(&tree, "a1").text.as_deref(), Some("the answer"));
    assert_eq!(entry(&tree, "u2").text.as_deref(), Some("plain string"));
    assert!(!entry(&tree, "u2").agent);
    assert!(entry(&tree, "u3").agent);
    assert!(entry(&tree, "u4").agent);
    assert_eq!(entry(&tree, "u5").text, None);
}

#[test]
fn labels_follow_the_latest_entry_and_an_empty_label_deletes() {
    let fx = Fixture::new("labels");
    let label = |id: &str, parent: &str, target: &str, text: &str| json!({"type":"label","id":id,"parentId":parent,"timestamp":"t","targetId":target,"label":text});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                user("u2", Some("a1"), "q2", 3),
                tool_result("t1", Some("u2")),
                label("l1", "t1", "u1", "draft"),
                label("l2", "l1", "u1", "final"),
                label("l3", "l2", "u2", "gone"),
                label("l4", "l3", "u2", ""),
                // Aimed at a collapsed entry: shown on its kept ancestor.
                label("l5", "l4", "t1", "on the tool"),
            ],
        ),
    );
    let tree = fx.tree(&file);
    assert_eq!(entry(&tree, "u1").label.as_deref(), Some("final"));
    assert_eq!(entry(&tree, "a1").label, None);
    assert_eq!(entry(&tree, "u2").label.as_deref(), Some("on the tool"));
}

#[test]
fn clearing_the_label_of_a_collapsed_entry_keeps_its_kept_ancestors_own_label() {
    let fx = Fixture::new("labels_collapsed");
    let label = |id: &str, parent: &str, target: &str, text: &str| json!({"type":"label","id":id,"parentId":parent,"timestamp":"t","targetId":target,"label":text});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                tool_result("t1", Some("a1")),
                label("l1", "t1", "a1", "important"),
                label("l2", "l1", "t1", "check"),
                label("l3", "l2", "t1", ""),
            ],
        ),
    );
    let tree = fx.tree(&file);
    assert_eq!(entry(&tree, "a1").label.as_deref(), Some("important"));
}

#[test]
fn compaction_maps_its_first_kept_entry_to_a_kept_ancestor() {
    let fx = Fixture::new("compaction");
    let compaction = |id: &str, parent: &str, first: &str| json!({"type":"compaction","id":id,"parentId":parent,"timestamp":"t","firstKeptEntryId":first});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                tool_result("t1", Some("a1")),
                user("u2", Some("t1"), "q2", 3),
                compaction("k1", "u2", "u2"),
                compaction("k2", "k1", "t1"),
                compaction("k3", "k2", "gone"),
            ],
        ),
    );
    let tree = fx.tree(&file);
    let k1 = entry(&tree, "k1");
    assert_eq!(
        (k1.first_kept_id.as_deref(), k1.first_kept_exact),
        (Some("u2"), true)
    );
    let k2 = entry(&tree, "k2");
    assert_eq!(
        (k2.first_kept_id.as_deref(), k2.first_kept_exact),
        (Some("a1"), false)
    );
    let k3 = entry(&tree, "k3");
    assert_eq!(
        (k3.first_kept_id.as_deref(), k3.first_kept_exact),
        (None, false)
    );
}

#[test]
fn file_facts_title_cwd_and_malformed_lines() {
    let fx = Fixture::new("facts");
    let a = fx.put(
        "a.jsonl",
        &with_header(None, vec![user("u1", None, "q", 1)]),
    );
    let renamed = json!({"type":"title_change","id":"tc","parentId":"u1","timestamp":"2026-10-04T09:30:00.000Z","title":"Early name"});
    let file = fx.put_raw(
        "b.jsonl",
        &format!(
            "{}\n{}\nnot json\n\n{{\"type\":\"message\"\n{}\n{}\n{}\n",
            json!({"type":"title","v":1,"title":"Newest name","updatedAt":"2026-10-04T11:00:00.000Z"}),
            header(Some(&a))[1],
            user("u1", None, "q", 1),
            renamed,
            user("u2", Some("tc"), "after junk", 2),
        ),
    );
    let tree = fx.tree(&file);
    let this = &tree.files[0];
    assert_eq!(this.title.as_deref(), Some("Newest name"));
    assert_eq!(this.cwd.as_deref(), Some("/work/proj"));
    assert_eq!(this.path, file.to_string_lossy());
    assert_eq!(entry(&tree, "u2").parent_id.as_deref(), Some("u1"));

    // With an empty title line the latest title_change wins.
    let c = fx.put(
        "c.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                renamed_with("tc1", "First"),
                renamed_with("tc2", "Second"),
            ],
        ),
    );
    assert_eq!(fx.tree(&c).files[0].title.as_deref(), Some("Second"));
    assert_eq!(
        fx.tree(&a)
            .files
            .iter()
            .find(|f| f.path.ends_with("a.jsonl"))
            .unwrap()
            .title,
        None
    );
}

fn renamed_with(id: &str, title: &str) -> Value {
    let at = if id == "tc1" {
        "2026-10-04T09:30:00.000Z"
    } else {
        "2026-10-04T09:45:00.000Z"
    };
    json!({"type":"title_change","id":id,"parentId":"u1","timestamp":at,"title":title})
}

#[test]
fn jsonl_paths_stay_confined_to_the_sessions_root() {
    let fx = Fixture::new("validate");
    let good = fx.put(
        "s.jsonl",
        &with_header(None, vec![user("u1", None, "q", 1)]),
    );
    assert!(build(&fx.root, &good).is_ok());

    // omp writes the file lazily, so the path of a fresh tab is not there yet:
    // an empty tree while the directory is confined, an error otherwise.
    let unwritten = build(&fx.root, &fx.path("nope.jsonl")).expect("empty tree");
    assert!(unwritten.files.is_empty() && unwritten.entries.is_empty());
    let no_dir = build(&fx.root, &fx.root.join("--gone--").join("nope.jsonl")).unwrap_err();
    assert!(no_dir.contains("does not exist"), "{no_dir}");
    let unwritten_txt = build(&fx.root, &fx.path("nope.txt")).unwrap_err();
    assert!(unwritten_txt.contains(".jsonl"), "{unwritten_txt}");

    let text = fx.put_raw("notes.txt", "{}\n");
    let wrong_kind = build(&fx.root, &text).unwrap_err();
    assert!(wrong_kind.contains(".jsonl"), "{wrong_kind}");

    let elsewhere = Fixture::new("validate_other");
    let outside = elsewhere.put("o.jsonl", &with_header(None, vec![]));
    let rejected = build(&fx.root, &outside).unwrap_err();
    assert!(rejected.contains("outside"), "{rejected}");

    // A `..` hop that leaves the root is judged by where it lands.
    let sneaky = fx
        .dir
        .join("..")
        .join("..")
        .join("..")
        .join(elsewhere.root.parent().unwrap().file_name().unwrap())
        .join("sessions")
        .join("--work-proj--")
        .join("o.jsonl");
    assert!(build(&fx.root, &sneaky).unwrap_err().contains("outside"));
    // An unwritten file is confined the same way, `..` hop or not.
    let unwritten_outside = elsewhere.path("fresh.jsonl");
    assert!(build(&fx.root, &unwritten_outside)
        .unwrap_err()
        .contains("outside"));
    let unwritten_sneaky = sneaky.with_file_name("fresh.jsonl");
    assert!(build(&fx.root, &unwritten_sneaky)
        .unwrap_err()
        .contains("outside"));

    assert!(build(&fx.root, &fx.dir).is_err());
}

#[test]
fn a_parent_session_written_as_a_bare_id_links_the_family() {
    let fx = Fixture::new("idform");
    let session = |id: &str, parent: Option<&str>| {
        let mut head = json!({"type":"session","version":3,"id":id,"timestamp":"2026-10-04T09:00:00.000Z","cwd":"/work/proj"});
        if let Some(parent) = parent {
            head["parentSession"] = json!(parent);
        }
        head
    };
    let root_id = "01a10000-0000-7000-8000-000000000001";
    let fork_id = "01a10000-0000-7000-8000-000000000002";
    let root = fx.put(
        &format!("2026-10-04T09-00-00-000Z_{root_id}.jsonl"),
        &[session(root_id, None), user("u1", None, "q", 1)],
    );
    // TUI `/fork`: the header names the parent by id only.
    let fork = fx.put(
        &format!("2026-10-04T10-00-00-000Z_{fork_id}.jsonl"),
        &[session(fork_id, Some(root_id)), user("u1", None, "q", 1)],
    );
    // A parent found through its header id, not its file name.
    fx.put(
        "odd-name.jsonl",
        &[session("hdr-id", None), user("z1", None, "z", 1)],
    );
    let by_header = fx.put(
        "child.jsonl",
        &[
            session("child-id", Some("hdr-id")),
            user("z1", None, "z", 1),
        ],
    );
    // An id no listed file has links nothing.
    let dangling = fx.put(
        "lost.jsonl",
        &[
            session("lost-id", Some("no-such-id")),
            user("l1", None, "l", 1),
        ],
    );

    let from_fork = fx.tree(&fork);
    assert_eq!(
        names(&from_fork),
        [
            format!("2026-10-04T10-00-00-000Z_{fork_id}.jsonl"),
            format!("2026-10-04T09-00-00-000Z_{root_id}.jsonl"),
        ]
    );
    assert_eq!(fx.tree(&root).files.len(), 2);
    assert_eq!(
        names(&fx.tree(&by_header)),
        ["child.jsonl", "odd-name.jsonl"]
    );
    assert_eq!(names(&fx.tree(&dangling)), ["lost.jsonl"]);
}

/// The sorted keys of a JSON object.
fn keys(v: &Value) -> Vec<&str> {
    let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    k.sort_unstable();
    k
}

#[test]
fn serialises_the_contract_field_names() {
    let fx = Fixture::new("json");
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
            ],
        ),
    );
    let value = serde_json::to_value(fx.tree(&file)).unwrap();
    assert_eq!(keys(&value), ["entries", "files"]);
    assert_eq!(
        keys(&value["files"][0]),
        ["current", "cwd", "leafId", "path", "title"]
    );
    assert_eq!(
        keys(&value["entries"][1]),
        [
            "agent",
            "at",
            "firstKeptExact",
            "firstKeptId",
            "id",
            "inCurrent",
            "kind",
            "label",
            "parentId",
            "text",
            "ts",
            "usage"
        ]
    );
    assert_eq!(
        keys(&value["entries"][1]["usage"]),
        [
            "cacheRead",
            "cacheWrite",
            "costRead",
            "costWrite",
            "input",
            "output",
            "ttl"
        ]
    );
    assert_eq!(value["entries"][0]["kind"], "user");
    assert_eq!(value["entries"][0]["ts"], 1);
    assert_eq!(value["entries"][1]["parentId"], "u1");
}

#[test]
fn history_returns_active_chain_across_compactions_and_tool_calls() {
    let fx = Fixture::new("history_chain");
    let mut reply = assistant("a1", Some("u1"), "answer", 2);
    reply["message"]["content"] = json!([
        {"type":"thinking","thinking":"reasoning"},
        {"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"x","api_key":"secret"}},
        {"type":"text","text":"answer"}
    ]);
    reply["message"]["headers"] = json!({"Authorization":"secret"});
    let tool = json!({"type":"message","id":"t1","parentId":"a1",
        "message":{"role":"toolResult","toolCallId":"call-1","toolName":"read",
            "isError":true,"timestamp":3,"content":[{"type":"text","text":"X".repeat(200_000)}],
            "details":{"accessToken":"secret"}}});
    let compact = json!({"type":"compaction","id":"k1","parentId":"t1",
        "timestamp":"1970-01-01T00:00:01.123Z","summary":"older context",
        "tokensBefore":1234,"firstKeptEntryId":"a1"});
    let failed = json!({"type":"compaction","id":"bad","parentId":"k1",
        "timestamp":"1970-01-01T00:00:02.000Z","summary":"not saved","success":false});
    let file = fx.put(
        "current.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "early prompt", 1),
                reply,
                tool,
                compact,
                failed,
                user("abandoned", Some("bad"), "abandoned branch", 4),
                assistant("abandoned-reply", Some("abandoned"), "old answer", 5),
                user("u2", Some("bad"), "current prompt", 6),
                assistant("a2", Some("u2"), "current answer", 7),
                other("custom", "last", Some("a2")),
            ],
        ),
    );
    let result = serde_json::to_value(history::build(&fx.root, &file).unwrap()).unwrap();
    assert_eq!(result["fork"], Value::Null);
    let messages = result["messages"].as_array().unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|m| m["entryId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["u1", "a1", "t1", "k1", "u2", "a2"]
    );
    assert_eq!(messages[0]["content"][0]["text"], "early prompt");
    assert_eq!(messages[1]["content"][0]["thinking"], "reasoning");
    assert_eq!(messages[1]["content"][1]["arguments"]["path"], "x");
    assert_eq!(
        messages[1]["content"][1]["arguments"]["api_key"],
        "[REDACTED]"
    );
    assert_eq!(messages[1]["headers"], "[REDACTED]");
    assert_eq!(
        messages[2],
        json!({"role":"toolResult","entryId":"t1",
        "toolCallId":"call-1","toolName":"read","isError":true,"timestamp":3,
        "historyOmittedOutput":true})
    );
    assert_eq!(
        messages[3],
        json!({"role":"compactionSummary","entryId":"k1",
        "timestamp":"1970-01-01T00:00:01.123Z","summary":"older context","tokensBefore":1234,
        "firstKeptEntryId":"a1"})
    );
    assert!(!result.to_string().contains(&"X".repeat(1000)));
    assert!(!result.to_string().contains("secret"));
}

#[test]
fn history_retains_early_messages_in_a_long_compacted_session() {
    let fx = Fixture::new("history_long");
    let mut entries = Vec::new();
    let mut parent: Option<String> = None;
    for n in 0..1_200 {
        let u = format!("u{n}");
        let a = format!("a{n}");
        entries.push(user(&u, parent.as_deref(), &format!("prompt {n}"), n));
        entries.push(assistant(&a, Some(&u), &format!("answer {n}"), n));
        parent = Some(a);
    }
    entries.push(json!({"type":"compaction","id":"compact","parentId":parent,
        "timestamp":"1970-01-01T00:00:00Z","summary":"summary","tokensBefore":123}));
    entries.push(user("new", Some("compact"), "after compaction", 1201));
    let file = fx.put("long.jsonl", &with_header(None, entries));
    let messages = history::build(&fx.root, &file).unwrap().messages;
    assert_eq!(messages.len(), 2402);
    assert_eq!(messages[0]["entryId"], "u0");
    assert_eq!(messages[1]["entryId"], "a0");
    assert_eq!(messages[2400]["entryId"], "compact");
    assert_eq!(messages[2400]["timestamp"], "1970-01-01T00:00:00Z");
    assert_eq!(messages[2401]["entryId"], "new");
}

#[test]
fn history_handles_lazy_files_partial_lines_and_missing_parents() {
    let fx = Fixture::new("history_missing");
    let empty =
        serde_json::to_value(history::build(&fx.root, &fx.path("new.jsonl")).unwrap()).unwrap();
    assert_eq!(empty, json!({"messages":[],"fork":null}));

    let prefix = with_header(None, vec![user("u1", None, "kept", 1)])
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    let file = fx.put_raw(
        "partial.jsonl",
        &format!("{prefix}\n{{\"type\":\"message\",\"id\":\"unwritten\""),
    );
    let history = history::build(&fx.root, &file).unwrap();
    assert_eq!(history.messages.len(), 1);
    assert_eq!(history.messages[0]["entryId"], "u1");

    let broken = fx.put(
        "broken.jsonl",
        &with_header(None, vec![user("u2", Some("lost"), "x", 2)]),
    );
    assert!(history::build(&fx.root, &broken)
        .unwrap_err()
        .contains("parent entry lost is missing"));
    let duplicate = fx.put(
        "duplicate.jsonl",
        &with_header(
            None,
            vec![user("u1", None, "first", 1), user("u1", None, "second", 2)],
        ),
    );
    assert!(history::build(&fx.root, &duplicate)
        .unwrap_err()
        .contains("duplicate"));
}

#[test]
fn history_fork_number_is_the_stable_complete_family_order() {
    let fx = Fixture::new("history_forks");
    let root = fx.put(
        "f00.jsonl",
        &with_header(None, vec![user("u0", None, "root", 1)]),
    );
    let mut children = Vec::new();
    for n in 1..=35 {
        let name = format!("f{n:02}.jsonl");
        let parent = children.last().unwrap_or(&root);
        let file = fx.put(
            &name,
            &with_header(Some(parent), vec![user("u0", None, "root", 1)]),
        );
        children.push(file);
    }
    let first = serde_json::to_value(history::build(&fx.root, &children[0]).unwrap()).unwrap();
    let last = serde_json::to_value(history::build(&fx.root, &children[34]).unwrap()).unwrap();
    assert_eq!(
        first["fork"],
        json!({"number":1,"parentSession":root.to_string_lossy()})
    );
    assert_eq!(
        last["fork"],
        json!({"number":35,"parentSession":children[33].to_string_lossy()})
    );
    assert!(history::build(&fx.root, &root).unwrap().fork.is_none());
    fx.put("unrelated.jsonl", &with_header(None, vec![]));
    assert_eq!(
        history::build(&fx.root, &children[34])
            .unwrap()
            .fork
            .unwrap()
            .number,
        35
    );
}

#[test]
fn history_preserves_bare_parent_session_ids() {
    let fx = Fixture::new("history_bare_parent");
    fx.put(
        "f00.jsonl",
        &[
            json!({"type":"session","id":"root-id"}),
            user("u1", None, "root", 1),
        ],
    );
    let one = fx.put(
        "f01.jsonl",
        &[
            json!({"type":"session","id":"fork-one","parentSession":"root-id"}),
            user("u1", None, "root", 1),
        ],
    );
    let two = fx.put(
        "f02.jsonl",
        &[
            json!({"type":"session","id":"fork-two","parentSession":"root-id"}),
            user("u1", None, "root", 1),
        ],
    );
    let first = serde_json::to_value(history::build(&fx.root, &one).unwrap()).unwrap();
    let second = serde_json::to_value(history::build(&fx.root, &two).unwrap()).unwrap();
    assert_eq!(first["fork"], json!({"number":1,"parentSession":"root-id"}));
    assert_eq!(
        second["fork"],
        json!({"number":2,"parentSession":"root-id"})
    );
}

#[test]
fn history_rejects_outside_files_and_oversized_lines() {
    let fx = Fixture::new("history_security");
    let elsewhere = Fixture::new("history_elsewhere");
    let outside = elsewhere.put("other.jsonl", &with_header(None, vec![]));
    assert!(history::build(&fx.root, &outside)
        .unwrap_err()
        .contains("outside"));
    assert!(history::build(&fx.root, &elsewhere.path("new.jsonl"))
        .unwrap_err()
        .contains("outside"));
    assert!(history::build(&fx.root, &fx.path("new.txt"))
        .unwrap_err()
        .contains(".jsonl"));

    let large = fx.put_raw("huge.jsonl", &"x".repeat(16 * 1024 * 1024 + 1));
    assert!(history::build(&fx.root, &large)
        .unwrap_err()
        .contains("line exceeds"));

    let large_metadata = fx.put(
        "large-metadata.jsonl",
        &with_header(
            None,
            vec![
                json!({"type":"message","id":"tool","parentId":null,"message":{
            "role":"toolResult","toolCallId":"a".repeat(16 * 1024 + 1),
            "toolName":"read","isError":false}}),
            ],
        ),
    );
    assert!(history::build(&fx.root, &large_metadata)
        .unwrap_err()
        .contains("metadata exceeds"));
}

#[cfg(unix)]
#[test]
fn history_rejects_escaping_and_dangling_symlinks() {
    use std::os::unix::fs::symlink;
    let fx = Fixture::new("history_links");
    let elsewhere = Fixture::new("history_link_target");
    let outside = elsewhere.put("other.jsonl", &with_header(None, vec![]));
    let escaping = fx.path("escaping.jsonl");
    symlink(outside, &escaping).unwrap();
    assert!(history::build(&fx.root, &escaping)
        .unwrap_err()
        .contains("outside"));
    let dangling = fx.path("dangling.jsonl");
    symlink(fx.path("missing.jsonl"), &dangling).unwrap();
    assert!(history::build(&fx.root, &dangling)
        .unwrap_err()
        .contains("dangling"));
}

#[test]
fn history_replays_captured_leaf_and_ignores_late_off_branch_records() {
    let fx = Fixture::new("captured_leaf");
    let early = user("root", None, "root", 1);
    let old = user("old", Some("root"), "abandoned", 2);
    let current = user("current", Some("root"), "current", 3);
    let mut late = other("model_usage", "late", Some("old"));
    late["activeLeafId"] = json!("current");
    let file = fx.put(
        "valid.jsonl",
        &with_header(
            None,
            vec![early.clone(), old.clone(), current.clone(), late.clone()],
        ),
    );
    let history = history::build(&fx.root, &file).unwrap();
    assert_eq!(
        history
            .messages
            .iter()
            .map(|m| m["entryId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["root", "current"]
    );

    late["activeLeafId"] = Value::Null;
    let file = fx.put(
        "clear.jsonl",
        &with_header(None, vec![early.clone(), current.clone(), late.clone()]),
    );
    let messages = history::build(&fx.root, &file).unwrap().messages;
    assert!(
        messages.is_empty(),
        "expected cleared history, got {messages:?}"
    );

    late["activeLeafId"] = json!("missing");
    let mut intervening = other("custom", "offbranch", Some("old"));
    intervening["activeLeafId"] = json!("root");
    let file = fx.put(
        "dangling.jsonl",
        &with_header(None, vec![early, old, current, intervening, late]),
    );
    let history = history::build(&fx.root, &file).unwrap();
    assert_eq!(
        history
            .messages
            .iter()
            .map(|m| m["entryId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["root", "current"]
    );
}

fn history_blob(fx: &Fixture, bytes: &[u8]) -> String {
    let hash = crate::json_store::hex_sha256(bytes);
    let dir = fx.root.parent().unwrap().join("blobs");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(&hash), bytes).unwrap();
    format!("blob:sha256:{hash}")
}

fn image_message(id: &str, parent: Option<&str>, reference: &str) -> Value {
    let mut entry = user(id, parent, "image", 1);
    entry["message"]["content"] = json!([{"type":"image","data":reference,"mimeType":"image/png"}]);
    entry
}

#[test]
fn history_hydrates_native_images_and_provider_data_urls_without_mutation() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fx = Fixture::new("history_blobs");
    let bytes = b"\x89PNG\r\n\x1a\nactual image bytes";
    let url = "data:image/png;base64,iVBORw0KGgo=";
    let reference = history_blob(&fx, bytes);
    let url_ref = history_blob(&fx, url.as_bytes());
    let mut reply = assistant("answer", Some("image"), "done", 2);
    reply["message"]["content"] = json!([{"type":"image","data":reference,"mimeType":"image/png"},
        {"type":"input_image","image_url":url_ref}]);
    let entries = with_header(None, vec![image_message("image", None, &reference), reply]);
    let file = fx.put("images.jsonl", &entries);
    let before = fs::read(&file).unwrap();
    let messages = history::build(&fx.root, &file).unwrap().messages;
    assert_eq!(messages[0]["content"][0]["data"], STANDARD.encode(bytes));
    assert_eq!(messages[1]["content"][0]["data"], STANDARD.encode(bytes));
    assert_eq!(messages[1]["content"][1]["image_url"], url);
    assert_eq!(fs::read(&file).unwrap(), before);
    assert_eq!(
        fs::read(
            fx.root
                .parent()
                .unwrap()
                .join("blobs")
                .join(reference.strip_prefix("blob:sha256:").unwrap())
        )
        .unwrap(),
        bytes
    );
}

#[test]
fn history_reports_missing_invalid_corrupt_and_oversized_images() {
    let fx = Fixture::new("history_bad_blobs");
    let missing = format!("blob:sha256:{}", "a".repeat(64));
    let file = fx.put(
        "missing.jsonl",
        &with_header(None, vec![image_message("i", None, &missing)]),
    );
    assert!(history::build(&fx.root, &file)
        .unwrap_err()
        .contains("blob"));
    let invalid = format!("blob:sha256:{}", "A".repeat(64));
    let file = fx.put(
        "invalid.jsonl",
        &with_header(None, vec![image_message("i", None, &invalid)]),
    );
    assert!(history::build(&fx.root, &file)
        .unwrap_err()
        .contains("lowercase SHA-256"));
    let blob_dir = fx.root.parent().unwrap().join("blobs");
    fs::create_dir_all(&blob_dir).unwrap();
    fs::write(blob_dir.join("a".repeat(64)), b"wrong bytes").unwrap();
    assert!(history::build(&fx.root, &fx.path("missing.jsonl"))
        .unwrap_err()
        .contains("SHA-256"));
    fs::write(blob_dir.join("a".repeat(64)), vec![0; 8 * 1024 * 1024 + 1]).unwrap();
    assert!(history::build(&fx.root, &fx.path("missing.jsonl"))
        .unwrap_err()
        .contains("exceeds"));
}

#[test]
fn history_bounds_hydrated_images_and_skips_unselected_blobs() {
    let fx = Fixture::new("history_blob_limits");
    let reference = history_blob(&fx, &vec![7; 8 * 1024 * 1024]);
    let mut oversized = user("i", None, "images", 1);
    oversized["message"]["content"] = Value::Array(
        (0..6)
            .map(|_| json!({"type":"image","data":reference,"mimeType":"image/png"}))
            .collect(),
    );
    let file = fx.put("many.jsonl", &with_header(None, vec![oversized]));
    assert!(history::build(&fx.root, &file)
        .unwrap_err()
        .contains("hydrated images exceed"));

    let missing = format!("blob:sha256:{}", "f".repeat(64));
    let mut late = other("model_usage", "late", Some("abandoned"));
    late["activeLeafId"] = json!("current");
    let file = fx.put(
        "branch.jsonl",
        &with_header(
            None,
            vec![
                user("root", None, "root", 1),
                image_message("abandoned", Some("root"), &missing),
                user("current", Some("root"), "current", 2),
                late,
            ],
        ),
    );
    let messages = history::build(&fx.root, &file).unwrap().messages;
    assert_eq!(
        messages
            .iter()
            .map(|m| m["entryId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["root", "current"]
    );
}

#[cfg(unix)]
#[test]
fn history_rejects_blob_and_store_symlinks() {
    use std::os::unix::fs::symlink;
    let fx = Fixture::new("history_blob_links");
    let other = Fixture::new("history_blob_link_target");
    let bytes = b"outside";
    let hash = crate::json_store::hex_sha256(bytes);
    let outside = other.root.join(&hash);
    fs::write(&outside, bytes).unwrap();
    let store = fx.root.parent().unwrap().join("blobs");
    fs::create_dir_all(&store).unwrap();
    symlink(&outside, store.join(&hash)).unwrap();
    let file = fx.put(
        "link.jsonl",
        &with_header(
            None,
            vec![image_message("i", None, &format!("blob:sha256:{hash}"))],
        ),
    );
    assert!(history::build(&fx.root, &file)
        .unwrap_err()
        .contains("blob"));
    fs::remove_file(store.join(&hash)).unwrap();
    fs::remove_dir(&store).unwrap();
    symlink(&other.root, &store).unwrap();
    assert!(history::build(&fx.root, &file)
        .unwrap_err()
        .contains("blob store"));
}
