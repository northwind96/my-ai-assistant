<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import OpenAI from "openai";
import { Agent, run, setDefaultOpenAIKey, OpenAIChatCompletionsModel, type RunStreamEvent } from "@openai/agents";
import { skillsLoader } from "./skills";
import { agentTools } from "./tools";
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
  lightTheme
} from 'naive-ui'
import {
  ChatbubbleOutline,
  SparklesOutline,
  AddOutline,
  SettingsOutline,
  CopyOutline,
  RefreshOutline,
  TrashOutline,
  MicOutline,
  ImageOutline,
  PaperPlaneOutline,
  MenuOutline,
  ChevronDownOutline,
  SearchOutline,
  TimeOutline,
  PinOutline,
  ArrowDownOutline,
  BulbOutline
} from '@vicons/ionicons5'

import {LinkOutlined} from '@vicons/antd'

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

// 对话历史类型
interface Conversation {
  id: string;
  title: string;
  mode: 'chat' | 'agent';
  timestamp: Date;
  pinned?: boolean;
}

// 配置类型
interface ApiConfig {
  base_url: string;
  model: string;
  token: string;
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
const messages = ref<Message[]>([
  { id: 1, content: '你好！我是AI助手，有什么可以帮您的吗？', sender: 'ai', timestamp: new Date() }
]);
const inputText = ref('');
const isLoading = ref(false);
const currentMode = ref<ChatMode>('chat');
const skills = ref<SkillInfo[]>([]);
const collapsed = ref(false);
const currentConversation = ref<Conversation>({
  id: '1',
  title: '你是谁',
  mode: 'chat',
  timestamp: new Date()
});

// 深度思考开关（仅 Chat 模式）
const enableThinking = ref(false);

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

// 对话历史（模拟数据）
const conversations = ref<Conversation[]>([
  { id: '1', title: '你是谁', mode: 'chat', timestamp: new Date(), pinned: false },
  { id: '2', title: '新对话', mode: 'chat', timestamp: new Date(Date.now() - 86400000), pinned: false },
  { id: '3', title: '新对话', mode: 'chat', timestamp: new Date(Date.now() - 86400000 * 2), pinned: false },
  { id: '4', title: '你是谁', mode: 'chat', timestamp: new Date(Date.now() - 86400000 * 3), pinned: false },
]);

// 置顶对话
const pinnedConversations = computed(() => conversations.value.filter(c => c.pinned));
// 今日对话
const todayConversations = computed(() => conversations.value.filter(c => !c.pinned && isToday(c.timestamp)));
// 历史对话
const historyConversations = computed(() => conversations.value.filter(c => !c.pinned && !isToday(c.timestamp)));

function isToday(date: Date) {
  const today = new Date();
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

// 切换模式
function switchMode(mode: ChatMode) {
  currentMode.value = mode;
  messages.value = [
    { 
      id: 1, 
      content: mode === 'chat' 
        ? '你好！我是AI助手，有什么可以帮您的吗？' 
        : '你好！我是Agent助手，可以执行工具和Skills。', 
      sender: 'ai', 
      timestamp: new Date() 
    }
  ];
}

// 创建新对话
function createNewConversation() {
  const newConv: Conversation = {
    id: Date.now().toString(),
    title: '新对话',
    mode: currentMode.value,
    timestamp: new Date()
  };
  conversations.value.unshift(newConv);
  currentConversation.value = newConv;
  messages.value = [
    { id: 1, content: '你好！有什么可以帮您的吗？', sender: 'ai', timestamp: new Date() }
  ];
}

// 选择对话
function selectConversation(conv: Conversation) {
  currentConversation.value = conv;
  // 这里可以加载对应对话的历史消息
}

// 发送消息
async function sendMessage() {
  if (!inputText.value.trim() || !openaiClient) return;
  
  const userMessage: Message = {
    id: Date.now(),
    content: inputText.value,
    sender: 'user',
    timestamp: new Date()
  };
  
  messages.value.push(userMessage);
  const userInput = inputText.value;
  inputText.value = '';
  isLoading.value = true;
  
  try {
    if (currentMode.value === 'chat') {
      await chatMode(userInput);
    } else {
      await agentMode(userInput);
    }
  } catch (error) {
    console.error('请求失败:', error);
    messages.value.push({
      id: Date.now(),
      content: '抱歉，服务暂时不可用，请稍后重试。',
      sender: 'ai',
      timestamp: new Date()
    });
  } finally {
    isLoading.value = false;
  }
}

// Chat模式
async function chatMode(userInput: string) {
  if (!openaiClient) return;

  // 构建请求参数
  const requestParams: any = {
    model: 'qwen3.5-plus',
    messages: [{ role: 'user', content: userInput }],
    stream: true,
    enable_thinking: enableThinking.value,
    max_tokens: 8192  // 设置最大输出 token 数
  };

  const stream = await openaiClient.chat.completions.create(requestParams) as any;

  // 创建 AI 消息占位，用于流式更新
  const aiMessageId = Date.now();
  const md = getMarkdown();
  messages.value.push({
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
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    // 收集思考内容
    if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
      reasoningContent += delta.reasoning_content;
      const aiMessage = messages.value.find(m => m.id === aiMessageId);
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
      const aiMessage = messages.value.find(m => m.id === aiMessageId);
      if (aiMessage) {
        aiMessage.content = aiContent;
        aiMessage.nodes = parseMarkdownToStructure(aiContent, md);
      }
      // 流式更新时自动滚动
      scrollToBottom();
    }
  }
}

// Agent模式
async function agentMode(userInput: string) {
  if (!openaiClient) return;

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
    const model = new OpenAIChatCompletionsModel(openaiClient, 'qwen3.5-plus');
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
    messages.value.push({
      id: aiMessageId,
      content: '',
      nodes: [],
      sender: 'ai',
      timestamp: new Date()
    });

    // 重置自动滚动标志
    shouldAutoScroll.value = true;

    // 使用流式模式运行 Agent
    const streamResult = await run(agent, userInput, { stream: true });

    let aiContent = '';
    // 记录工具调用状态
    const toolCalls: { name: string; arguments: string; status: 'pending' | 'running' | 'completed'; output?: string }[] = [];

    // 使用 toStream() 获取原始事件流
    const eventStream = streamResult.toStream() as unknown as ReadableStream<RunStreamEvent>;
    const reader = eventStream.getReader();

    // 更新消息内容，包含工具调用信息
    function updateMessageContent() {
      const aiMessage = messages.value.find(m => m.id === aiMessageId);
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
            scrollToBottom();
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
            scrollToBottom();
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
              // 流式更新时自动滚动
              scrollToBottom();
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 等待流完成，确保获取最终结果
    await streamResult.completed;

    // 如果内容为空，使用 finalOutput 作为后备
    const aiMessage = messages.value.find(m => m.id === aiMessageId);
    if (aiMessage && (!aiMessage.content || aiMessage.content.trim() === '')) {
      const finalOutput = streamResult.finalOutput;
      if (finalOutput && typeof finalOutput === 'string') {
        aiMessage.content = finalOutput;
        aiMessage.nodes = parseMarkdownToStructure(finalOutput, md);
      }
    }
    // 最终滚动到底部
    scrollToBottom();
  } catch (error) {
    console.error('Agent执行失败:', error);
    messages.value.push({
      id: Date.now(),
      content: `Agent执行失败: ${error}`,
      sender: 'ai',
      timestamp: new Date()
    });
  }
}

// 监听AI响应事件
let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  try {
    const config = await invoke<ApiConfig>("get_api_config");
    openaiClient = new OpenAI({
      baseURL: config.base_url,
      apiKey: config.token,
      dangerouslyAllowBrowser: true
    });
    await loadSkills();
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
            <span class="logo-text">AI Assistant</span>
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
                :key="conv.id"
                :class="['conversation-item', { active: currentConversation.id === conv.id }]"
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
                :key="conv.id"
                :class="['conversation-item', { active: currentConversation.id === conv.id }]"
                @click="selectConversation(conv)"
              >
                <n-icon><ChatbubbleOutline /></n-icon>
                <span class="conv-title">{{ conv.title }}</span>
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
                :key="conv.id"
                :class="['conversation-item', { active: currentConversation.id === conv.id }]"
                @click="selectConversation(conv)"
              >
                <n-icon><ChatbubbleOutline /></n-icon>
                <span class="conv-title">{{ conv.title }}</span>
              </div>
            </div>
          </div>

          <!-- 底部设置 -->
          <div class="sidebar-footer">
            <n-divider style="margin: 12px 0;" />
            <n-button text class="settings-btn">
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
        <!-- 顶部标题栏 -->
        <n-layout-header bordered class="header">
          <div class="header-content">
            <div class="header-left">
              <n-button v-if="collapsed" text @click="collapsed = false" class="menu-toggle">
                <template #icon>
                  <n-icon><MenuOutline /></n-icon>
                </template>
              </n-button>
              <span class="conversation-title">{{ currentConversation.title }}</span>
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
          <div class="messages-wrapper">
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
                  <span class="sender-name">{{ message.sender === 'user' ? '用户' : 'AI Assistant' }}</span>
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
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button text size="small" class="tool-btn">
                        <template #icon>
                          <n-icon size="18"><LinkOutlined /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    添加链接
                  </n-tooltip>
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button text size="small" class="tool-btn">
                        <template #icon>
                          <n-icon size="18"><ImageOutline /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    添加图片
                  </n-tooltip>
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button text size="small" class="tool-btn">
                        <template #icon>
                          <n-icon size="18"><MicOutline /></n-icon>
                        </template>
                      </n-button>
                    </template>
                    语音输入
                  </n-tooltip>
                  <n-divider vertical style="height: 16px; margin: 0 4px;" />
                  <!-- 深度思考开关（仅 Chat 模式） -->
                  <n-tooltip v-if="currentMode === 'chat'" trigger="hover">
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
                  <n-divider v-if="currentMode === 'chat'" vertical style="height: 16px; margin: 0 4px;" />
                  <div class="model-selector-inline">
                    <n-icon size="14" color="#2563EB"><SparklesOutline /></n-icon>
                    <span>LongCat-Flash-Chat</span>
                    <n-icon size="12"><ChevronDownOutline /></n-icon>
                  </div>
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
      </n-layout>
    </n-layout>
  </n-config-provider>
</template>

<style scoped>
/* ============================================
   AI Assistant - Modern Glassmorphism Design
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
}

.conversation-item:hover {
  background: rgba(255, 255, 255, 0.8);
  color: #1E293B;
  transform: translateX(2px);
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
