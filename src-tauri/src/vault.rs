//! Vault storage on the local disk: the Rust side of shared/vault.ts's VaultStorage.
//! Every path from the page is vault-relative and checked here, so the page can never read or
//! write outside the open vault folder.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Folders the vault never lists (hidden folders are skipped as well).
const IGNORED: [&str; 5] = [".git", ".obsidian", ".vimmi", ".trash", "node_modules"];

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct FileStat {
    pub mtime: f64,
    pub ctime: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ListedFile {
    pub path: String,
    #[serde(flatten)]
    pub stat: FileStat,
}

#[derive(Debug, Serialize, Default)]
pub struct Listing {
    pub folders: Vec<String>,
    pub files: Vec<ListedFile>,
}

/// True for vault-relative paths the vault ignores (same rule as isIgnoredPath in shared/vault.ts).
pub fn is_ignored(rel: &str) -> bool {
    rel.split('/').any(|part| part.starts_with('.') || IGNORED.contains(&part))
}

/// Joins a vault-relative path onto the root, refusing anything that could leave the vault.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = rel.replace('\\', "/");
    let cleaned = cleaned.trim_start_matches('/');
    let mut out = root.to_path_buf();
    for comp in Path::new(cleaned).components() {
        match comp {
            Component::Normal(part) => {
                let s = part.to_string_lossy();
                // A drive letter or alternate data stream on Windows ("C:", "note.md:x").
                if s.contains(':') {
                    return Err(format!("Cesta je mimo trezor: {rel}"));
                }
                out.push(part);
            }
            Component::CurDir => {}
            _ => return Err(format!("Cesta je mimo trezor: {rel}")),
        }
    }
    Ok(out)
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> Option<f64> {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0)
}

pub fn to_stat(meta: &fs::Metadata) -> FileStat {
    let mtime = millis(meta.modified()).unwrap_or(0.0);
    let ctime = millis(meta.created()).unwrap_or(mtime);
    FileStat { mtime, ctime, dir: if meta.is_dir() { Some(true) } else { None } }
}

fn rel_of(root: &Path, full: &Path) -> String {
    full.strip_prefix(root)
        .unwrap_or(full)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn list(root: &Path) -> Result<Listing, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut out = Listing::default();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let full = entry.path();
            let rel = rel_of(root, &full);
            if is_ignored(&rel) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                out.folders.push(rel);
                stack.push(full);
            } else if kind.is_file() {
                if let Ok(meta) = entry.metadata() {
                    out.files.push(ListedFile { path: rel, stat: to_stat(&meta) });
                }
            }
        }
    }
    Ok(out)
}

/// Writes through a temporary file and a rename, so a crash never leaves half a note.
pub fn atomic_write(full: &Path, data: &[u8]) -> Result<FileStat, String> {
    let parent = full.parent().ok_or("Neplatná cesta")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = full.file_name().ok_or("Neplatná cesta")?.to_string_lossy();
    let tmp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(data).map_err(|e| e.to_string())?;
        f.sync_all().ok();
    }
    if let Err(e) = fs::rename(&tmp, full) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    fs::metadata(full).map(|m| to_stat(&m)).map_err(|e| e.to_string())
}

pub fn stat(full: &Path) -> Option<FileStat> {
    fs::metadata(full).ok().map(|m| to_stat(&m))
}

pub fn rename(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

/// Moves a file or folder into the vault's .trash folder with a time stamp.
pub fn trash(root: &Path, full: &Path) -> Result<(), String> {
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ");
    let name = full.file_name().ok_or("Neplatná cesta")?.to_string_lossy().into_owned();
    let dest = root.join(".trash").join(format!("{stamp} {name}"));
    rename(full, &dest)
}

/// Path of the vault's private data (sync state, chats, history) under .vimmi.
pub fn private_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    safe_join(&root.join(".vimmi"), name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_outside_the_vault() {
        let root = Path::new("/v");
        assert!(safe_join(root, "../etc/passwd").is_err());
        assert!(safe_join(root, "a/../../b").is_err());
        assert!(safe_join(root, "C:/Windows").is_err());
        assert!(safe_join(root, "note.md:stream").is_err());
        assert_eq!(safe_join(root, "/Projekty/a.md").unwrap(), PathBuf::from("/v/Projekty/a.md"));
        assert_eq!(safe_join(root, "Projekty\\b.md").unwrap(), PathBuf::from("/v/Projekty/b.md"));
        assert_eq!(safe_join(root, "./c.md").unwrap(), PathBuf::from("/v/c.md"));
    }

    #[test]
    fn ignores_hidden_and_tool_folders() {
        assert!(is_ignored(".git/config"));
        assert!(is_ignored("a/.obsidian/x"));
        assert!(is_ignored("node_modules/x.md"));
        assert!(!is_ignored("Projekty/Web Vimmi.md"));
    }

    #[test]
    fn writes_lists_renames_and_trashes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        atomic_write(&safe_join(root, "Projekty/Web.md").unwrap(), "# Web".as_bytes()).unwrap();
        atomic_write(&safe_join(root, "Deník.md").unwrap(), "ahoj".as_bytes()).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "x").unwrap();
        let l = list(root).unwrap();
        let mut files: Vec<_> = l.files.iter().map(|f| f.path.clone()).collect();
        files.sort();
        assert_eq!(files, vec!["Deník.md", "Projekty/Web.md"]);
        assert_eq!(l.folders, vec!["Projekty"]);
        assert_eq!(fs::read_to_string(root.join("Projekty/Web.md")).unwrap(), "# Web");
        // no temporary files left behind
        assert!(fs::read_dir(root.join("Projekty")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));

        rename(&root.join("Deník.md"), &root.join("Archiv/Deník.md")).unwrap();
        assert!(root.join("Archiv/Deník.md").exists());
        trash(root, &root.join("Archiv/Deník.md")).unwrap();
        assert!(!root.join("Archiv/Deník.md").exists());
        let trashed: Vec<_> = fs::read_dir(root.join(".trash")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(trashed.len(), 1);
        assert!(trashed[0].ends_with(" Deník.md"));
    }

    #[test]
    fn private_data_stays_under_dot_vimmi() {
        let root = Path::new("/v");
        assert_eq!(private_path(root, "chats/1.json").unwrap(), PathBuf::from("/v/.vimmi/chats/1.json"));
        assert!(private_path(root, "../a.md").is_err());
    }
}
