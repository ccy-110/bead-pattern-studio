<script setup lang="ts">
import { computed, ref } from 'vue'

import { cloud, login, logout, openPattern, register, removePattern, saveCurrent, sharePattern, unsharePattern } from '@/stores/cloud'
import { pattern } from '@/stores/project'
import SectionCard from './SectionCard.vue'

/**
 * 账号与云端图纸。
 *
 * 没登录时就是一张登录/注册表单；登录后显示当前邮箱、保存按钮和"我的图纸"。
 *
 * 这里**不在挂载时发请求**：会话检查由 `main.ts` 在启动时做一次。
 * 否则每个挂载这个面板的组件测试都会去连一个不存在的后端。
 */

const mode = ref<'login' | 'register'>('login')
const email = ref('')
const password = ref('')
const localBusy = ref(false)

const badge = computed(() => cloud.user?.email ?? (cloud.status === 'offline' ? '未连接' : '未登录'))
const canSave = computed(() => cloud.user !== null && pattern.value !== null && !cloud.busy && !localBusy.value)

function switchMode(next: 'login' | 'register'): void {
  mode.value = next
  cloud.error = null
  cloud.notice = null
}

async function submit(): Promise<void> {
  if (localBusy.value) return
  const mail = email.value.trim()
  if (mail === '' || password.value === '') {
    cloud.error = '请填写邮箱和密码'
    return
  }

  localBusy.value = true
  const ok = mode.value === 'login' ? await login(mail, password.value) : await register(mail, password.value)
  localBusy.value = false

  if (ok) {
    password.value = ''
  }
}

async function doSave(): Promise<void> {
  // 提示与列表刷新都在 store 里统一处理
  await saveCurrent()
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function doDelete(id: string, title: string): Promise<void> {
  if (!window.confirm(`删除「${title}」后无法恢复，确定吗？`)) return
  await removePattern(id)
}

async function doShare(item: { id: string; shared: boolean }): Promise<void> {
  if (item.shared) {
    if (window.confirm('关闭分享后，已经发出去的链接会立即失效。继续吗？')) {
      await unsharePattern(item.id)
    }
    return
  }
  await sharePattern(item.id)
}
</script>

<template>
  <SectionCard title="账号" :open="cloud.user === null" :badge="badge">
    <!-- 后端没起来：本地功能照常，只提示云端不可用 -->
    <div v-if="cloud.status === 'offline'" class="banner banner-warn">
      云端功能不可用（连不上服务器）。本地保存、导出、打印都不受影响。
    </div>

    <template v-else-if="cloud.user === null">
      <div class="field">
        <div class="field-label"><span>邮箱</span></div>
        <input
          v-model="email"
          class="input"
          type="email"
          autocomplete="email"
          placeholder="you@example.com"
          @keydown.enter="submit"
        />
      </div>
      <div class="field">
        <div class="field-label"><span>密码</span></div>
        <input
          v-model="password"
          class="input"
          type="password"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          placeholder="至少 8 位"
          @keydown.enter="submit"
        />
      </div>

      <div class="row">
        <button type="button" class="btn btn-sm" :disabled="localBusy || cloud.busy" @click="submit">
          {{ mode === 'login' ? '登录' : '注册' }}
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="localBusy || cloud.busy"
          @click="switchMode(mode === 'login' ? 'register' : 'login')"
        >
          {{ mode === 'login' ? '没有账号？注册' : '已有账号？登录' }}
        </button>
      </div>

      <p class="field-hint">
        邮箱只用于登录，不会公开。忘记密码需要联系站长重置（暂时没有邮件找回）。
      </p>
    </template>

    <template v-else>
      <div class="row">
        <button type="button" class="btn btn-sm" :disabled="!canSave" @click="doSave">
          {{ cloud.busy ? '保存中…' : '保存当前图纸到云端' }}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" @click="logout">退出</button>
      </div>
      <p v-if="pattern === null" class="field-hint">还没有图纸可保存。</p>

      <div class="field-label" style="margin-top: 10px">
        <span>我的图纸</span>
        <span class="field-value">{{ cloud.patterns.length }}</span>
      </div>

      <p v-if="cloud.patterns.length === 0" class="field-hint">还没有保存过图纸。</p>

      <ul v-else class="cloud-list">
        <li v-for="item in cloud.patterns" :key="item.id" class="cloud-item">
          <img v-if="item.thumbnail" class="cloud-thumb" :src="item.thumbnail" :alt="item.title" />
          <div class="cloud-meta">
            <div class="cloud-title" :title="item.title">{{ item.title }}</div>
            <div class="cloud-sub">
              {{ item.cols }}×{{ item.rows }} · {{ formatTime(item.updatedAt) }}
              <span v-if="item.shared" class="cloud-badge">已分享</span>
            </div>
            <div class="row">
              <button type="button" class="btn btn-ghost btn-sm" :disabled="cloud.busy" @click="openPattern(item.id)">
                打开
              </button>
              <button type="button" class="btn btn-ghost btn-sm" :disabled="cloud.busy" @click="doShare(item)">
                {{ item.shared ? '关闭分享' : '分享' }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="cloud.busy"
                @click="doDelete(item.id, item.title)"
              >
                删除
              </button>
            </div>
          </div>
        </li>
      </ul>
    </template>

    <div v-if="cloud.error" class="banner banner-danger">{{ cloud.error }}</div>
    <div v-else-if="cloud.notice" class="banner banner-info">{{ cloud.notice }}</div>
  </SectionCard>
</template>
