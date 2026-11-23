//! First start after the update from the Electron app (0.7.x): reads its saved API keys and the
//! GitHub token so nobody has to enter them again. Electron kept them in api-keys.json, encrypted
//! with Chromium's safeStorage:
//! - "plain:" + text: stored without encryption (no keyring was available).
//! - Linux "v10"/"v11": AES-128-CBC, key = PBKDF2-SHA1(password, "saltysalt", 1 round), IV = 16 spaces;
//!   v10 uses the fixed password "peanuts", v11 a random password kept in the Secret Service keyring.
//! - Windows "v10": AES-256-GCM with a key from "Local State", itself protected by DPAPI.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;

/// The Electron app's settings folder (Electron's userData: %APPDATA%\Vimmi, ~/.config/Vimmi).
pub fn electron_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("Vimmi"))
}

fn printable(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| !c.is_control())
}

/// PBKDF2-SHA1 key Chromium uses on Linux.
pub fn linux_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1, &mut key);
    key
}

pub fn decrypt_cbc(key: &[u8; 16], data: &[u8]) -> Option<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let mut buf = data.to_vec();
    let out = cbc::Decryptor::<aes::Aes128>::new(key.into(), &[b' '; 16].into()).decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?;
    String::from_utf8(out.to_vec()).ok().filter(|s| printable(s))
}

pub fn decrypt_gcm(key: &[u8], data: &[u8]) -> Option<String> {
    use aes_gcm::aead::{Aead, KeyInit};
    if data.len() < 12 + 16 || key.len() != 32 {
        return None;
    }
    let (nonce, body) = data.split_at(12);
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).ok()?;
    let out = cipher.decrypt(nonce.into(), body).ok()?;
    String::from_utf8(out).ok().filter(|s| printable(s))
}

/// Passwords Electron may have kept in the Linux keyring (the application name differs by version).
#[cfg(target_os = "linux")]
fn keyring_passwords() -> Vec<Vec<u8>> {
    use dbus_secret_service::{EncryptionType, SecretService};
    let mut out = Vec::new();
    let Ok(ss) = SecretService::connect(EncryptionType::Dh) else { return out };
    for app in ["vimmi", "Vimmi", "chromium"] {
        let attrs = std::collections::HashMap::from([("xdg:schema", "chrome_libsecret_os_crypt_password_v2"), ("application", app)]);
        let Ok(found) = ss.search_items(attrs) else { continue };
        for item in found.unlocked.iter().chain(found.locked.iter()) {
            let _ = item.ensure_unlocked();
            if let Ok(secret) = item.get_secret() {
                if !out.contains(&secret) {
                    out.push(secret);
                }
            }
        }
    }
    out
}

/// The AES key for Electron's secrets on Windows, from "Local State" (DPAPI-protected).
#[cfg(windows)]
fn windows_key(dir: &Path) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let state: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("Local State")).ok()?).ok()?;
    let b64 = state.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let mut blob = raw.strip_prefix(b"DPAPI")?.to_vec();
    let input = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_mut_ptr() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: input points to our buffer for the call; output is allocated by Windows and freed below.
    unsafe {
        if CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output) == 0 {
            return None;
        }
        let key = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Some(key)
    }
}

/// Decrypts one stored value; `linux` holds the keyring passwords to try for v11.
fn decrypt_value(raw: &[u8], linux: &[Vec<u8>], windows: Option<&[u8]>) -> Option<String> {
    if let Some(rest) = raw.strip_prefix(b"plain:") {
        return String::from_utf8(rest.to_vec()).ok().filter(|s| printable(s));
    }
    if let Some(body) = raw.strip_prefix(b"v10") {
        if let Some(key) = windows {
            if let Some(v) = decrypt_gcm(key, body) {
                return Some(v);
            }
        }
        return decrypt_cbc(&linux_key(b"peanuts"), body);
    }
    if let Some(body) = raw.strip_prefix(b"v11") {
        return linux.iter().find_map(|pw| decrypt_cbc(&linux_key(pw), body));
    }
    None
}

/// Reads the Electron app's saved keys from its folder: provider id -> key.
pub fn read_keys(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stored: BTreeMap<String, String> =
        std::fs::read_to_string(dir.join("api-keys.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    // Version 0.1 kept a single Claude key in its own file.
    if !stored.contains_key("anthropic") {
        if let Ok(bin) = std::fs::read(dir.join("api-key.bin")) {
            stored.insert("anthropic".into(), base64::engine::general_purpose::STANDARD.encode(bin));
        }
    }
    if stored.is_empty() {
        return out;
    }
    let needs_keyring = stored.values().any(|v| base64::engine::general_purpose::STANDARD.decode(v).map(|r| r.starts_with(b"v11")).unwrap_or(false));
    #[cfg(target_os = "linux")]
    let linux = if needs_keyring { keyring_passwords() } else { Vec::new() };
    #[cfg(not(target_os = "linux"))]
    let linux: Vec<Vec<u8>> = {
        let _ = needs_keyring;
        Vec::new()
    };
    #[cfg(windows)]
    let windows = windows_key(dir);
    #[cfg(not(windows))]
    let windows: Option<Vec<u8>> = None;
    for (id, value) in stored {
        let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(value) else { continue };
        if let Some(v) = decrypt_value(&raw, &linux, windows.as_deref()) {
            out.insert(id, v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};

    fn encrypt_cbc(password: &[u8], text: &str) -> Vec<u8> {
        let key = linux_key(password);
        cbc::Encryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into()).encrypt_padded_vec_mut::<Pkcs7>(text.as_bytes())
    }

    #[test]
    fn reads_plain_v10_and_v11_values() {
        let dir = tempfile::tempdir().unwrap();
        let b64 = |b: Vec<u8>| base64::engine::general_purpose::STANDARD.encode(b);
        let mut v10 = b"v10".to_vec();
        v10.extend(encrypt_cbc(b"peanuts", "sk-or-v1-test"));
        let mut v11 = b"v11".to_vec();
        v11.extend(encrypt_cbc(b"keyring-password", "AIza-test"));
        let keys = serde_json::json!({
            "github": b64(b"plain:github_pat_test".to_vec()),
            "openrouter": b64(v10),
            "gemini": b64(v11.clone()),
        });
        std::fs::write(dir.path().join("api-keys.json"), keys.to_string()).unwrap();

        // Without the keyring password the v11 value cannot be read; the others can.
        let raw_v11 = &v11;
        assert_eq!(decrypt_value(raw_v11, &[], None), None);
        assert_eq!(decrypt_value(raw_v11, &[b"wrong".to_vec(), b"keyring-password".to_vec()], None).as_deref(), Some("AIza-test"));

        let stored: BTreeMap<String, String> = serde_json::from_str(&std::fs::read_to_string(dir.path().join("api-keys.json")).unwrap()).unwrap();
        let get = |id: &str| decrypt_value(&base64::engine::general_purpose::STANDARD.decode(&stored[id]).unwrap(), &[b"keyring-password".to_vec()], None);
        assert_eq!(get("github").as_deref(), Some("github_pat_test"));
        assert_eq!(get("openrouter").as_deref(), Some("sk-or-v1-test"));
        assert_eq!(get("gemini").as_deref(), Some("AIza-test"));
    }

    #[test]
    fn reads_windows_gcm_values() {
        use aes_gcm::aead::{Aead, KeyInit};
        let key = [7u8; 32];
        let nonce = [3u8; 12];
        let mut body = nonce.to_vec();
        body.extend(aes_gcm::Aes256Gcm::new_from_slice(&key).unwrap().encrypt(&nonce.into(), b"sk-ant-test".as_ref()).unwrap());
        let mut raw = b"v10".to_vec();
        raw.extend(&body);
        assert_eq!(decrypt_value(&raw, &[], Some(&key)).as_deref(), Some("sk-ant-test"));
        assert_eq!(decrypt_value(&raw, &[], Some(&[8u8; 32])), None);
    }

    #[test]
    fn old_single_claude_key_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("api-key.bin"), b"plain:sk-ant-old").unwrap();
        assert_eq!(read_keys(dir.path()).get("anthropic").map(String::as_str), Some("sk-ant-old"));
    }
}
