<template>
  <q-page class="content-panel login-page">
    <div class="login-card section-surface q-pa-lg">
      <div class="text-h5 text-weight-bold q-mb-md">
        {{ mode === 'login' ? '登录' : '注册' }}
      </div>

      <!-- Auth-method tabs (only the password tab is fully wired today) -->
      <q-tabs v-model="method" dense narrow-indicator align="left" no-caps active-color="primary">
        <q-tab name="password" label="账号 + 密码" />
        <q-tab name="email-code" label="邮箱验证码" disable>
          <q-tooltip>近期开放</q-tooltip>
        </q-tab>
        <q-tab name="sms" label="手机号验证码" disable>
          <q-tooltip>需 SMS 提供商接入</q-tooltip>
        </q-tab>
      </q-tabs>
      <q-separator class="q-mb-md" />

      <q-form @submit.prevent="onSubmit" class="q-gutter-md">
        <q-input
          v-model="identifier"
          outlined
          :label="mode === 'login' ? '用户名 / 邮箱 / 手机号' : '用户名'"
          autocomplete="username"
          :rules="[(v) => !!v || '不能为空']"
        />
        <q-input
          v-if="mode === 'register'"
          v-model="email"
          outlined
          label="邮箱（可选）"
          type="email"
          autocomplete="email"
        />
        <q-input
          v-model="password"
          outlined
          :label="mode === 'login' ? '密码' : '密码（至少 8 位）'"
          :type="showPw ? 'text' : 'password'"
          autocomplete="current-password"
          :rules="[
            (v) => !!v || '不能为空',
            (v) => mode === 'login' || v.length >= 8 || '至少 8 位'
          ]"
        >
          <template #append>
            <q-icon
              :name="showPw ? 'visibility_off' : 'visibility'"
              class="cursor-pointer"
              @click="showPw = !showPw"
            />
          </template>
        </q-input>

        <div class="row items-center q-gutter-md">
          <q-btn
            type="submit"
            color="primary"
            :label="mode === 'login' ? '登录' : '注册'"
            :loading="auth.busy.value"
          />
          <q-btn
            flat
            color="primary"
            :label="mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'"
            @click="toggleMode"
          />
          <q-space />
          <q-btn flat icon="arrow_back" label="返回市场" to="/marketplace" />
        </div>
      </q-form>

      <div class="text-caption text-grey-7 q-mt-md">
        {{
          mode === 'register'
            ? '首位注册的用户会自动获得 admin 角色（仅在用户表为空时）。'
            : '会话保存在本地，未联网时仍可访问已缓存的市场目录。'
        }}
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useAuth } from 'src/composables/useAuth';

const router = useRouter();
const auth = useAuth();

const mode = ref<'login' | 'register'>('login');
const method = ref<'password' | 'email-code' | 'sms'>('password');
const identifier = ref('');
const email = ref('');
const password = ref('');
const showPw = ref(false);

onMounted(async () => {
  await auth.refresh();
  if (auth.state.value.user) router.replace('/');
});

function toggleMode(): void {
  mode.value = mode.value === 'login' ? 'register' : 'login';
}

async function onSubmit(): Promise<void> {
  const ok =
    mode.value === 'login'
      ? await auth.login(identifier.value, password.value)
      : await auth.register({
          username: identifier.value,
          email: email.value || undefined,
          password: password.value,
          displayName: identifier.value
        });
  if (ok) router.replace('/marketplace');
}
</script>

<style scoped lang="scss">
.login-page {
  display: flex;
  align-items: flex-start;
  justify-content: center;
}
.login-card {
  width: min(480px, 100%);
  margin-top: 32px;
}
</style>
