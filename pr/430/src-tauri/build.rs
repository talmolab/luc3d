use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin};

/// Every native command, registered as the INLINED plugin `lucid` (invoked as
/// `plugin:lucid|<name>`). Bare app commands are blocked for a page served from
/// http://localhost (a "remote" origin to Tauri); plugin commands can be
/// granted there through a capability, so everything lives in this plugin.
/// `lucid:default` allows all of them and is granted in
/// capabilities/default.json and in the runtime localhost capability (lib.rs).
///
/// The list is constant across feature sets: the sleap-nn commands are always
/// registered and answer Err("SLEAP_NN_NOT_IN_THIS_BUILD") when the feature is
/// off. Keep it identical to `lucid_plugin()`'s generate_handler! in lib.rs.
const COMMANDS: &[&str] = &[
    "pick_save_path",
    "pick_directory",
    "path_stat",
    "read_range",
    "list_dir",
    "make_dir",
    "write_open",
    "write_chunk",
    "write_truncate",
    "write_commit",
    "write_abort",
    "reveal_path",
    "open_external_url",
    "ask_dialog",
    "message_dialog",
    "set_close_guard",
    "confirm_close",
    "system_info",
    "set_app_menu",
    "get_update_info",
    "set_update_channel",
    "check_update",
    "install_update",
    "restart_app",
    "sleap_nn_status",
    "run_python_command",
    "cancel_command",
    "detect_uv",
    "detect_gpu",
];

fn main() {
    tauri_build::try_build(
        Attributes::new().plugin(
            "lucid",
            InlinedPlugin::new()
                .commands(COMMANDS)
                .default_permission(DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
