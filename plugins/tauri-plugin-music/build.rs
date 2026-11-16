fn main() {
    tauri_plugin::Builder::new(&["capabilities","destinations","instruments","select_instrument","set_preset","set_parameter","show_interface","play","stop","transport_status","render","render_progress","cancel_render","inbox","copy_incoming","acknowledge","close","preview_incoming","stop_preview"])
        .ios_path("ios").build();
}
