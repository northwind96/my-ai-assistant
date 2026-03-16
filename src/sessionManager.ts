import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";

// 消息类型
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  timestamp: number;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string; // for tool messages
}

// 会话类型
export interface Session {
  chat_id: string;
  title: string;
  mode: 'chat' | 'agent';
  created_at: number;
  updated_at: number;
  messages: SessionMessage[];
}

// 会话元数据（用于列表展示）
export interface SessionMeta {
  chat_id: string;
  title: string;
  mode: 'chat' | 'agent';
  created_at: number;
  updated_at: number;
  message_count: number;
}

const MAX_MESSAGES_PER_SESSION = 500;
const MAX_CONTEXT_MESSAGES = 100;
const MAX_MESSAGE_LENGTH = 500;
const MAX_SESSIONS_IN_LIST = 20;

class SessionManager {
  private baseSessionsDir: string = '';
  private initialized: boolean = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    const home = await homeDir();
    this.baseSessionsDir = await join(home, '.nova', 'sessions');

    // 确保 chat 和 agent 子目录存在
    try {
      await invoke('create_dir_all', { path: await join(this.baseSessionsDir, 'chat') });
      await invoke('create_dir_all', { path: await join(this.baseSessionsDir, 'agent') });
    } catch (error) {
      console.error('Failed to create sessions directories:', error);
    }

    this.initialized = true;
  }

  private async ensureDirExists(dirPath: string): Promise<void> {
    try {
      await invoke('create_dir_all', { path: dirPath });
    } catch (error) {
      console.error('Failed to create directory:', error);
    }
  }

  // 根据 mode 获取会话目录
  private getSessionsDir(mode: 'chat' | 'agent'): string {
    return `${this.baseSessionsDir}/${mode}`;
  }

  // 获取会话文件路径
  private getSessionFilePath(chatId: string, mode: 'chat' | 'agent'): string {
    return `${this.getSessionsDir(mode)}/${chatId}.jsonl`;
  }

  // 生成唯一的 chat_id
  generateChatId(): string {
    return `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // 创建新会话
  async createSession(title: string, mode: 'chat' | 'agent'): Promise<Session> {
    await this.init();

    const now = Date.now();
    const session: Session = {
      chat_id: this.generateChatId(),
      title,
      mode,
      created_at: now,
      updated_at: now,
      messages: []
    };

    // 保存会话文件
    await this.saveSession(session);

    return session;
  }

  // 保存会话到文件
  async saveSession(session: Session): Promise<void> {
    await this.init();

    const filePath = this.getSessionFilePath(session.chat_id, session.mode);

    // 限制消息数量，保留最新的 MAX_MESSAGES_PER_SESSION 条
    if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
      session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }

    // 将每条消息转换为 JSONL 格式
    const lines: string[] = [];

    // 第一行是会话元数据
    const meta = {
      chat_id: session.chat_id,
      title: session.title,
      mode: session.mode,
      created_at: session.created_at,
      updated_at: session.updated_at
    };
    lines.push(JSON.stringify({ type: 'meta', data: meta }));

    // 后续行是消息
    for (const msg of session.messages) {
      lines.push(JSON.stringify({ type: 'message', data: msg }));
    }

    // 写入文件
    const content = lines.join('\n');
    await invoke('write_text_file', { path: filePath, contents: content });
  }

  // 加载会话（需要指定 mode）
  async loadSession(chatId: string, mode: 'chat' | 'agent'): Promise<Session | null> {
    await this.init();

    const filePath = this.getSessionFilePath(chatId, mode);

    try {
      const content = await invoke<string>('read_text_file', { path: filePath });
      const lines = content.split('\n').filter(line => line.trim());

      let session: Session | null = null;
      const messages: SessionMessage[] = [];

      for (const line of lines) {
        try {
          const record = JSON.parse(line);

          if (record.type === 'meta') {
            const meta = record.data;
            session = {
              chat_id: meta.chat_id,
              title: meta.title,
              mode: meta.mode,
              created_at: meta.created_at,
              updated_at: meta.updated_at,
              messages: []
            };
          } else if (record.type === 'message') {
            messages.push(record.data);
          }
        } catch (e) {
          console.error('Failed to parse line:', line, e);
        }
      }

      if (session) {
        session.messages = messages;
      }

      return session;
    } catch (error) {
      console.error('Failed to load session:', error);
      return null;
    }
  }

  // 添加消息到会话（需要指定 mode）
  async addMessage(chatId: string, mode: 'chat' | 'agent', message: Omit<SessionMessage, 'id' | 'timestamp'>): Promise<void> {
    const session = await this.loadSession(chatId, mode);
    if (!session) {
      throw new Error(`Session ${chatId} not found`);
    }

    const newMessage: SessionMessage = {
      ...message,
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now()
    };

    session.messages.push(newMessage);
    session.updated_at = Date.now();

    await this.saveSession(session);
  }

  // 获取指定模式的会话列表（按更新时间排序，最多20个）
  async listSessions(mode: 'chat' | 'agent', limit: number = MAX_SESSIONS_IN_LIST): Promise<SessionMeta[]> {
    await this.init();

    try {
      // 读取对应 mode 目录下的所有 .jsonl 文件
      const modeDir = this.getSessionsDir(mode);
      const files = await invoke<string[]>('read_dir', { path: modeDir }) as string[];
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

      const sessions: SessionMeta[] = [];

      for (const file of jsonlFiles) {
        try {
          const chatId = file.replace('.jsonl', '');
          const session = await this.loadSession(chatId, mode);
          if (session) {
            sessions.push({
              chat_id: session.chat_id,
              title: session.title,
              mode: session.mode,
              created_at: session.created_at,
              updated_at: session.updated_at,
              message_count: session.messages.length
            });
          }
        } catch (e) {
          console.error('Failed to load session from file:', file, e);
        }
      }

      // 按更新时间排序，最新的在前
      sessions.sort((a, b) => b.updated_at - a.updated_at);

      return sessions.slice(0, limit);
    } catch (error) {
      console.error('Failed to list sessions:', error);
      return [];
    }
  }

  // 删除会话（需要指定 mode）
  async deleteSession(chatId: string, mode: 'chat' | 'agent'): Promise<void> {
    await this.init();

    const filePath = this.getSessionFilePath(chatId, mode);
    try {
      await invoke('remove_file', { path: filePath });
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  }

  // 更新会话标题（需要指定 mode）
  async updateSessionTitle(chatId: string, mode: 'chat' | 'agent', title: string): Promise<void> {
    const session = await this.loadSession(chatId, mode);
    if (session) {
      session.title = title;
      session.updated_at = Date.now();
      await this.saveSession(session);
    }
  }

  // 压缩消息历史，准备发送到模型
  compressMessagesForContext(messages: SessionMessage[]): Array<{ role: string; content: string | any[] }> {
    // 取最新的 MAX_CONTEXT_MESSAGES 条消息
    let contextMessages = messages.slice(-MAX_CONTEXT_MESSAGES);

    const compressed = contextMessages.map(msg => {
      let content = msg.content;

      // 处理内容截断
      if (typeof content === 'string') {
        if (content.length > MAX_MESSAGE_LENGTH) {
          content = content.slice(0, MAX_MESSAGE_LENGTH) + '...';
        }
      } else if (Array.isArray(content)) {
        // 处理多模态内容，将图片替换为占位符
        content = content.map(c => {
          if (c.type === 'image_url' || c.type === 'image') {
            return { type: 'text', text: '[image]' };
          }
          // 截断长文本
          if (c.type === 'text' && c.text && c.text.length > MAX_MESSAGE_LENGTH) {
            return { type: 'text', text: c.text.slice(0, MAX_MESSAGE_LENGTH) + '...' };
          }
          return c;
        });
      }

      const result: any = {
        role: msg.role,
        content
      };

      // 添加 tool_calls 如果有
      if (msg.tool_calls) {
        result.tool_calls = msg.tool_calls;
      }

      // 添加 tool_call_id 和 name 如果是 tool 消息
      if (msg.tool_call_id) {
        result.tool_call_id = msg.tool_call_id;
      }
      if (msg.name) {
        result.name = msg.name;
      }

      return result;
    });

    return compressed;
  }

  // 构建完整的请求上下文
  buildFullContext(
    systemPrompt: string,
    sessionMessages: SessionMessage[],
    currentUserMessage: string
  ): Array<{ role: string; content: string | any[] }> {
    const context: Array<{ role: string; content: string | any[] }> = [];

    // 1. 系统提示词
    context.push({
      role: 'system',
      content: systemPrompt
    });

    // 2. 压缩后的会话历史
    const compressedHistory = this.compressMessagesForContext(sessionMessages);
    context.push(...compressedHistory);

    // 3. 当前用户消息
    context.push({
      role: 'user',
      content: currentUserMessage
    });

    return context;
  }
}

// 导出单例
export const sessionManager = new SessionManager();
