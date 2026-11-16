//! Keys in `Info.ios.plist` that iPad behaviour depends on. The plist is only
//! merged into the app by an iOS build, which cannot run here, so these keep
//! the keys from being dropped by accident.

use std::fs;
use std::path::Path;

fn plist() -> String {
    let text = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Info.ios.plist")).unwrap();
    text.split_whitespace().collect()
}

#[test]
fn ipad_trackpad_uses_native_indirect_input() {
    assert!(plist().contains("<key>UIApplicationSupportsIndirectInputEvents</key><true/>"));
}

#[test]
fn one_window_scene_with_taos_delegate() {
    // Without the scene manifest a landscape iPad delivered trackpad scrolls on the wrong axis.
    let p = plist();
    assert!(p.contains("<key>UIApplicationSceneManifest</key><dict>"));
    assert!(p.contains("<key>UIApplicationSupportsMultipleScenes</key><false/>"));
    assert!(p.contains("<key>UIWindowSceneSessionRoleApplication</key><array>"));
    assert!(p.contains("<key>UISceneDelegateClassName</key><string>TaoSceneDelegate</string>"));
}
