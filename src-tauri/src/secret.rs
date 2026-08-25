//! Thin wrapper over the OS credential store (keyring).

use crate::error::AppResult;

const SERVICE: &str = "com.opspilot.desktop";

fn entry(profile_id: &str) -> keyring::Entry {
    keyring::Entry::new(SERVICE, &format!("profile:{profile_id}"))
        .unwrap_or_else(|_| panic!("failed to create keyring entry"))
}

pub async fn get(profile_id: &str) -> AppResult<Option<String>> {
    match tokio::task::spawn_blocking({
        let id = profile_id.to_string();
        move || entry(&id).get_password()
    })
    .await?
    {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub async fn set(profile_id: &str, secret: &str) -> AppResult<()> {
    let id = profile_id.to_string();
    let secret = secret.to_string();
    tokio::task::spawn_blocking(move || entry(&id).set_password(&secret))
        .await??;
    Ok(())
}

pub async fn delete(profile_id: &str) -> AppResult<()> {
    let id = profile_id.to_string();
    tokio::task::spawn_blocking(move || entry(&id).delete_credential())
        .await??;
    Ok(())
}
