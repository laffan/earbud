use tauri::{plugin::{Builder, TauriPlugin}, Runtime};
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_music);
#[tauri::command]
fn capabilities() -> serde_json::Value {
    let ios = cfg!(target_os = "ios");
    serde_json::json!({"supportsAUv3Hosting":ios,"supportsCoreMIDIOutput":ios,
        "supportsAudioShareImport":ios,"supportsNativeInstrumentRendering":ios})
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("music").invoke_handler(tauri::generate_handler![capabilities])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_music)?;
            Ok(())
        }).build()
}
