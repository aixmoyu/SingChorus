<template>
  <div class="page">
    <div class="page-header">
      <h1>Templates</h1>
    </div>

    <n-spin v-if="templateStore.loading" />
    <template v-else>
      <n-alert v-if="templateStore.error" type="error" style="margin-bottom: var(--space-md)">
        {{ templateStore.error }}
      </n-alert>
      <template v-if="templateStore.templates.length === 0">
        <n-empty :description="templateStore.error ? 'No templates available.' : 'No templates available. Check your cloud connection.'" />
      </template>
      <template v-else>
      <n-grid :cols="3" :x-gap="12" :y-gap="12" :xs="1" :s="2" :m="3" responsive="screen">
        <n-gi v-for="t in templateStore.templates" :key="t.id">
          <n-card :title="t.name">
            <n-text depth="3">{{ t.type }} — v{{ t.version }}</n-text>
            <n-h5 style="margin-top: var(--space-sm)">Parameters</n-h5>
            <n-ul>
              <n-li v-for="p in t.schema.params" :key="p.name">
                <n-text>{{ p.name }}</n-text>
                <n-text depth="3" style="margin-left: 4px">({{ p.type }}{{ p.required ? ', required' : '' }})</n-text>
              </n-li>
            </n-ul>
            <n-collapse style="margin-top: var(--space-sm)">
              <n-collapse-item title="Server Template" name="server">
                <n-code :code="JSON.stringify(t.schema.server_template, null, 2)" language="json" />
              </n-collapse-item>
              <n-collapse-item title="Client Template" name="client">
                <n-code :code="JSON.stringify(t.schema.client_template, null, 2)" language="json" />
              </n-collapse-item>
            </n-collapse>
          </n-card>
        </n-gi>
      </n-grid>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { NGrid, NGi, NCard, NText, NH5, NUl, NLi, NCollapse, NCollapseItem, NCode, NEmpty, NSpin, NAlert } from 'naive-ui'
import { useTemplateStore } from '@/stores/template'

const templateStore = useTemplateStore()
onMounted(() => templateStore.fetchTemplates())
</script>
