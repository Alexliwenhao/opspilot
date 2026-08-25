//! Persistent local storage for profiles, settings, known_hosts and sessions.

use crate::error::AppResult;
use crate::protocol::{HostProfile, Settings};
use serde::{de::DeserializeOwned, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;
use tracing::{debug, error, info, warn};

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            dir: root.as_ref().to_path_buf(),
        }
    }

    pub fn from_app(app: &tauri::AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .expect("app_data_dir must exist");
        Self::new(dir)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub async fn init(&self) -> AppResult<()> {
        fs::create_dir_all(&self.dir).await?;
        // Ensure the profiles file exists so the frontend gets [] not an error.
        if !self.path("profiles.json").exists() {
            self.save_json("profiles.json", &Vec::<HostProfile>::new())
                .await?;
        }
        if !self.path("settings.json").exists() {
            self.save_json("settings.json", &Settings::default()).await?;
        }
        if !self.path("known_hosts.json").exists() {
            self.save_json("known_hosts.json", &KnownHosts::default())
                .await?;
        }
        info!(dir = %self.dir.display(), "store initialised");
        Ok(())
    }

    async fn load_json<T: DeserializeOwned + Default>(&self, name: &str) -> AppResult<T> {
        let path = self.path(name);
        if !path.exists() {
            return Ok(T::default());
        }
        let text = fs::read_to_string(&path).await?;
        match serde_json::from_str::<T>(&text) {
            Ok(v) => Ok(v),
            Err(e) => {
                error!(file = name, error = %e, "corrupt json; using default");
                Ok(T::default())
            }
        }
    }

    async fn save_json<T: Serialize + std::fmt::Debug>(&self, name: &str, value: &T) -> AppResult<()> {
        let path = self.path(name);
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(value)?;
        fs::write(&tmp, text).await?;
        fs::rename(&tmp, &path).await?;
        Ok(())
    }

    // --- profiles -----------------------------------------------------------

    pub async fn list_profiles(&self) -> AppResult<Vec<HostProfile>> {
        self.load_json("profiles.json").await
    }

    pub async fn save_profile(&self, mut profile: HostProfile) -> AppResult<HostProfile> {
        if profile.id.trim().is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
            profile.created_at = crate::protocol::now_ms();
        }
        profile.updated_at = crate::protocol::now_ms();

        let mut profiles = self.list_profiles().await?;
        profiles.retain(|p| p.id != profile.id);
        profiles.push(profile.clone());
        // Sort by group then name so the tree is deterministic.
        profiles.sort_by(|a, b| {
            let ga = a.group.as_deref().unwrap_or("");
            let gb = b.group.as_deref().unwrap_or("");
            ga.cmp(gb).then(a.name.cmp(&b.name))
        });
        self.save_json("profiles.json", &profiles).await?;
        debug!(id = %profile.id, name = %profile.name, "saved profile");
        Ok(profile)
    }

    pub async fn delete_profile(&self, id: &str) -> AppResult<()> {
        let mut profiles = self.list_profiles().await?;
        profiles.retain(|p| p.id != id);
        self.save_json("profiles.json", &profiles).await?;

        // Also remove any stored secret.
        if let Err(e) = crate::secret::delete(id).await {
            warn!(profile_id = id, error = %e, "failed to delete secret");
        }
        info!(id, "deleted profile");
        Ok(())
    }

    pub async fn get_profile(&self, id: &str) -> AppResult<Option<HostProfile>> {
        let profiles = self.list_profiles().await?;
        Ok(profiles.into_iter().find(|p| p.id == id))
    }

    // --- settings -----------------------------------------------------------

    pub async fn load_settings(&self) -> AppResult<Settings> {
        self.load_json("settings.json").await
    }

    pub async fn save_settings(&self, settings: &Settings) -> AppResult<()> {
        self.save_json("settings.json", settings).await
    }

    // --- known_hosts --------------------------------------------------------

    pub async fn known_hosts(&self) -> AppResult<KnownHosts> {
        self.load_json("known_hosts.json").await
    }

    pub async fn save_known_hosts(&self, hosts: &KnownHosts) -> AppResult<()> {
        self.save_json("known_hosts.json", hosts).await
    }

    pub async fn check_host_key(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
    ) -> AppResult<HostKeyTrust> {
        let known = self.known_hosts().await?;
        let key = format!("{}:{}", host, port);
        match known.entries.get(&key) {
            Some(entry) if entry.fingerprint == fingerprint => Ok(HostKeyTrust::Trusted),
            Some(entry) => Ok(HostKeyTrust::Changed {
                expected: entry.fingerprint.clone(),
            }),
            None => Ok(HostKeyTrust::Unknown),
        }
    }

    pub async fn trust_host_key(
        &self,
        host: &str,
        port: u16,
        fingerprint: String,
    ) -> AppResult<()> {
        let mut known = self.known_hosts().await?;
        let key = format!("{}:{}", host, port);
        known.entries.insert(
            key,
            KnownHostEntry {
                fingerprint,
                trusted_at: crate::protocol::now_ms(),
            },
        );
        self.save_known_hosts(&known).await
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KnownHosts {
    pub entries: std::collections::HashMap<String, KnownHostEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub fingerprint: String,
    pub trusted_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyTrust {
    Trusted,
    Unknown,
    Changed { expected: String },
}
