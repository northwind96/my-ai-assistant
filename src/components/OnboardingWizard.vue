<template>
  <div class="onboarding-overlay">
    <div class="onboarding-container">
      <!-- 步骤指示器 -->
      <div class="step-indicator">
        <div
          v-for="step in totalSteps"
          :key="step"
          :class="['step-dot', { active: currentStep >= step, completed: currentStep > step }]"
        />
      </div>

      <!-- 步骤 1: 欢迎页 -->
      <div v-if="currentStep === 1" class="step-content">
        <div class="welcome-icon">👋</div>
        <h1 class="step-title">欢迎使用 Nova</h1>
        <p class="step-description">
          在开始之前，我们需要检查您的环境并进行一些基本配置。
          这个过程只需要几分钟。
        </p>
        <button class="btn-primary" @click="nextStep">
          开始设置
        </button>
      </div>

      <!-- 步骤 2: 环境检查 -->
      <div v-if="currentStep === 2" class="step-content">
        <h1 class="step-title">环境检查</h1>
        <p class="step-description">正在检查必要的运行环境...</p>

        <div class="env-check-list">
          <div :class="['env-item', envStatus.python3 ? 'success' : 'error']">
            <div class="env-icon">
              <span v-if="envStatus.python3 === null">⏳</span>
              <span v-else-if="envStatus.python3">✅</span>
              <span v-else>❌</span>
            </div>
            <div class="env-info">
              <div class="env-name">Python 3</div>
              <div class="env-status">
                <span v-if="envStatus.python3 === null">检查中...</span>
                <span v-else-if="envStatus.python3">
                  已安装 {{ envStatus.python3_version }}
                </span>
                <span v-else>未安装</span>
              </div>
            </div>
          </div>

          <div :class="['env-item', envStatus.node ? 'success' : 'error']">
            <div class="env-icon">
              <span v-if="envStatus.node === null">⏳</span>
              <span v-else-if="envStatus.node">✅</span>
              <span v-else>❌</span>
            </div>
            <div class="env-info">
              <div class="env-name">Node.js</div>
              <div class="env-status">
                <span v-if="envStatus.node === null">检查中...</span>
                <span v-else-if="envStatus.node">
                  已安装 {{ envStatus.node_version }}
                </span>
                <span v-else>未安装</span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!allEnvReady" class="env-warning">
          <p>⚠️ 部分环境未就绪，某些功能可能无法正常使用。</p>
          <p class="env-hint">您可以继续配置，但建议先安装缺失的环境。</p>
        </div>

        <div class="step-actions">
          <button class="btn-secondary" @click="checkEnv" :disabled="checking">
            {{ checking ? '检查中...' : '重新检查' }}
          </button>
          <button class="btn-primary" @click="nextStep" :disabled="checking">
            {{ allEnvReady ? '继续' : '跳过' }}
          </button>
        </div>
      </div>

      <!-- 步骤 3: 配置模型供应商 -->
      <div v-if="currentStep === 3" class="step-content">
        <h1 class="step-title">配置模型供应商</h1>
        <p class="step-description">
          请配置至少一个 AI 模型供应商，用于 Chat 和 Agent 模式。
        </p>

        <div class="channel-form">
          <div class="form-group">
            <label>渠道名称</label>
            <input
              v-model="newChannel.name"
              type="text"
              placeholder="例如：OpenAI、阿里云、智谱 AI"
              class="form-input"
            />
          </div>

          <div class="form-group">
            <label>Base URL</label>
            <input
              v-model="newChannel.base_url"
              type="text"
              placeholder="https://api.openai.com/v1"
              class="form-input"
            />
          </div>

          <div class="form-group">
            <label>API Key</label>
            <input
              v-model="newChannel.api_key"
              type="password"
              placeholder="sk-..."
              class="form-input"
            />
          </div>

          <div class="form-group">
            <label>模型列表</label>
            <div class="models-input">
              <div class="model-tags">
                <span
                  v-for="(model, index) in newChannel.models"
                  :key="index"
                  class="model-tag"
                >
                  {{ model }}
                  <button class="tag-remove" @click="removeModel(index)">×</button>
                </span>
              </div>
              <div class="model-input-row">
                <input
                  v-model="newModelInput"
                  type="text"
                  placeholder="输入模型名称，如 gpt-4"
                  class="form-input"
                  @keydown.enter="addModel"
                />
                <button class="btn-small" @click="addModel">添加</button>
              </div>
            </div>
          </div>
        </div>

        <div class="step-actions">
          <button class="btn-secondary" @click="prevStep">上一步</button>
          <button
            class="btn-primary"
            @click="saveChannel"
            :disabled="!canSaveChannel"
          >
            保存并继续
          </button>
        </div>
      </div>

      <!-- 步骤 4: 完成 -->
      <div v-if="currentStep === 4" class="step-content">
        <div class="welcome-icon">🎉</div>
        <h1 class="step-title">设置完成！</h1>
        <p class="step-description">
          您已完成所有初始化配置，现在可以开始使用 Nova 了。
        </p>

        <div class="summary-box">
          <h3>配置摘要</h3>
          <div class="summary-item">
            <span class="summary-label">Python 3:</span>
            <span :class="['summary-value', envStatus.python3 ? 'success' : 'warning']">
              {{ envStatus.python3 ? '✅ 已就绪' : '⚠️ 未安装' }}
            </span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Node.js:</span>
            <span :class="['summary-value', envStatus.node ? 'success' : 'warning']">
              {{ envStatus.node ? '✅ 已就绪' : '⚠️ 未安装' }}
            </span>
          </div>
          <div class="summary-item">
            <span class="summary-label">模型供应商:</span>
            <span class="summary-value success">✅ 已配置</span>
          </div>
        </div>

        <button class="btn-primary" @click="finish">
          开始使用
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';

interface EnvStatus {
  python3: boolean | null;
  node: boolean | null;
  python3_version: string | null;
  node_version: string | null;
}

interface Channel {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
}

const emit = defineEmits<{
  complete: [];
}>();

const currentStep = ref(1);
const totalSteps = 4;
const checking = ref(false);

const envStatus = ref<EnvStatus>({
  python3: null,
  node: null,
  python3_version: null,
  node_version: null,
});

const newChannel = ref<Channel>({
  id: '',
  name: '',
  base_url: '',
  api_key: '',
  models: [],
});

const newModelInput = ref('');

const allEnvReady = computed(() => {
  return envStatus.value.python3 === true && envStatus.value.node === true;
});

const canSaveChannel = computed(() => {
  return (
    newChannel.value.name.trim() &&
    newChannel.value.base_url.trim() &&
    newChannel.value.api_key.trim() &&
    newChannel.value.models.length > 0
  );
});

async function checkEnv() {
  checking.value = true;
  try {
    const result = await invoke<EnvStatus>('check_environment');
    envStatus.value = result;
  } catch (error) {
    console.error('环境检查失败:', error);
  } finally {
    checking.value = false;
  }
}

function nextStep() {
  if (currentStep.value < totalSteps) {
    currentStep.value++;
    if (currentStep.value === 2) {
      checkEnv();
    }
  }
}

function prevStep() {
  if (currentStep.value > 1) {
    currentStep.value--;
  }
}

function addModel() {
  const model = newModelInput.value.trim();
  if (model && !newChannel.value.models.includes(model)) {
    newChannel.value.models.push(model);
    newModelInput.value = '';
  }
}

function removeModel(index: number) {
  newChannel.value.models.splice(index, 1);
}

async function saveChannel() {
  if (!canSaveChannel.value) return;

  // 生成唯一 ID
  newChannel.value.id = `channel_${Date.now()}`;

  try {
    // 保存配置
    await invoke('save_api_config', {
      config: {
        channels: [newChannel.value],
        chat_channel_id: newChannel.value.id,
        agent_channel_id: newChannel.value.id,
      },
    });

    nextStep();
  } catch (error) {
    console.error('保存配置失败:', error);
    alert('保存配置失败，请重试');
  }
}

async function finish() {
  try {
    await invoke('mark_initialized');
    emit('complete');
  } catch (error) {
    console.error('标记初始化失败:', error);
  }
}

onMounted(() => {
  // 初始化时生成渠道 ID
  newChannel.value.id = `channel_${Date.now()}`;
});
</script>

<style scoped>
.onboarding-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.onboarding-container {
  background: white;
  border-radius: 20px;
  padding: 48px;
  width: 100%;
  max-width: 560px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
}

.step-indicator {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-bottom: 40px;
}

.step-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #e5e7eb;
  transition: all 0.3s ease;
}

.step-dot.active {
  background: #667eea;
}

.step-dot.completed {
  background: #10b981;
}

.step-content {
  text-align: center;
}

.welcome-icon {
  font-size: 64px;
  margin-bottom: 24px;
}

.step-title {
  font-size: 28px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 16px;
}

.step-description {
  font-size: 16px;
  color: #6b7280;
  line-height: 1.6;
  margin-bottom: 32px;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  padding: 14px 32px;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 10px 20px -5px rgba(102, 126, 234, 0.4);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary {
  background: #f3f4f6;
  color: #4b5563;
  border: none;
  padding: 14px 32px;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-secondary:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn-secondary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-small {
  background: #667eea;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-small:hover {
  background: #5a67d8;
}

.step-actions {
  display: flex;
  gap: 16px;
  justify-content: center;
  margin-top: 32px;
}

/* 环境检查样式 */
.env-check-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 24px;
}

.env-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  border-radius: 12px;
  background: #f9fafb;
  border: 2px solid transparent;
  transition: all 0.2s ease;
}

.env-item.success {
  border-color: #10b981;
  background: #ecfdf5;
}

.env-item.error {
  border-color: #ef4444;
  background: #fef2f2;
}

.env-icon {
  font-size: 24px;
}

.env-info {
  text-align: left;
  flex: 1;
}

.env-name {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.env-status {
  font-size: 14px;
  color: #6b7280;
  margin-top: 4px;
}

.env-warning {
  background: #fffbeb;
  border: 1px solid #f59e0b;
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 24px;
}

.env-warning p {
  margin: 0;
  color: #92400e;
  font-size: 14px;
}

.env-hint {
  margin-top: 8px !important;
  color: #a16207 !important;
}

/* 表单样式 */
.channel-form {
  text-align: left;
  margin-bottom: 24px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 8px;
}

.form-input {
  width: 100%;
  padding: 12px 16px;
  border: 2px solid #e5e7eb;
  border-radius: 10px;
  font-size: 15px;
  transition: all 0.2s ease;
  box-sizing: border-box;
}

.form-input:focus {
  outline: none;
  border-color: #667eea;
}

.form-input::placeholder {
  color: #9ca3af;
}

.models-input {
  border: 2px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
}

.model-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.model-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #667eea;
  color: white;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 14px;
}

.tag-remove {
  background: none;
  border: none;
  color: white;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  transition: background 0.2s;
}

.tag-remove:hover {
  background: rgba(255, 255, 255, 0.2);
}

.model-input-row {
  display: flex;
  gap: 8px;
}

.model-input-row .form-input {
  flex: 1;
}

/* 摘要样式 */
.summary-box {
  background: #f9fafb;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 32px;
  text-align: left;
}

.summary-box h3 {
  margin: 0 0 16px 0;
  font-size: 16px;
  color: #374151;
}

.summary-item {
  display: flex;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid #e5e7eb;
}

.summary-item:last-child {
  border-bottom: none;
}

.summary-label {
  color: #6b7280;
  font-size: 14px;
}

.summary-value {
  font-size: 14px;
  font-weight: 500;
}

.summary-value.success {
  color: #10b981;
}

.summary-value.warning {
  color: #f59e0b;
}
</style>
