<script setup lang="ts">
import { useData } from 'vitepress'
import { onMounted, ref, useId, watch } from 'vue'

const { code } = defineProps<{ code: string }>()
const { isDark } = useData()
const id = useId()
const source = decodeURIComponent(code)
const svg = ref('')
const failed = ref(false)

// Read after the import so a theme toggle has already swapped the site's variables.
function siteVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--vp-${name}`).trim()
}

// Imported here so a page with no diagram never loads mermaid.
async function draw() {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: 'base',
    flowchart: { curve: 'linear', wrappingWidth: 160, subGraphTitleMargin: { top: 8, bottom: 8 } },
    themeVariables: {
      darkMode: isDark.value,
      dropShadow: 'none',
      fontFamily: siteVar('font-family-base'),
      background: siteVar('c-bg'),
      primaryColor: siteVar('c-bg-soft'),
      primaryBorderColor: siteVar('c-border'),
      primaryTextColor: siteVar('c-text-1'),
      lineColor: siteVar('c-text-2'),
      tertiaryColor: siteVar('c-bg-alt'),
      tertiaryBorderColor: siteVar('c-divider'),
      edgeLabelBackground: siteVar('c-bg'),
    },
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
  <div v-if="failed" class="language-mermaid">
    <pre><code>{{ source }}</code></pre>
  </div>
  <div v-else class="mermaid" v-html="svg" />
</template>

<style>
/* Mermaid sizes labels at its own line height; the doc's taller one clipped them. */
.vp-doc .mermaid p {
  line-height: inherit;
}

/* Mermaid draws rectangles square, with no setting for it. */
.vp-doc .mermaid .node rect {
  rx: 6px;
  ry: 6px;
}
.vp-doc .mermaid .cluster rect {
  rx: 10px;
  ry: 10px;
}
</style>
