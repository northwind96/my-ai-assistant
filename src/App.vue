<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import OpenAI from "openai";
import { Agent, run, setDefaultOpenAIKey, OpenAIChatCompletionsModel, type RunStreamEvent } from "@openai/agents";
import { skillsLoader } from "./skills";
import { agentTools } from "./tools";
import { sessionManager, type Session } from "./sessionManager";
import MarkdownRender, { getMarkdown, parseMarkdownToStructure, type ParsedNode } from 'markstream-vue'
import {
  NLayout,
  NLayoutSider,
  NLayoutHeader,
  NLayoutContent,
  NButton,
  NInput,
  NAvatar,
  NTooltip,
  NSpace,
  NDivider,
  NIcon,
  NConfigProvider,
  NMessageProvider,
  lightTheme,
  createDiscreteApi,
  NTag,
  NSelect,
  NModal,
  NForm,
  NFormItem,
  NInputGroup
} from 'naive-ui'
import {
  ChatbubbleOutline,
  SparklesOutline,
  AddOutline,
  SettingsOutline,
  CopyOutline,
  RefreshOutline,
  TrashOutline,
  PaperPlaneOutline,
  MenuOutline,
  ChevronDownOutline,
  SearchOutline,
  TimeOutline,
  PinOutline,
  ArrowDownOutline,
  BulbOutline,
  DocumentTextOutline,
  ImageOutline,
  CloseOutline
} from '@vicons/ionicons5'

import {LinkOutlined} from '@vicons/antd'

// 附件类型定义
interface Attachment {
  id: string;
  path: string;
  name: string;
  type: 'text' | 'image' | 'document'; // text: txt/json/jsonl/csv, image: jpg/jpeg/png, document: xlsx/docx/ppt
  extension: string;
  size?: number;
  base64Data?: string; // 图片的 base64 数据
  content?: string; // 文本文件内容
}

// 渠道配置类型
interface Channel {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
}

// 应用配置类型
interface AppConfig {
  channels: Channel[];
  chat_channel_id: string;
  agent_channel_id: string;
}

// 最大附件数量
const MAX_ATTACHMENTS = 5;

// 支持的文件类型
const ALLOWED_EXTENSIONS = {
  text: ['txt', 'json', 'jsonl', 'csv', 'md'],
  image: ['jpg', 'jpeg', 'png'],
  document: ['xlsx', 'docx', 'ppt', 'pptx']
};

// 空附件数组常量
const emptyAttachments: Attachment[] = [];

// 消息类型定义
interface Message {
  id: number;
  content: string;
  nodes?: ParsedNode[];
  sender: 'user' | 'ai' | 'system';
  timestamp: Date;
  reasoningContent?: string; // 深度思考内容
  showReasoning?: boolean; // 是否展开显示思考内容
}

// 标签页类型定义
interface Tab {
  id: string;                    // 标签页唯一ID
  chat_id: string;               // 关联的会话ID
  title: string;                 // 标签页标题
  mode: 'chat' | 'agent';        // 模式
  messages: Message[];           // 该标签页的消息列表
  session: Session | null;       // 关联的会话对象
  attachments: Attachment[];     // 附件列表（仅Agent模式）
  isLoading?: boolean;           // 是否正在加载
  selectedModel?: string;        // 该标签页选择的模型
  created_at: number;
  updated_at: number;
}

// 对话历史类型（使用 SessionMeta）
interface Conversation {
  chat_id: string;
  title: string;
  mode: 'chat' | 'agent';
  created_at: number;
  updated_at: number;
  message_count: number;
  pinned?: boolean;
}

// Skill类型
interface SkillInfo {
  name: string;
  path: string;
  description: string;
  content: string;
}

// 模式类型
type ChatMode = 'chat' | 'agent';

// 响应数据
const inputText = ref('');
const isLoading = ref(false);
const currentMode = ref<ChatMode>('chat');
const skills = ref<SkillInfo[]>([]);
const collapsed = ref(false);

// 设置面板状态
const showSettings = ref(false);
const appConfig = ref<AppConfig>({
  channels: [],
  chat_channel_id: '',
  agent_channel_id: ''
});
const editingChannel = ref<Channel | null>(null);
const isAddingChannel = ref(false);
const newModelInput = ref('');

// 控制渠道编辑弹窗显示
const showChannelModal = computed({
  get: () => editingChannel.value !== null,
  set: (value: boolean) => {
    if (!value) {
      editingChannel.value = null;
    }
  }
});

// 标签页状态管理
const tabs = ref<Tab[]>([]);
const activeTabId = ref<string>('');

// 当前标签页计算属性
const currentTab = computed(() => {
  return tabs.value.find(t => t.id === activeTabId.value) || null;
});

// 空数组常量，避免每次返回新数组引用
const emptyMessages: Message[] = [];

// messages 改为计算属性，始终返回当前标签页的消息数组
// 这样任何对 messages 的修改都会直接反映到标签页上
const messages = computed({
  get: () => {
    const tab = currentTab.value;
    if (tab) {
      return tab.messages;
    }
    // 没有标签页时返回固定的空数组
    return emptyMessages;
  },
  set: (value) => {
    const tab = currentTab.value;
    if (tab) {
      tab.messages = value;
    }
  }
});

// attachments 也改为计算属性，始终返回当前标签页的附件数组
const attachments = computed({
  get: () => {
    const tab = currentTab.value;
    if (tab && tab.attachments) {
      return tab.attachments;
    }
    return emptyAttachments;
  },
  set: (value) => {
    const tab = currentTab.value;
    if (tab) {
      tab.attachments = value;
    }
  }
});

const currentConversation = ref<Conversation>({
  chat_id: '',
  title: '新对话',
  mode: 'chat',
  created_at: Date.now(),
  updated_at: Date.now(),
  message_count: 0
});

// 深度思考开关（仅 Chat 模式）
const enableThinking = ref(false);

// 首页默认选择的模型（用于没有标签页时）
const defaultSelectedModel = ref('');

// 当前选中的模型 - 改为计算属性，从当前标签页获取/设置
const selectedModel = computed({
  get: () => {
    const tab = currentTab.value;
    if (tab?.selectedModel) {
      return tab.selectedModel;
    }
    // 首页时使用默认选择的模型
    if (!tab && defaultSelectedModel.value) {
      return defaultSelectedModel.value;
    }
    // 如果没有设置，返回默认模型
    const mode = tab?.mode || 'chat';
    const channel = appConfig.value.channels.find(
      c => c.id === (mode === 'chat' ? appConfig.value.chat_channel_id : appConfig.value.agent_channel_id)
    );
    return channel?.models?.[0] || '';
  },
  set: (value: string) => {
    const tab = currentTab.value;
    if (tab) {
      tab.selectedModel = value;
    } else {
      // 首页时保存到默认变量
      defaultSelectedModel.value = value;
    }
  }
});

// 获取当前可用模型列表
const availableModels = computed(() => {
  const mode = currentTab.value?.mode || 'chat';
  const channel = appConfig.value.channels.find(
    c => c.id === (mode === 'chat' ? appConfig.value.chat_channel_id : appConfig.value.agent_channel_id)
  );
  return channel?.models || [];
});

// 消息提示 - 使用 createDiscreteApi 在 setup 外部使用 message
const { message } = createDiscreteApi(['message']);

// 聊天内容区域引用
const chatContentRef = ref<any>(null);

// 自动滚动到底部
function scrollToBottom() {
  nextTick(() => {
    if (chatContentRef.value) {
      // n-layout-content 是 Naive UI 组件，需要获取其 $el 或内部滚动容器
      const componentEl = chatContentRef.value.$el;
      const el = componentEl || chatContentRef.value;
      // 尝试找到实际的滚动容器
      const scrollContainer = el.querySelector?.('.n-layout-scroll-container') || el;
      if (scrollContainer && scrollContainer.scrollHeight !== undefined) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      } else if (el.scrollHeight !== undefined) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
}

// 是否应该自动滚动（用户未手动滚动时）
const shouldAutoScroll = ref(true);

// 是否显示"回到底部"按钮
const showScrollToBottom = ref(false);

// 检测用户是否手动滚动
function handleScroll(event: Event) {
  const target = event.target as HTMLElement;
  const isAtBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
  shouldAutoScroll.value = isAtBottom;
  showScrollToBottom.value = !isAtBottom;
}

// 点击按钮回到底部
function goTobottom() {
  shouldAutoScroll.value = true;
  scrollToBottom();
}

// 监听消息变化，自动滚动
watch(messages, () => {
  if (shouldAutoScroll.value) {
    scrollToBottom();
  }
}, { deep: true });

// 对话历史（从会话管理加载）
const conversations = ref<Conversation[]>([]);

// 置顶对话
const pinnedConversations = computed(() => conversations.value.filter(c => c.pinned));
// 今日对话
const todayConversations = computed(() => conversations.value.filter(c => !c.pinned && isToday(c.updated_at)));
// 历史对话
const historyConversations = computed(() => conversations.value.filter(c => !c.pinned && !isToday(c.updated_at)));

function isToday(timestamp: number) {
  const today = new Date();
  const date = new Date(timestamp);
  return date.toDateString() === today.toDateString();
}

// function formatDate(date: Date) {
//   const now = new Date();
//   const diff = now.getTime() - date.getTime();
//   const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
//   if (days === 0) return '今天';
//   if (days === 1) return '昨天';
//   if (days < 7) return `${days}天前`;
//   return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
// }

let openaiClient: OpenAI | null = null;

// 加载Skills列表
async function loadSkills() {
  try {
    const skillsList = await skillsLoader.listSkills();
    skills.value = skillsList.map(s => ({
      name: s.name,
      path: s.path,
      description: s.description || s.name,
      content: s.content || ''
    }));
    const summary = await skillsLoader.buildSkillsSummary();
    console.log("Skills摘要:", summary.xml);
  } catch (error) {
    console.error("加载Skills失败:", error);
  }
}

// 标签页操作函数

// 创建新标签页（异步，创建时立即持久化）
async function createTab(mode: 'chat' | 'agent' = 'chat', title?: string) {
  const newTab: Tab = {
    id: `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    chat_id: '',
    title: title || '新对话',
    mode: mode,
    messages: [
      {
        id: 1,
        content: mode === 'chat'
          ? '你好！我是 Nova，有什么可以帮您的吗？'
          : '你好！我是Agent助手，可以执行工具和Skills。',
        sender: 'ai',
        timestamp: new Date()
      }
    ],
    session: null,
    attachments: [],
    selectedModel: defaultSelectedModel.value || undefined,
    created_at: Date.now(),
    updated_at: Date.now()
  };

  // 立即创建会话文件（持久化）
  try {
    const session = await sessionManager.createSession(newTab.title, mode);
    newTab.chat_id = session.chat_id;
    newTab.session = session;
  } catch (error) {
    console.error('创建会话失败:', error);
  }

  tabs.value.push(newTab);
  activeTabId.value = newTab.id;

  // 同步会话状态（messages 和 attachments 是计算属性，会自动同步）
  currentSession.value = newTab.session;

  return newTab;
}

// ========== 设置面板函数 ==========

// 打开设置面板
async function openSettings() {
  showSettings.value = true;
  await loadAppConfig();
}

// 加载应用配置
async function loadAppConfig() {
  try {
    const config = await invoke<AppConfig>('get_api_config');
    appConfig.value = config;
  } catch (error) {
    console.error('加载配置失败:', error);
    message.error('加载配置失败');
  }
}

// 保存应用配置
async function saveAppConfig() {
  try {
    await invoke('save_api_config', { config: appConfig.value });
    message.success('配置已保存');
    // 重新初始化 OpenAI 客户端
    const defaultChannel = appConfig.value.channels[0];
    if (defaultChannel) {
      openaiClient = new OpenAI({
        baseURL: defaultChannel.base_url,
        apiKey: defaultChannel.api_key,
        dangerouslyAllowBrowser: true
      });
    }
  } catch (error) {
    console.error('保存配置失败:', error);
    message.error('保存配置失败');
  }
}

// 添加新渠道
function addChannel() {
  editingChannel.value = {
    id: `channel_${Date.now()}`,
    name: '新渠道',
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    models: ['gpt-3.5-turbo']
  };
  isAddingChannel.value = true;
}

// 编辑渠道
function editChannel(channel: Channel) {
  editingChannel.value = { ...channel };
  isAddingChannel.value = false;
}

// 保存渠道
function saveChannel() {
  if (!editingChannel.value) return;
  
  const index = appConfig.value.channels.findIndex(c => c.id === editingChannel.value!.id);
  if (index > -1) {
    // 更新现有渠道
    appConfig.value.channels[index] = { ...editingChannel.value };
  } else {
    // 添加新渠道
    appConfig.value.channels.push({ ...editingChannel.value });
  }
  
  // 如果是第一个渠道，设置为默认
  if (appConfig.value.channels.length === 1) {
    appConfig.value.chat_channel_id = editingChannel.value.id;
    appConfig.value.agent_channel_id = editingChannel.value.id;
  }
  
  editingChannel.value = null;
  saveAppConfig();
}

// 删除渠道
function deleteChannel(channelId: string) {
  const index = appConfig.value.channels.findIndex(c => c.id === channelId);
  if (index > -1) {
    appConfig.value.channels.splice(index, 1);
    // 如果删除的是当前选中的渠道，重置选择
    if (appConfig.value.chat_channel_id === channelId) {
      appConfig.value.chat_channel_id = appConfig.value.channels[0]?.id || '';
    }
    if (appConfig.value.agent_channel_id === channelId) {
      appConfig.value.agent_channel_id = appConfig.value.channels[0]?.id || '';
    }
    saveAppConfig();
  }
}

// 添加模型到渠道
function addModelToChannel() {
  if (!editingChannel.value || !newModelInput.value.trim()) return;
  if (!editingChannel.value.models.includes(newModelInput.value.trim())) {
    editingChannel.value.models.push(newModelInput.value.trim());
  }
  newModelInput.value = '';
}

// 从渠道删除模型
function removeModelFromChannel(modelIndex: number) {
  if (!editingChannel.value) return;
  editingChannel.value.models.splice(modelIndex, 1);
}

// 关闭设置面板
function closeSettings() {
  showSettings.value = false;
  editingChannel.value = null;
}

// 切换到指定标签页
function switchToTab(tabId: string) {
  if (activeTabId.value === tabId) return;
  activeTabId.value = tabId;
  const tab = currentTab.value;
  if (tab) {
    currentMode.value = tab.mode;
    currentSession.value = tab.session;
    // messages 和 attachments 是计算属性，会自动同步
    // selectedModel 也是计算属性，会自动从 tab.selectedModel 获取
  }
}

// 关闭标签页
function closeTab(tabId: string, event?: Event) {
  event?.stopPropagation();

  const index = tabs.value.findIndex(t => t.id === tabId);
  if (index === -1) return;

  // 如果关闭的是当前标签页，需要切换到其他标签页
  if (activeTabId.value === tabId) {
    // 先移除标签页
    tabs.value.splice(index, 1);

    // 移除后再决定切换到哪个标签页
    if (tabs.value.length > 0) {
      // 优先切换到原索引位置的标签页（右侧那个），如果超出范围则切换到最后一个
      const newActiveIndex = Math.min(index, tabs.value.length - 1);
      const newActiveTab = tabs.value[newActiveIndex];
      activeTabId.value = newActiveTab.id;
      currentMode.value = newActiveTab.mode;
      currentSession.value = newActiveTab.session;
      // messages 和 attachments 是计算属性，会自动同步
    } else {
      // 关闭的是最后一个标签页，清空状态（跳转到首页）
      activeTabId.value = '';
      currentMode.value = 'chat';
      currentSession.value = null;
      // messages 和 attachments 是计算属性，会自动返回空数组
    }
  } else {
    // 关闭的不是当前标签页，直接移除
    tabs.value.splice(index, 1);
  }
}

// 切换当前标签页的模式
function switchMode(mode: ChatMode) {
  // 只更新全局模式（用于新建对话时的默认模式）
  // 不修改已存在标签页的模式
  currentMode.value = mode;

  // 重新加载对应模式的会话列表（不阻塞 UI）
  loadConversationList();
}

// 新建对话（创建新标签页，使用当前选择的模式）
async function createNewConversation() {
  showSettings.value = false; // 关闭设置面板
  await createTab(currentMode.value);
  loadConversationList();
}

// 当前会话对象
const currentSession = ref<Session | null>(null);

// 加载会话列表
async function loadConversationList() {
  try {
    const sessions = await sessionManager.listSessions(currentMode.value, 20);
    conversations.value = sessions.map(s => ({
      chat_id: s.chat_id,
      title: s.title,
      mode: s.mode,
      created_at: s.created_at,
      updated_at: s.updated_at,
      message_count: s.message_count,
      pinned: false
    }));
  } catch (error) {
    console.error('加载会话列表失败:', error);
  }
}

// 选择对话
async function selectConversation(conv: Conversation) {
  // 关闭设置面板
  showSettings.value = false;

  // 检查是否已经有标签页打开了这个会话
  const existingTab = tabs.value.find(t => t.chat_id === conv.chat_id);

  if (existingTab) {
    // 如果已经打开，切换到该标签页
    switchToTab(existingTab.id);
    return;
  }

  // 加载会话（先加载，确认会话存在）
  const session = await sessionManager.loadSession(conv.chat_id, conv.mode);
  if (!session) {
    console.error('会话不存在:', conv.chat_id);
    return;
  }

  // 创建标签页（不创建新会话文件，直接使用已有会话）
  const newTab: Tab = {
    id: `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    chat_id: conv.chat_id,
    title: conv.title,
    mode: conv.mode,
    messages: [],
    session: session,
    attachments: [],
    created_at: Date.now(),
    updated_at: Date.now()
  };

  // 将会话消息转换为 UI 消息
  const sessionMessages = session.messages.map((msg, index) => ({
    id: index + 1,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    sender: msg.role === 'user' ? 'user' : 'ai',
    timestamp: new Date(msg.timestamp)
  }));

  // 如果没有消息，添加欢迎消息
  if (sessionMessages.length === 0) {
    newTab.messages.push({
      id: 1,
      content: conv.mode === 'chat'
        ? '你好！我是 Nova，有什么可以帮您的吗？'
        : '你好！我是Agent助手，可以执行工具和Skills。',
      sender: 'ai',
      timestamp: new Date()
    });
  } else {
    newTab.messages.push(...sessionMessages as Message[]);
  }

  // 添加标签页并激活
  tabs.value.push(newTab);
  activeTabId.value = newTab.id;
  currentSession.value = session;
  currentMode.value = session.mode;
}

// 删除会话
async function deleteConversation(conv: Conversation, event: Event) {
  event.stopPropagation(); // 阻止冒泡，避免触发选择会话

  try {
    // 1. 先找到并关闭对应的标签页
    const tabIndex = tabs.value.findIndex(t => t.chat_id === conv.chat_id);
    if (tabIndex !== -1) {
      const tab = tabs.value[tabIndex];
      // 如果关闭的是当前激活的标签页
      if (activeTabId.value === tab.id) {
        // 先移除标签页
        tabs.value.splice(tabIndex, 1);

        // 切换到其他标签页或清空
        if (tabs.value.length > 0) {
          const newActiveIndex = Math.min(tabIndex, tabs.value.length - 1);
          const newActiveTab = tabs.value[newActiveIndex];
          activeTabId.value = newActiveTab.id;
          currentMode.value = newActiveTab.mode;
          currentSession.value = newActiveTab.session;
          // messages 和 attachments 是计算属性，会自动同步
        } else {
          // 没有其他标签页了，保持当前模式，清空会话状态
          activeTabId.value = '';
          // 不要改变 currentMode，保持用户当前选择的模式
          currentSession.value = null;
          // messages 和 attachments 是计算属性，会自动返回空数组
        }
      } else {
        // 不是当前标签页，直接移除
        tabs.value.splice(tabIndex, 1);
      }
    }

    // 2. 删除本地存储的会话文件
    await sessionManager.deleteSession(conv.chat_id, conv.mode);

    // 3. 从会话列表中移除
    const index = conversations.value.findIndex(c => c.chat_id === conv.chat_id);
    if (index > -1) {
      conversations.value.splice(index, 1);
    }
  } catch (error) {
    console.error('删除会话失败:', error);
  }
}

// 获取文件类型
function getFileType(extension: string): 'text' | 'image' | 'document' {
  const ext = extension.toLowerCase();
  if (ALLOWED_EXTENSIONS.text.includes(ext)) return 'text';
  if (ALLOWED_EXTENSIONS.image.includes(ext)) return 'image';
  return 'document';
}

// 获取文件图标
function getFileIcon(type: 'text' | 'image' | 'document') {
  switch (type) {
    case 'image':
      return ImageOutline;
    case 'text':
    case 'document':
    default:
      return DocumentTextOutline;
  }
}

// 获取类型标签
function getTypeLabel(type: 'text' | 'image' | 'document', extension: string) {
  switch (type) {
    case 'image':
      return '图片';
    case 'text':
      return extension.toUpperCase();
    case 'document':
      return extension.toUpperCase();
    default:
      return '文件';
  }
}

// 打开附件选择对话框
async function openAttachmentDialog() {
  // 检查附件数量限制
  if (attachments.value.length >= MAX_ATTACHMENTS) {
    message.warning(`最多只能上传 ${MAX_ATTACHMENTS} 个附件`);
    return;
  }

  try {
    // 动态导入 Tauri dialog API
    const { open } = await import('@tauri-apps/plugin-dialog');

    // 收集所有支持的扩展名
    const allExtensions = [
      ...ALLOWED_EXTENSIONS.text,
      ...ALLOWED_EXTENSIONS.image,
      ...ALLOWED_EXTENSIONS.document
    ];

    // 使用 Tauri 的 dialog API 打开文件选择器
    const selected = await open({
      filters: [
        {
          name: '支持的文件',
          extensions: allExtensions
        }
      ],
      multiple: true // 允许多选
    });

    if (selected) {
      // 统一处理为数组
      const files = Array.isArray(selected) ? selected : [selected];
      const remainingSlots = MAX_ATTACHMENTS - attachments.value.length;

      if (files.length > remainingSlots) {
        message.warning(`只能再添加 ${remainingSlots} 个附件`);
        return;
      }

      for (const filePath of files) {
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || '未知文件';
        const extension = fileName.split('.').pop()?.toLowerCase() || '';
        const fileType = getFileType(extension);

        const attachment: Attachment = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          path: filePath,
          name: fileName,
          type: fileType,
          extension
        };

        attachments.value.push(attachment);
      }

      message.success(`已添加 ${files.length} 个附件`);
    }
  } catch (error) {
    console.error('打开文件对话框失败:', error);
    message.error('打开文件对话框失败');
  }
}

// 移除附件
function removeAttachment(id: string) {
  const index = attachments.value.findIndex(a => a.id === id);
  if (index > -1) {
    attachments.value.splice(index, 1);
  }
}

// 读取图片为 base64
async function readImageAsBase64(filePath: string): Promise<string> {
  try {
    // 使用 Tauri 读取文件为 base64
    const base64 = await invoke<string>('read_file_as_base64', { path: filePath });
    return base64;
  } catch (error) {
    console.error('读取图片失败:', error);
    throw error;
  }
}

// 发送消息
async function sendMessage() {
  if (!inputText.value.trim() || !openaiClient) return;

  // 如果没有标签页，先创建一个
  if (tabs.value.length === 0) {
    await createTab(currentMode.value);
  }

  // 保存当前标签页和会话的引用
  const targetTab = currentTab.value;
  if (!targetTab) return;

  // 如果没有当前会话，先创建一个
  if (!currentSession.value) {
    await createNewConversation();
  }

  // 重新获取引用（createNewConversation 可能会改变）
  const finalTargetTab = currentTab.value;
  const targetSession = currentSession.value;
  if (!finalTargetTab) return;

  // 构建用户消息内容
  let userContent = inputText.value;

  // 获取标签页的模式
  const tabMode = finalTargetTab.mode;

  // Agent 模式下处理附件
  if (tabMode === 'agent' && attachments.value.length > 0) {
    // 构建附件信息
    const attachmentInfo = attachments.value.map(att => {
      if (att.type === 'image') {
        return `【图片文件: ${att.name}】路径: ${att.path}`;
      } else if (att.type === 'text') {
        return `【文本文件: ${att.name}】路径: ${att.path}`;
      } else {
        return `【文档文件: ${att.name}】路径: ${att.path}`;
      }
    }).join('\n');

    userContent = `${userContent}\n\n附件文件：\n${attachmentInfo}`;
  }

  const userMessage: Message = {
    id: Date.now(),
    content: inputText.value,
    sender: 'user',
    timestamp: new Date()
  };

  // 检查是否只有欢迎消息（占位消息），如果是则清空
  if (finalTargetTab.messages.length === 1 && finalTargetTab.messages[0].sender === 'ai') {
    // 替换欢迎消息为用户消息
    finalTargetTab.messages.length = 0;  // 清空数组但保持引用
    finalTargetTab.messages.push(userMessage);
  } else {
    finalTargetTab.messages.push(userMessage);
  }

  const userInput = inputText.value;
  const attachmentsToSend = [...attachments.value]; // 保存当前附件列表

  // 保存用户消息到会话（如果是替换欢迎消息的情况，需要特殊处理）
  if (finalTargetTab.messages.length === 1) {
    // 清空会话中的消息，重新保存
    if (targetSession) {
      targetSession.messages = [];
    }
  }

  // 保存用户消息到会话
  if (targetSession) {
    await sessionManager.addMessage(targetSession.chat_id, targetSession.mode, {
      role: 'user',
      content: userContent
    });
  }

  // 如果是第一条用户消息，更新会话标题
  if (targetSession && targetSession.title === '新对话') {
    const newTitle = userInput.length <= 15 ? userInput : userInput.slice(0, 15) + '...';
    await sessionManager.updateSessionTitle(targetSession.chat_id, targetSession.mode, newTitle);
    targetSession.title = newTitle;
    finalTargetTab.title = newTitle;
  }

  inputText.value = '';
  finalTargetTab.attachments = []; // 清空附件
  isLoading.value = true;

  try {
    if (tabMode === 'chat') {
      await chatMode(userInput);
    } else {
      await agentMode(userInput, attachmentsToSend);
    }
  } catch (error) {
    console.error('请求失败:', error);
    const errorMsg = '抱歉，服务暂时不可用，请稍后重试。';
    // 写入到原始标签页
    finalTargetTab.messages.push({
      id: Date.now(),
      content: errorMsg,
      sender: 'ai',
      timestamp: new Date()
    });
    if (targetSession) {
      await sessionManager.addMessage(targetSession.chat_id, targetSession.mode, {
        role: 'assistant',
        content: errorMsg
      });
    }
  } finally {
    isLoading.value = false;
  }
}

// Chat模式
async function chatMode(userInput: string) {
  if (!openaiClient) return;

  // 保存当前标签页的引用，防止切换标签页后写入错误的位置
  const targetTab = currentTab.value;
  const targetSession = currentSession.value;
  if (!targetTab) return;

  // 构建消息历史上下文
  let messagesContext: Array<{ role: string; content: string }> = [];

  if (targetSession && targetSession.messages.length > 0) {
    // 使用会话管理器的压缩功能获取历史消息
    const compressedHistory = sessionManager.compressMessagesForContext(targetSession.messages);
    messagesContext = compressedHistory.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }));
  }

  // 添加当前用户消息
  messagesContext.push({ role: 'user', content: userInput });

    // 构建请求参数
    const requestParams: any = {
      model: selectedModel.value || 'qwen3.5-plus',
      messages: messagesContext,
      stream: true,
      enable_thinking: enableThinking.value,
      max_tokens: 8192  // 设置最大输出 token 数
    };

  const stream = await openaiClient.chat.completions.create(requestParams) as any;

  // 创建 AI 消息占位，用于流式更新
  const aiMessageId = Date.now();
  const md = getMarkdown();
  targetTab.messages.push({
    id: aiMessageId,
    content: '',
    nodes: [],
    sender: 'ai',
    timestamp: new Date(),
    reasoningContent: '',
    showReasoning: false
  });

  // 重置自动滚动标志
  shouldAutoScroll.value = true;

  let aiContent = '';
  let reasoningContent = '';

  for await (const chunk of stream) {
    // 检查标签页是否还存在
    if (!tabs.value.find(t => t.id === targetTab.id)) {
      // 标签页已被关闭，停止处理
      break;
    }

    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    // 收集思考内容
    if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
      reasoningContent += delta.reasoning_content;
      const aiMessage = targetTab.messages.find(m => m.id === aiMessageId);
      if (aiMessage) {
        aiMessage.reasoningContent = reasoningContent;
        // 默认展开显示思考内容
        aiMessage.showReasoning = true;
      }
    }

    // 收集回复内容
    const content = delta.content || '';
    if (content) {
      aiContent += content;
      // 实时更新消息内容和 nodes
      const aiMessage = targetTab.messages.find(m => m.id === aiMessageId);
      if (aiMessage) {
        aiMessage.content = aiContent;
        aiMessage.nodes = parseMarkdownToStructure(aiContent, md);
      }
      // 流式更新时自动滚动（仅当还在当前标签页时）
      if (activeTabId.value === targetTab.id) {
        scrollToBottom();
      }
    }
  }

  // 保存 AI 回复到会话
  if (aiContent && targetSession) {
    // 使用保存的 session 引用
    await sessionManager.addMessage(targetSession.chat_id, targetSession.mode, {
      role: 'assistant',
      content: aiContent
    });
  }
}

// Agent模式
async function agentMode(userInput: string, attachmentsList: Attachment[] = []) {
  if (!openaiClient) return;

  // 保存当前标签页的引用，防止切换标签页后写入错误的位置
  const targetTab = currentTab.value;
  const targetSession = currentSession.value;
  if (!targetTab) return;

  try {
    const summary = await skillsLoader.buildSkillsSummary();
    const skillsXml = summary.xml;
    const skillsDescription = skillsXml
      ? `# Skills

The following skills extend your capabilities. To use a skill, read its SKILL.md file using the read_file tool.
Skills with available="false" need dependencies installed first.
${skillsXml}`
      : '';

      setDefaultOpenAIKey(openaiClient.apiKey);
      const model = new OpenAIChatCompletionsModel(openaiClient, selectedModel.value || 'qwen3.5-plus');
    const agent = new Agent({
      name: 'Assistant',
      instructions: `你是一个智能助手，可以帮助用户完成各种任务。

你可以使用以下工具：
- exec: 执行shell命令
- read_file: 读取文件内容
- write_file: 写入文件
- list_dir: 列出目录内容

当用户需要执行特定操作时，请使用这些工具。
当用户需要执行特定操作时，你也可以使用相关的 Skills。
每个 Skill 都有详细的使用说明和位置信息。
如果需要使用某个 Skill，请告诉用户需要什么条件。${skillsDescription}`,
      model: model,
      tools: agentTools,
      modelSettings: {
        maxTokens: 8192  // 设置最大输出 token 数，避免被截断
      }
    });

    // 创建 AI 消息占位，用于流式更新
    const aiMessageId = Date.now();
    const md = getMarkdown();
    targetTab.messages.push({
      id: aiMessageId,
      content: '',
      nodes: [],
      sender: 'ai',
      timestamp: new Date()
    });

    // 重置自动滚动标志
    shouldAutoScroll.value = true;

    // 构建消息内容（支持多模态）
    let messageContent: any = userInput;

    // 如果有附件，构建多模态消息
    if (attachmentsList.length > 0) {
      const contentParts: any[] = [{ type: 'input_text', text: userInput }];

      // 添加附件信息到文本
      const attachmentInfo = attachmentsList.map(att => {
        if (att.type === 'image') {
          return `【图片: ${att.name}】`;
        } else if (att.type === 'text') {
          return `【文本文件: ${att.name}，路径: ${att.path}】`;
        } else {
          return `【文档文件: ${att.name}，路径: ${att.path}】`;
        }
      }).join('\n');

      // 更新文本内容
      contentParts[0].text = `${userInput}\n\n附件文件：\n${attachmentInfo}`;

      // 处理图片附件
      for (const attachment of attachmentsList) {
        if (attachment.type === 'image') {
          try {
            const base64Data = await readImageAsBase64(attachment.path);
            const mimeType = attachment.extension === 'png' ? 'image/png' : 'image/jpeg';
            contentParts.push({
              type: 'input_image',
              image: `data:${mimeType};base64,${base64Data}`,
              detail: 'auto'
            });
          } catch (error) {
            console.error(`读取图片 ${attachment.name} 失败:`, error);
            contentParts[0].text += `\n[图片 ${attachment.name} 读取失败]`;
          }
        }
      }

      // 使用消息数组格式
      messageContent = [
        {
          role: 'user',
          content: contentParts
        }
      ];
    }

    // 使用流式模式运行 Agent
    const streamResult = await run(agent, messageContent, { stream: true });

    let aiContent = '';
    // 记录工具调用状态
    const toolCalls: { name: string; arguments: string; status: 'pending' | 'running' | 'completed'; output?: string }[] = [];

    // 使用 toStream() 获取原始事件流
    const eventStream = streamResult.toStream() as unknown as ReadableStream<RunStreamEvent>;
    const reader = eventStream.getReader();

    // 更新消息内容，包含工具调用信息
    function updateMessageContent() {
      if (!targetTab) return;
      const aiMessage = targetTab.messages.find(m => m.id === aiMessageId);
      if (!aiMessage) return;

      let fullContent = '';

      // 截断过长的字符串值
      function truncateValue(value: string, maxLength: number = 50): string {
        if (value.length <= maxLength) return value;
        return value.slice(0, maxLength) + '...';
      }

      // 格式化参数，对长字符串进行截断
      function formatArgs(args: Record<string, any>): string {
        const formatted: Record<string, any> = {};
        for (const [key, value] of Object.entries(args)) {
          if (typeof value === 'string') {
            formatted[key] = truncateValue(value);
          } else if (typeof value === 'object' && value !== null) {
            const strValue = JSON.stringify(value);
            formatted[key] = truncateValue(strValue);
          } else {
            formatted[key] = value;
          }
        }
        return JSON.stringify(formatted, null, 2);
      }

      // 添加工具调用信息
      if (toolCalls.length > 0) {
        for (const tool of toolCalls) {
          if (tool.status === 'running') {
            fullContent += `\n> 🔧 **正在调用工具: \`${tool.name}\`**\n`;
          } else if (tool.status === 'completed') {
            fullContent += `\n> ✅ **工具 \`${tool.name}\` 执行完成**\n`;
          }
          // 显示参数（无论是运行中还是已完成）
          if (tool.arguments) {
            fullContent += '> **参数:**\n> ```json\n';
            try {
              const args = JSON.parse(tool.arguments);
              fullContent += `> ${formatArgs(args).split('\n').join('\n> ')}\n`;
            } catch {
              fullContent += `> ${truncateValue(tool.arguments)}\n`;
            }
            fullContent += '> ```\n';
          }
        }
        fullContent += '\n---\n';
      }

      // 添加 AI 回复内容
      fullContent += aiContent;

      aiMessage.content = fullContent;
      aiMessage.nodes = parseMarkdownToStructure(fullContent, md);
    }

    try {
      while (true) {
        // 检查标签页是否还存在
        if (!tabs.value.find(t => t.id === targetTab.id)) {
          // 标签页已被关闭，停止处理
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        // 处理 RunItem 事件（工具调用等）
        if (value.type === 'run_item_stream_event') {
          const item = value.item;
          const eventName = value.name;

          // 处理工具调用开始
          if (eventName === 'tool_called' && item.type === 'tool_call_item') {
            const toolItem = item as any;
            const toolName = toolItem.rawItem?.name || 'unknown';
            const toolArgs = toolItem.rawItem?.arguments || '';

            // 添加到工具调用列表
            const existingTool = toolCalls.find(t => t.name === toolName && t.status === 'pending');
            if (existingTool) {
              existingTool.status = 'running';
              existingTool.arguments = toolArgs;
            } else {
              toolCalls.push({ name: toolName, arguments: toolArgs, status: 'running' });
            }
            updateMessageContent();
            if (activeTabId.value === targetTab.id) {
              scrollToBottom();
            }
          }

          // 处理工具调用输出
          if (eventName === 'tool_output' && item.type === 'tool_call_output_item') {
            const toolItem = item as any;
            const toolName = toolItem.rawItem?.name || 'unknown';
            const output = typeof toolItem.output === 'string' ? toolItem.output : JSON.stringify(toolItem.output);

            // 更新工具调用状态
            const tool = toolCalls.find(t => t.name === toolName && t.status === 'running');
            if (tool) {
              tool.status = 'completed';
              tool.output = output;
            }
            updateMessageContent();
            if (activeTabId.value === targetTab.id) {
              scrollToBottom();
            }
          }
        }

        // 处理原始模型流事件（包含文本增量）
        if (value.type === 'raw_model_stream_event') {
          const rawEvent = value.data;
          // 处理文本增量事件 (output_text_delta)
          if (rawEvent.type === 'output_text_delta' && rawEvent.delta) {
            const textDelta = rawEvent.delta;
            if (textDelta) {
              aiContent += textDelta;
              updateMessageContent();
              // 流式更新时自动滚动（仅当还在当前标签页时）
              if (activeTabId.value === targetTab.id) {
                scrollToBottom();
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 等待流完成，确保获取最终结果
    await streamResult.completed;

    // 获取最终的 AI 内容
    let finalAiContent = aiContent;
    const aiMessage = targetTab.messages.find(m => m.id === aiMessageId);
    if (aiMessage && (!aiMessage.content || aiMessage.content.trim() === '')) {
      const finalOutput = streamResult.finalOutput;
      if (finalOutput && typeof finalOutput === 'string') {
        aiMessage.content = finalOutput;
        aiMessage.nodes = parseMarkdownToStructure(finalOutput, md);
        finalAiContent = finalOutput;
      }
    }

    // 保存 AI 回复到会话
    if (finalAiContent && targetSession) {
      await sessionManager.addMessage(targetSession.chat_id, targetSession.mode, {
        role: 'assistant',
        content: finalAiContent
      });
    }

    // 最终滚动到底部（仅当还在当前标签页时）
    if (activeTabId.value === targetTab.id) {
      scrollToBottom();
    }
  } catch (error) {
    console.error('Agent执行失败:', error);
    const errorMsg = `Agent执行失败: ${error}`;
    targetTab.messages.push({
      id: Date.now(),
      content: errorMsg,
      sender: 'ai',
      timestamp: new Date()
    });
    if (targetSession) {
      await sessionManager.addMessage(targetSession.chat_id, targetSession.mode, {
        role: 'assistant',
        content: errorMsg
      });
    }
  }
}

// 监听AI响应事件
let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  // 不初始化默认标签页，从空状态开始
  tabs.value = [];
  activeTabId.value = '';

  try {
    const config = await invoke<AppConfig>("get_api_config");
    // 保存配置到响应式变量
    appConfig.value = config;
    // 获取默认渠道的配置
    const defaultChannel = config.channels[0];
    if (defaultChannel) {
      openaiClient = new OpenAI({
        baseURL: defaultChannel.base_url,
        apiKey: defaultChannel.api_key,
        dangerouslyAllowBrowser: true
      });
    }
    await loadSkills();

    // 加载会话列表
    await loadConversationList();
  } catch (error) {
    console.error("配置初始化失败:", error);
  }

  unlisten = await listen("ai_response", (event) => {
    const response = event.payload as string;
    messages.value.push({
      id: Date.now(),
      content: response,
      sender: 'ai',
      timestamp: new Date()
    });
  });
});

onUnmounted(() => {
  if (unlisten) unlisten();
});

// 快捷键发送消息
function handleKeyPress(event: KeyboardEvent) {
  // 检查是否正在使用输入法（composition 状态）
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// 复制消息
function copyMessage(content: string) {
  navigator.clipboard.writeText(content);
}

// 重新生成
function regenerateMessage() {
  // 重新生成最后一条AI消息
}
</script>

<template>
  <n-config-provider :theme="lightTheme">
    <n-message-provider>
      <n-layout has-sider class="app-container">
      <!-- 左侧边栏 -->
      <n-layout-sider
        bordered
        collapse-mode="width"
        :collapsed-width="0"
        :width="280"
        :collapsed="collapsed"
        show-trigger
        @collapse="collapsed = true"
        @expand="collapsed = false"
        class="sidebar"
      >
        <div class="sidebar-content">
          <!-- Logo 区域 -->
          <div class="logo-area">
            <div class="logo-icon">
              <n-icon size="24"><SparklesOutline /></n-icon>
            </div>
            <span class="logo-text">Nova</span>
          </div>

          <!-- 新对话按钮 -->
          <n-button
            class="new-chat-btn"
            dashed
            block
            @click="createNewConversation"
          >
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            新建对话
          </n-button>

          <!-- Chat/Agent 切换 -->
          <div class="mode-switch">
            <n-button
              :class="['mode-btn', { 'mode-btn-active': currentMode === 'chat' }]"
              @click="switchMode('chat')"
            >
              <template #icon>
                <n-icon><ChatbubbleOutline /></n-icon>
              </template>
              Chat
            </n-button>
            <n-button
              :class="['mode-btn', { 'mode-btn-active': currentMode === 'agent' }]"
              @click="switchMode('agent')"
            >
              <template #icon>
                <n-icon><SparklesOutline /></n-icon>
              </template>
              Agent
            </n-button>
          </div>

          <n-divider style="margin: 16px 0;" />

          <!-- 置顶对话 -->
          <div v-if="pinnedConversations.length > 0" class="section">
            <div class="section-title">
              <n-icon><PinOutline /></n-icon>
              <span>置顶</span>
            </div>
            <div class="conversation-list">
              <div
                v-for="conv in pinnedConversations"
                :key="conv.chat_id"
                :class="['conversation-item', { active: currentConversation.chat_id === conv.chat_id }]"
                @click="selectConversation(conv)"
              >
                <n-icon><ChatbubbleOutline /></n-icon>
                <span class="conv-title">{{ conv.title }}</span>
              </div>
            </div>
          </div>

          <!-- 今天 -->
          <div v-if="todayConversations.length > 0" class="section">
            <div class="section-title">
              <n-icon><TimeOutline /></n-icon>
              <span>今天</span>
            </div>
            <div class="conversation-list">
              <div
                v-for="conv in todayConversations"
                :key="conv.chat_id"
                :class="['conversation-item', { active: currentConversation.chat_id === conv.chat_id }]"
                @click="selectConversation(conv)"
              >
                <n-icon><ChatbubbleOutline /></n-icon>
                <span class="conv-title">{{ conv.title }}</span>
                <n-button
                  text
                  size="tiny"
                  class="delete-btn"
                  @click.stop="deleteConversation(conv, $event)"
                >
                  <template #icon>
                    <n-icon><TrashOutline /></n-icon>
                  </template>
                </n-button>
              </div>
            </div>
          </div>

          <!-- 历史 -->
          <div v-if="historyConversations.length > 0" class="section">
            <div class="section-title">
              <n-icon><TimeOutline /></n-icon>
              <span>历史记录</span>
            </div>
            <div class="conversation-list">
              <div
                v-for="conv in historyConversations"
                :key="conv.chat_id"
                :class="['conversation-item', { active: currentConversation.chat_id === conv.chat_id }]"
                @click="selectConversation(conv)"
              >
                <n-icon><ChatbubbleOutline /></n-icon>
                <span class="conv-title">{{ conv.title }}</span>
                <n-button
                  text
                  size="tiny"
                  class="delete-btn"
                  @click.stop="deleteConversation(conv, $event)"
                >
                  <template #icon>
                    <n-icon><TrashOutline /></n-icon>
                  </template>
                </n-button>
              </div>
            </div>
          </div>

          <!-- 底部设置 -->
          <div class="sidebar-footer">
            <n-divider style="margin: 12px 0;" />
            <n-button text class="settings-btn" @click="openSettings">
              <template #icon>
                <n-icon><SettingsOutline /></n-icon>
              </template>
              设置
            </n-button>
          </div>
        </div>
      </n-layout-sider>

      <!-- 主内容区 -->
      <n-layout class="main-layout">
        <!-- 设置页面（替换整个内容区） -->
        <template v-if="showSettings">
          <n-layout-content class="settings-page">
            <div class="settings-wrapper">
              <!-- 页面头部 -->
              <div class="settings-header">
                <n-button text @click="closeSettings" class="back-btn">
                  <template #icon>
                    <n-icon size="18"><ChevronDownOutline style="transform: rotate(90deg)" /></n-icon>
                  </template>
                  返回对话
                </n-button>
                <div class="header-info">
                  <h1>设置</h1>
                  <p>管理您的 AI 供应商和模型配置</p>
                </div>
              </div>

              <div class="settings-body">
                <!-- 渠道管理卡片 -->
                <div class="settings-card">
                  <div class="card-header">
                    <div class="card-title">
                      <div class="title-icon">
                        <n-icon size="20"><SparklesOutline /></n-icon>
                      </div>
                      <div>
                        <h3>渠道管理</h3>
                        <p>配置 AI 供应商连接信息</p>
                      </div>
                    </div>
                    <n-button type="primary" @click="addChannel" class="add-channel-btn">
                      <template #icon>
                        <n-icon><AddOutline /></n-icon>
                      </template>
                      添加渠道
                    </n-button>
                  </div>

                  <!-- 渠道列表 -->
                  <div class="channel-list">
                    <div
                      v-for="channel in appConfig.channels"
                      :key="channel.id"
                      class="channel-card"
                    >
                      <div class="channel-main">
                        <div class="channel-icon">
                          <n-icon size="24"><SparklesOutline /></n-icon>
                        </div>
                        <div class="channel-details">
                          <div class="channel-name">{{ channel.name }}</div>
                          <div class="channel-url">{{ channel.base_url }}</div>
                          <div class="channel-models">
                            <span
                              v-for="(model, idx) in channel.models.slice(0, 3)"
                              :key="idx"
                              class="model-chip"
                            >
                              {{ model }}
                            </span>
                            <span v-if="channel.models.length > 3" class="model-chip more">
                              +{{ channel.models.length - 3 }}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div class="channel-actions">
                        <n-button quaternary size="small" @click="editChannel(channel)">
                          <template #icon>
                            <n-icon><SettingsOutline /></n-icon>
                          </template>
                        </n-button>
                        <n-button quaternary size="small" type="error" @click="deleteChannel(channel.id)">
                          <template #icon>
                            <n-icon><TrashOutline /></n-icon>
                          </template>
                        </n-button>
                      </div>
                    </div>

                    <div v-if="appConfig.channels.length === 0" class="empty-state">
                      <div class="empty-icon">
                        <n-icon size="48" color="#CBD5E1"><SparklesOutline /></n-icon>
                      </div>
                      <p>暂无渠道配置</p>
                      <span>点击上方按钮添加您的第一个 AI 供应商</span>
                    </div>
                  </div>
                </div>

                <!-- 默认渠道卡片 -->
                <div class="settings-card">
                  <div class="card-header">
                    <div class="card-title">
                      <div class="title-icon green">
                        <n-icon size="20"><ChatbubbleOutline /></n-icon>
                      </div>
                      <div>
                        <h3>默认渠道</h3>
                        <p>为不同模式设置默认使用的渠道</p>
                      </div>
                    </div>
                  </div>

                  <div class="default-settings">
                    <div class="setting-item">
                      <div class="setting-info">
                        <span class="setting-label">Chat 模式</span>
                        <span class="setting-desc">智能对话、深度思考</span>
                      </div>
                      <n-select
                        v-model:value="appConfig.chat_channel_id"
                        :options="appConfig.channels.map(c => ({ label: c.name, value: c.id }))"
                        placeholder="选择渠道"
                        class="model-select"
                        style="width: 200px"
                        @update:value="saveAppConfig"
                      />
                    </div>
                    <div class="setting-item">
                      <div class="setting-info">
                        <span class="setting-label">Agent 模式</span>
                        <span class="setting-desc">工具调用、文件处理</span>
                      </div>
                      <n-select
                        v-model:value="appConfig.agent_channel_id"
                        :options="appConfig.channels.map(c => ({ label: c.name, value: c.id }))"
                        placeholder="选择渠道"
                        class="model-select"
                        style="width: 200px"
                        @update:value="saveAppConfig"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </n-layout-content>
        </template>

        <!-- 聊天页面 -->
        <template v-else>
          <!-- 标签页栏（仅在有标签页时显示） -->
          <div v-if="tabs.length > 0" class="tab-bar">
            <div class="tab-list">
              <div
                v-for="tab in tabs"
                :key="tab.id"
                :class="['tab-item', { active: activeTabId === tab.id }]"
                @click="switchToTab(tab.id)"
              >
                <n-icon size="14" class="tab-icon">
                  <ChatbubbleOutline v-if="tab.mode === 'chat'" />
                  <SparklesOutline v-else />
                </n-icon>
                <span class="tab-title">{{ tab.title }}</span>
                <n-button
                  text
                  size="tiny"
                  class="tab-close"
                  @click="closeTab(tab.id, $event)"
                >
                  <template #icon>
                    <n-icon size="12"><CloseOutline /></n-icon>
                  </template>
                </n-button>
              </div>
            </div>
          </div>

          <!-- 顶部标题栏 -->
          <n-layout-header bordered class="header">
            <div class="header-content">
              <div class="header-left">
                <n-button v-if="collapsed" text @click="collapsed = false" class="menu-toggle">
                  <template #icon>
                    <n-icon><MenuOutline /></n-icon>
                  </template>
                </n-button>
                <span class="conversation-title">{{ currentTab?.title || '新对话' }}</span>
                <n-button text size="small" class="title-dropdown">
                  <template #icon>
                    <n-icon><ChevronDownOutline /></n-icon>
                  </template>
                </n-button>
              </div>
              <div class="header-right">
                <n-space :size="4">
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button text>
                        <template #icon>
                          <n-icon><SearchOutline /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    搜索对话
                  </n-tooltip>
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button text>
                        <template #icon>
                          <n-icon><CopyOutline /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    复制对话
                  </n-tooltip>
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button text>
                        <template #icon>
                          <n-icon><TrashOutline /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    删除对话
                  </n-tooltip>
                </n-space>
              </div>
            </div>
          </n-layout-header>

          <!-- 聊天内容区 -->
          <n-layout-content ref="chatContentRef" class="chat-content" @scroll="handleScroll">
            <!-- 首页欢迎界面（无标签页时显示） -->
            <div v-if="tabs.length === 0" class="home-welcome">
              <div class="welcome-content">
                <n-icon size="64" color="#2563EB" class="welcome-icon">
                  <SparklesOutline />
                </n-icon>
                <h1 class="welcome-title">欢迎使用 Nova</h1>
                <p class="welcome-subtitle">选择模式后，直接在下方输入内容开始对话</p>
                <div class="welcome-modes">
                  <div
                    :class="['mode-card', { active: currentMode === 'chat' }]"
                    @click="switchMode('chat')"
                  >
                    <n-icon size="24" color="#2563EB"><ChatbubbleOutline /></n-icon>
                    <span>Chat 模式</span>
                    <p>智能对话，深度思考</p>
                  </div>
                  <div
                    :class="['mode-card', { active: currentMode === 'agent' }]"
                    @click="switchMode('agent')"
                  >
                    <n-icon size="24" color="#2563EB"><SparklesOutline /></n-icon>
                    <span>Agent 模式</span>
                    <p>工具调用，文件处理</p>
                  </div>
                </div>
              </div>
            </div>

            <div v-else class="messages-wrapper">
              <div
                v-for="message in messages"
                :key="message.id"
                :class="['message-row', message.sender]"
              >
                <!-- 用户头像 -->
                <n-avatar
                  v-if="message.sender === 'user'"
                  round
                  :size="36"
                  class="avatar user-avatar"
                  :style="{ background: 'linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)' }"
                >
                  U
              </n-avatar>

              <!-- AI头像 -->
              <n-avatar
                v-else
                round
                :size="36"
                class="avatar ai-avatar"
              >
                <n-icon size="20"><SparklesOutline /></n-icon>
              </n-avatar>

              <!-- 消息内容 -->
              <div class="message-body">
                <div class="message-header">
                  <span class="sender-name">{{ message.sender === 'user' ? '用户' : 'Nova' }}</span>
                  <span class="message-time">{{ message.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</span>
                </div>
                <div class="message-text">
                  <div class="message-text-content">
                  <!-- 深度思考内容（可折叠） -->
                  <template v-if="message.reasoningContent">
                    <div class="reasoning-section">
                      <div
                        class="reasoning-header"
                        @click="message.showReasoning = !message.showReasoning"
                      >
                        <n-icon size="14" class="reasoning-icon">
                          <SparklesOutline />
                        </n-icon>
                        <span>深度思考</span>
                        <n-icon size="12" class="reasoning-toggle" :class="{ 'is-open': message.showReasoning }">
                          <ChevronDownOutline />
                        </n-icon>
                      </div>
                      <div v-show="message.showReasoning" class="reasoning-content">
                        {{ message.reasoningContent }}
                      </div>
                    </div>
                  </template>

                  <template v-if="message.content">
                    <MarkdownRender
                      :custom-id="'msg-' + message.id"
                      :content="message.content"
                      :nodes="message.nodes"
                    />
                  </template>
                  <template v-else-if="isLoading && message.sender === 'ai' && message.id === messages[messages.length - 1]?.id">
                    <div class="thinking-indicator">
                      <div class="thinking-spinner"></div>
                      <span>思考中...</span>
                      <span class="dot"></span>
                      <span class="dot"></span>
                      <span class="dot"></span>
                    </div>
                  </template>
                  </div>
                </div>

                <!-- AI消息操作按钮 -->
                <div v-if="message.sender === 'ai'" class="message-actions">
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button text size="tiny" @click="copyMessage(message.content)">
                        <template #icon>
                          <n-icon><CopyOutline /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    复制
                  </n-tooltip>
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button text size="tiny" @click="regenerateMessage">
                        <template #icon>
                          <n-icon><RefreshOutline /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    重新生成
                  </n-tooltip>
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button text size="tiny">
                        <template #icon>
                          <n-icon><TrashOutline /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    删除
                  </n-tooltip>
                </div>
              </div>
            </div>

          </div>

          <!-- 回到底部按钮 -->
          <Transition name="fade">
            <button
              v-if="showScrollToBottom"
              class="scroll-to-bottom-btn"
              @click="goTobottom"
            >
              <n-icon size="18"><ArrowDownOutline /></n-icon>
            </button>
          </Transition>
        </n-layout-content>

        <!-- 底部输入区 -->
        <n-layout-footer bordered class="footer">
          <div class="input-wrapper-outer">
            <div class="input-container">
              <!-- 附件列表 -->
              <div v-if="attachments.length > 0" class="attachments-list">
                <div
                  v-for="attachment in attachments"
                  :key="attachment.id"
                  class="attachment-item"
                >
                  <n-icon size="16" class="attachment-icon">
                    <component :is="getFileIcon(attachment.type)" />
                  </n-icon>
                  <div class="attachment-info">
                    <span class="attachment-name" :title="attachment.name">{{ attachment.name }}</span>
                    <span class="attachment-type">{{ getTypeLabel(attachment.type, attachment.extension) }}</span>
                  </div>
                  <n-button
                    text
                    size="tiny"
                    class="attachment-remove"
                    @click="removeAttachment(attachment.id)"
                  >
                    <template #icon>
                      <n-icon size="14"><CloseOutline /></n-icon>
                    </template>
                  </n-button>
                </div>
              </div>

              <n-space vertical>
                 <!-- 文本输入区域 -->
                <n-input
                  v-model:value="inputText"
                  type="textarea"
                  :autosize="{ minRows: 3, maxRows: 8 }"
                  placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
                  @keydown="handleKeyPress"
                  :disabled="isLoading"
                  class="message-input"
                />
              </n-space>

              <!-- 底部工具栏 -->
              <div class="input-toolbar">
                <div class="toolbar-left">
                  <!-- 添加附件（仅 Agent 模式） -->
                  <n-tooltip v-if="(currentTab?.mode || currentMode) === 'agent'" trigger="hover">
                    <template #trigger>
                      <n-button text size="small" class="tool-btn" @click="openAttachmentDialog">
                        <template #icon>
                          <n-icon size="18"><LinkOutlined /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    添加附件 ({{ attachments.length }}/{{ MAX_ATTACHMENTS }})
                  </n-tooltip>
                  <n-divider v-if="(currentTab?.mode || currentMode) === 'chat'" vertical style="height: 16px; margin: 0 4px;" />
                  <!-- 深度思考开关（仅 Chat 模式） -->
                  <n-tooltip v-if="(currentTab?.mode || currentMode) === 'chat'" trigger="hover">
                    <template #trigger>
                      <n-button
                        text
                        size="small"
                        :class="['thinking-toggle-btn', { 'is-active': enableThinking }]"
                        @click="enableThinking = !enableThinking"
                      >
                        <template #icon>
                          <n-icon size="16"><BulbOutline /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    {{ enableThinking ? '已开启深度思考' : '点击开启深度思考' }}
                  </n-tooltip>
                  <n-divider vertical style="height: 16px; margin: 0 4px;" />
                  <!-- 模型选择下拉框 -->
                  <n-select
                    v-model:value="selectedModel"
                    :options="availableModels.map(m => ({ label: m, value: m }))"
                    size="small"
                    class="model-select"
                    style="width: 180px"
                    placeholder="选择模型"
                    :disabled="availableModels.length === 0"
                  />
                </div>
                <div class="toolbar-right">
                  <n-button
                    text
                    class="send-btn-inline"
                    :disabled="!inputText.trim() || isLoading"
                    @click="sendMessage"
                  >
                    <template #icon>
                      <n-icon size="20"><PaperPlaneOutline /></n-icon>
                    </template>
                  </n-button>
                </div>
              </div>
            </div>
          </div>
        </n-layout-footer>
        </template>
      </n-layout>

      <!-- 渠道编辑弹窗 -->
      <n-modal
        v-model:show="showChannelModal"
        :title="isAddingChannel ? '添加渠道' : '编辑渠道'"
        preset="card"
        style="width: 500px"
        :mask-closable="false"
      >
        <div v-if="editingChannel" class="channel-form">
          <n-form label-placement="left" label-width="100">
            <n-form-item label="渠道名称">
              <n-input v-model:value="editingChannel.name" placeholder="例如：OpenAI" />
            </n-form-item>
            <n-form-item label="Base URL">
              <n-input v-model:value="editingChannel.base_url" placeholder="https://api.openai.com/v1" />
            </n-form-item>
            <n-form-item label="API Key">
              <n-input
                v-model:value="editingChannel.api_key"
                type="password"
                placeholder="sk-..."
                show-password-on="click"
              />
            </n-form-item>
            <n-form-item label="模型列表">
              <div class="models-input">
                <n-tag
                  v-for="(model, index) in editingChannel.models"
                  :key="index"
                  closable
                  @close="removeModelFromChannel(index)"
                  class="model-tag"
                >
                  {{ model }}
                </n-tag>
                <n-input-group>
                  <n-input
                    v-model:value="newModelInput"
                    placeholder="输入模型名称"
                    @keyup.enter="addModelToChannel"
                  />
                  <n-button @click="addModelToChannel">添加</n-button>
                </n-input-group>
              </div>
            </n-form-item>
          </n-form>
        </div>
        <template #footer>
          <n-space justify="end">
            <n-button @click="editingChannel = null">取消</n-button>
            <n-button type="primary" @click="saveChannel">保存</n-button>
          </n-space>
        </template>
      </n-modal>
    </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
/* ============================================
   Nova - Modern Glassmorphism Design
   ============================================ */

/* CSS Variables - Design Tokens */
:root {
  --primary: #2563EB;
  --primary-light: #3B82F6;
  --primary-dark: #1D4ED8;
  --accent: #059669;
  --accent-light: #10B981;

  --bg-base: #F8FAFC;
  --bg-elevated: #FFFFFF;
  --bg-glass: rgba(255, 255, 255, 0.7);

  --text-primary: #0F172A;
  --text-secondary: #475569;
  --text-muted: #94A3B8;

  --border-light: #E2E8F0;
  --border-glass: rgba(255, 255, 255, 0.3);

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -1px rgba(0, 0, 0, 0.04);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -2px rgba(0, 0, 0, 0.04);
  --shadow-glow: 0 0 20px rgba(37, 99, 235, 0.15);

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 20px;

  --transition-fast: 150ms ease;
  --transition-normal: 200ms ease;
  --transition-slow: 300ms cubic-bezier(0.16, 1, 0.3, 1);
}

.app-container {
  height: 100vh;
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* ============================================
   设置面板样式
   ============================================ */
.settings-page {
  height: 100%;
  overflow-y: auto;
  background: linear-gradient(180deg, #F8FAFC 0%, #F1F5F9 100%);
}

.settings-wrapper {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px;
}

.settings-header {
  margin-bottom: 24px;
}

.settings-header .back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #64748B;
  font-size: 14px;
  padding: 8px 12px;
  margin-left: -12px;
  border-radius: 8px;
  transition: all 0.2s;
}

.settings-header .back-btn:hover {
  background: #F1F5F9;
  color: #2563EB;
}

.settings-header .header-info {
  margin-top: 16px;
}

.settings-header .header-info h1 {
  font-size: 24px;
  font-weight: 700;
  color: #0F172A;
  margin-bottom: 4px;
}

.settings-header .header-info p {
  font-size: 14px;
  color: #64748B;
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-card {
  background: #FFFFFF;
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
}

.card-title {
  display: flex;
  gap: 12px;
}

.title-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #4F46E5;
}

.title-icon.green {
  background: linear-gradient(135deg, #ECFDF5 0%, #D1FAE5 100%);
  color: #059669;
}

.card-title h3 {
  font-size: 16px;
  font-weight: 600;
  color: #0F172A;
  margin-bottom: 2px;
}

.card-title p {
  font-size: 13px;
  color: #64748B;
}

.add-channel-btn {
  border-radius: 8px;
}

.channel-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.channel-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: #FAFBFC;
  border: 1px solid #E2E8F0;
  border-radius: 12px;
  transition: all 0.2s;
}

.channel-card:hover {
  border-color: #CBD5E1;
  background: #FFFFFF;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.channel-main {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
}

.channel-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #4F46E5;
}

.channel-details {
  flex: 1;
}

.channel-name {
  font-size: 15px;
  font-weight: 600;
  color: #0F172A;
  margin-bottom: 2px;
}

.channel-url {
  font-size: 12px;
  color: #94A3B8;
  font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  margin-bottom: 8px;
}

.channel-models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.model-chip {
  display: inline-flex;
  padding: 2px 8px;
  background: #F1F5F9;
  border-radius: 4px;
  font-size: 11px;
  color: #475569;
  font-weight: 500;
}

.model-chip.more {
  background: #EEF2FF;
  color: #4F46E5;
}

.channel-actions {
  display: flex;
  gap: 4px;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  border: 2px dashed #E2E8F0;
  border-radius: 12px;
  background: #FAFBFC;
}

.empty-state .empty-icon {
  margin-bottom: 12px;
}

.empty-state p {
  font-size: 15px;
  font-weight: 500;
  color: #475569;
  margin-bottom: 4px;
}

.empty-state span {
  font-size: 13px;
  color: #94A3B8;
}

.default-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: #FAFBFC;
  border-radius: 10px;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.setting-label {
  font-size: 14px;
  font-weight: 500;
  color: #0F172A;
}

.setting-desc {
  font-size: 12px;
  color: #94A3B8;
}

.channel-form {
  padding: 16px 0;
}

.models-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.models-input .model-tag {
  margin-right: 8px;
  margin-bottom: 8px;
}

/* ============================================
   侧边栏样式 - Glassmorphism
   ============================================ */
.sidebar {
  background: linear-gradient(180deg, #E8ECF2 0%, #D1D9E6 100%);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-right: 1px solid #CBD5E1 !important;
}

.sidebar-content {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px;
}

/* Logo 区域 */
.logo-area {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  margin-bottom: 16px;
}

.logo-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #2563EB 0%, #3B82F6 100%);
  border-radius: 12px;
  color: #fff;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 0 20px rgba(37, 99, 235, 0.15);
}

.logo-icon .n-icon {
  color: #fff !important;
}

.logo-text {
  font-size: 16px;
  font-weight: 700;
  color: #0F172A;
  letter-spacing: -0.02em;
}

.new-chat-btn {
  margin-bottom: 16px;
  height: 44px;
  border-radius: 12px;
  font-weight: 500;
  font-size: 14px;
  transition: all var(--transition-normal);
  border: 1.5px dashed #CBD5E1;
  background: #FFFFFF;
  color: #475569 !important;
}

.new-chat-btn:hover {
  border-color: #2563EB !important;
  color: #2563EB !important;
  background: #EFF6FF;
  transform: translateY(-1px);
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
}

/* 模式切换 */
.mode-switch {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  padding: 4px;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 12px;
  border: 1px solid #CBD5E1;
}

.mode-btn {
  flex: 1;
  height: 38px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 13px;
  transition: all var(--transition-normal);
  border: none;
  background: transparent;
  color: #475569 !important;
}

.mode-btn:hover {
  background: rgba(255, 255, 255, 0.9);
  color: #1E293B !important;
}

.mode-btn-active {
  background: #FFFFFF !important;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  color: #2563EB !important;
  border: none !important;
}

.mode-btn :deep(.n-button__border),
.mode-btn :deep(.n-button__state-border) {
  border: none !important;
}

.mode-btn-active :deep(.n-button__border),
.mode-btn-active :deep(.n-button__state-border) {
  border: none !important;
}

/* 模式按钮聚焦样式 - 蓝色主题 */
.mode-btn :deep(.n-button__state-border) {
  box-shadow: none !important;
}

.mode-btn:focus-visible :deep(.n-button__state-border),
.mode-btn:focus :deep(.n-button__state-border) {
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.3) !important;
}

.mode-btn-active:focus-visible :deep(.n-button__state-border),
.mode-btn-active:focus :deep(.n-button__state-border) {
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.3) !important;
}

.section {
  margin-bottom: 12px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #64748B;
  padding: 10px 8px 6px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.conversation-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.conversation-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  cursor: pointer;
  font-size: 13px;
  color: #475569;
  transition: all var(--transition-fast);
  background: transparent;
  position: relative;
}

.conversation-item:hover {
  background: rgba(255, 255, 255, 0.8);
  color: #1E293B;
  transform: translateX(2px);
}

.conversation-item:hover .delete-btn {
  opacity: 1;
  visibility: visible;
}

.conversation-item.active {
  background: #FFFFFF;
  color: var(--primary);
  box-shadow: var(--shadow-sm);
  font-weight: 500;
}

.conversation-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  background: var(--primary);
  border-radius: 0 2px 2px 0;
}

.conv-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.delete-btn {
  opacity: 0;
  visibility: hidden;
  transition: all var(--transition-fast);
  color: #94a3b8;
  padding: 2px;
  margin: -2px;
}

.delete-btn:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 4px;
}

.sidebar-footer {
  margin-top: auto;
}

.settings-btn {
  width: 100%;
  justify-content: flex-start;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 13px;
  color: #475569 !important;
  transition: all var(--transition-fast);
}

.settings-btn:hover {
  background: #FFFFFF !important;
  color: #2563EB !important;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

/* ============================================
   主布局样式
   ============================================ */
.main-layout {
  background: #FFFFFF;
  position: relative;
}

/* 标签页栏样式 */
.tab-bar {
  background: #F8FAFC;
  border-bottom: 1px solid #E2E8F0;
  padding: 8px 16px 0;
  flex-shrink: 0;
}

.tab-list {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab-list::-webkit-scrollbar {
  display: none;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #FFFFFF;
  border: 1px solid #E2E8F0;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  font-size: 13px;
  color: #64748B;
  transition: all var(--transition-fast);
  min-width: 120px;
  max-width: 200px;
  position: relative;
}

.tab-item:hover {
  background: #F1F5F9;
  color: #475569;
}

.tab-item.active {
  background: #FFFFFF;
  color: #1E293B;
  border-color: #CBD5E1;
  border-bottom: 2px solid #2563EB;
  font-weight: 500;
}

.tab-icon {
  flex-shrink: 0;
}

.tab-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close {
  opacity: 0;
  color: #94A3B8 !important;
  padding: 2px !important;
  margin: -2px;
  transition: all var(--transition-fast);
}

.tab-item:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  color: #EF4444 !important;
  background: rgba(239, 68, 68, 0.1) !important;
}

.tab-add {
  color: #64748B !important;
  padding: 6px !important;
  margin-left: 4px;
}

.tab-add:hover {
  color: #2563EB !important;
  background: rgba(37, 99, 235, 0.1) !important;
}

/* 头部样式 */
.header {
  height: 60px;
  padding: 0 24px;
  background: #FFFFFF;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: none !important;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  flex-shrink: 0;
  z-index: 10;
}

.header-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.conversation-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.header-right :deep(.n-button) {
  color: var(--text-muted) !important;
  transition: all var(--transition-fast);
}

.header-right :deep(.n-button:hover) {
  color: var(--text-primary) !important;
  background: rgba(0, 0, 0, 0.04) !important;
}

/* ============================================
   聊天内容区
   ============================================ */
.chat-content {
  background: #FFFFFF;
  position: absolute;
  top: 60px;
  bottom: 140px;
  left: 0;
  right: 0;
  overflow-y: auto;
}

.chat-content::-webkit-scrollbar {
  width: 6px;
}

.chat-content::-webkit-scrollbar-track {
  background: transparent;
}

.chat-content::-webkit-scrollbar-thumb {
  background: var(--border-light);
  border-radius: 3px;
}

.chat-content::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

.messages-wrapper {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px 32px;
  user-select: none;
}

/* 首页欢迎界面 */
.home-welcome {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: 48px;
}

.welcome-content {
  text-align: center;
  max-width: 480px;
}

.welcome-icon {
  margin-bottom: 24px;
}

.welcome-title {
  font-size: 28px;
  font-weight: 600;
  color: #1E293B;
  margin-bottom: 12px;
}

.welcome-subtitle {
  font-size: 16px;
  color: #64748B;
  margin-bottom: 32px;
}

.welcome-modes {
  display: flex;
  gap: 16px;
  justify-content: center;
}

.mode-card {
  flex: 1;
  max-width: 180px;
  padding: 20px 16px;
  background: #F8FAFC;
  border: 2px solid #E2E8F0;
  border-radius: 12px;
  cursor: pointer;
  transition: all var(--transition-fast);
  text-align: center;
}

.mode-card:hover {
  background: #F1F5F9;
  border-color: #CBD5E1;
}

.mode-card.active {
  background: #EFF6FF;
  border-color: #2563EB;
}

.mode-card span {
  display: block;
  margin-top: 12px;
  font-size: 15px;
  font-weight: 600;
  color: #1E293B;
}

.mode-card p {
  margin-top: 6px;
  font-size: 12px;
  color: #94A3B8;
}

/* 回到底部按钮 */
.scroll-to-bottom-btn {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #FFFFFF;
  border: 1px solid #E2E8F0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748B;
  transition: all 0.2s ease;
  z-index: 10;
}

.scroll-to-bottom-btn:hover {
  background: #2563EB;
  border-color: #2563EB;
  color: #FFFFFF;
  transform: translateX(-50%) scale(1.05);
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
}

/* 淡入淡出动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px);
}

/* 深度思考开关按钮 */
.thinking-toggle-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  color: #64748B !important;
  transition: all var(--transition-fast);
}

.thinking-toggle-btn:hover {
  background: rgba(37, 99, 235, 0.08) !important;
  color: #2563EB !important;
}

.thinking-toggle-btn.is-active {
  background: rgba(37, 99, 235, 0.12) !important;
  color: #2563EB !important;
}

.thinking-text {
  font-size: 12px;
  font-weight: 500;
}

/* 深度思考内容展示 */
.reasoning-section {
  margin-bottom: 12px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  background: #F8FAFC;
  overflow: hidden;
}

.reasoning-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: #2563EB;
  transition: background var(--transition-fast);
}

.reasoning-header:hover {
  background: rgba(37, 99, 235, 0.05);
}

.reasoning-icon {
  color: #2563EB;
}

.reasoning-toggle {
  margin-left: auto;
  transition: transform 0.2s ease;
}

.reasoning-toggle.is-open {
  transform: rotate(180deg);
}

.reasoning-content {
  padding: 12px;
  font-size: 13px;
  line-height: 1.6;
  color: #475569;
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px solid #E2E8F0;
  background: #FFFFFF;
}

/* AI 消息行 - 左对齐，充分利用空间 */
.message-row:not(.user) {
  padding-right: 15%;
}

/* 用户消息行 - 右对齐，限制宽度 */
.message-row.user {
  padding-left: 15%;
}

.message-row {
  display: flex;
  gap: 14px;
  margin-bottom: 28px;
  animation: messageSlideIn 0.3s var(--transition-slow);
}

@keyframes messageSlideIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message-row.user {
  flex-direction: row-reverse;
}

.message-row.user .message-body {
  align-items: flex-end;
}

.avatar {
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
  user-select: none;
}

.ai-avatar {
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
  color: #fff;
  box-shadow: var(--shadow-glow);
}

.message-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  max-width: 100%;
  min-width: 0;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
  user-select: none;
}

.message-row.user .message-header {
  justify-content: flex-end;
}

.sender-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.message-time {
  font-size: 11px;
  color: var(--text-muted);
}

.message-text {
  font-size: 14px;
  line-height: 1.65;
  color: #1E293B;
  background: #FFFFFF;
  border-radius: 16px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  border: 1px solid #E2E8F0;
  transition: border-color var(--transition-fast);
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
}

/* 内容包装器 - 承载 padding 和可选择 */
.message-text-content {
  padding: 16px 20px;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.message-text :deep(*) {
  margin: 0;
}

.message-text :deep(p) {
  margin-bottom: 8px;
  margin-top: 0;
}

.message-text :deep(p:first-child) {
  margin-top: 0;
}

.message-text :deep(p:last-child) {
  margin-bottom: 0;
}

/* 覆盖 markstream-vue 的默认 margin */
.message-text :deep(.markdown-renderer) {
  margin: 0 !important;
}

.message-text :deep(.paragraph-node) {
  margin: 0 0 8px 0 !important;
}

.message-text :deep(.paragraph-node:last-child) {
  margin-bottom: 0 !important;
}

.message-text :deep(h1),
.message-text :deep(h2),
.message-text :deep(h3),
.message-text :deep(h4) {
  margin-top: 16px;
  margin-bottom: 12px;
}

.message-text :deep(ul),
.message-text :deep(ol) {
  margin-bottom: 12px;
  padding-left: 24px;
}

.message-text :deep(li) {
  margin-bottom: 6px;
}

.message-text :deep(pre) {
  margin: 12px 0;
  border-radius: 8px;
}

.message-text :deep(blockquote) {
  margin: 12px 0;
  padding-left: 16px;
  border-left: 3px solid #E2E8F0;
}

.message-text:hover {
  border-color: #CBD5E1;
}

.message-row.user .message-text {
  background: linear-gradient(135deg, #2563EB 0%, #3B82F6 100%);
  color: #ffffff;
  border: none;
  border-radius: 16px;
}

.message-row.user .message-text-content {
  user-select: text;
  -webkit-user-select: text;
}

.message-row.user .message-text:hover {
  background: linear-gradient(135deg, #1D4ED8 0%, #2563EB 100%);
}

.message-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  opacity: 0;
  transition: opacity var(--transition-fast);
  user-select: none;
}

.message-row:hover .message-actions {
  opacity: 1;
}

.message-actions :deep(.n-button) {
  color: var(--text-muted) !important;
}

.message-actions :deep(.n-button:hover) {
  color: var(--primary) !important;
  background: rgba(37, 99, 235, 0.08) !important;
}

/* ============================================
   底部输入区
   ============================================ */
.footer {
  background: #FFFFFF;
  padding: 16px 24px 24px 24px;
  border-top: none !important;
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
}

.input-wrapper-outer {
  max-width: 800px;
  margin: 0 auto;
}

.input-container {
  display: flex;
  flex-direction: column;
  background: #FFFFFF;
  border-radius: 16px;
  padding: 16px 16px 8px 16px;
  border: 1px solid #E2E8F0;
  transition: all var(--transition-normal);
}

.input-container:focus-within {
  border-color: #CBD5E1;
}

/* 附件列表样式 */
.attachments-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #E2E8F0;
}

.attachment-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #F8FAFC;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 13px;
  transition: all var(--transition-fast);
}

.attachment-item:hover {
  background: #F1F5F9;
  border-color: #CBD5E1;
}

.attachment-icon {
  color: #64748B;
  flex-shrink: 0;
}

.attachment-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.attachment-name {
  color: #1E293B;
  font-weight: 500;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-type {
  font-size: 11px;
  color: #94A3B8;
  font-weight: 400;
}

.attachment-remove {
  color: #94A3B8 !important;
  flex-shrink: 0;
  padding: 2px;
  border-radius: 4px;
  transition: all var(--transition-fast);
}

.attachment-remove:hover {
  color: #EF4444 !important;
  background: rgba(239, 68, 68, 0.1);
}

/* 输入框去除边框 */
.message-input :deep(.n-input__border),
.message-input :deep(.n-input__state-border) {
  border: none !important;
  box-shadow: none !important;
}

.message-input :deep(.n-input:focus-within .n-input__border),
.message-input :deep(.n-input:focus-within .n-input__state-border) {
  border: none !important;
  box-shadow: none !important;
}

/* 底部工具栏 */
.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 4px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* 修复 n-upload 组件间距问题 */
.toolbar-left :deep(.n-upload) {
  display: inline-flex;
  width: auto !important;
}

.toolbar-left :deep(.n-upload .n-upload-trigger) {
  display: inline-flex;
  width: auto !important;
}

.toolbar-left :deep(.n-upload .n-button) {
  margin: 0 !important;
}

.toolbar-right {
  display: flex;
  align-items: center;
}

.tool-btn {
  color: #64748B !important;
  transition: all var(--transition-fast);
  padding: 6px;
  border-radius: 8px;
}

.tool-btn:hover {
  color: #2563EB !important;
  background: rgba(37, 99, 235, 0.08) !important;
}

/* 内联模型选择器 */
.model-selector-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #374151;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all var(--transition-fast);
}

.model-selector-inline:hover {
  background: #F3F4F6;
}

/* 模型选择器样式 */
.model-select {
  --n-border: none !important;
  --n-border-hover: none !important;
  --n-border-focus: none !important;
  --n-border-active: none !important;
  --n-box-shadow-focus: none !important;
}

.model-select :deep(.n-base-selection) {
  background-color: transparent !important;
  border: none !important;
  box-shadow: none !important;
  outline: none !important;
}

.model-select :deep(.n-base-selection__border),
.model-select :deep(.n-base-selection__state-border) {
  border: none !important;
}

.model-select :deep(.n-base-selection:hover) {
  background-color: transparent !important;
}

.model-select :deep(.n-base-selection--active),
.model-select :deep(.n-base-selection--focused) {
  background-color: transparent !important;
  box-shadow: none !important;
  border: none !important;
}

.model-select :deep(.n-base-selection-input) {
  background-color: transparent !important;
}

.model-select :deep(.n-base-selection-label) {
  background-color: transparent !important;
}

/* 发送按钮 */
.send-btn-inline {
  color: #2563EB !important;
  padding: 6px;
  border-radius: 8px;
  transition: all var(--transition-fast);
}

.send-btn-inline:hover:not(:disabled) {
  background: rgba(37, 99, 235, 0.1) !important;
}

.send-btn-inline:disabled {
  color: #94A3B8 !important;
  opacity: 0.5;
  cursor: not-allowed;
}

/* ============================================
   加载状态
   ============================================ */
.loading .message-body {
  align-items: flex-start;
}

.loading .ai-avatar {
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

/* 打字指示器 */
.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 12px 16px;
  background: var(--bg-elevated);
  border-radius: var(--radius-lg);
  border-bottom-left-radius: 4px;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-light);
}

.typing-indicator span {
  width: 8px;
  height: 8px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: typingBounce 1.4s ease-in-out infinite;
}

.typing-indicator span:nth-child(1) {
  animation-delay: 0s;
}

.typing-indicator span:nth-child(2) {
  animation-delay: 0.2s;
}

.typing-indicator span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typingBounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-6px);
    opacity: 1;
  }
}

/* 思考中指示器 */
.thinking-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 16px;
  color: var(--text-muted);
  font-size: 14px;
}

.thinking-indicator .dot {
  width: 6px;
  height: 6px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: thinkingBounce 1.4s ease-in-out infinite;
}

.thinking-indicator .dot:nth-child(2) {
  animation-delay: 0s;
}

.thinking-indicator .dot:nth-child(3) {
  animation-delay: 0.2s;
}

.thinking-indicator .dot:nth-child(4) {
  animation-delay: 0.4s;
}

@keyframes thinkingBounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

/* 思考中旋转动画 */
.thinking-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #E2E8F0;
  border-top-color: #2563EB;
  border-radius: 50%;
  animation: thinkingSpin 0.8s linear infinite;
  margin-right: 8px;
}

@keyframes thinkingSpin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

/* 用户头像样式 */
.user-avatar {
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  box-shadow: var(--shadow-sm);
}

/* 菜单切换按钮 */
.menu-toggle {
  color: var(--text-secondary) !important;
}

.menu-toggle:hover {
  color: var(--text-primary) !important;
}

.title-dropdown {
  color: var(--text-muted) !important;
}

.title-dropdown:hover {
  color: var(--text-secondary) !important;
}

/* ============================================
   Naive UI 组件样式覆盖
   ============================================ */
:deep(.n-divider) {
  margin: 12px 0;
  border-color: var(--border-light);
}

:deep(.n-badge) {
  font-size: 10px;
}

:deep(.n-spin) {
  color: var(--primary);
}
</style>

<script lang="ts">
export default {
  components: {
    MarkdownRender
  }
}
</script>
