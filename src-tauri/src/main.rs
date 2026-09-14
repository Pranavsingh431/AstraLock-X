// Without this a release build on Windows opens a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    astralock_x_lib::run()
}
