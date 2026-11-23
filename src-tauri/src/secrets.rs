//! API keys and the GitHub token: in the system keyring (Secret Service on Linux, Credential
//! Manager on Windows, Keychain on macOS). Without a keyring they fall back to a file only the
//! current user can read, as the Electron app did.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

const SERVICE: &str = "io.github.gerchanisko.vimmi";

fn valid_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err("Neplatný název klíče.".into())
    }
}

/// True when the system keyring stores and returns a value (checked once per run).
pub fn keyring_works() -> bool {
    static WORKS: OnceLock<bool> = OnceLock::new();
    *WORKS.get_or_init(|| {
        if std::env::var("VIMMI_NO_KEYRING").is_ok() {
            return false;
        }
        let Ok(entry) = keyring::Entry::new(SERVICE, "__probe") else { return false };
        let ok = entry.set_password("ok").is_ok() && entry.get_password().map(|v| v == "ok").unwrap_or(false);
        let _ = entry.delete_credential();
        ok
    })
}

fn file_path(dir: &Path) -> std::path::PathBuf {
    dir.join("secrets.json")
}

fn read_file(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(file_path(dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write_file(dir: &Path, map: &BTreeMap<String, String>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = file_path(dir);
    if map.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
    crate::vault::atomic_write(&path, json.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn get(dir: &Path, id: &str) -> Result<Option<String>, String> {
    valid_id(id)?;
    if keyring_works() {
        if let Ok(v) = keyring::Entry::new(SERVICE, id).and_then(|e| e.get_password()) {
            return Ok(Some(v));
        }
    }
    Ok(read_file(dir).get(id).cloned())
}

pub fn set(dir: &Path, id: &str, value: Option<&str>) -> Result<(), String> {
    valid_id(id)?;
    let value = value.map(str::trim).filter(|v| !v.is_empty());
    let mut file = read_file(dir);
    let had_file_entry = file.remove(id).is_some();
    if keyring_works() {
        let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
        match value {
            Some(v) => entry.set_password(v).map_err(|e| e.to_string())?,
            None => {
                let _ = entry.delete_credential();
            }
        }
    } else if let Some(v) = value {
        file.insert(id.to_string(), v.to_string());
    }
    if had_file_entry || (!keyring_works() && value.is_some()) || value.is_none() {
        write_file(dir, &file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_fallback_round_trip() {
        std::env::set_var("VIMMI_NO_KEYRING", "1");
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(get(dir.path(), "anthropic").unwrap(), None);
        set(dir.path(), "anthropic", Some("  sk-test ")).unwrap();
        assert_eq!(get(dir.path(), "anthropic").unwrap().as_deref(), Some("sk-test"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("secrets.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        set(dir.path(), "anthropic", None).unwrap();
        assert_eq!(get(dir.path(), "anthropic").unwrap(), None);
        assert!(get(dir.path(), "../x").is_err());
    }
}
