//! Bounded inspection and non-overwriting copies of scratch workspaces.
//! Links and special files are never followed; promotion rejects them rather
//! than silently losing part of the workspace.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};

const MAX_ENTRIES: usize = 20_000;
const MAX_DEPTH: usize = 64;
const COPY_DEPTH: usize = 128;

#[derive(Debug, serde::Serialize)]
pub struct ScratchFile {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct Usage {
    pub bytes: u64,
    pub files: usize,
    pub complete: bool,
    /// Another chat metadata row still references the same workspace.
    pub shared: bool,
}

struct Scan {
    files: Vec<ScratchFile>,
    bytes: u64,
    seen: usize,
    complete: bool,
}

// A directory handle, not merely a checked path. Unix children are opened
// relative to it with O_NOFOLLOW, so replacing a parent with a link after it
// was inspected cannot redirect a read outside the workspace.
struct Directory {
    file: File,
    path: PathBuf,
    #[cfg(windows)]
    root: PathBuf,
}

enum Node {
    Directory(Directory),
    File(File),
    Link,
    Special,
}

#[cfg(windows)]
fn windows_identity(file: &File) -> io::Result<(u32, u32, u32, u32)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the File owns a live handle and info points to writable storage.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
        info.dwFileAttributes,
    ))
}

#[cfg(windows)]
fn windows_path(file: &File) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    // SAFETY: a null buffer with length zero requests the necessary length.
    let required =
        unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), std::ptr::null_mut(), 0, 0) };
    if required == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0_u16; required as usize + 1];
    // SAFETY: buffer is writable for the supplied capacity and file is live.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..length as usize],
    )))
}

#[cfg(windows)]
fn open_windows_entry(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        // BACKUP_SEMANTICS permits directories; OPEN_REPARSE_POINT refuses
        // to traverse the final component of this particular open.
        .custom_flags(0x0200_0000 | 0x0020_0000)
        .open(path)
}

impl Directory {
    fn open(path: &Path) -> io::Result<Self> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
            options.custom_flags(0x0200_0000 | 0x0020_0000);
        }
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() {
            return Err(io::Error::other(
                "workspace directory is not a real directory",
            ));
        }
        let file = options.open(path)?;
        if !file.metadata()?.is_dir() {
            return Err(io::Error::other("workspace directory changed"));
        }
        #[cfg(windows)]
        let root = {
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            if windows_identity(&file)?.3 & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(io::Error::other("workspace directory is a reparse point"));
            }
            let root = windows_path(&file)?;
            if root != path.canonicalize()? {
                return Err(io::Error::other(
                    "workspace directory changed while opening",
                ));
            }
            root
        };
        Ok(Self {
            file,
            path: path.to_path_buf(),
            #[cfg(windows)]
            root,
        })
    }

    #[cfg(unix)]
    fn child(&self, name: &std::ffi::OsStr) -> io::Result<Node> {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        let name_c =
            CString::new(name.as_bytes()).map_err(|_| io::Error::other("invalid filename"))?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: name is NUL terminated, stat is writable, and the directory
        // handle stays alive for the call.
        if unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                name_c.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fstatat succeeded and initialized the whole struct.
        let mode = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
        if mode == libc::S_IFLNK {
            return Ok(Node::Link);
        }
        if mode != libc::S_IFDIR && mode != libc::S_IFREG {
            return Ok(Node::Special);
        }
        let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
        if mode == libc::S_IFDIR {
            flags |= libc::O_DIRECTORY;
        }
        // SAFETY: valid directory descriptor and NUL-terminated name.
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name_c.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: openat returned a new descriptor owned by this File.
        let file = unsafe { File::from_raw_fd(fd) };
        let meta = file.metadata()?;
        if mode == libc::S_IFDIR && meta.is_dir() {
            Ok(Node::Directory(Self {
                file,
                path: self.path.join(name),
            }))
        } else if mode == libc::S_IFREG && meta.is_file() {
            Ok(Node::File(file))
        } else {
            Err(io::Error::other("workspace entry changed while opening"))
        }
    }

    #[cfg(windows)]
    fn ensure_current(&self) -> io::Result<()> {
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        let current = open_windows_entry(&self.path)?;
        let held = windows_identity(&self.file)?;
        let fresh = windows_identity(&current)?;
        if held.0 != fresh.0
            || held.1 != fresh.1
            || held.2 != fresh.2
            || fresh.3 & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || !windows_path(&current)?.starts_with(&self.root)
        {
            return Err(io::Error::other(
                "workspace directory changed while opening",
            ));
        }
        Ok(())
    }

    #[cfg(windows)]
    fn child(&self, name: &std::ffi::OsStr) -> io::Result<Node> {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        self.ensure_current()?;
        let path = self.path.join(name);
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(Node::Link);
        }
        if !meta.is_dir() && !meta.is_file() {
            return Ok(Node::Special);
        }
        let file = open_windows_entry(&path)?;
        let opened = file.metadata()?;
        let info = windows_identity(&file)?;
        if info.3 & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("workspace entry became a reparse point"));
        }
        let resolved = windows_path(&file)?;
        let parent = windows_path(&self.file)?;
        if !resolved.starts_with(&self.root) || resolved.parent() != Some(parent.as_path()) {
            return Err(io::Error::other("workspace entry escaped its directory"));
        }
        // Compare the current parent identity again after opening the child.
        self.ensure_current()?;
        if opened.is_dir() {
            Ok(Node::Directory(Self {
                file,
                path,
                root: self.root.clone(),
            }))
        } else if opened.is_file() {
            Ok(Node::File(file))
        } else {
            Err(io::Error::other("workspace entry changed while opening"))
        }
    }

    #[cfg(not(any(unix, windows)))]
    fn child(&self, name: &std::ffi::OsStr) -> io::Result<Node> {
        let path = self.path.join(name);
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            Ok(Node::Link)
        } else if meta.is_dir() {
            Ok(Node::Directory(Self::open(&path)?))
        } else if meta.is_file() {
            Ok(Node::File(File::open(path)?))
        } else {
            Ok(Node::Special)
        }
    }

    fn entries(&self) -> io::Result<Entries> {
        Entries::new(self)
    }
}

// fdopendir enumerates the already-open directory, not its potentially
// replaced path. Iteration is streaming so a huge directory cannot allocate
// an unbounded Vec before the inspection budget is enforced.
#[cfg(any(target_os = "macos", target_os = "linux"))]
struct Entries(*mut libc::DIR);

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Entries {
    fn new(dir: &Directory) -> io::Result<Self> {
        use std::os::fd::AsRawFd;
        // Opening "." from the directory creates an independent directory
        // offset; dup would make a preflight consume the later copy's stream.
        // SAFETY: the descriptor is live and the literal is NUL terminated.
        let fd = unsafe {
            libc::openat(
                dir.file.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fd is a newly opened directory descriptor; fdopendir takes ownership on success.
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            // SAFETY: fdopendir failed, so this descriptor still belongs to us.
            unsafe { libc::close(fd) };
            return Err(error);
        }
        Ok(Self(stream))
    }

    fn next(&mut self) -> io::Result<Option<OsString>> {
        use std::ffi::CStr;
        use std::os::unix::ffi::OsStringExt;
        loop {
            #[cfg(target_os = "macos")]
            // SAFETY: __error returns the calling thread's errno pointer.
            let errno = unsafe { libc::__error() };
            #[cfg(target_os = "linux")]
            // SAFETY: __errno_location returns the calling thread's errno pointer.
            let errno = unsafe { libc::__errno_location() };
            // SAFETY: errno is thread-local and the DIR is owned here.
            unsafe { *errno = 0 };
            // SAFETY: the DIR stream is live and exclusively owned by this iterator.
            let entry = unsafe { libc::readdir(self.0) };
            if entry.is_null() {
                // SAFETY: errno points to this thread's valid errno storage.
                let code = unsafe { *errno };
                return if code == 0 {
                    Ok(None)
                } else {
                    Err(io::Error::from_raw_os_error(code))
                };
            }
            // SAFETY: readdir returned a valid dirent with a NUL-terminated name.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name != b"." && name != b".." {
                return Ok(Some(OsString::from_vec(name.to_vec())));
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for Entries {
    fn drop(&mut self) {
        // SAFETY: fdopendir returned this stream and this is its sole owner.
        unsafe { libc::closedir(self.0) };
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
struct Entries(fs::ReadDir);

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl Entries {
    fn new(dir: &Directory) -> io::Result<Self> {
        #[cfg(windows)]
        dir.ensure_current()?;
        let entries = fs::read_dir(&dir.path)?;
        #[cfg(windows)]
        dir.ensure_current()?;
        Ok(Self(entries))
    }
    fn next(&mut self) -> io::Result<Option<OsString>> {
        self.0
            .next()
            .transpose()
            .map(|entry| entry.map(|e| e.file_name()))
    }
}

fn scan_dir(dir: &Directory, prefix: &str, depth: usize, cap: usize, result: &mut Scan) {
    let Ok(mut entries) = dir.entries() else {
        result.complete = false;
        return;
    };
    loop {
        let name = match entries.next() {
            Ok(Some(name)) => name,
            Ok(None) => return,
            Err(_) => {
                result.complete = false;
                return;
            }
        };
        if result.seen >= cap {
            result.complete = false;
            return;
        }
        result.seen += 1;
        let Some(name_str) = name.to_str() else {
            result.complete = false;
            continue;
        };
        let relative = if prefix.is_empty() {
            name_str.to_owned()
        } else {
            format!("{prefix}/{name_str}")
        };
        match dir.child(&name) {
            Ok(Node::File(file)) => match file.metadata() {
                Ok(meta) => {
                    result.bytes = result.bytes.saturating_add(meta.len());
                    result.files.push(ScratchFile {
                        path: relative,
                        bytes: meta.len(),
                    });
                }
                Err(_) => result.complete = false,
            },
            Ok(Node::Directory(child)) if depth < MAX_DEPTH => {
                scan_dir(&child, &relative, depth + 1, cap, result);
            }
            Ok(Node::Directory(_)) | Err(_) => result.complete = false,
            Ok(Node::Link | Node::Special) => {}
        }
        if result.seen >= cap && !result.complete {
            return;
        }
    }
}

fn scan_with_cap(root: &Path, cap: usize) -> Result<Scan, String> {
    let root = Directory::open(root).map_err(|e| format!("cannot open chat workspace: {e}"))?;
    let mut scan = Scan {
        files: Vec::new(),
        bytes: 0,
        seen: 0,
        complete: true,
    };
    scan_dir(&root, "", 0, cap, &mut scan);
    scan.files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(scan)
}

pub fn files(root: &Path) -> Result<Vec<ScratchFile>, String> {
    let scan = scan_with_cap(root, MAX_ENTRIES)?;
    if !scan.complete {
        return Err("Chat file list is incomplete: the workspace is too large, too deep, or contains unreadable paths".to_string());
    }
    Ok(scan.files)
}

pub fn usage(root: &Path) -> Result<Usage, String> {
    let scan = scan_with_cap(root, MAX_ENTRIES)?;
    Ok(Usage {
        bytes: scan.bytes,
        files: scan.files.len(),
        complete: scan.complete,
        shared: false,
    })
}

fn open_relative(root: &Path, path: &str) -> Result<File, String> {
    let mut dir = Directory::open(root).map_err(|e| e.to_string())?;
    let mut parts = Path::new(path).components().peekable();
    if parts.peek().is_none() {
        return Err("empty chat file path".to_string());
    }
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            return Err("chat file path must be relative and cannot contain traversal".to_string());
        };
        match (
            dir.child(name)
                .map_err(|e| format!("cannot open chat file: {e}"))?,
            parts.peek().is_none(),
        ) {
            (Node::File(file), true) => return Ok(file),
            (Node::Directory(next), false) => dir = next,
            _ => return Err("chat file must be a regular file without symbolic links".to_string()),
        }
    }
    Err("invalid chat file path".to_string())
}

fn copy_file(mut source: File, dest: &Path) -> io::Result<()> {
    let permissions = source.metadata()?.permissions();
    let mut output = OpenOptions::new().write(true).create_new(true).open(dest)?;
    let result =
        io::copy(&mut source, &mut output).and_then(|_| output.set_permissions(permissions));
    if result.is_err() {
        drop(output);
        let _ = fs::remove_file(dest);
    }
    result
}

pub fn export(root: &Path, path: &str, dest: &Path) -> Result<(), String> {
    let source = open_relative(root, path)?;
    copy_file(source, dest)
        .map_err(|e| format!("cannot export file (existing files are never overwritten): {e}"))
}

fn compare_artifact_files(mut source: File, mut snapshot: File) -> Result<(), String> {
    use std::io::Read;
    let length = source.metadata().map_err(|e| e.to_string())?.len();
    if snapshot.metadata().map_err(|e| e.to_string())?.len() != length {
        return Err("fork snapshot has incomplete session artifacts".to_string());
    }
    let mut remaining = length;
    let mut a = [0_u8; 8192];
    let mut b = [0_u8; 8192];
    while remaining > 0 {
        let count = usize::try_from(remaining.min(a.len() as u64)).map_err(|e| e.to_string())?;
        source
            .read_exact(&mut a[..count])
            .map_err(|e| format!("cannot read original artifact: {e}"))?;
        snapshot
            .read_exact(&mut b[..count])
            .map_err(|e| format!("cannot read fork artifact: {e}"))?;
        if a[..count] != b[..count] {
            return Err("fork snapshot has different session artifacts".to_string());
        }
        remaining -= count as u64;
    }
    Ok(())
}

fn compare_artifact_dirs(
    source: &Directory,
    snapshot: &Directory,
    depth: usize,
    seen: &mut usize,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("session artifacts exceed the verification depth".to_string());
    }
    let mut entries = source
        .entries()
        .map_err(|e| format!("cannot inspect original artifacts: {e}"))?;
    while let Some(name) = entries
        .next()
        .map_err(|e| format!("cannot inspect original artifacts: {e}"))?
    {
        *seen += 1;
        if *seen > MAX_ENTRIES {
            return Err("session artifacts exceed the verification limit".to_string());
        }
        let original = source
            .child(&name)
            .map_err(|e| format!("cannot inspect original artifact: {e}"))?;
        let copied = snapshot
            .child(&name)
            .map_err(|e| format!("fork snapshot is missing an artifact: {e}"))?;
        match (original, copied) {
            (Node::File(original), Node::File(copied)) => compare_artifact_files(original, copied)?,
            (Node::Directory(original), Node::Directory(copied)) => {
                compare_artifact_dirs(&original, &copied, depth + 1, seen)?;
            }
            _ => {
                return Err(
                    "fork artifacts contain links, special files, or mismatched entries"
                        .to_string(),
                )
            }
        }
    }
    Ok(())
}

/// Upstream logs but suppresses fork artifact-copy failures. Verify every
/// original artifact before letting native unpack consume the disposable fork.
pub fn verify_fork_artifacts(original: &Path, snapshot: &Path) -> Result<(), String> {
    let source = original.with_extension("");
    match fs::symlink_metadata(&source) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("cannot inspect original artifacts: {error}")),
        Ok(meta) if !meta.is_dir() => {
            return Err("original artifact root is not a real directory".to_string())
        }
        Ok(_) => {}
    }
    let source =
        Directory::open(&source).map_err(|e| format!("cannot open original artifacts: {e}"))?;
    let copied = Directory::open(&snapshot.with_extension(""))
        .map_err(|e| format!("cannot open fork artifacts: {e}"))?;
    let mut seen = 0;
    compare_artifact_dirs(&source, &copied, 0, &mut seen)
}

fn visit(dir: &Directory, dest: Option<&Path>, depth: usize) -> Result<(), String> {
    if depth > COPY_DEPTH {
        return Err("chat workspace exceeds the maximum promotion depth".to_string());
    }
    let mut entries = dir
        .entries()
        .map_err(|e| format!("cannot inspect chat workspace: {e}"))?;
    while let Some(name) = entries
        .next()
        .map_err(|e| format!("cannot inspect chat workspace: {e}"))?
    {
        match dir
            .child(&name)
            .map_err(|e| format!("cannot inspect chat entry: {e}"))?
        {
            Node::Link => return Err("Cannot promote a chat containing symbolic links".to_string()),
            Node::Special => {
                return Err("Cannot promote a chat containing special files".to_string())
            }
            Node::File(file) => {
                if let Some(target) = dest {
                    copy_file(file, &target.join(&name))
                        .map_err(|e| format!("cannot copy chat file: {e}"))?;
                }
            }
            Node::Directory(child) => {
                if let Some(target) = dest {
                    let target = target.join(&name);
                    fs::create_dir(&target)
                        .map_err(|e| format!("cannot create project directory: {e}"))?;
                    visit(&child, Some(&target), depth + 1)?;
                } else {
                    visit(&child, None, depth + 1)?;
                }
            }
        }
    }
    Ok(())
}
pub(super) fn copy_new_directory(
    destination: &Path,
    copy: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    fs::create_dir(destination).map_err(|e| {
        format!("cannot create new project directory (it must not already exist): {e}")
    })?;
    if let Err(error) = copy() {
        if let Err(cleanup) = fs::remove_dir_all(destination) {
            return Err(format!(
                "{error}; could not remove partial project at {}: {cleanup}",
                destination.display()
            ));
        }
        return Err(error);
    }
    Ok(())
}

pub fn promote(root: &Path, dest: &Path) -> Result<String, String> {
    let source = Directory::open(root).map_err(|e| format!("cannot open chat workspace: {e}"))?;
    let source_path = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve chat workspace: {e}"))?;
    let parent = dest
        .parent()
        .ok_or("project destination has no parent")?
        .canonicalize()
        .map_err(|e| format!("cannot resolve project destination: {e}"))?;
    let name = dest.file_name().ok_or("project destination has no name")?;
    if parent.starts_with(&source_path) {
        return Err("project destination cannot be inside the chat workspace".to_string());
    }
    let destination = parent.join(name);
    destination.to_str().ok_or("project path is not UTF-8")?;
    // Reject links/special entries before creating anything; repeat the checks
    // during the copy, because files can change between the two traversals.
    visit(&source, None, 0)?;
    let mut shown = None;
    copy_new_directory(&destination, || {
        visit(&source, Some(&destination), 0)?;
        // Validate while rollback still owns the fresh directory.
        shown = Some(crate::external_open::canonical_folder(&destination)?);
        Ok(())
    })?;
    shown.ok_or_else(|| "could not resolve copied project".to_string())
}

#[cfg(test)]
pub(super) fn usage_with_cap(root: &Path, cap: usize) -> Result<Usage, String> {
    let scan = scan_with_cap(root, cap)?;
    Ok(Usage {
        bytes: scan.bytes,
        files: scan.files.len(),
        complete: scan.complete,
        shared: false,
    })
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn replaced_directory_cannot_redirect_an_open_handle() {
        let tmp = TempDir::new("chat-workspaces", "windows-replaced-parent");
        let root = tmp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), b"original").unwrap();
        let dir = Directory::open(&root).unwrap();
        fs::rename(&root, tmp.path().join("moved")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), b"replacement").unwrap();
        assert!(dir.child(std::ffi::OsStr::new("file")).is_err());
    }
}
