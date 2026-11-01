//! The active parent chain of one saved session, including pre-compaction
//! messages. This is separate from the family graph and from omp's compacted
//! runtime context: neither is the transcript to show in the chat.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Map, Value};

use crate::redaction::{is_credential_key, REDACTED_PLACEHOLDER};

use super::{family, images, validate};

// Refuse a history rather than silently returning a truncated one. Tool output
// is not retained, but its line must still be parsed to connect its children.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 250_000;
const MAX_RETAINED_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOOL_METADATA_BYTES: usize = 16 * 1024;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHistory {
    pub messages: Vec<Value>,
    pub fork: Option<Fork>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fork {
    pub number: usize,
    pub parent_session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line<'a> {
    #[serde(rename = "type", borrow)]
    kind: &'a str,
    id: Option<String>,
    parent_id: Option<String>,
    #[serde(default, deserialize_with = "captured_leaf")]
    active_leaf_id: CapturedLeaf,
    parent_session: Option<String>,
    timestamp: Option<String>,
    summary: Option<String>,
    #[serde(borrow)]
    tokens_before: Option<&'a RawValue>,
    short_summary: Option<String>,
    first_kept_entry_id: Option<String>,
    success: Option<bool>,
    status: Option<String>,
    #[serde(borrow)]
    message: Option<&'a RawValue>,
}

// Missing and explicit null have different meanings when selecting the leaf.
#[derive(Default)]
enum CapturedLeaf {
    #[default]
    Absent,
    Cleared,
    Id(String),
}

fn captured_leaf<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<CapturedLeaf, D::Error> {
    Option::<String>::deserialize(deserializer)
        .map(|leaf| leaf.map_or(CapturedLeaf::Cleared, CapturedLeaf::Id))
}

// Parse only metadata from tool results; their potentially huge content never
// enters the returned value. Assistant tool-call blocks remain intact.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageFields<'a> {
    #[serde(borrow)]
    role: Option<&'a str>,
    #[serde(borrow)]
    tool_call_id: Option<&'a RawValue>,
    #[serde(borrow)]
    tool_name: Option<&'a RawValue>,
    #[serde(borrow)]
    is_error: Option<&'a RawValue>,
    #[serde(borrow)]
    timestamp: Option<&'a RawValue>,
}

struct Entry {
    parent: Option<String>,
    message: Option<Value>,
}

enum SelectedLeaf {
    Own(usize),
    Cleared,
    Captured(String),
}

struct ParsedHistory {
    entries: Vec<Entry>,
    by_id: HashMap<String, usize>,
    selected_leaf: Option<SelectedLeaf>,
    last_self_selected: Option<usize>,
    parent_session: Option<String>,
    retained: usize,
}

/// Match the same structured-key boundary as the agent stdout reader. Free
/// text is intentionally unchanged, exactly as with `get_messages` responses.
fn sanitize(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if is_credential_key(key) {
                    *value = Value::String(REDACTED_PLACEHOLDER.to_string());
                } else {
                    sanitize(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(sanitize),
        _ => {}
    }
}

fn copy_field(
    map: &mut Map<String, Value>,
    key: &str,
    raw: Option<&RawValue>,
    valid: fn(&Value) -> bool,
) -> usize {
    let Some(raw) = raw else { return 0 };
    if let Ok(value) = serde_json::from_str::<Value>(raw.get()) {
        if valid(&value) {
            map.insert(key.to_string(), value);
            return raw.get().len();
        }
    }
    0
}

fn saved_message(raw: &RawValue, id: &str) -> Result<Option<(Value, usize)>, String> {
    let Ok(fields) = serde_json::from_str::<MessageFields<'_>>(raw.get()) else {
        return Ok(None);
    };
    let (mut value, size) = match fields.role {
        Some("user" | "assistant") => {
            let Ok(value) = serde_json::from_str::<Value>(raw.get()) else {
                return Ok(None);
            };
            (value, raw.get().len())
        }
        Some("toolResult") => {
            for field in [
                fields.tool_call_id,
                fields.tool_name,
                fields.is_error,
                fields.timestamp,
            ]
            .into_iter()
            .flatten()
            {
                if field.get().len() > MAX_TOOL_METADATA_BYTES {
                    return Err(format!(
                        "session tool result metadata exceeds {MAX_TOOL_METADATA_BYTES} bytes"
                    ));
                }
            }
            let mut map = Map::new();
            map.insert("role".into(), Value::String("toolResult".into()));
            map.insert("historyOmittedOutput".into(), Value::Bool(true));
            let mut size = 0;
            size += copy_field(
                &mut map,
                "toolCallId",
                fields.tool_call_id,
                Value::is_string,
            );
            size += copy_field(&mut map, "toolName", fields.tool_name, Value::is_string);
            size += copy_field(&mut map, "isError", fields.is_error, Value::is_boolean);
            size += copy_field(&mut map, "timestamp", fields.timestamp, Value::is_number);
            (Value::Object(map), size)
        }
        _ => return Ok(None),
    };
    let Some(map) = value.as_object_mut() else {
        return Ok(None);
    };
    map.insert("entryId".into(), Value::String(id.to_string()));
    sanitize(&mut value);
    Ok(Some((value, size)))
}

fn compaction(line: &mut Line<'_>, id: &str) -> Option<(Value, usize)> {
    if line.success == Some(false) || line.status.as_deref() == Some("error") {
        return None;
    }
    let summary = line.summary.take()?;
    let mut map = Map::new();
    map.insert("role".into(), Value::String("compactionSummary".into()));
    map.insert("entryId".into(), Value::String(id.to_string()));
    let mut size = summary.len();
    map.insert("summary".into(), Value::String(summary));
    if let Some(short) = line.short_summary.take() {
        size += short.len();
        map.insert("shortSummary".into(), Value::String(short));
    }
    if let Some(first) = line.first_kept_entry_id.take() {
        size += first.len();
        map.insert("firstKeptEntryId".into(), Value::String(first));
    }
    size += copy_field(
        &mut map,
        "tokensBefore",
        line.tokens_before,
        Value::is_number,
    );
    if let Some(timestamp) = line.timestamp.take() {
        // The frontend's existing date formatter accepts ISO entry timestamps.
        map.insert("timestamp".into(), Value::String(timestamp));
    }
    let mut value = Value::Object(map);
    sanitize(&mut value);
    Some((value, size))
}

fn read_history(session_file: &Path) -> Result<ParsedHistory, String> {
    let file = File::open(session_file)
        .map_err(|e| format!("cannot read {}: {e}", session_file.display()))?;
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut selected_leaf = None;
    let mut last_self_selected = None;
    let mut parent_session = None;
    let mut retained = 0usize;

    loop {
        bytes.clear();
        let count = (&mut reader)
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| format!("cannot read {}: {e}", session_file.display()))?;
        if count == 0 {
            break;
        }
        if count > MAX_LINE_BYTES {
            return Err(format!(
                "session history line exceeds {MAX_LINE_BYTES} bytes"
            ));
        }
        // A partial final line or malformed entry is not a committed entry.
        let Ok(mut line) = serde_json::from_slice::<Line<'_>>(&bytes) else {
            continue;
        };
        if line.kind == "session" {
            parent_session = line.parent_session.filter(|parent| !parent.is_empty());
            continue;
        }
        let Some(id) = line.id.take() else { continue };
        selected_leaf = Some(match std::mem::take(&mut line.active_leaf_id) {
            CapturedLeaf::Absent => {
                last_self_selected = Some(entries.len());
                SelectedLeaf::Own(entries.len())
            }
            CapturedLeaf::Cleared => SelectedLeaf::Cleared,
            CapturedLeaf::Id(leaf) => {
                if leaf == id {
                    last_self_selected = Some(entries.len());
                }
                SelectedLeaf::Captured(leaf)
            }
        });
        if entries.len() >= MAX_ENTRIES {
            return Err(format!("session history exceeds {MAX_ENTRIES} entries"));
        }
        let saved = match line.kind {
            "message" => match line.message {
                Some(message) => saved_message(message, &id)?,
                None => None,
            },
            "compaction" => compaction(&mut line, &id),
            _ => None,
        };
        let (message, size) = saved.map_or((None, 0), |(message, size)| (Some(message), size));
        retained = retained
            .saturating_add(id.len() * 2)
            .saturating_add(line.parent_id.as_ref().map_or(0, String::len))
            .saturating_add(size);
        if retained > MAX_RETAINED_BYTES {
            return Err(format!(
                "session history exceeds {MAX_RETAINED_BYTES} retained bytes"
            ));
        }
        if by_id.insert(id, entries.len()).is_some() {
            return Err("session history contains duplicate entry IDs".into());
        }
        // The last physical record may belong to a discarded branch.
        entries.push(Entry {
            parent: line.parent_id,
            message,
        });
    }
    Ok(ParsedHistory {
        entries,
        by_id,
        selected_leaf,
        last_self_selected,
        parent_session,
        retained,
    })
}

pub(super) fn build(root: &Path, session_file: &Path) -> Result<ConversationHistory, String> {
    let Some((dir, current)) = validate(root, session_file)? else {
        return Ok(ConversationHistory::default());
    };
    let ParsedHistory {
        mut entries,
        by_id,
        selected_leaf,
        last_self_selected,
        parent_session,
        mut retained,
    } = read_history(session_file)?;

    let mut leaf = match selected_leaf {
        None | Some(SelectedLeaf::Cleared) => None,
        Some(SelectedLeaf::Own(index)) => Some(index),
        Some(SelectedLeaf::Captured(id)) => by_id.get(&id).copied().or(last_self_selected),
    };

    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    while let Some(index) = leaf {
        if !seen.insert(index) {
            return Err("session history contains a parent cycle".into());
        }
        let entry = &mut entries[index];
        if let Some(message) = entry.message.take() {
            chain.push(message);
        }
        leaf = match entry.parent.as_deref() {
            Some(id) => Some(
                *by_id
                    .get(id)
                    .ok_or_else(|| format!("session history parent entry {id} is missing"))?,
            ),
            None => None,
        };
    }
    chain.reverse();
    let mut hydrated = 0;
    for message in &mut chain {
        images::hydrate(
            root,
            message,
            &mut hydrated,
            &mut retained,
            MAX_RETAINED_BYTES,
        )?;
    }
    let fork = match parent_session {
        Some(parent_session) => Some(Fork {
            number: family::fork_number(dir, current)
                .map_err(|e| format!("cannot list {}: {e}", dir.display()))?,
            parent_session,
        }),
        None => None,
    };
    Ok(ConversationHistory {
        messages: chain,
        fork,
    })
}
