<script setup lang="ts">
import { useData } from 'vitepress'
import { onMounted, ref, useId, watch } from 'vue'

const { code } = defineProps<{ code: string }>()
const { isDark } = useData()
const id = useId()
const svg = ref('')

// Imported here so a page with no diagram never loads mermaid.
async function draw() {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({ startOnLoad: false, theme: isDark.value ? 'dark' : 'default' })
  svg.value = (await mermaid.render(id, decodeURIComponent(code))).svg
}

onMounted(draw)
watch(isDark, draw)
</script>

<template>
  <div class="mermaid" v-html="svg" />
</template>

<style>
/* Mermaid sizes labels at its own line height; the doc's taller one clipped them. */
.vp-doc .mermaid p {
  line-height: inherit;
}
</style>
