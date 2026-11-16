// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { visit } from "unist-util-visit";

// rehype 插件：给所有 Markdown 渲染的 <img> 自动加 loading="lazy" decoding="async"
// 覆盖所有文章详情页的内容图片，浏览器原生懒加载，零 JS 开销
function rehypeLazyImages() {
  return (tree) => {
    visit(tree, "element", (node) => {
      if (node.tagName === "img") {
        node.properties = node.properties || {};
        if (!node.properties.loading) node.properties.loading = "lazy";
        if (!node.properties.decoding) node.properties.decoding = "async";
      }
    });
  };
}

// https://astro.build/config
export default defineConfig({
  site: "https://x.zcgo.top",
  output: "static",
  adapter: cloudflare({
    imageService: "passthrough",
  }),
  markdown: {
    rehypePlugins: [rehypeLazyImages],
  },
  vite: {
    optimizeDeps: {
      exclude: [
        "astro:content",
        "astro:content/runtime",
        "astro:env",
        "astro:env/server",
        "astro:env/client",
        "astro/loaders",
        "astro/zod",
      ],
    },
  },
});
