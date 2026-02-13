use std::collections::HashMap;
use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use base64::Engine;
use chrono::{DateTime, Utc};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerProfile {
    id: String,
    name: String,
    host: String,
    user: Option<String>,
    port: Option<u16>,
    password: Option<String>,
    tags: Vec<String>,
    favorite: bool,
    last_used_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    is_dir: bool,
}

struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn IoWrite + Send>,
}

struct AppState {
    profiles: Mutex<Vec<ServerProfile>>,
    data_path: Mutex<Option<PathBuf>>,
    pty_sessions: Mutex<HashMap<String, PtySession>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            profiles: Mutex::new(Vec::new()),
            data_path: Mutex::new(None),
            pty_sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
fn list_profiles(state: tauri::State<'_, AppState>) -> Result<Vec<ServerProfile>, String> {
    let profiles = state.profiles.lock().map_err(|_| "profile state poisoned")?;
    Ok(profiles.clone())
}

#[tauri::command]
fn upsert_profile(state: tauri::State<'_, AppState>, profile: ServerProfile) -> Result<(), String> {
    let mut profiles = state.profiles.lock().map_err(|_| "profile state poisoned")?;
    if let Some(existing) = profiles.iter_mut().find(|candidate| candidate.id == profile.id) {
        *existing = profile;
    } else {
        profiles.push(profile);
    }
    persist_profiles(&state, &profiles)
}

#[tauri::command]
fn add_profile_from_csv(state: tauri::State<'_, AppState>, csv_line: String) -> Result<(), String> {
    let fields = csv_line
        .split(',')
        .map(|segment| segment.trim().to_owned())
        .collect::<Vec<_>>();

    if fields.len() < 2 {
        return Err("Expected format: name,host,user,password(optional)".into());
    }

    let profile = ServerProfile {
        id: Uuid::new_v4().to_string(),
        name: fields[0].clone(),
        host: fields[1].clone(),
        user: fields.get(2).filter(|value| !value.is_empty()).cloned(),
        password: fields.get(3).filter(|value| !value.is_empty()).cloned(),
        port: Some(22),
        tags: Vec::new(),
        favorite: false,
        last_used_at: None,
    };

    let mut profiles = state.profiles.lock().map_err(|_| "profile state poisoned")?;
    profiles.insert(0, profile);
    persist_profiles(&state, &profiles)
}

#[tauri::command]
fn connect_profile(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut profiles = state.profiles.lock().map_err(|_| "profile state poisoned")?;
    let profile = profiles
        .iter_mut()
        .find(|candidate| candidate.id == id)
        .ok_or_else(|| "Profile not found".to_string())?;

    profile.last_used_at = Some(Utc::now());

    let target = match &profile.user {
        Some(user) => format!("{user}@{}", profile.host),
        None => profile.host.clone(),
    };

    let mut command = Command::new("alacritty");
    command.arg("-e");

    if let Some(password) = &profile.password {
        command.arg("sh").arg("-lc").arg(format!(
            "sshpass -p '{}' ssh -p {} {}",
            escape_shell(password),
            profile.port.unwrap_or(22),
            target
        ));
    } else {
        command.arg("ssh");
        command.arg("-p");
        command.arg(profile.port.unwrap_or(22).to_string());
        command.arg(target);
    }

    command.spawn().map_err(|err| format!("Failed to launch connection: {err}"))?;
    persist_profiles(&state, &profiles)
}

#[tauri::command]
fn open_local_terminal() -> Result<(), String> {
    Command::new("alacritty")
        .spawn()
        .map_err(|err| format!("Failed to launch local terminal: {err}"))?;
    Ok(())
}

#[tauri::command]
fn open_vscode(state: tauri::State<'_, AppState>, profile_id: Option<String>) -> Result<(), String> {
    if let Some(pid) = profile_id {
        let profiles = state.profiles.lock().map_err(|_| "profile state poisoned")?;
        let profile = profiles
            .iter()
            .find(|p| p.id == pid)
            .ok_or_else(|| "Profile not found".to_string())?;

        let target = match &profile.user {
            Some(user) => format!("{user}@{}", profile.host),
            None => profile.host.clone(),
        };

        Command::new("code")
            .arg("--remote")
            .arg(format!("ssh-remote+{}", target))
            .arg("/")
            .spawn()
            .map_err(|err| format!("Failed to launch VS Code: {err}"))?;
    } else {
        Command::new("code")
            .spawn()
            .map_err(|err| format!("Failed to launch VS Code: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
fn spawn_pty(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    profile_id: Option<String>,
) -> Result<(), String> {
    // Build the command to run in the PTY
    let mut cmd = if let Some(ref pid) = profile_id {
        let mut profiles = state.profiles.lock().map_err(|_| "profile state poisoned")?;
        let profile = profiles
            .iter_mut()
            .find(|p| p.id == *pid)
            .ok_or_else(|| "Profile not found".to_string())?;

        profile.last_used_at = Some(Utc::now());

        let target = match &profile.user {
            Some(user) => format!("{user}@{}", profile.host),
            None => profile.host.clone(),
        };
        let port_str = profile.port.unwrap_or(22).to_string();

        let cmd = if let Some(password) = &profile.password {
            let mut c = CommandBuilder::new("sshpass");
            c.arg("-p");
            c.arg(password.as_str());
            c.arg("ssh");
            c.arg("-o");
            c.arg("StrictHostKeyChecking=no");
            c.arg("-p");
            c.arg(&port_str);
            c.arg(&target);
            c
        } else {
            let mut c = CommandBuilder::new("ssh");
            c.arg("-o");
            c.arg("StrictHostKeyChecking=no");
            c.arg("-p");
            c.arg(&port_str);
            c.arg(&target);
            c
        };

        let _ = persist_profiles(&state, &profiles);
        cmd
    } else {
        CommandBuilder::new_default_prog()
    };

    // Set TERM so the shell knows it's in a capable terminal (enables correct
    // backspace/erase, colors, etc.) — equivalent to what Alacritty itself does.
    cmd.env("TERM", "xterm-256color");

    // Open a PTY
    let pty_system = native_pty_system();
    let size = PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

    // Close the slave side in the parent process
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    // Store the session
    {
        let mut sessions = state
            .pty_sessions
            .lock()
            .map_err(|_| "pty state poisoned")?;
        sessions.insert(
            session_id.clone(),
            PtySession {
                master: pair.master,
                writer,
            },
        );
    }

    // Spawn a reader thread that emits output events
    let sid = session_id.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        let engine = base64::engine::general_purpose::STANDARD;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app_handle.emit(&format!("pty-exit-{sid}"), ());
                    break;
                }
                Ok(n) => {
                    let encoded = engine.encode(&buf[..n]);
                    let _ = app_handle.emit(&format!("pty-output-{sid}"), encoded);
                }
                Err(_) => {
                    let _ = app_handle.emit(&format!("pty-exit-{sid}"), ());
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn write_pty(state: tauri::State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    let mut sessions = state
        .pty_sessions
        .lock()
        .map_err(|_| "pty state poisoned")?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or("Session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write failed: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("Flush failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn resize_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state
        .pty_sessions
        .lock()
        .map_err(|_| "pty state poisoned")?;
    let session = sessions.get(&session_id).ok_or("Session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn close_pty(state: tauri::State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut sessions = state
        .pty_sessions
        .lock()
        .map_err(|_| "pty state poisoned")?;
    sessions.remove(&session_id);
    Ok(())
}

#[tauri::command]
fn list_directory(path: Option<String>) -> Result<Vec<DirEntry>, String> {
    let dir = path
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));

    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {e}"))?;

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry
            .file_type()
            .map(|ft| ft.is_dir())
            .unwrap_or(false);

        if is_dir {
            dirs.push(DirEntry { name, is_dir: true });
        } else {
            files.push(DirEntry { name, is_dir: false });
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.append(&mut files);

    Ok(dirs)
}

#[tauri::command]
fn rename_entry(old_path: String, new_path: String) -> Result<(), String> {
    let src = Path::new(&old_path);
    if !src.exists() {
        return Err(format!("Source does not exist: {old_path}"));
    }
    let dest = Path::new(&new_path);
    if dest.exists() {
        return Err(format!("Destination already exists: {new_path}"));
    }
    fs::rename(src, dest).map_err(|e| format!("Rename failed: {e}"))
}

#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("Delete directory failed: {e}"))
    } else {
        fs::remove_file(p).map_err(|e| format!("Delete file failed: {e}"))
    }
}

#[tauri::command]
fn move_entry(src: String, dest_dir: String) -> Result<(), String> {
    let src_path = Path::new(&src);
    if !src_path.exists() {
        return Err(format!("Source does not exist: {src}"));
    }
    let file_name = src_path
        .file_name()
        .ok_or_else(|| "Cannot determine file name".to_string())?;
    let dest_path = Path::new(&dest_dir).join(file_name);
    if dest_path.exists() {
        return Err(format!(
            "Destination already exists: {}",
            dest_path.display()
        ));
    }
    fs::rename(src_path, &dest_path).map_err(|e| format!("Move failed: {e}"))
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("Create file failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir(&path).map_err(|e| format!("Create directory failed: {e}"))
}

#[tauri::command]
fn open_file_default(path: String) -> Result<(), String> {
    Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open file: {e}"))?;
    Ok(())
}

#[tauri::command]
fn open_in_vscode(path: String) -> Result<(), String> {
    Command::new("code")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open in VS Code: {e}"))?;
    Ok(())
}

fn escape_shell(input: &str) -> String {
    input.replace('"', "\\\"").replace('\'', "'\\''")
}

fn profile_store_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(directory) = app.path().app_data_dir() {
        return directory.join("profiles.json");
    }

    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".alacritty-manager")
            .join("profiles.json");
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".alacritty-manager")
        .join("profiles.json")
}

fn read_profiles(path: &Path) -> Vec<ServerProfile> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };

    serde_json::from_str::<Vec<ServerProfile>>(&content).unwrap_or_default()
}

fn persist_profiles(state: &AppState, profiles: &[ServerProfile]) -> Result<(), String> {
    let path = {
        let path_guard = state.data_path.lock().map_err(|_| "path state poisoned")?;
        path_guard.clone().ok_or_else(|| "App data path unavailable".to_string())?
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Failed to create data dir: {err}"))?;
    }

    let data = serde_json::to_vec_pretty(profiles)
        .map_err(|err| format!("Failed to encode profile store: {err}"))?;
    fs::write(path, data).map_err(|err| format!("Failed to write profile store: {err}"))
}

fn debug_log_path() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join("Library")
            .join("Logs")
            .join("alacritty-manager-startup.log");
    }

    PathBuf::from("/tmp/alacritty-manager-startup.log")
}

fn append_debug_log(message: &str) {
    let path = debug_log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let line = format!("{} {message}\n", Utc::now().to_rfc3339());
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::panic::set_hook(Box::new(|panic_info| {
        let location = panic_info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let payload = if let Some(message) = panic_info.payload().downcast_ref::<&str>() {
            (*message).to_string()
        } else if let Some(message) = panic_info.payload().downcast_ref::<String>() {
            message.clone()
        } else {
            "non-string panic payload".to_string()
        };
        append_debug_log(&format!("panic at {location}: {payload}"));
    }));
    append_debug_log("run:start");

    let run_result = tauri::Builder::default()
        .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_drag::init())
        .manage(AppState::default())
        .setup(|app| {
            append_debug_log("setup:start");
            let state: tauri::State<'_, AppState> = app.state();
            let path = profile_store_path(app.handle());
            append_debug_log(&format!("setup:profile_store={}", path.display()));

            let profiles = read_profiles(&path);
            append_debug_log(&format!("setup:loaded_profiles={}", profiles.len()));

            {
                let mut path_guard = state.data_path.lock().map_err(|_| "path state poisoned")?;
                *path_guard = Some(path);
            }

            {
                let mut profile_guard = state.profiles.lock().map_err(|_| "profile state poisoned")?;
                *profile_guard = profiles;
            }

            append_debug_log("setup:ok");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            upsert_profile,
            add_profile_from_csv,
            connect_profile,
            open_local_terminal,
            open_vscode,
            spawn_pty,
            write_pty,
            resize_pty,
            close_pty,
            list_directory,
            rename_entry,
            delete_entry,
            move_entry,
            create_file,
            create_dir,
            open_file_default,
            open_in_vscode,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = run_result {
        append_debug_log(&format!("run:error={error}"));
        panic!("error while running tauri application: {error}");
    }
}
