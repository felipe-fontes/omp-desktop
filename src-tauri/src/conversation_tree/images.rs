//! Restore native content-addressed image payloads only after selecting the branch.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

const PREFIX: &str = "blob:sha256:";
// Native image blocks store raw bytes; provider image URLs store UTF-8 base64.
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_URL_BYTES: usize = MAX_IMAGE_BYTES.div_ceil(3) * 4 + 1024;
const MAX_HYDRATED_BYTES: usize = 64 * 1024 * 1024;

#[cfg(unix)]
fn open_blob(root: &Path, hash: &str) -> Result<File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;

    let agent = root.parent().ok_or("invalid sessions directory")?;
    // Pin the real profile's blobs directory, disallowing a redirected sibling.
    let store = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(agent.join("blobs"))
        .map_err(|e| format!("cannot open profile image blob store: {e}"))?;
    let mut name = [0u8; 65];
    name[..64].copy_from_slice(hash.as_bytes());
    // openat pins lookup to the already-open store, and never follows a blob link.
    // SAFETY: the live directory handle pins the store; the validated hash
    // is exactly 64 ASCII bytes followed by a NUL in `name`. These flags
    // reject links and make the returned fd private to this process.
    let fd = unsafe {
        libc::openat(
            store.as_raw_fd(),
            name.as_ptr().cast(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(format!(
            "cannot open image blob {hash}: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: openat returned a new, non-negative fd; this is its sole owner.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(windows)]
fn open_blob(root: &Path, hash: &str) -> Result<File, String> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
        VOLUME_NAME_DOS,
    };

    const PATH_CAPACITY: u16 = 32_768;
    let agent = root
        .parent()
        .ok_or("invalid sessions directory")?
        .canonicalize()
        .map_err(|e| format!("cannot resolve profile directory: {e}"))?;
    let store = agent.join("blobs");
    let metadata = std::fs::symlink_metadata(&store)
        .map_err(|e| format!("cannot inspect profile image blob store: {e}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || store
            .canonicalize()
            .map_err(|e| format!("cannot resolve image blob store: {e}"))?
            != store
    {
        return Err("profile image blob store is a link or outside the profile".into());
    }
    // Open the file itself, not a final reparse point. Check the opened
    // handle's actual location too, so a swapped parent cannot redirect it.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(store.join(hash))
        .map_err(|e| format!("cannot open image blob {hash}: {e}"))?;
    let mut path = vec![0u16; usize::from(PATH_CAPACITY)];
    // SAFETY: the file owns a valid handle and `path` is writable for exactly
    // the supplied number of UTF-16 units. The returned length is checked.
    let len = usize::try_from(unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            path.as_mut_ptr(),
            u32::from(PATH_CAPACITY),
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    })
    .map_err(|_| format!("cannot resolve opened image blob {hash}"))?;
    if len == 0 || len >= path.len() {
        return Err(format!("cannot resolve opened image blob {hash}"));
    }
    let actual = std::path::PathBuf::from(std::ffi::OsString::from_wide(&path[..len]));
    if actual.parent() != Some(store.as_path()) {
        return Err(format!("image blob {hash} is outside the profile store"));
    }
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn open_blob(root: &Path, hash: &str) -> Result<File, String> {
    let _ = (root, hash);
    Err("secure image blob access is unavailable on this platform".into())
}

fn resolve(
    root: &Path,
    reference: &str,
    data_url: bool,
    hydrated: &mut usize,
    retained: &mut usize,
    retained_limit: usize,
) -> Result<String, String> {
    let hash = reference
        .strip_prefix(PREFIX)
        .ok_or("invalid image blob reference")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("invalid image blob reference: expected a lowercase SHA-256 hash".into());
    }
    let mut file = open_blob(root, hash)?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("cannot inspect image blob {hash}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("image blob {hash} is not a regular file"));
    }
    let limit = if data_url {
        MAX_URL_BYTES
    } else {
        MAX_IMAGE_BYTES
    };
    let capacity = usize::try_from(metadata.len())
        .map_err(|_| format!("image blob {hash} exceeds {limit} bytes"))?;
    if capacity > limit {
        return Err(format!("image blob {hash} exceeds {limit} bytes"));
    }
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read image blob {hash}: {e}"))?;
    if bytes.len() > limit {
        return Err(format!("image blob {hash} exceeds {limit} bytes"));
    }
    if crate::json_store::hex_sha256(&bytes) != hash {
        return Err(format!("image blob {hash} failed SHA-256 verification"));
    }
    let output_len = if data_url {
        bytes.len()
    } else {
        bytes.len().div_ceil(3) * 4
    };
    *hydrated = hydrated
        .checked_add(output_len)
        .ok_or("hydrated image size overflow")?;
    if *hydrated > MAX_HYDRATED_BYTES {
        return Err(format!("hydrated images exceed {MAX_HYDRATED_BYTES} bytes"));
    }
    *retained = retained.saturating_add(output_len.saturating_sub(reference.len()));
    if *retained > retained_limit {
        return Err(format!(
            "session history exceeds {retained_limit} retained bytes after image hydration"
        ));
    }
    if data_url {
        let url = String::from_utf8(bytes)
            .map_err(|_| format!("image blob {hash} is not a UTF-8 data URL"))?;
        let Some((mime, data)) = url
            .strip_prefix("data:image/")
            .and_then(|s| s.split_once(";base64,"))
        else {
            return Err(format!("image blob {hash} is not an image data URL"));
        };
        let unpadded = data.trim_end_matches('=');
        let padding = data.len() - unpadded.len();
        let remainder = unpadded.len() % 4;
        let decoded_len = (unpadded.len() / 4) * 3
            + match remainder {
                2 => 1,
                3 => 2,
                _ => 0,
            };
        if mime.is_empty()
            || mime.contains(';')
            || mime.contains(',')
            || unpadded.is_empty()
            || remainder == 1
            || padding > 2
            || (padding > 0 && (data.len() % 4 != 0 || padding != 4 - remainder))
            || decoded_len > MAX_IMAGE_BYTES
            || !unpadded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
        {
            return Err(format!(
                "image blob {hash} contains an invalid image data URL"
            ));
        }
        Ok(url)
    } else {
        Ok(STANDARD.encode(bytes))
    }
}

fn visit(
    root: &Path,
    value: &mut Value,
    key: Option<&str>,
    hydrated: &mut usize,
    retained: &mut usize,
    retained_limit: usize,
) -> Result<(), String> {
    match value {
        Value::Array(values) => {
            for value in values {
                visit(root, value, key, hydrated, retained, retained_limit)?;
            }
        }
        Value::Object(map) => {
            let is_image = map.get("type").and_then(Value::as_str) == Some("image");
            let is_image_payload = is_image
                || map
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .is_some_and(|s| {
                        s.get(..6)
                            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("image/"))
                    });
            let image_data =
                (key == Some("content") && is_image) || (key == Some("images") && is_image_payload);
            let generated =
                map.get("type").and_then(Value::as_str) == Some("image_generation_call");
            for (field, child) in map {
                if field == "frames" {
                    continue;
                }
                let selected = (field == "data" && image_data)
                    || (field == "result" && generated)
                    || field == "image_url";
                if selected {
                    if let Some(reference) = child.as_str().filter(|s| s.starts_with("blob:")) {
                        *child = Value::String(resolve(
                            root,
                            reference,
                            field == "image_url",
                            hydrated,
                            retained,
                            retained_limit,
                        )?);
                        continue;
                    }
                }
                visit(root, child, Some(field), hydrated, retained, retained_limit)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn hydrate(
    root: &Path,
    message: &mut Value,
    hydrated: &mut usize,
    retained: &mut usize,
    retained_limit: usize,
) -> Result<(), String> {
    if matches!(
        message.get("role").and_then(Value::as_str),
        Some("user" | "assistant")
    ) {
        visit(root, message, None, hydrated, retained, retained_limit)?;
    }
    Ok(())
}
