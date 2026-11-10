<script setup lang="ts">
import { useData } from 'vitepress'
import { onMounted, ref, useId, watch } from 'vue'

const { code } = defineProps<{ code: string }>()
const { isDark } = useData()
const id = useId()
const source = decodeURIComponent(code)
const svg = ref('')
const failed = ref(false)

// Imported here so a page with no diagram never loads mermaid.
async function draw() {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: isDark.value ? 'dark' : 'default',
  })
  try {
    svg.value = (await mermaid.render(id, source)).svg
  } catch (error) {
    console.error(error)
    failed.value = true
  }
}

onMounted(draw)
watch(isDark, draw)
</script>

<template>
  <div v-if="failed" class="language-mermaid"><pre><code>{{ source }}</code></pre></div>
  <div v-else class="mermaid" v-html="svg" />
</template>
