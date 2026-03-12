use tauri::{AppHandle, Emitter};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use once_cell::sync::Lazy;

// 配置结构
#[derive(Debug, Deserialize, Clone)]
struct ApiConfig {
    api: ApiSettings,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ApiSettings {
    base_url: String,
    model: String,
    token: String,
}

// 全局配置
static CONFIG: Lazy<Mutex<Option<ApiConfig>>> = Lazy::new(|| Mutex::new(None));

// 从用户本地目录加载配置
fn load_config() -> Result<ApiConfig, Box<dyn std::error::Error>> {
    // 获取用户主目录
    let home_dir = std::env::var("HOME")
        .map_err(|_| "无法获取用户主目录")?;
    
    // 拼接配置文件路径: ~/.longcat/setting.json
    let config_path = std::path::Path::new(&home_dir)
        .join(".longcat")
        .join("setting.json");
    
    println!("配置文件路径: {:?}", config_path);
    
    let config_content = std::fs::read_to_string(&config_path)?;
    let config: ApiConfig = serde_json::from_str(&config_content)?;
    Ok(config)
}

// 启动时加载并初始化配置
fn load_and_init_config() -> Result<(), String> {
    let config = load_config().map_err(|e| e.to_string())?;
    let mut global_config = CONFIG.lock().map_err(|e| e.to_string())?;
    *global_config = Some(config);
    Ok(())
}

// Skill信息结构
#[derive(Debug, Serialize, Clone)]
struct SkillInfo {
    name: String,
    path: String,
    description: String,
    content: String,  // 完整的 SKILL.md 内容
}

// 读取skills目录
#[tauri::command]
fn get_skills() -> Result<Vec<SkillInfo>, String> {
    let home_dir = std::env::var("HOME").map_err(|_| "无法获取用户主目录")?;
    let skills_dir = std::path::Path::new(&home_dir)
        .join(".longcat")
        .join("skills");
    
    println!("Skills目录: {:?}", skills_dir);
    
    if !skills_dir.exists() {
        return Ok(vec![]);
    }
    
    let mut skills = Vec::new();
    
    // 遍历skills目录下的所有子目录
    if let Ok(entries) = std::fs::read_dir(&skills_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                
                // 读取 SKILL.md 完整内容
                let skill_md_path = path.join("SKILL.md");
                let (description, content) = if skill_md_path.exists() {
                    let full_content = std::fs::read_to_string(&skill_md_path)
                        .unwrap_or_default();
                    let first_line = full_content.lines().next().unwrap_or("").to_string();
                    (first_line, full_content)
                } else {
                    ("无描述".to_string(), String::new())
                };
                
                skills.push(SkillInfo {
                    name,
                    path: path.to_string_lossy().to_string(),
                    description,
                    content,
                });
            }
        }
    }
    
    Ok(skills)
}

// OpenAI API 请求结构
#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<Message>,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct Message {
    role: String,
    content: String,
}

// OpenAI API 响应结构
#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    content: String,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// 初始化配置命令
#[tauri::command]
fn init_config() -> Result<String, String> {
    let config = load_config().map_err(|e| e.to_string())?;
    let mut global_config = CONFIG.lock().map_err(|e| e.to_string())?;
    *global_config = Some(config.clone());
    Ok(format!("配置加载成功，模型: {}", config.api.model))
}

// 获取API配置命令（供前端使用）
#[tauri::command]
fn get_api_config() -> Result<ApiSettings, String> {
    let config_guard = CONFIG.lock().map_err(|e| e.to_string())?;
    let config = config_guard.as_ref().ok_or("配置未初始化，请先调用 init_config")?;
    Ok(config.api.clone())
}

// AI处理请求命令
#[tauri::command]
async fn process_ai_request(app: AppHandle, prompt: String) -> Result<(), String> {
    println!("收到AI请求: {}", prompt);
    
    // 获取配置（先提取需要的数据，释放锁）
    let (base_url, model, token) = {
        let config_guard = CONFIG.lock().map_err(|e| e.to_string())?;
        let config = config_guard.as_ref().ok_or("配置未初始化，请先调用 init_config")?;
        (
            config.api.base_url.clone(),
            config.api.model.clone(),
            config.api.token.clone()
        )
    };
    
    // 构建请求
    let client = reqwest::Client::new();
    let request_body = ChatRequest {
        model: model.clone(),
        messages: vec![
            Message {
                role: "user".to_string(),
                content: prompt.clone(),
            }
        ],
        stream: false,
    };
    
    // 发送请求
    let response = client
        .post(format!("{}/chat/completions", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    
    // 解析响应
    let chat_response: ChatResponse = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;
    
    let ai_reply = chat_response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_else(|| "未获取到有效回复".to_string());
    
    println!("AI响应: {}", ai_reply);
    
    // 发送AI响应事件
    app.emit("ai_response", &ai_reply).map_err(|e| e.to_string())?;
    
    Ok(())
}

// Shell 执行命令
#[tauri::command]
fn exec_command(command: String, working_dir: Option<String>) -> Result<String, String> {
    println!("执行命令: {}", command);
    
    let cwd = working_dir.unwrap_or_else(|| std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string()));
    
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("执行命令失败: {}", e))?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push_str("\n");
        }
        result.push_str("STDERR: ");
        result.push_str(&stderr);
    }
    if result.is_empty() {
        result = "(no output)".to_string();
    }
    
    if !output.status.success() {
        result.push_str(&format!("\nExit code: {}", output.status.code().unwrap_or(-1)));
    }
    
    // 截断过长输出
    let max_len = 10000;
    if result.len() > max_len {
        result = format!("{}...\n(truncated, {} more chars)", &result[..max_len], result.len() - max_len);
    }
    
    Ok(result)
}

// 读取文件
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    println!("读取文件: {}", path);
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

// 写入文件
#[tauri::command]
fn write_file(path: String, content: String) -> Result<String, String> {
    println!("写入文件: {}", path);
    // 确保父目录存在
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    std::fs::write(&path, &content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(format!("Successfully wrote {} bytes to {}", content.len(), path))
}

// 列出目录
#[tauri::command]
fn list_dir(path: String) -> Result<String, String> {
    println!("列出目录: {}", path);
    let dir_path = std::path::Path::new(&path);
    
    if !dir_path.exists() {
        return Err(format!("Directory not found: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    
    let mut items = Vec::new();
    for entry in std::fs::read_dir(dir_path).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let file_type = entry.file_type().map_err(|e| format!("获取类型失败: {}", e))?;
        let prefix = if file_type.is_dir() { "📁 " } else { "📄 " };
        items.push(format!("{}{}", prefix, entry.file_name().to_string_lossy()));
    }
    
    items.sort();
    
    if items.is_empty() {
        return Ok(format!("Directory {} is empty", path));
    }
    
    Ok(items.join("\n"))
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            init_config, get_api_config, get_skills, process_ai_request,
            exec_command, read_file, write_file, list_dir
        ])
        .setup(|_app| {
            // 应用启动时自动初始化配置
            if let Err(e) = load_and_init_config() {
                eprintln!("启动时加载配置失败: {}", e);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
