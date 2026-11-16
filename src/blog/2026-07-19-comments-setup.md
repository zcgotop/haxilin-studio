---
title: '博客的评论功能添加！'
description: '从零到一给 Astro 博客接入 Giscus 评论区，附 giscus.app 配置页面每一步的详细说明、组件代码示例，以及踩坑记录。'
author: 'HaxiLin'
pubDate: 2026-07-19
tags: ["github", "comment", "discussion", "blogging"]
altTags: []
---

今天继续完善博客，主要工作是给文章页接入评论区。先后尝试了几种方案，最后选定了 Giscus——它以 GitHub Discussions 作为评论后端，无需自建数据库、无需额外服务，评论数据天然归档在你的仓库里，管理起来非常方便。

下面按顺序记录完整流程，跟着做即可。

## 一、启用仓库的 Discussions 功能

Giscus 把每篇文章的评论映射为 GitHub Discussions 中的一个 Discussion，所以第一步要在仓库里开启 Discussions。

进入你的 GitHub 仓库页面，依次点击 **Settings → General**，往下滚动到 **Features** 区块，勾选 **Discussions**。勾选后仓库顶部导航栏会多出一个 Discussions 标签，说明功能已经启用。

## 二、安装 Giscus App

Giscus 需要通过一个 GitHub App 来读写 Discussions，所以第二步是把这个 App 装到你的账号下。

打开 [https://github.com/apps/giscus](https://github.com/apps/giscus)，点击 **Install**，页面会列出你账号下的所有仓库。选择你要接入评论的那个仓库（也可以选 All repositories，但建议只授权单个仓库，权限最小化更安全）。授权完成后，Giscus App 就能以你的名义在对应仓库里创建和读取 Discussion 了。

## 三、在 giscus.app 生成配置代码

这是最关键的一步。打开 [https://giscus.app/zh-CN](https://giscus.app/zh-CN)，页面从上到下分为若干区块，逐项填写：

1. **仓库（repository）**：填入你的仓库全名，格式为 `用户名/仓库名`，例如 `zcgo707/haxilin-studio`。填写后页面会立即校验该仓库是否已启用 Discussions、是否已安装 Giscus App，两项都通过才会继续。

2. **页面  discussion 映射（mapping）**：决定每篇文章对应一个 Discussion 的方式。常用选项有：
    - `pathname`：以页面路径作为标识，适合文章 URL 比较固定的博客。
    - `title`：以文章标题作为标识。
    - `URL`：以完整 URL 作为标识。

    我的博客结构简单，选了 **`pathname`**，这样每篇文章都能稳定对应到一个独立的 Discussion。

3. **Discussion 分类（category）**：评论会被写入 Discussions 中的哪个分类。强烈推荐选 **Announcements**——这个分类默认只有仓库维护者能发起新帖，但任何人都可以回复，正好契合"博主发文章、访客留言"的场景，而且能有效挡掉垃圾广告贴。其它分类（如 General）允许任何人开新帖，评论列表会变得很乱。

4. **特性（Features）**：可选配置，例如是否开启表情反应（reactions）、是否发送评论元数据等。我开启了 reactions，让访客能用 emoji 给评论点赞。

5. **主题（Theme）**：评论区的视觉主题。我选了 **`preferred_color_scheme`**，这样评论区的明暗会自动跟随系统的明暗模式，和博客整体风格保持一致。

填完以上选项后，页面底部的 **「启用 giscus」** 区块会实时生成一段 `<script>` 代码，类似这样：

```html
<script src="https://giscus.app/client.js"
    data-repo="zcgo707/haxilin-studio"
    data-repo-id="R_kgDOTOcDhQ"
    data-category="Announcements"
    data-category-id="DIC_kwDOTOcDhQ4DBfzv"
    data-mapping="pathname"
    data-strict="0"
    data-reactions-enabled="1"
    data-emit-metadata="0"
    data-input-position="bottom"
    data-theme="preferred_color_scheme"
    data-lang="zh-CN"
    crossorigin="anonymous"
    async>
</script>
```

其中四个最关键的参数是：

| 参数 | 含义 |
| --- | --- |
| `data-repo` | 仓库全名 `用户名/仓库名` |
| `data-repo-id` | 仓库的唯一 ID（base64 编码），由 giscus.app 自动生成 |
| `data-category` | Discussions 分类名，例如 `Announcements` |
| `data-category-id` | 分类的唯一 ID（base64 编码），同样由 giscus.app 生成 |

把这四个值记下来，下一步要填进组件里。

## 四、创建评论组件

在 `src/components/` 下新建 `Comments.astro`，把上一步生成的脚本粘进去即可。完整代码如下：

```astro
---
// Giscus 评论组件 —— 基于 GitHub Discussions
// 配置来自 https://giscus.app/zh-CN
// 主题跟随系统明暗模式（preferred_color_scheme）
//
// 注意：Astro 默认会处理 <script> 标签（打包/作用域隔离），
// 而 Giscus 需要原始的 data-* 属性 + async 加载，
// 所以必须用 `is:inline` 让 Astro 原样输出到 HTML。
---

<section class="comments">
    <h2 class="comments-title">评论</h2>
    <div class="giscus"></div>
    <script is:inline src="https://giscus.app/client.js"
        data-repo="zcgo707/haxilin-studio"
        data-repo-id="R_kgDOTOcDhQ"
        data-category="Announcements"
        data-category-id="DIC_kwDOTOcDhQ4DBfzv"
        data-mapping="pathname"
        data-strict="0"
        data-reactions-enabled="1"
        data-emit-metadata="0"
        data-input-position="bottom"
        data-theme="preferred_color_scheme"
        data-lang="zh-CN"
        crossorigin="anonymous"
        async>
    </script>
</section>

<style>
    .comments {
        margin-top: 3rem;
        padding-top: 2rem;
        border-top: 1px solid var(--color-border);
    }

    .comments-title {
        font-size: 1.2rem;
        margin-bottom: 1rem;
        color: var(--color-text);
    }

    .giscus {
        min-height: 100px;
    }
</style>
```

这里有一个**关键细节**值得单独拎出来说：Astro 默认会对组件里的 `<script>` 标签做打包和作用域隔离处理，而 Giscus 的 client.js 必须以原始的 `data-*` 属性 + `async` 方式加载，一旦被 Astro 改写就会失效。解决办法是给 `<script>` 加上 `is:inline` 指令，告诉 Astro 原样输出、不要动它。

## 五、在文章页引入组件

最后一步是把评论组件挂到文章布局里。打开 `src/layouts/MarkdownPostLayout.astro`，在 `<article>` 标签的末尾、`</article>` 之前插入 `<Comments />`：

```astro
---
import BaseLayout from "./BaseLayout.astro";
import Comments from "../components/Comments.astro";
const { frontmatter } = Astro.props;
---

<BaseLayout pageTitle={frontmatter.title} showTitle={false}>
    <article class="post-page">
        <!-- 文章头部、正文等 -->
        <div class="post-content">
            <slot />
        </div>

        <Comments />
    </article>
</BaseLayout>
```

保存后刷新任意一篇文章，底部就会出现评论区。首次访问某篇文章时，Giscus 会自动在 Discussions 的 Announcements 分类下创建一条对应的 Discussion，之后的评论都会写入这条 Discussion。

## 踩坑记录

接入完成后，网页上评论区加载正常，也能登录、输入，但点击「发布」之后就卡死，预览也一直转圈加载不出来。反复排查后发现，原因是我一直开着 **Watt Toolkit**（原 Steam++），它对 GitHub 做了代理加速，导致 Discussions 的写入请求被干扰。关掉 Watt Toolkit 之后，发布、预览一切顺畅。

如果你也遇到类似的"加载出来但发不出去"的问题，不妨先排查一下代理、加速器之类的网络中间层。

## 致谢

此外，感谢[二叉树树的教程](https://2x.nz/posts/?slug=giscus-akismet)：他在文中提供了一个免费的垃圾留言过滤方案——Akismet，配合 Giscus 使用可以进一步挡掉机器人广告评论，感兴趣的话可以去他的博客看详情。
